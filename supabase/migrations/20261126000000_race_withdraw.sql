-- Leaving the race lobby (DECISIONS 66): a checked-in rider may withdraw while
-- check-in is open and gets the full fee back.
--
-- Every Shards movement has its own idempotency key built from its ref, so a
-- rider who leaves and checks in again must not reuse the first entry's ref
-- (the debit would be skipped as a retry). Each withdrawal is counted, and
-- the next entry and refund refs carry that count.

create table public.avalanche_race_withdrawals (
  race_id text not null references public.avalanche_races (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  n integer not null default 0,
  primary key (race_id, user_id)
);
alter table public.avalanche_race_withdrawals enable row level security;

create or replace function public.race_check_in(p_race text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r avalanche_races;
  n integer;
  maxr integer;
  v_left integer;
  v_ref text;
begin
  perform _race_guard();
  select * into r from avalanche_races where id = p_race for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no such race'); end if;
  if r.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'check-in closed'); end if;
  if exists (select 1 from avalanche_race_entries where race_id = p_race and user_id = p_user) then
    return jsonb_build_object('ok', true, 'already', true, 'balance', shards_balance(p_user), 'pot', r.pot);
  end if;
  select max_riders into maxr from avalanche_race_config;
  select count(*) into n from avalanche_race_entries where race_id = p_race;
  if n >= maxr then return jsonb_build_object('ok', false, 'reason', 'race full'); end if;
  select coalesce(max(w.n), 0) into v_left from avalanche_race_withdrawals w where w.race_id = p_race and w.user_id = p_user;
  v_ref := 'avalanche race ' || p_race || ' entry' || case when v_left > 0 then ' #' || (v_left + 1) else '' end;
  if not shards_debit(p_user, r.entry_fee, v_ref) then
    return jsonb_build_object('ok', false, 'reason', 'not enough shards', 'balance', shards_balance(p_user));
  end if;
  insert into avalanche_race_entries (race_id, user_id, fee) values (p_race, p_user, r.entry_fee);
  update avalanche_races set pot = pot + r.entry_fee where id = p_race returning pot into n;
  return jsonb_build_object('ok', true, 'balance', shards_balance(p_user), 'pot', n);
end $$;

create function public.race_withdraw(p_race text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r avalanche_races;
  e avalanche_race_entries;
  v_n integer;
begin
  perform _race_guard();
  select * into r from avalanche_races where id = p_race for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no such race'); end if;
  if r.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'check-in closed'); end if;
  select * into e from avalanche_race_entries where race_id = p_race and user_id = p_user for update;
  if not found then return jsonb_build_object('ok', true, 'already', true, 'balance', shards_balance(p_user), 'pot', r.pot); end if;
  insert into avalanche_race_withdrawals (race_id, user_id, n) values (p_race, p_user, 1)
    on conflict (race_id, user_id) do update set n = avalanche_race_withdrawals.n + 1
    returning n into v_n;
  perform shards_credit(p_user, e.fee, 'avalanche race ' || p_race || ' withdrawal #' || v_n);
  delete from avalanche_race_entries where race_id = p_race and user_id = p_user;
  update avalanche_races set pot = pot - e.fee where id = p_race returning pot into v_n;
  return jsonb_build_object('ok', true, 'balance', shards_balance(p_user), 'pot', v_n);
end $$;

revoke all on function public.race_withdraw(text, uuid) from public, anon, authenticated;
grant execute on function public.race_withdraw(text, uuid) to service_role, authenticated; -- _race_guard decides
