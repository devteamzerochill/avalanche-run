-- Avalanche Run: server-side player profile (slice 1).
--
-- Adds new objects only. It does not alter any existing table, function or
-- policy: submit_avalanche_run calls the existing submit_avalanche_score as is,
-- then applies the game's own progression on top.
--
--   get_avalanche_profile()                         snowflakes, unlocks, skin, missions, streak, totals, best
--   submit_avalanche_run(p_distance, p_key, p_run_id, p_stats)
--                                                   the score path plus snowflakes, missions, streak, totals
--   buy_avalanche_item(p_type, p_id)                spend snowflakes on a rider or board
--   select_avalanche_item(p_type, p_id)             wear an owned rider or board
--
-- Snowflakes are an Avalanche Run currency only; site XP, coins and credits
-- keep coming from submit_avalanche_score unchanged. Riders and boards are
-- cosmetic, so they never affect the leaderboard.

-- ---------------------------------------------------------------------------
-- Catalogue: mirrors the game's src/config.js (RIDERS, BOARDS, MISSIONS,
-- CONFIG.meta.streakRewards). tests/catalog.mjs checks the two match.

create table public.avalanche_items (
  type text not null check (type in ('rider', 'board')),
  id text not null,
  cost integer not null, -- snowflakes; -1 = streak reward only, never for sale
  primary key (type, id)
);

create table public.avalanche_missions (
  id text primary key,
  ord integer not null unique, -- missions are handed out in this order, cycling
  stat text not null check (stat in ('distance', 'nearMisses', 'flakes', 'cleanJumps', 'tricks', 'bestCombo', 'perfects', 'topKmh', 'trickScore')),
  goal integer not null check (goal > 0),
  reward integer not null check (reward >= 0),
  total boolean not null default false -- true: progress adds up over runs; false: best single run
);

create table public.avalanche_streak_rewards (
  day integer primary key,
  flakes integer not null default 0,
  rider text,
  board text
);

insert into public.avalanche_items (type, id, cost) values
  ('rider', 'nova', 0), ('rider', 'pine', 150), ('rider', 'blush', 300), ('rider', 'frost', 500), ('rider', 'yeti', -1),
  ('board', 'classic', 0), ('board', 'sunrise', 100), ('board', 'mint', 200), ('board', 'ember', -1), ('board', 'aurora', 400);

insert into public.avalanche_missions (id, ord, stat, goal, reward, total) values
  ('dist1', 1, 'distance', 800, 30, false),
  ('near1', 2, 'nearMisses', 5, 30, false),
  ('flake1', 3, 'flakes', 40, 30, true),
  ('clean1', 4, 'cleanJumps', 6, 40, false),
  ('trick1', 5, 'tricks', 3, 40, false),
  ('dist2', 6, 'distance', 1500, 60, false),
  ('combo1', 7, 'bestCombo', 4, 50, false),
  ('perfect1', 8, 'perfects', 2, 60, false),
  ('glacier', 9, 'distance', 1200, 50, false),
  ('speed1', 10, 'topKmh', 170, 50, false),
  ('near2', 11, 'nearMisses', 40, 80, true),
  ('storm', 12, 'distance', 2600, 120, false),
  ('trick2', 13, 'trickScore', 300, 80, false),
  ('dist3', 14, 'distance', 4000, 200, false);

insert into public.avalanche_streak_rewards (day, flakes, rider, board) values
  (2, 40, null, null),
  (3, 0, null, 'ember'),
  (5, 120, null, null),
  (7, 0, 'yeti', null);

-- ---------------------------------------------------------------------------
-- Player state.

create table public.avalanche_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  flakes integer not null default 0 check (flakes >= 0),
  riders text[] not null default array['nova'],
  boards text[] not null default array['classic'],
  rider text not null default 'nova',
  board text not null default 'classic',
  streak integer not null default 0,
  streak_day date, -- UTC day of the last run that advanced the streak
  missions jsonb not null default '[]'::jsonb, -- [{id, progress, done}], three active
  mission_next integer not null default 0,
  runs integer not null default 0,
  distance bigint not null default 0,
  flakes_collected bigint not null default 0,
  near_misses bigint not null default 0,
  best_score integer not null default 0, -- best score submitted through submit_avalanche_run
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per counted attempt, so a retried submission never pays twice.
create table public.avalanche_run_extras (
  user_id uuid not null references auth.users on delete cascade,
  key text not null,
  stats jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.avalanche_items enable row level security;
alter table public.avalanche_missions enable row level security;
alter table public.avalanche_streak_rewards enable row level security;
alter table public.avalanche_profiles enable row level security;
alter table public.avalanche_run_extras enable row level security;

-- The catalogue is public; player rows are read through the functions below
-- (or directly, own row only). All writes go through the functions.
create policy "catalogue is public" on public.avalanche_items for select using (true);
create policy "catalogue is public" on public.avalanche_missions for select using (true);
create policy "catalogue is public" on public.avalanche_streak_rewards for select using (true);
create policy "own profile" on public.avalanche_profiles for select to authenticated using (auth.uid() = user_id);
create policy "own run extras" on public.avalanche_run_extras for select to authenticated using (auth.uid() = user_id);
grant select on public.avalanche_items, public.avalanche_missions, public.avalanche_streak_rewards to anon, authenticated;
grant select on public.avalanche_profiles, public.avalanche_run_extras to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients).
--
-- Profile rows are changed with p := jsonb_populate_record(p, ...) rather than
-- p.field := ...: Lovable's migration checker rejects field assignment on a
-- row variable, although PostgreSQL accepts it.

-- Replace finished missions and top up to three, in catalogue order, skipping
-- any already active. Mirrors refillMissions() in src/systems/meta.js.
create function public._avalanche_refill_missions(p public.avalanche_profiles)
returns public.avalanche_profiles
language plpgsql
set search_path = public
as $$
declare
  v_defs text[];
  v_n integer;
  v_out jsonb := '[]'::jsonb;
  v_active text[];
  v_item jsonb;
  v_id text;
  v_guard integer;
begin
  select array_agg(id order by ord) into v_defs from avalanche_missions;
  v_n := coalesce(array_length(v_defs, 1), 0);
  if v_n = 0 then
    return p;
  end if;
  select coalesce(array_agg(m->>'id'), '{}') into v_active from jsonb_array_elements(p.missions) m where not coalesce((m->>'done')::boolean, false);
  for v_item in select value from jsonb_array_elements(p.missions) loop
    if coalesce((v_item->>'done')::boolean, false) then
      v_guard := v_n;
      v_id := v_defs[(p.mission_next % v_n) + 1];
      while v_guard > 0 and v_id = any(v_active) loop
        p := jsonb_populate_record(p, jsonb_build_object('mission_next', p.mission_next + 1));
        v_id := v_defs[(p.mission_next % v_n) + 1];
        v_guard := v_guard - 1;
      end loop;
      v_out := v_out || jsonb_build_object('id', v_id, 'progress', 0, 'done', false);
      v_active := v_active || v_id;
      p := jsonb_populate_record(p, jsonb_build_object('mission_next', p.mission_next + 1));
    else
      v_out := v_out || v_item;
    end if;
  end loop;
  while jsonb_array_length(v_out) < 3 loop
    v_guard := v_n;
    v_id := v_defs[(p.mission_next % v_n) + 1];
    while v_guard > 0 and v_id = any(v_active) loop
      p := jsonb_populate_record(p, jsonb_build_object('mission_next', p.mission_next + 1));
      v_id := v_defs[(p.mission_next % v_n) + 1];
      v_guard := v_guard - 1;
    end loop;
    v_out := v_out || jsonb_build_object('id', v_id, 'progress', 0, 'done', false);
    v_active := v_active || v_id;
    p := jsonb_populate_record(p, jsonb_build_object('mission_next', p.mission_next + 1));
  end loop;
  p := jsonb_populate_record(p, jsonb_build_object('missions', v_out));
  return p;
end;
$$;

-- The caller's profile, created with defaults on first use, locked for update.
create function public._avalanche_profile_for_update(p_uid uuid)
returns public.avalanche_profiles
language plpgsql
set search_path = public
as $$
declare
  p avalanche_profiles;
begin
  insert into avalanche_profiles (user_id) values (p_uid) on conflict (user_id) do nothing;
  select * into p from avalanche_profiles where user_id = p_uid for update;
  if jsonb_array_length(p.missions) < 3 then
    p := _avalanche_refill_missions(p);
    update avalanche_profiles set missions = p.missions, mission_next = p.mission_next where user_id = p_uid;
  end if;
  return p;
end;
$$;

-- What the game shows. A streak older than yesterday has lapsed.
create function public._avalanche_profile_json(p public.avalanche_profiles)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'flakes', p.flakes,
    'riders', to_jsonb(p.riders),
    'boards', to_jsonb(p.boards),
    'rider', p.rider,
    'board', p.board,
    'streak', case when p.streak_day >= (now() at time zone 'utc')::date - 1 then p.streak else 0 end,
    'streak_today', coalesce(p.streak_day = (now() at time zone 'utc')::date, false),
    'missions', p.missions,
    'totals', jsonb_build_object('runs', p.runs, 'distance', p.distance, 'flakes', p.flakes_collected, 'nearMisses', p.near_misses),
    'best', p.best_score
  );
$$;

revoke all on function public._avalanche_refill_missions(public.avalanche_profiles) from public, anon, authenticated;
revoke all on function public._avalanche_profile_for_update(uuid) from public, anon, authenticated;
revoke all on function public._avalanche_profile_json(public.avalanche_profiles) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client functions.

create function public.get_avalanche_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  return _avalanche_profile_json(_avalanche_profile_for_update(v_uid));
end;
$$;

-- The score goes through the existing submit_avalanche_score unchanged; its
-- full response is returned with an "avalanche" object added. Progression is
-- applied only to a counted, first-seen key, and a failure there never undoes
-- the score: it is reported as avalanche.error instead.
--
-- p_stats is the game's run summary: distance (whole metres), flakes,
-- nearMisses, bestCombo, cleanJumps, tricks, perfects, trickScore, topKmh.
-- Values are client-reported, so each is clamped to what the run could
-- plausibly produce. Proof of Play (a later slice) replaces the clamps.
create function public.submit_avalanche_run(p_distance integer, p_key text default null, p_run_id text default null, p_stats jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text := nullif(p_key, '');
  v_today date := (now() at time zone 'utc')::date;
  v_res jsonb;
  v_prev jsonb;
  p avalanche_profiles;
  s jsonb;
  v_dist integer;
  v_val integer;
  v_m jsonb;
  v_missions jsonb := '[]'::jsonb;
  v_def avalanche_missions;
  v_mission_flakes integer := 0;
  v_completed text[] := '{}';
  v_streak jsonb := null;
  v_sr avalanche_streak_rewards;
  v_last_day integer;
  v_extra jsonb;
begin
  -- The metres ridden (p_stats.distance) feed the Daily Reward bar and the run check (DECISIONS 65).
  v_res := submit_avalanche_score(p_distance, p_key, p_run_id,
    case when jsonb_typeof(p_stats->'distance') = 'number' then floor((p_stats->>'distance')::numeric)::integer end);
  if v_uid is null or not coalesce((v_res->>'counted')::boolean, false) or v_key is null then
    return v_res;
  end if;

  select result into v_prev from avalanche_run_extras where user_id = v_uid and key = v_key;
  if found then
    return v_res || jsonb_build_object('avalanche', v_prev || jsonb_build_object('duplicate', true));
  end if;

  begin
    v_dist := least(greatest(coalesce((p_stats->>'distance')::integer, 0), 0), p_distance);
    s := jsonb_build_object(
      'distance', v_dist,
      'flakes', least(greatest(coalesce((p_stats->>'flakes')::integer, 0), 0), v_dist / 8 + 20),
      'nearMisses', least(greatest(coalesce((p_stats->>'nearMisses')::integer, 0), 0), v_dist / 10 + 5),
      'bestCombo', least(greatest(coalesce((p_stats->>'bestCombo')::integer, 0), 0), 5),
      'cleanJumps', least(greatest(coalesce((p_stats->>'cleanJumps')::integer, 0), 0), v_dist / 25 + 5),
      'tricks', least(greatest(coalesce((p_stats->>'tricks')::integer, 0), 0), v_dist / 25 + 5),
      'topKmh', least(greatest(coalesce((p_stats->>'topKmh')::integer, 0), 0), 300)
    );
    s := s || jsonb_build_object(
      'perfects', least(greatest(coalesce((p_stats->>'perfects')::integer, 0), 0), (s->>'tricks')::integer),
      'trickScore', least(greatest(coalesce((p_stats->>'trickScore')::integer, 0), 0), (s->>'tricks')::integer * 400 + (s->>'cleanJumps')::integer * 50 + v_dist / 10)
    );

    p := _avalanche_profile_for_update(v_uid);
    -- Missions finished last run are replaced before this run counts, as in the game.
    p := _avalanche_refill_missions(p);

    -- Daily streak: the first counted run of each UTC day advances it.
    if p.streak_day is distinct from v_today then
      p := jsonb_populate_record(p, jsonb_build_object(
        'streak', case when p.streak_day = v_today - 1 then p.streak + 1 else 1 end,
        'streak_day', v_today));
      select * into v_sr from avalanche_streak_rewards where day = p.streak;
      select max(day) into v_last_day from avalanche_streak_rewards;
      v_streak := jsonb_build_object('day', p.streak, 'flakes', 0, 'rider', null, 'board', null);
      if v_sr.day is not null then
        p := jsonb_populate_record(p, jsonb_build_object('flakes', p.flakes + v_sr.flakes));
        v_streak := v_streak || jsonb_build_object('flakes', v_sr.flakes);
        if v_sr.rider is not null and not v_sr.rider = any(p.riders) then
          p := jsonb_populate_record(p, jsonb_build_object('riders', p.riders || v_sr.rider));
          v_streak := v_streak || jsonb_build_object('rider', v_sr.rider);
        end if;
        if v_sr.board is not null and not v_sr.board = any(p.boards) then
          p := jsonb_populate_record(p, jsonb_build_object('boards', p.boards || v_sr.board));
          v_streak := v_streak || jsonb_build_object('board', v_sr.board);
        end if;
      elsif v_last_day is not null and p.streak > v_last_day then
        p := jsonb_populate_record(p, jsonb_build_object('flakes', p.flakes + 60)); -- every day after the last listed reward (CONFIG.meta.streakDailyFlakes)
        v_streak := v_streak || jsonb_build_object('flakes', 60);
      end if;
    end if;

    -- Missions: best single run, or a running total.
    for v_m in select value from jsonb_array_elements(p.missions) loop
      if not coalesce((v_m->>'done')::boolean, false) then
        select * into v_def from avalanche_missions where id = v_m->>'id';
        if v_def.id is not null then
          v_val := coalesce((s->>v_def.stat)::integer, 0);
          v_m := v_m || jsonb_build_object('progress', least(v_def.goal,
            case when v_def.total then coalesce((v_m->>'progress')::integer, 0) + v_val else greatest(coalesce((v_m->>'progress')::integer, 0), v_val) end));
          if (v_m->>'progress')::integer >= v_def.goal then
            v_m := v_m || jsonb_build_object('done', true);
            v_mission_flakes := v_mission_flakes + v_def.reward;
            v_completed := v_completed || v_def.id;
          end if;
        end if;
      end if;
      v_missions := v_missions || v_m;
    end loop;
    p := jsonb_populate_record(p, jsonb_build_object(
      'missions', v_missions,
      'flakes', p.flakes + (s->>'flakes')::integer + v_mission_flakes,
      'runs', p.runs + 1,
      'distance', p.distance + v_dist,
      'flakes_collected', p.flakes_collected + (s->>'flakes')::integer,
      'near_misses', p.near_misses + (s->>'nearMisses')::integer,
      'best_score', greatest(p.best_score, p_distance)));

    update avalanche_profiles set
      flakes = p.flakes, riders = p.riders, boards = p.boards, streak = p.streak, streak_day = p.streak_day,
      missions = p.missions, mission_next = p.mission_next, runs = p.runs, distance = p.distance,
      flakes_collected = p.flakes_collected, near_misses = p.near_misses, best_score = p.best_score, updated_at = now()
    where user_id = v_uid;

    v_extra := jsonb_build_object(
      'flakes_earned', (s->>'flakes')::integer,
      'mission_flakes', v_mission_flakes,
      'completed', to_jsonb(v_completed),
      'streak_reward', v_streak,
      'new_best', p.best_score = p_distance,
      'profile', _avalanche_profile_json(p)
    );
    insert into avalanche_run_extras (user_id, key, stats, result) values (v_uid, v_key, s, v_extra);
    return v_res || jsonb_build_object('avalanche', v_extra);
  exception when others then
    -- Keep the counted score; report the progression failure.
    return v_res || jsonb_build_object('avalanche', jsonb_build_object('error', sqlerrm));
  end;
end;
$$;

create function public.buy_avalanche_item(p_type text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cost integer;
  p avalanche_profiles;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select cost into v_cost from avalanche_items where type = p_type and id = p_id;
  if v_cost is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown item');
  end if;
  p := _avalanche_profile_for_update(v_uid);
  if (p_type = 'rider' and p_id = any(p.riders)) or (p_type = 'board' and p_id = any(p.boards)) then
    return jsonb_build_object('ok', false, 'reason', 'already owned', 'profile', _avalanche_profile_json(p));
  end if;
  if v_cost < 0 then
    return jsonb_build_object('ok', false, 'reason', 'streak reward only', 'profile', _avalanche_profile_json(p));
  end if;
  if p.flakes < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'not enough snowflakes', 'profile', _avalanche_profile_json(p));
  end if;
  p := jsonb_populate_record(p, jsonb_build_object('flakes', p.flakes - v_cost));
  if p_type = 'rider' then
    p := jsonb_populate_record(p, jsonb_build_object('riders', p.riders || p_id, 'rider', p_id));
  else
    p := jsonb_populate_record(p, jsonb_build_object('boards', p.boards || p_id, 'board', p_id));
  end if;
  update avalanche_profiles set flakes = p.flakes, riders = p.riders, boards = p.boards, rider = p.rider, board = p.board, updated_at = now()
  where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', _avalanche_profile_json(p));
end;
$$;

create function public.select_avalanche_item(p_type text, p_id text)
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
  else
    return jsonb_build_object('ok', false, 'reason', 'not owned', 'profile', _avalanche_profile_json(p));
  end if;
  update avalanche_profiles set rider = p.rider, board = p.board, updated_at = now() where user_id = v_uid;
  return jsonb_build_object('ok', true, 'profile', _avalanche_profile_json(p));
end;
$$;

revoke all on function public.get_avalanche_profile() from public, anon;
revoke all on function public.submit_avalanche_run(integer, text, text, jsonb) from public, anon;
revoke all on function public.buy_avalanche_item(text, text) from public, anon;
revoke all on function public.select_avalanche_item(text, text) from public, anon;
grant execute on function public.get_avalanche_profile() to authenticated;
grant execute on function public.submit_avalanche_run(integer, text, text, jsonb) to authenticated;
grant execute on function public.buy_avalanche_item(text, text) to authenticated;
grant execute on function public.select_avalanche_item(text, text) to authenticated;
