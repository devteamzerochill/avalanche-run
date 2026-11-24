-- Solo scores checked by replay (owner, 2026-11-25; DECISIONS 72). The game
-- sends each finished run's inputs to the race server (Colyseus Cloud), which
-- re-simulates them with src/core and records the result here. Only the race
-- server account (or the service role) may record a check (_race_guard).
--
-- While avalanche_run_check_config.enforce is false (the default) checks are
-- only recorded. Once it is true, submit_avalanche_run counts a score only if a
-- passing check with that exact score exists for the player and key. Turn it on
-- when the new game replaces the old one on zerochill.com, together with
-- closing direct calls to submit_avalanche_score (the old game uses them).

create table public.avalanche_run_checks (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  score integer not null,
  metres integer not null,
  seed bigint not null,
  ok boolean not null,
  reason text,          -- why it failed: seed, version, replay, score, metres
  scripted boolean not null default false, -- follows the game's own bot (recorded, not blocking)
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.avalanche_run_checks enable row level security;
revoke all on table public.avalanche_run_checks from public, anon, authenticated;

create table public.avalanche_run_check_config (
  id integer primary key check (id = 1),
  enforce boolean not null default false
);
-- No row is seeded (Lovable's migration tool takes no data changes; live as
-- 0318): a missing row means not enforced. Enforce with an upsert of (1, true).
alter table public.avalanche_run_check_config enable row level security;
revoke all on table public.avalanche_run_check_config from public, anon, authenticated;

-- The race server records one check per run; the first one stands, so a second
-- request with other inputs can't replace a failed check.
create function public.avalanche_run_check(p_user uuid, p_key text, p_score integer, p_metres integer, p_seed bigint, p_ok boolean, p_reason text, p_scripted boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c avalanche_run_checks;
begin
  perform _race_guard();
  if p_user is null or coalesce(p_key, '') = '' or length(p_key) > 128 then
    raise exception 'bad run check' using errcode = '22023';
  end if;
  insert into avalanche_run_checks (user_id, key, score, metres, seed, ok, reason, scripted)
  values (p_user, p_key, p_score, p_metres, p_seed, p_ok, nullif(p_reason, ''), coalesce(p_scripted, false))
  on conflict (user_id, key) do nothing;
  select * into c from avalanche_run_checks where user_id = p_user and key = p_key;
  return jsonb_build_object('ok', c.ok, 'score', c.score, 'reason', c.reason, 'enforce', (select enforce from avalanche_run_check_config where id = 1));
end $$;
revoke all on function public.avalanche_run_check(uuid, text, integer, integer, bigint, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.avalanche_run_check(uuid, text, integer, integer, bigint, boolean, text, boolean) to service_role, authenticated; -- _race_guard decides

-- submit_avalanche_run as live today, plus the check at the start.
create or replace function public.submit_avalanche_run(p_distance integer, p_key text default null, p_run_id text default null, p_stats jsonb default '{}'::jsonb)
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
  -- Scores checked by replay (DECISIONS 72): once enforced, only a run the race
  -- server replayed to exactly this score counts.
  if v_uid is not null and coalesce((select enforce from avalanche_run_check_config where id = 1), false)
     and not exists (select 1 from avalanche_run_checks c where c.user_id = v_uid and c.key = v_key and c.ok and c.score = p_distance) then
    return jsonb_build_object('counted', false, 'rejected', true, 'reason', 'unverified');
  end if;

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
