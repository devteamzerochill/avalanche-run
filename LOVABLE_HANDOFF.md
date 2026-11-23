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
| `buy_avalanche_item(p_type, p_id)` | Spends snowflakes on a rider or board. The server checks price, balance and ownership. |
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

> Please apply the attached SQL migration (`20261124000000_avalanche_profiles.sql`) to the zerochill.com database. It only adds new tables and functions for Avalanche Run (server-side snowflakes, unlocks, missions and daily streak). It doesn't alter any existing table, function, policy or grant; the new `submit_avalanche_run` calls the existing `submit_avalanche_score` unchanged. After applying, please confirm: (1) the migration ran without errors, (2) `submit_avalanche_score` still has the signature `(p_distance integer, p_key text, p_run_id text)`, and (3) a signed-in call to `get_avalanche_profile` returns a profile with 0 snowflakes and three missions.
