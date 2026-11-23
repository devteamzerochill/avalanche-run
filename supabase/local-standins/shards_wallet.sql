-- LOCAL ONLY. A stand-in for the zerochill.com Shards wallet, which is not in
-- the API handoff. The race migration calls these four functions; on the
-- live site Lovable maps them onto the real wallet and profiles.
--
-- Stand-in behaviour: a player's first wallet starts with 100 test Shards.

create table if not exists public.standin_shards (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 100 check (balance >= 0)
);
alter table public.standin_shards enable row level security;

create table if not exists public.standin_shards_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  amount integer not null, -- negative: spent
  ref text not null,
  at timestamptz not null default now()
);
alter table public.standin_shards_log enable row level security;

create or replace function public.shards_balance(p_user uuid)
returns integer language sql security definer set search_path = public as $$
  select coalesce((select balance from standin_shards where user_id = p_user), 100);
$$;

-- Take p_amount from the player. False when the balance is too low.
create or replace function public.shards_debit(p_user uuid, p_amount integer, p_ref text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into standin_shards (user_id) values (p_user) on conflict do nothing;
  update standin_shards set balance = balance - p_amount where user_id = p_user and balance >= p_amount;
  if not found then return false; end if;
  insert into standin_shards_log (user_id, amount, ref) values (p_user, -p_amount, p_ref);
  return true;
end $$;

create or replace function public.shards_credit(p_user uuid, p_amount integer, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into standin_shards (user_id) values (p_user) on conflict do nothing;
  update standin_shards set balance = balance + p_amount where user_id = p_user;
  insert into standin_shards_log (user_id, amount, ref) values (p_user, p_amount, p_ref);
end $$;

-- The name other players see. Locally: the sign-up display name, else the
-- email prefix. On the live site Lovable returns the profile's display_name,
-- then username, as the site's leaderboards do.
create or replace function public.avalanche_player_name(p_user uuid)
returns text language sql security definer set search_path = public as $$
  select coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), nullif(trim(u.raw_user_meta_data->>'full_name'), ''), nullif(trim(u.raw_user_meta_data->>'name'), ''), nullif(trim(u.raw_user_meta_data->>'username'), ''), split_part(u.email, '@', 1))
  from auth.users u where u.id = p_user;
$$;

revoke all on function public.shards_balance(uuid) from public, anon, authenticated;
revoke all on function public.shards_debit(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.shards_credit(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.avalanche_player_name(uuid) from public, anon, authenticated;
grant execute on function public.avalanche_player_name(uuid) to service_role; -- the race server reads names
