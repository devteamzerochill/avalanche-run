-- LIVE ONLY: the race tables as first applied (migration 0310) referenced
-- auth.users with no delete action, so deleting the account of anyone who had
-- raced (or the server or house account) would fail and roll back. Match the
-- site's other game tables: a player's entries go with the account; the
-- config's server and house accounts are cleared. The migration file itself
-- now says the same, for fresh databases.
alter table public.avalanche_race_entries
  drop constraint avalanche_race_entries_user_id_fkey,
  add constraint avalanche_race_entries_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade;
alter table public.avalanche_race_config
  drop constraint avalanche_race_config_house_user_fkey,
  add constraint avalanche_race_config_house_user_fkey foreign key (house_user) references auth.users (id) on delete set null,
  drop constraint avalanche_race_config_server_user_fkey,
  add constraint avalanche_race_config_server_user_fkey foreign key (server_user) references auth.users (id) on delete set null;
