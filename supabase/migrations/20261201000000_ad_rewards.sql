-- Rewarded video crediting (ads slice 2, DECISIONS 86, docs/ads.md).
--
-- Before a rewarded video the app asks for a one-use ticket for what the video
-- pays (today: doubling a counted run's snowflakes). The ticket id goes to
-- LevelPlay as the user id. LevelPlay's server-to-server callback reaches the
-- website route /api/public/levelplay-reward (locally, the levelplay-reward
-- edge function), which checks the signature and calls
-- avalanche_ad_reward_callback as the service role. Only that call credits.
-- The amount is ours (the run's own snowflakes), never LevelPlay's [REWARDS],
-- which is tied to ad revenue.
--
-- Only new objects; nothing existing is changed. Live as migration 0320 (2026-11-26).

create table public.avalanche_ad_rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null, -- no auth.users link: the live project's rule for new tables
  kind text not null check (kind in ('double')),
  run_key text not null,
  flakes integer not null check (flakes > 0),
  status text not null default 'pending' check (status in ('pending', 'credited')),
  event_id text unique,
  caller_ip text,
  created_at timestamptz not null default now(),
  credited_at timestamptz,
  unique (user_id, kind, run_key)
);

alter table public.avalanche_ad_rewards enable row level security;
create policy "own ad rewards" on public.avalanche_ad_rewards for select to authenticated using (auth.uid() = user_id);
grant select on public.avalanche_ad_rewards to authenticated;
grant all on public.avalanche_ad_rewards to service_role;

-- The ticket for doubling one counted run. Asking again for the same run
-- returns the same ticket, so a retried request never makes a second one.
create function public.start_avalanche_ad_reward(p_kind text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_flakes integer;
  t avalanche_ad_rewards;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_kind is distinct from 'double' then
    return jsonb_build_object('ok', false, 'reason', 'unknown kind');
  end if;
  select coalesce((result->>'flakes_earned')::integer, 0) into v_flakes
  from avalanche_run_extras where user_id = v_uid and key = p_key;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown run');
  end if;
  if v_flakes <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no snowflakes');
  end if;
  insert into avalanche_ad_rewards (user_id, kind, run_key, flakes) values (v_uid, p_kind, p_key, v_flakes)
  on conflict (user_id, kind, run_key) do nothing;
  select * into t from avalanche_ad_rewards where user_id = v_uid and kind = p_kind and run_key = p_key;
  if t.status = 'credited' then
    return jsonb_build_object('ok', false, 'reason', 'already credited');
  end if;
  return jsonb_build_object('ok', true, 'ticket', t.id, 'flakes', t.flakes);
end;
$$;

-- A ticket's state, with the profile once it has paid, so the game can update
-- the balance without another call.
create function public.get_avalanche_ad_reward(p_ticket uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  t avalanche_ad_rewards;
  p avalanche_profiles;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  select * into t from avalanche_ad_rewards where id = p_ticket and user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown ticket');
  end if;
  if t.status <> 'credited' then
    return jsonb_build_object('ok', true, 'status', t.status, 'flakes', t.flakes);
  end if;
  select * into p from avalanche_profiles where user_id = v_uid;
  return jsonb_build_object('ok', true, 'status', t.status, 'flakes', t.flakes, 'profile', _avalanche_profile_json(p));
end;
$$;

-- Called only by the levelplay-reward route after it has checked the
-- callback's signature. Every outcome but an error is final, so the function
-- answers LevelPlay "<eventId>:OK" and the retries stop.
create function public.avalanche_ad_reward_callback(p_ticket text, p_event_id text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  t avalanche_ad_rewards;
  p avalanche_profiles;
begin
  if coalesce(p_event_id, '') = '' or length(p_event_id) > 128 then
    raise exception 'missing event id';
  end if;
  -- LevelPlay retries an event until it is acknowledged.
  if exists (select 1 from avalanche_ad_rewards where event_id = p_event_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  begin
    v_id := p_ticket::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'unknown ticket');
  end;
  select * into t from avalanche_ad_rewards where id = v_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown ticket');
  end if;
  -- A second video on the same ticket pays nothing.
  if t.status = 'credited' then
    return jsonb_build_object('status', 'already credited');
  end if;
  update avalanche_ad_rewards set status = 'credited', event_id = p_event_id, caller_ip = nullif(p_ip, ''), credited_at = now() where id = t.id;
  p := _avalanche_profile_for_update(t.user_id);
  update avalanche_profiles set flakes = p.flakes + t.flakes, updated_at = now() where user_id = t.user_id;
  return jsonb_build_object('status', 'credited', 'flakes', t.flakes);
end;
$$;

revoke all on function public.start_avalanche_ad_reward(text, text) from public, anon;
revoke all on function public.get_avalanche_ad_reward(uuid) from public, anon;
grant execute on function public.start_avalanche_ad_reward(text, text) to authenticated;
grant execute on function public.get_avalanche_ad_reward(uuid) to authenticated;
revoke all on function public.avalanche_ad_reward_callback(text, text, text) from public, anon, authenticated;
grant execute on function public.avalanche_ad_reward_callback(text, text, text) to service_role;
