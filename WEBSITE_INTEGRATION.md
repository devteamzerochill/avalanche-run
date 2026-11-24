# Hosting the new Avalanche Run on zerochill.com

For whoever wires the new game into `/den/avalanche-run`. The game runs in an iframe and never calls the backend itself: the page keeps doing every API call with the existing generated client and helpers, exactly as the API handoff of 2026-11-23 describes. The game only reports attempts and displays what the page sends back.

`tools/host-mock.html` is a working reference: it hosts the game and answers every message the way the live API behaves, including failures. Open it from the dev server (`/tools/host-mock.html`).

## 0. Testing before the page switches

The game also has a live test mode (`?live`, outside an iframe) that makes these same calls itself against the real backend, with its own email + password sign-in. It exists so the game can be tested end to end before this page changes; it is not the release setup.

## 1. Embed

Serve the contents of `dist/web/` (from `node tools/build.mjs`) and embed it:

```html
<iframe src="/games/avalanche-run/index.html?portrait&host=https%3A%2F%2Fzerochill.com"
        allow="autoplay; fullscreen" title="Avalanche Run"></iframe>
```

- `host=` must be the page's own origin (use `location.origin`, so preview hosts work too). Without it the game stays fully local: no messages, CPU stand-ins on the board.
- `portrait` keeps the 9:16 phone layout on every screen.
- Keep the existing sign-in redirect and launch-time gate on the route. The game doesn't handle either.

## 2. Messages

All messages are plain objects sent with `postMessage`.

- **Game to page:** `{ source: 'avalanche-run', protocol: 1, type, ... }`, sent to the `host` origin only.
- **Page to game:** `{ source: 'zerochill', protocol: 1, type, ... }`, sent with `iframe.contentWindow.postMessage(msg, gameOrigin)`.

Each side must ignore messages whose `event.source` isn't the other window, or whose `event.origin` isn't the expected origin.

The playable-ad build also posts `{ source: 'avalanche-run', type: 'boot' | 'gameplay_start' | 'endcard' | 'replay' }`. Those have no `protocol` field and can be ignored.

### Game to page

| `type` | Fields | Page does |
|---|---|---|
| `hello` | `game: 'avalanche_run'` | Send `session`, `board`, `bars`, `daily_best` (section 3). |
| `attempt_start` | `attempt` (opaque id) | Call `start_game_run({ p_game: 'avalanche_run' })` best-effort, as today (`run-keys.ts`). Remember the latest run id **for this attempt**; a late answer for an older attempt must not replace it. Play has already started; never block on this. |
| `attempt_end` | `attempt`, `score`, `key`, `stats` | Submit once through the existing helper (`score-submit.ts`). Once the profile migration is live (LOVABLE_HANDOFF.md): `submit_avalanche_run({ p_distance: score, p_key: key, p_run_id, p_stats: stats })`; before that, `submit_avalanche_score({ p_distance: score, p_key: key, p_run_id, p_metres: stats.distance })`. `p_metres` (whole metres ridden) feeds the Daily Reward bar and the run check, which measure metres; the score can also carry trick points. Omit `p_run_id` if no run id came back for this attempt. Then reply `submit_result` and refresh (section 3). |
| `retry` | `attempt`, `score`, `key`, `stats` | The player pressed Retry after a failure. Submit again with **exactly the same arguments**. |
| `buy` | `itemType` (`rider`, `board` or `trail`), `id` | `buy_avalanche_item({ p_type: itemType, p_id: id })`, then reply `item_result` and `profile`. |
| `select` | `itemType`, `id` (`trail` + `none` takes the trail off) | `select_avalanche_item({ p_type: itemType, p_id: id })`, then reply `item_result` and `profile`. |
| `refresh` | none | Re-send `board`, `bars`, `daily_best`. The game asks when the Ranks screen opens. |
| `race_token` | none | Only with `race` in the iframe URL (multiplayer race, `RACE_HANDOFF.md`). Reply `race_token` with the current session's access token, refreshed first if it expires within a minute. |

Notes:
- `score` is already the bonus-inclusive score (`floor(metres) + near-miss bonuses`, 25 × combo per near miss), the same metric the old engine reported as `stats.distance`. It's an integer of 0 or more. Send it as is. Since 2026-11-25 it also carries trick points (`LOVABLE_HANDOFF.md`, "Score with trick points"); the message doesn't change, and `stats.distance` / `p_metres` still carry the metres alone.
- `key` is `avalanche:<UTC date>:<attempt start ms>:<score>`, 8 to 128 characters. It's stable for the attempt, so retries reuse it.
- `stats` is the run summary the profile APIs use: `distance` (whole metres), `flakes`, `nearMisses`, `bestCombo`, `cleanJumps`, `tricks`, `perfects`, `trickScore`, `topKmh`. Pass it through unchanged.
- The game never sends bot, recorded or test runs. Restarting or quitting mid-run abandons the attempt without `attempt_end`.

### Page to game

| `type` | Fields | Meaning |
|---|---|---|
| `session` | `signedIn: boolean` | Whether a player session exists. |
| `board` | `board` | The `landing_board({ p_game: 'avalanche_run', p_limit: 25 })` result, unchanged (or `null`). |
| `bars` | `bar` | The `daily_pop_bars({})` entry where `game_id === 'avalanche_run'`, unchanged (or `null`). |
| `daily_best` | `best: number \| null` | Today's `best_distance` from `avalanche_run_daily_scores` (`null` if no row or signed out). |
| `submit_result` | `attempt`, `status`, `result`, `reason` | See below. With `submit_avalanche_run`, `result.avalanche` carries the snowflakes, missions and streak reward. |
| `profile` | `profile` | The `get_avalanche_profile()` result (or `null` when signed out). Send only once the profile migration is live. |
| `item_result` | `action`, `itemType`, `id`, `ok`, `reason` | The outcome of `buy` / `select`. |
| `race_token` | `token`, `expiresAt` | The player's own `access_token` and `expires_at`, or `token: null` when signed out. The game sends it only to the race server, which checks it once. |

`submit_result.status`:

| `status` | When | `result` |
|---|---|---|
| `counted` | RPC returned `counted: true, duplicate: false` | The full RPC JSON (`xp`, `coins`, `credits_pending`, `pop`, ...) |
| `duplicate` | RPC returned `duplicate: true` | The RPC JSON |
| `rejected` | RPC returned `rejected: true` | The RPC JSON; put its `reason` in `reason` |
| `signin` | The helper reports the session is lost and the player must sign in again | `null` |
| `failed` | Anything else after the helper's retries (transport, `P0` exceptions) | `null`; a short message in `reason` |

## 3. After every `submit_result`, and on `hello` / `refresh`

Send `session`, then `board`, `bars` and `daily_best` with fresh values, and `profile` once the profile migration is live. The game redraws whichever screen is showing.

## 4. What the game shows

- **Title screen:** "Best today" is the higher of the local best and `daily_best`. A Daily Reward bar shows the bar's `label`, `xp_today / daily_max_xp`, and Cleared or Daily max reached (from `cleared`, `exhausted`, `xp_blocked_by_cap`).
- **Ranks screen:** the all-time `record`, the `top` rows, the player's `me` row (even outside the top), and `players` today. Names use `display_name`, falling back to `username`. Avatars load only from `https:` URLs and fall back to initials.
- **End card:** Saving…, then one of: Saved · #rank today (from `board.me` once the refreshed board arrives), Already saved, Not counted: reason, Couldn't save + Retry, or Sign in again + Retry. Reward chips come from the RPC result: `+xp XP`, `+coins coins`, credits pending, and the `pop` label with its cleared/half/progress state. A counted run with nothing earned says so. It's not shown as a rejection.

The game never computes rewards, caps, thresholds or eligibility. It only displays the server's values.

## 5. Things the handoff warns about (still apply)

- Never put an admin or service key anywhere near the game. The iframe holds no credentials, except the player's own session token while racing (`race_token`).
- One open server run per account across games: `attempt_start` replaces any other open run, as the old game did.
- Daily buckets use server UTC at submission time. A run that spans midnight lands on the new day.
- The manual Retry lives in the game's end card. Like the old game, it's not a durable queue: closing the page loses an unsent result.
- Preview and production share one backend. Test with approved throwaway accounts.

## 5b. Scores checked by replay (DECISIONS 72)

Before the game sends `attempt_end` it asks the page for `race_token` (the same message as the race) and posts the run to the race server, which replays it and records the result on the site. The page changes nothing in the submit itself. It must answer `race_token`, which it does once it embeds with `?race`; without `?race` the game skips the check so saves never wait. Allow `https://sg-sgp-b4a82550.colyseus.cloud` in `connect-src` (the check is an https POST, the race a wss connection).

When the new game replaces the old one: set `avalanche_run_check_config.enforce = true` and revoke `submit_avalanche_score` from `authenticated` (the old game's direct path; `submit_avalanche_run` still calls it as the definer). From then on a score without a passing check comes back `{ rejected: true, reason: 'unverified' }`.

## 6. Test checklist (with the real page)

- [ ] Open the page signed in → the title shows the Daily Reward bar and the server's best today.
- [ ] Open Ranks → today's board, your row and the all-time record appear.
- [ ] Play a run → the end card shows Saving…, then Saved · #N today, with the right reward chips.
- [ ] A run over the bar's threshold → the bar on the title fills; the end card shows the reward cleared.
- [ ] Block the network during the end card → Couldn't save + Retry; restore the network, press Retry → Saved (same key, no double count).
- [ ] Sign out in another tab, finish a run → Sign in again.
