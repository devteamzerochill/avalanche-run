-- No ads (DECISIONS 93, owner 2026-11-26): an account flag that turns off the
-- banner and the ads between runs in the phone apps. Optional reward videos stay.
-- Two ways to get it:
--   buy_avalanche_item('perk', 'no_ads')     debit 500 Shards, set the flag
--   avalanche_set_no_ads(user, true)          the site, after checking a $4.99
--                                             App Store / Google Play purchase
-- The profile now also returns no_ads.
--
-- Shard packs bought in the apps need nothing here: the site's purchase check
-- credits the wallet with shards_credit (docs/purchases.md).

alter table public.avalanche_items drop constraint avalanche_items_type_check;
alter table public.avalanche_items add constraint avalanche_items_type_check check (type in ('rider', 'board', 'trail', 'perk'));

-- Mirrors CONFIG.store.noAds in src/config.js (tests/catalog.mjs checks it).
insert into public.avalanche_items (type, id, cost, shards) values ('perk', 'no_ads', -1, 500);

alter table public.avalanche_profiles add column no_ads boolean not null default false;

create or replace function public._avalanche_profile_json(p public.avalanche_profiles)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
    'flakes', p.flakes,
    'riders', to_jsonb(p.riders),
    'boards', to_jsonb(p.boards),
    'trails', to_jsonb(p.trails),
    'rider', p.rider,
    'board', p.board,
    'trail', p.trail,
    'no_ads', p.no_ads,
    'shards', shards_balance(p.user_id),
    'streak', case when p.streak_day >= (now() at time zone 'utc')::date - 1 then p.streak else 0 end,
    'streak_today', coalesce(p.streak_day = (now() at time zone 'utc')::date, false),
    'missions', p.missions,
    'totals', jsonb_build_object('runs', p.runs, 'distance', p.distance, 'flakes', p.flakes_collected, 'nearMisses', p.near_misses),
    'best', p.best_score
  );
end;
$$;
revoke all on function public._avalanche_profile_json(public.avalanche_profiles) from public, anon, authenticated;

create or replace function public.buy_avalanche_item(p_type text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cost integer;
  v_shards integer;
  p avalanche_profiles;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select cost, shards into v_cost, v_shards from avalanche_items where type = p_type and id = p_id;
  if v_cost is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown item');
  end if;
  p := _avalanche_profile_for_update(v_uid);
  if (p_type = 'rider' and p_id = any(p.riders)) or (p_type = 'board' and p_id = any(p.boards)) or (p_type = 'trail' and p_id = any(p.trails))
    or (p_type = 'perk' and p_id = 'no_ads' and p.no_ads) then
    return jsonb_build_object('ok', false, 'reason', 'already owned', 'profile', _avalanche_profile_json(p));
  end if;
  if v_shards is not null then
    if not shards_debit(v_uid, v_shards, 'avalanche shop ' || p_type || ' ' || p_id) then
      return jsonb_build_object('ok', false, 'reason', 'not enough shards', 'profile', _avalanche_profile_json(p));
    end if;
  elsif v_cost < 0 then
    return jsonb_build_object('ok', false, 'reason', 'streak reward only', 'profile', _avalanche_profile_json(p));
  elsif p.flakes < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'not enough snowflakes', 'profile', _avalanche_profile_json(p));
  else
    p := jsonb_populate_record(p, jsonb_build_object('flakes', p.flakes - v_cost));
  end if;
  if p_type = 'rider' then
    p := jsonb_populate_record(p, jsonb_build_object('riders', p.riders || p_id, 'rider', p_id));
  elsif p_type = 'board' then
    p := jsonb_populate_record(p, jsonb_build_object('boards', p.boards || p_id, 'board', p_id));
  elsif p_type = 'trail' then
    p := jsonb_populate_record(p, jsonb_build_object('trails', p.trails || p_id, 'trail', p_id));
  else
    p := jsonb_populate_record(p, jsonb_build_object('no_ads', true));
  end if;
  update avalanche_profiles set flakes = p.flakes, riders = p.riders, boards = p.boards, trails = p.trails,
    rider = p.rider, board = p.board, trail = p.trail, no_ads = p.no_ads, updated_at = now()
  where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', _avalanche_profile_json(p));
end;
$$;

-- For the site's store purchase check (service role only): true after a verified
-- No ads purchase or restore, false after Apple or Google refund it.
create function public.avalanche_set_no_ads(p_user uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _avalanche_profile_for_update(p_user); -- makes the row if the player never played
  update avalanche_profiles set no_ads = p_on, updated_at = now() where user_id = p_user;
end;
$$;
revoke all on function public.avalanche_set_no_ads(uuid, boolean) from public, anon, authenticated;
grant execute on function public.avalanche_set_no_ads(uuid, boolean) to service_role;
