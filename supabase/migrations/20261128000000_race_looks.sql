-- Race riders show their real look (DECISIONS 71): the race server reads each
-- rider's outfit, board and trail from their profile, so a player can only
-- show items they own. Race server account (or service role) only.
--
--   race_looks(p_users uuid[]) -> { "<user id>": { rider, board, trail }, ... }
-- Players with no profile yet are left out (the game draws the default look).

create function public.race_looks(p_users uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _race_guard();
  return coalesce((
    select jsonb_object_agg(user_id, jsonb_build_object('rider', rider, 'board', board, 'trail', trail))
    from avalanche_profiles where user_id = any(p_users)
  ), '{}'::jsonb);
end $$;

revoke all on function public.race_looks(uuid[]) from public, anon, authenticated;
grant execute on function public.race_looks(uuid[]) to service_role, authenticated; -- _race_guard decides
