-- Avalanche Run: endurance race ledger (docs/endurance-race.md).
--
-- The race itself runs on the Colyseus race server, which replays every rider
-- and decides the result. This migration only keeps the money straight:
-- entries, escrowed fees, the payout and the burn. Every function here is for
-- the race server alone (service role); players can only read.
--
-- It needs three wallet functions from the site, which is not part of this
-- migration (locally: supabase/local-standins/shards_wallet.sql):
--   shards_balance(user uuid) -> integer
--   shards_debit(user uuid, amount integer, ref text) -> boolean  (false: too low)
--   shards_credit(user uuid, amount integer, ref text)
--   avalanche_player_name(user uuid) -> text  (the name other players see)
--
-- Adds new objects only.

create table public.avalanche_race_config (
  id integer primary key default 1 check (id = 1),
  entry_fee integer not null default 10 check (entry_fee > 0),
  prize_pct integer not null default 90 check (prize_pct between 0 and 100), -- the rest is burned
  min_riders integer not null default 2,
  max_riders integer not null default 50
);
insert into public.avalanche_race_config default values;

create table public.avalanche_races (
  id text primary key,
  seed bigint not null,
  status text not null default 'open' check (status in ('open', 'racing', 'settled', 'cancelled', 'voided')),
  entry_fee integer not null,
  prize_pct integer not null, -- the winner's share when the race opened; the rest is burned
  pot integer not null default 0,
  prize integer not null default 0,
  burned integer not null default 0,
  void_reason text, -- why the race server voided it (status 'voided')
  created_at timestamptz not null default now(),
  started_at timestamptz,
  settled_at timestamptz
);

create table public.avalanche_race_entries (
  race_id text not null references public.avalanche_races (id),
  user_id uuid not null references auth.users (id),
  fee integer not null,
  place integer,
  death_tick integer,
  distance integer,
  prize integer not null default 0,
  refunded boolean not null default false,
  checked_in_at timestamptz not null default now(),
  primary key (race_id, user_id)
);

alter table public.avalanche_race_config enable row level security;
alter table public.avalanche_races enable row level security;
alter table public.avalanche_race_entries enable row level security;
create policy "race config is public" on public.avalanche_race_config for select using (true);
create policy "races are public" on public.avalanche_races for select using (true);
create policy "own race entries" on public.avalanche_race_entries for select to authenticated using (auth.uid() = user_id);
grant select on public.avalanche_race_config, public.avalanche_races to anon, authenticated;
grant select on public.avalanche_race_entries to authenticated;

-- ---------------------------------------------------------------------------
-- Race server functions.

-- The player's wallet, the entry fee, and their race record (races ridden,
-- wins, Shards won), read from the entries.
create function public.race_balance(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return (select jsonb_build_object('balance', shards_balance(p_user), 'fee', c.entry_fee, 'prize_pct', c.prize_pct, 'max_riders', c.max_riders, 'min_riders', c.min_riders,
            'races', (select count(*) from avalanche_race_entries e join avalanche_races r on r.id = e.race_id where e.user_id = p_user and r.status = 'settled'),
            'wins', (select count(*) from avalanche_race_entries e join avalanche_races r on r.id = e.race_id where e.user_id = p_user and e.place = 1 and r.status = 'settled'),
            'won', (select coalesce(sum(e.prize), 0) from avalanche_race_entries e where e.user_id = p_user))
          from avalanche_race_config c);
end $$;

-- Open the next race for check-in, at the current entry fee and prize share.
create function public.race_open(p_race text, p_seed bigint)
returns jsonb language sql security definer set search_path = public as $$
  insert into avalanche_races (id, seed, entry_fee, prize_pct)
  select p_race, p_seed, entry_fee, prize_pct from avalanche_race_config
  returning jsonb_build_object('id', id, 'fee', entry_fee, 'prize_pct', prize_pct);
$$;

-- Take the entry fee into escrow. Idempotent per player and race.
create function public.race_check_in(p_race text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r avalanche_races;
  n integer;
  maxr integer;
begin
  select * into r from avalanche_races where id = p_race for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no such race'); end if;
  if r.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'check-in closed'); end if;
  if exists (select 1 from avalanche_race_entries where race_id = p_race and user_id = p_user) then
    return jsonb_build_object('ok', true, 'already', true, 'balance', shards_balance(p_user), 'pot', r.pot);
  end if;
  select max_riders into maxr from avalanche_race_config;
  select count(*) into n from avalanche_race_entries where race_id = p_race;
  if n >= maxr then return jsonb_build_object('ok', false, 'reason', 'race full'); end if;
  if not shards_debit(p_user, r.entry_fee, 'avalanche race ' || p_race || ' entry') then
    return jsonb_build_object('ok', false, 'reason', 'not enough shards', 'balance', shards_balance(p_user));
  end if;
  insert into avalanche_race_entries (race_id, user_id, fee) values (p_race, p_user, r.entry_fee);
  update avalanche_races set pot = pot + r.entry_fee where id = p_race returning pot into n;
  return jsonb_build_object('ok', true, 'balance', shards_balance(p_user), 'pot', n);
end $$;

-- Close check-in and start. Returns the riders who paid.
create function public.race_start(p_race text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update avalanche_races set status = 'racing', started_at = now() where id = p_race and status = 'open';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not open'); end if;
  return jsonb_build_object('ok', true, 'riders',
    coalesce((select jsonb_agg(user_id) from avalanche_race_entries where race_id = p_race), '[]'::jsonb));
end $$;

-- Too few riders, or the race could not run: every fee goes back.
create function public.race_cancel(p_race text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e record;
  n integer := 0;
begin
  update avalanche_races set status = 'cancelled', settled_at = now() where id = p_race and status in ('open', 'racing');
  if not found then return jsonb_build_object('ok', false, 'reason', 'already closed'); end if;
  for e in select * from avalanche_race_entries where race_id = p_race and not refunded for update loop
    perform shards_credit(e.user_id, e.fee, 'avalanche race ' || p_race || ' refund');
    update avalanche_race_entries set refunded = true where race_id = p_race and user_id = e.user_id;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'refunded', n);
end $$;

-- Record the result and pay out once. p_results: [{user_id, place, death_tick,
-- distance}] for every rider, decided by the race server. Every place-1 rider
-- shares the prize; whole Shards only, so any remainder is burned with the rest.
create function public.race_settle(p_race text, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r avalanche_races;
  x jsonb;
  winners uuid[] := '{}';
  v_prize integer;
  v_each integer;
  w uuid;
begin
  select * into r from avalanche_races where id = p_race for update;
  if not found or r.status <> 'racing' then return jsonb_build_object('ok', false, 'reason', 'not racing'); end if;
  for x in select * from jsonb_array_elements(p_results) loop
    update avalanche_race_entries
      set place = (x->>'place')::integer, death_tick = (x->>'death_tick')::integer, distance = (x->>'distance')::integer
      where race_id = p_race and user_id = (x->>'user_id')::uuid;
    if (x->>'place')::integer = 1 and found then winners := winners || (x->>'user_id')::uuid; end if;
  end loop;
  v_prize := r.pot * r.prize_pct / 100;
  v_each := case when array_length(winners, 1) > 0 then v_prize / array_length(winners, 1) else 0 end;
  foreach w in array winners loop
    perform shards_credit(w, v_each, 'avalanche race ' || p_race || ' prize');
    update avalanche_race_entries set prize = v_each where race_id = p_race and user_id = w;
  end loop;
  v_prize := v_each * coalesce(array_length(winners, 1), 0);
  update avalanche_races set status = 'settled', settled_at = now(), prize = v_prize, burned = pot - v_prize where id = p_race;
  return jsonb_build_object('ok', true, 'pot', r.pot, 'prize', v_prize, 'each', v_each, 'burned', r.pot - v_prize, 'winners', to_jsonb(winners));
end $$;

-- The race server found the win scripted: keep the standings as evidence,
-- pay no prize, burn nothing, and give every rider their fee back.
create function public.race_void(p_race text, p_results jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r avalanche_races;
  x jsonb;
  e record;
  n integer := 0;
begin
  select * into r from avalanche_races where id = p_race for update;
  if not found or r.status <> 'racing' then return jsonb_build_object('ok', false, 'reason', 'not racing'); end if;
  for x in select * from jsonb_array_elements(p_results) loop
    update avalanche_race_entries
      set place = (x->>'place')::integer, death_tick = (x->>'death_tick')::integer, distance = (x->>'distance')::integer
      where race_id = p_race and user_id = (x->>'user_id')::uuid;
  end loop;
  update avalanche_races set status = 'voided', settled_at = now(), void_reason = p_reason where id = p_race;
  for e in select * from avalanche_race_entries where race_id = p_race and not refunded for update loop
    perform shards_credit(e.user_id, e.fee, 'avalanche race ' || p_race || ' voided, refund');
    update avalanche_race_entries set refunded = true where race_id = p_race and user_id = e.user_id;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'pot', r.pot, 'refunded', n);
end $$;

-- The race leaderboard: riders ranked by wins, then Shards won, from settled
-- races only (voided and cancelled ones don't count). Names come from
-- avalanche_player_name, as the race server shows them. PL/pgSQL so that
-- function is looked up when the board is read, not when this is created.
create function public.race_board(p_user uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return (with rec as (
    select e.user_id, count(*) as races, count(*) filter (where e.place = 1) as wins, coalesce(sum(e.prize), 0) as won
    from avalanche_race_entries e join avalanche_races r on r.id = e.race_id
    where r.status = 'settled'
    group by e.user_id
  ), ranked as (
    select rec.*, rank() over (order by wins desc, won desc) as rank,
      left(coalesce(nullif(trim(avalanche_player_name(rec.user_id)), ''), 'rider'), 20) as name
    from rec
  )
  select jsonb_build_object(
    'riders', (select count(*) from ranked),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', rank, 'name', name, 'races', races, 'wins', wins, 'won', won, 'me', user_id = p_user) order by rank, name)
                     from (select * from ranked order by rank, name limit greatest(1, least(p_limit, 50))) t), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rank, 'name', name, 'races', races, 'wins', wins, 'won', won, 'me', true) from ranked where user_id = p_user)));
end $$;

revoke all on function public.race_balance(uuid) from public, anon, authenticated;
revoke all on function public.race_open(text, bigint) from public, anon, authenticated;
revoke all on function public.race_check_in(text, uuid) from public, anon, authenticated;
revoke all on function public.race_start(text) from public, anon, authenticated;
revoke all on function public.race_cancel(text) from public, anon, authenticated;
revoke all on function public.race_settle(text, jsonb) from public, anon, authenticated;
revoke all on function public.race_void(text, jsonb, text) from public, anon, authenticated;
revoke all on function public.race_board(uuid, integer) from public, anon, authenticated;
grant execute on function public.race_balance(uuid) to service_role;
grant execute on function public.race_open(text, bigint) to service_role;
grant execute on function public.race_check_in(text, uuid) to service_role;
grant execute on function public.race_start(text) to service_role;
grant execute on function public.race_cancel(text) to service_role;
grant execute on function public.race_settle(text, jsonb) to service_role;
grant execute on function public.race_void(text, jsonb, text) to service_role;
grant execute on function public.race_board(uuid, integer) to service_role;
