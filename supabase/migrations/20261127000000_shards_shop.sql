-- Shards shop (DECISIONS 68): cosmetics bought with Shards, the site's real
-- currency, next to the snowflake riders and boards. Adds a third item type,
-- trails, and a Shards price on items.
--
-- buy_avalanche_item and select_avalanche_item keep their arguments, so the
-- page's existing calls cover the new items with no website change:
--   buy_avalanche_item('trail', 'aurora')     debit 100 Shards, own and wear it
--   select_avalanche_item('trail', 'none')    wear no trail
-- The profile now also returns trails, trail and the Shards balance.
--
-- Every debit goes through shards_debit with a ref of the item, so a retried
-- purchase can never charge twice.

alter table public.avalanche_items drop constraint avalanche_items_type_check;
alter table public.avalanche_items add constraint avalanche_items_type_check check (type in ('rider', 'board', 'trail'));
-- Shards price; null = not sold for Shards. Shards items have cost -1 (never for snowflakes).
alter table public.avalanche_items add column shards integer check (shards > 0);

-- Mirrors RIDERS, BOARDS and TRAILS in src/config.js (tests/catalog.mjs checks them).
insert into public.avalanche_items (type, id, cost, shards) values
  ('rider', 'galaxy', -1, 500),
  ('board', 'galaxy', -1, 250),
  ('trail', 'rainbow', -1, 100),
  ('trail', 'aurora', -1, 100),
  ('trail', 'ember', -1, 100),
  ('trail', 'stardust', -1, 100),
  ('trail', 'neon', -1, 100);

alter table public.avalanche_profiles add column trails text[] not null default '{}';
alter table public.avalanche_profiles add column trail text; -- null = no trail

create or replace function public._avalanche_profile_json(p public.avalanche_profiles)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
-- plpgsql, not sql: shards_balance is the site's wallet function, checked only when called.
begin
  return jsonb_build_object(
    'flakes', p.flakes,
    'riders', to_jsonb(p.riders),
    'boards', to_jsonb(p.boards),
    'trails', to_jsonb(p.trails),
    'rider', p.rider,
    'board', p.board,
    'trail', p.trail,
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
  if (p_type = 'rider' and p_id = any(p.riders)) or (p_type = 'board' and p_id = any(p.boards)) or (p_type = 'trail' and p_id = any(p.trails)) then
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
  else
    p := jsonb_populate_record(p, jsonb_build_object('trails', p.trails || p_id, 'trail', p_id));
  end if;
  update avalanche_profiles set flakes = p.flakes, riders = p.riders, boards = p.boards, trails = p.trails,
    rider = p.rider, board = p.board, trail = p.trail, updated_at = now()
  where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', _avalanche_profile_json(p));
end;
$$;

create or replace function public.select_avalanche_item(p_type text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  p avalanche_profiles;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  p := _avalanche_profile_for_update(v_uid);
  if p_type = 'rider' and p_id = any(p.riders) then
    p := jsonb_populate_record(p, jsonb_build_object('rider', p_id));
  elsif p_type = 'board' and p_id = any(p.boards) then
    p := jsonb_populate_record(p, jsonb_build_object('board', p_id));
  elsif p_type = 'trail' and p_id = 'none' then
    p := jsonb_populate_record(p, jsonb_build_object('trail', null));
  elsif p_type = 'trail' and p_id = any(p.trails) then
    p := jsonb_populate_record(p, jsonb_build_object('trail', p_id));
  else
    return jsonb_build_object('ok', false, 'reason', 'not owned', 'profile', _avalanche_profile_json(p));
  end if;
  update avalanche_profiles set rider = p.rider, board = p.board, trail = p.trail, updated_at = now() where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', _avalanche_profile_json(p));
end;
$$;
