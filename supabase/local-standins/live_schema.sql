-- LOCAL ONLY. Do not apply to Lovable Cloud: these objects already exist live.
--
-- Stand-ins for the live zerochill.com pieces the new Avalanche Run APIs build
-- on, rebuilt from docs/api-handoff-2026-11-23.md (we don't have the real
-- source). They behave as the handoff documents; reward, tournament and
-- run-validation internals are stubbed. Loaded as seed data on `supabase db reset`,
-- after the real migrations in ../migrations.

-- Daily best per player (handoff section 7).
create table if not exists public.avalanche_run_daily_scores (
  user_id uuid not null references auth.users on delete cascade,
  date_key date not null,
  best_distance integer not null default 0,
  run_count integer not null default 0,
  primary key (user_id, date_key)
);
alter table public.avalanche_run_daily_scores enable row level security;
drop policy if exists "own daily rows" on public.avalanche_run_daily_scores;
create policy "own daily rows" on public.avalanche_run_daily_scores for select to authenticated using (auth.uid() = user_id);
grant select on public.avalanche_run_daily_scores to authenticated;

-- All-time best per player and game. The live column names are not in the
-- handoff; the new APIs do not read this table.
create table if not exists public.player_game_stats (
  user_id uuid not null references auth.users on delete cascade,
  game_id text not null,
  best_score integer not null default 0,
  primary key (user_id, game_id)
);

-- Idempotency keys for score submissions, scoped to (player, key).
create table if not exists public.standin_score_keys (
  user_id uuid not null,
  key text not null,
  distance integer not null,
  primary key (user_id, key)
);

-- Issued runs (zc_runs is internal live; only its effect matters here).
create table if not exists public.standin_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  game text not null,
  started_at timestamptz not null default now(),
  status text not null default 'open'
);

-- start_game_run(p_game text) returns uuid (handoff section 4).
create or replace function public.start_game_run(p_game text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_game is distinct from 'avalanche_run' then
    raise exception 'unknown game';
  end if;
  -- One open run per account across games: older open runs are replaced.
  update standin_runs set status = 'replaced' where user_id = v_uid and status = 'open';
  insert into standin_runs (user_id, game) values (v_uid, p_game) returning id into v_id;
  return v_id;
end;
$$;

-- submit_avalanche_score(p_distance, p_key, p_run_id) returns jsonb (handoff section 5).
create or replace function public.submit_avalanche_score(p_distance integer, p_key text default null, p_run_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text := nullif(p_key, '');
  v_day date := (now() at time zone 'utc')::date;
  v_stored integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if v_key is not null and (length(v_key) < 8 or length(v_key) > 128) then
    raise exception 'invalid idempotency key';
  end if;
  if p_distance is null or p_distance < 0 or p_distance > 1000000 then
    return jsonb_build_object('ok', false, 'rejected', true, 'reason', 'distance out of range', 'counted', false);
  end if;
  if v_key is not null then
    select distance into v_stored from standin_score_keys where user_id = v_uid and key = v_key;
    if found then
      return jsonb_build_object('ok', true, 'distance', v_stored, 'counted', true, 'duplicate', true,
        'xp_awarded', false, 'xp', 0, 'coins', 0, 'credits_pending', 0, 'xp_reason', 'duplicate', 'pop', null);
    end if;
    insert into standin_score_keys (user_id, key, distance) values (v_uid, v_key, p_distance);
  end if;
  insert into player_game_stats (user_id, game_id, best_score) values (v_uid, 'avalanche_run', p_distance)
    on conflict (user_id, game_id) do update set best_score = greatest(player_game_stats.best_score, excluded.best_score);
  insert into avalanche_run_daily_scores (user_id, date_key, best_distance, run_count) values (v_uid, v_day, p_distance, 1)
    on conflict (user_id, date_key) do update set best_distance = greatest(avalanche_run_daily_scores.best_distance, excluded.best_distance),
      run_count = avalanche_run_daily_scores.run_count + 1;
  -- Reward and tournament processing (track_play_event, _record_tournament_score) is stubbed.
  return jsonb_build_object('ok', true, 'distance', p_distance, 'counted', true, 'duplicate', false,
    'xp_awarded', false, 'xp', 0, 'coins', 0, 'credits_pending', 0, 'xp_reason', 'stand-in: rewards not simulated', 'pop', null);
end;
$$;

-- landing_board(p_game, p_limit) (handoff section 8), enough for the game's Ranks screen.
create or replace function public.landing_board(p_game text, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_limit integer := least(25, greatest(1, coalesce(p_limit, 10)));
  v_rows jsonb;
begin
  if p_game is distinct from 'avalanche_run' then
    return null;
  end if;
  with ranked as (
    select s.user_id, s.best_distance as score, row_number() over (order by s.best_distance desc) as rank,
      u.email
    from avalanche_run_daily_scores s join auth.users u on u.id = s.user_id
    where s.date_key = v_day and s.best_distance > 0
  )
  select jsonb_build_object(
    'game', 'avalanche_run', 'scope', 'daily', 'metric', 'score', 'lower_better', false, 'date_key', v_day,
    'players', (select count(*) from ranked),
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', rank, 'username', split_part(email, '@', 1), 'display_name', null, 'avatar_url', null, 'score', score) order by rank) from ranked where rank <= v_limit), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', rank, 'username', split_part(email, '@', 1), 'display_name', null, 'avatar_url', null, 'score', score) from ranked where user_id = auth.uid()),
    'record', (select jsonb_build_object('username', split_part(u.email, '@', 1), 'display_name', null, 'avatar_url', null, 'score', p.best_score)
               from player_game_stats p join auth.users u on u.id = p.user_id where p.game_id = 'avalanche_run' order by p.best_score desc limit 1)
  ) into v_rows;
  return v_rows;
end;
$$;

-- daily_pop_bars() (handoff section 9): one fixed Avalanche entry is enough locally.
create or replace function public.daily_pop_bars(p_date date default null)
returns jsonb
language sql
stable
as $$
  select jsonb_build_array(jsonb_build_object('game_id', 'avalanche_run', 'metric', 'score', 'threshold', 412, 'label', 'Run 412m',
    'cleared', false, 'xp_today', 0, 'daily_max_xp', 45, 'exhausted', false, 'xp_blocked_by_cap', false));
$$;

revoke all on function public.start_game_run(text) from public, anon;
revoke all on function public.submit_avalanche_score(integer, text, text) from public, anon;
grant execute on function public.start_game_run(text) to authenticated;
grant execute on function public.submit_avalanche_score(integer, text, text) to authenticated;
grant execute on function public.landing_board(text, integer) to anon, authenticated;
grant execute on function public.daily_pop_bars(date) to anon, authenticated;
