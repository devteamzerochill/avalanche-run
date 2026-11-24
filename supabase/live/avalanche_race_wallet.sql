-- LIVE ONLY: the four functions the race migration needs, on zerochill.com's
-- real Shards ledger (public.reward_entries) and profiles. Apply after
-- migrations/20261125000000_endurance_race.sql. Locally the stand-ins in
-- local-standins/shards_wallet.sql play this part; this file needs the live
-- tables and is never applied to the local stack.
--
-- How it uses the ledger, following the site's own _bramble_charge_shards:
-- - Spendable Shards are the sum of delta_available.
-- - Fees, prizes, house fees and refunds are ADJUST entries (negative to take,
--   positive to pay); the ledger's triggers keep every bucket non-negative and
--   tell the player when Shards arrive.
-- - Each movement has its own idempotency key ('avalanche_race:' + ref), so a
--   retry never charges or pays twice. The refs are unique per race, player
--   and kind (entry, prize, house fee, refund, voided refund).
-- - All callers are the race_* functions, inside one transaction with the
--   race tables, so a check-in or payout commits or rolls back as a whole.

create or replace function public.shards_balance(p_user uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta_available), 0)::integer from reward_entries where player_id = p_user;
$$;

-- Take p_amount, or return false and change nothing when too few are available.
create or replace function public.shards_debit(p_user uuid, p_amount integer, p_ref text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_key text := 'avalanche_race:' || p_ref;
  v_avail bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid amount'; end if;
  -- The same per-player lock the ledger's own checks take.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));
  if exists (select 1 from reward_entries where player_id = p_user and idempotency_key = v_key) then return true; end if;
  select coalesce(sum(delta_available), 0) into v_avail from reward_entries where player_id = p_user;
  if v_avail < p_amount then return false; end if;
  insert into reward_entries (player_id, type, amount, delta_pending, delta_available, delta_reserved, reason, source_id, idempotency_key, actor, at)
  values (p_user, 'ADJUST', -p_amount, 0, -p_amount, 0, p_ref, 'avalanche_run.race', v_key, 'avalanche_race', now());
  return true;
end $$;

-- Add p_amount as available Shards. Zero pays nothing (a tie can round a share to 0).
create or replace function public.shards_credit(p_user uuid, p_amount integer, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount is null or p_amount < 0 then raise exception 'invalid amount'; end if;
  if p_amount = 0 then return; end if;
  insert into reward_entries (player_id, type, amount, delta_pending, delta_available, delta_reserved, reason, source_id, idempotency_key, actor, at)
  values (p_user, 'ADJUST', p_amount, 0, p_amount, 0, p_ref, 'avalanche_run.race', 'avalanche_race:' || p_ref, 'avalanche_race', now())
  on conflict (player_id, idempotency_key) do nothing;
end $$;

-- The name other riders see: display_name, then username, as the site's boards.
create or replace function public.avalanche_player_name(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(display_name), ''), nullif(trim(username), ''), 'rider') from profiles where id = p_user;
$$;

revoke all on function public.shards_balance(uuid) from public, anon, authenticated;
revoke all on function public.shards_debit(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.shards_credit(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.avalanche_player_name(uuid) from public, anon, authenticated;
grant execute on function public.avalanche_player_name(uuid) to service_role;
