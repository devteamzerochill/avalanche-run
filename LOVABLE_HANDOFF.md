# Avalanche Run: server profile (slice 1) for zerochill.com

What to deploy on the zerochill.com backend so the new Avalanche Run keeps snowflakes, unlocks, missions and the daily streak on the server instead of on the device.

## Apply

One file: [`supabase/migrations/20261124000000_avalanche_profiles.sql`](supabase/migrations/20261124000000_avalanche_profiles.sql).

Do **not** apply anything in `supabase/local-standins/`. Those are local copies of the live functions so the new ones can be tested without the real backend.

## What it changes

Only new objects. No existing table, function, policy or grant is changed.

| New | What it is |
|---|---|
| `avalanche_items`, `avalanche_missions`, `avalanche_streak_rewards` | Catalogue (10 riders/boards, 14 missions, 4 streak rewards), seeded by the migration. Readable by anyone. |
| `avalanche_profiles` | One row per player: snowflakes, owned and worn rider/board, streak, active missions, totals, best score. Players can read their own row only. |
| `avalanche_run_extras` | One row per counted attempt key, so a retried submission never pays twice. Players can read their own rows only. |
| `get_avalanche_profile()` | Returns the signed-in player's profile, creating it with defaults on first use. |
| `submit_avalanche_run(p_distance, p_key, p_run_id, p_stats)` | Calls the existing `submit_avalanche_score(p_distance, p_key, p_run_id)` unchanged and returns its full response, with an `avalanche` object added (snowflakes earned, missions completed, streak reward, updated profile). |
| `buy_avalanche_item(p_type, p_id)` | Spends snowflakes on a rider or board, or Shards on a Shards shop item (rider, board or trail; migration `20261127000000_shards_shop`). The server checks price, balance and ownership. |
| `select_avalanche_item(p_type, p_id)` | Wears an owned rider or board. |

All four client functions need a signed-in player (`authenticated`); `anon` can't call them. All writes go through these functions; there are no direct insert or update policies.

## Guarantees to check

- **The score path is untouched.** `submit_avalanche_run` passes the score straight to `submit_avalanche_score`. Site XP, coins, credits, Daily Reward and tournaments keep coming from there exactly as today.
- **Progression never undoes a score.** Snowflakes, missions and streak are applied only to a counted, first-seen key. If that part fails, the score stays counted and the response carries `avalanche.error` instead.
- **Rejected or duplicate runs pay nothing.** A rejected score gets no `avalanche` object. A repeated key returns the first result with `duplicate: true`.
- **Client stats are clamped.** `p_stats` is reported by the game, so each value is capped to what a run of that score could produce (Proof of Play replaces the caps in a later slice).
- **Snowflakes are an Avalanche Run currency only.** They don't touch site XP, coins or credits.
- **First sign-in starts fresh.** Nothing is imported from the device.

## Website changes

The page that hosts the game calls `submit_avalanche_run` instead of `submit_avalanche_score` (same three arguments plus `p_stats` from the game's message), and answers the new `buy` / `select` messages. Exact messages: [`WEBSITE_INTEGRATION.md`](WEBSITE_INTEGRATION.md).

## Score with trick points (needs the site's agreement)

The owner wants trick points to count in the score (2026-11-24). Today the score is whole metres plus near-miss bonuses, the old game's formula. The game also shows points for perfect landings, clean jumps, grabs and crevasse hops, but they never reach the score. The new score is:

`score = floor(metres) + near-miss bonuses + trick points`

It is still sent as `p_distance`, and nothing else in the API changes. The game keeps the old formula for runs zerochill.com scores until the site confirms the points below; then we switch it on with one setting.

What changes on the site's side:

1. **Higher scores.** In 8 runs of the game's human-like bot, scores came out 55-82% higher (up to about 36,700 for a 5-minute run). The 1,000,000 ceiling isn't affected.
2. **The run check's rate.** `zc_runs.check_run` has `max_metric_per_second = 87.8616` for Avalanche Run (observe mode, not calibrated). With trick points, a strong run reaches about **122 per second** (the old formula peaks at about 67). If the check is ever moved out of observe mode, the limit has to go up first, to at least 150, and should be calibrated on real players.
3. **One board, one formula.** Runs scored the old way and the new way shouldn't be ranked together. Switch at a UTC midnight, so each daily board uses one formula. All-time bests (`player_game_stats.best_score`) and any running tournament will mix the two; please say whether to reset, mark or leave them.
4. **Rewards.** Reward thresholds on the score (Daily Reward bars, XP) will be reached sooner. Please say whether they need retuning.
5. **Stats clamps.** `submit_avalanche_run` caps `p_stats` by what a run of that score could produce. A higher score only loosens those caps, so the migration needs no change.

**Answered 2026-11-24 (DECISIONS 65):** the game sends `p_metres`, and `submit_avalanche_score` (migration 0312) feeds the Daily Reward bar and the run check from metres, so the rate limit and reward thresholds stay as they are; the switch happens when the new game replaces the old one, at a UTC midnight; all-time bests stay; no tournament is running.

## Run checks (migration `20261129000000_run_checks.sql`, DECISIONS 72)

Adds `avalanche_run_checks` and `avalanche_run_check_config` (both closed to players), `avalanche_run_check(...)` for the race server account only, and replaces our own `submit_avalanche_run` with the same body plus one check at the start. Nothing changes while `enforce` is false (the default). Live functions (`submit_avalanche_score` and the rest) are untouched.

## Gold skin (migration `20261130000000_gold_skin.sql`, DECISIONS 83)

Two catalogue rows, nothing else: a Gold rider for 750 Shards and a Gold board for 350 Shards. `buy_avalanche_item` and `select_avalanche_item` already handle any Shards item, so the site needs no change. Until it is applied, the game shows Gold in the shop but buying it fails with an unknown item.

## Rewarded video crediting (migration `20261201000000_ad_rewards.sql` + edge function `levelplay-reward`, DECISIONS 86)

For the phone apps only; the website doesn't change. Only new objects:

| New | What it is |
|---|---|
| `avalanche_ad_rewards` | One ticket per rewarded video: whose it is, what it pays, and the LevelPlay event that paid it. Players can read their own rows only. |
| `start_avalanche_ad_reward(p_kind, p_key)` | A signed-in player gets the ticket for doubling one of their counted runs, worth the snowflakes the server counted for it. |
| `get_avalanche_ad_reward(p_ticket)` | A signed-in player's ticket status, with the profile once paid. |
| `avalanche_ad_reward_callback(p_ticket, p_event_id, p_ip)` | Pays a ticket once. **Service role only**: only the edge function calls it. |
| Edge function `levelplay-reward` | LevelPlay's server-to-server callback. Checks the MD5 signature against the `LEVELPLAY_PRIVATE_KEY` secret, then calls the function above. **Deploy with JWT verification off** (`verify_jwt = false`, in `supabase/config.toml`): LevelPlay sends no token. |

Needs the secret `LEVELPLAY_PRIVATE_KEY`, which the owner sets once they have a LevelPlay account. Until then the function answers 503 and pays nothing.

## Tested locally

On a local Supabase (Postgres 17, same auth and REST stack) with stand-ins for the live functions, `node tests/db.mjs` passes 11/11:

- signed out refused; fresh profile with defaults and three missions
- counted run pays snowflakes, completes missions, starts the streak, updates totals and best
- same key again pays nothing; next run refills missions in order
- implausible stats clamped; rejected score gets no progression
- a progression error keeps the score counted
- streak: next day advances and pays, a gap resets, day 8+ pays 60, a lapsed streak shows 0
- buying: not enough snowflakes, already owned, streak-only, unknown item; wearing: owned vs not owned
- row-level security: own row only, direct writes refused, catalogue readable signed out

Also played in the game against the local stack: sign in, a counted run (snowflakes and mission progress on the end card), a purchase from the shop, sign out back to the device save.

**Not tested against the live database.** Things only the live backend can confirm:

1. `submit_avalanche_score` still has the signature `(p_distance integer, p_key text, p_run_id text)`.
2. It behaves the same when called from inside another `security definer` function (it reads `auth.uid()` from the request, which still works there).
3. A signed-in test call to `get_avalanche_profile` returns a fresh profile.

## Prompt for Lovable

> Please apply the attached SQL migration (`20261124000000_avalanche_profiles.sql`) to the zerochill.com database. It only adds new tables and functions for Avalanche Run (server-side snowflakes, unlocks, missions and daily streak). It doesn't alter any existing table, function, policy or grant; the new `submit_avalanche_run` calls the existing `submit_avalanche_score` unchanged. After applying, please confirm: (1) the migration ran without errors, (2) `submit_avalanche_score` still has the signature `(p_distance integer, p_key text, p_run_id text)`, and (3) a signed-in call to `get_avalanche_profile` returns a profile with 0 snowflakes and three missions. Separately, please read "Score with trick points" in the handoff and answer its four questions (run-check rate, switch date, all-time bests and tournaments, rewards) before the game sends the new score.
