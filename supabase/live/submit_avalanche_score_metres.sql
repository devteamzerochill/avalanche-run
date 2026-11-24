-- LIVE ONLY (applied through Lovable, DECISIONS 65): submit_avalanche_score
-- takes the metres ridden apart from the score. Once trick points count, the
-- score is more than the metres, but the Daily Reward bar ("Run {v}m") and the
-- run check measure metres. Callers that send no p_metres (the old game) behave
-- exactly as before: metres = score.
--
-- The body is the live function as of 2026-11-24 with three changes, marked
-- "metres": the new argument, check_run measured on metres (with the score as
-- p_score), and the Daily Reward bar fed metres. Grants are restored as they were.

drop function public.submit_avalanche_score(integer, text, text);

create function public.submit_avalanche_score(p_distance integer, p_key text default null, p_run_id text default null, p_metres integer default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_uid uuid := auth.uid();
  v_dist int;
  v_metres int; -- metres: what the bar and the run check measure
  v_first boolean := false;
  v_dup boolean := false;
  v_prev_counted boolean := false;
  v_key text := nullif(p_key, '');
  v_day text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  v_xp jsonb;
  v_allowed boolean := true;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.player_flags where player_id = v_uid and banned) then
    raise exception 'account suspended';
  end if;
  if p_distance is null or p_distance < 0 or p_distance > 1000000 then
    -- Log the rejection so it survives (no exception = no rollback); nothing is counted or granted.
    insert into public.score_submission_rejections (player_id, game_id, idempotency_key, run_id, claimed_score, duration_ms, reason)
    values (v_uid, 'avalanche_run', left(nullif(p_key, ''), 128), left(nullif(btrim(p_run_id), ''), 64), p_distance,
      (select least(extract(epoch from now() - k.started_at) * 1000, 2147483647)::int from zc_runs.run_keys k
        where p_run_id ~* '^[0-9a-f-]{36}$' and k.run_id = btrim(p_run_id)::uuid and k.player_id = v_uid),
      case when p_distance is null then 'distance_missing' when p_distance < 0 then 'distance_negative' else 'distance_over_ceiling' end);
    return jsonb_build_object('ok', false, 'rejected', true, 'reason', 'distance out of range', 'counted', false);
  end if;
  v_dist := p_distance;
  -- metres: never more than the score (score = metres + bonuses + trick points).
  v_metres := least(greatest(coalesce(p_metres, p_distance), 0), p_distance);
  if v_key is not null then
    if length(v_key) < 8 or length(v_key) > 128 then raise exception 'bad idempotency key'; end if;
    insert into public.avalanche_run_keys (player_id, idempotency_key, distance) values (v_uid, v_key, v_dist)
    on conflict (player_id, idempotency_key) do nothing;
    v_first := found;
    if not v_first then
      v_dup := true;
      select coalesce(k.counted, false), coalesce(k.distance, v_dist) into v_prev_counted, v_dist
      from public.avalanche_run_keys k where k.player_id = v_uid and k.idempotency_key = v_key;
    end if;
  else
    v_first := true;
  end if;
  -- RUN KEYS: the server checks this claim against its run key (observe mode never blocks).
  -- A retry of the same key counts only if its first submit was allowed to count.
  if v_first then
    v_allowed := zc_runs.check_run(p_run_id, 'avalanche_run', v_key, v_metres, v_dist); -- metres
  else
    v_allowed := not zc_runs.key_blocked('avalanche_run', v_key);
  end if;
  if v_allowed then
    insert into public.player_game_stats (player_id, game_id, best_score, games_played) values (v_uid, 'avalanche_run', v_dist, 0)
    on conflict (player_id, game_id) do update set best_score = greatest(public.player_game_stats.best_score, excluded.best_score), updated_at = now();
  end if;
  if v_first and v_allowed then
    -- Per-day best, same gate as the all-time write so retries never double-count.
    insert into public.avalanche_run_daily_scores (user_id, date_key, best_distance, run_count) values (v_uid, v_day, v_dist, 1)
    on conflict (user_id, date_key) do update set best_distance = greatest(public.avalanche_run_daily_scores.best_distance, excluded.best_distance),
      run_count = public.avalanche_run_daily_scores.run_count + 1, updated_at = now();
    -- POP BAR: distance in metres is the run metric. (metres)
    v_xp := public.track_play_event('avalanche_run', 'avalanche_run.daily_run', v_key, v_metres);
    if v_dist > 0 then perform public._record_tournament_score(v_uid, 'avalanche_run', v_dist::bigint, true); end if;
    if v_key is not null then
      update public.avalanche_run_keys set counted = true, distance = v_dist where player_id = v_uid and idempotency_key = v_key;
    end if;
    v_prev_counted := true;
  end if;
  return jsonb_build_object(
    'ok', true, 'distance', v_dist, 'counted', v_prev_counted, 'duplicate', v_dup,
    'xp_awarded', coalesce((v_xp->>'granted')::boolean, false),
    'xp', coalesce((v_xp->>'xp')::int, 0),
    'coins', coalesce((v_xp->>'coins')::int, 0),
    'credits_pending', coalesce((v_xp->>'credits_pending')::int, 0),
    'xp_reason', v_xp->>'reason',
    'pop', v_xp->'pop'
  );
end $function$;

revoke all on function public.submit_avalanche_score(integer, text, text, integer) from public, anon;
grant execute on function public.submit_avalanche_score(integer, text, text, integer) to authenticated, service_role;
