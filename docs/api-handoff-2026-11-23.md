# Avalanche Run — Current API Handoff

**Prepared for:** Sean Consolacion / game integration team  
**Verified:** November 23, 2026, approximately 02:27–02:30 UTC  
**Application:** Zero Chill — https://zerochill.com  
**Game page:** https://zerochill.com/den/avalanche-run  
**Game identifier:** `avalanche_run`  
**Code reference:** `55421b04` (current checkout during review)

## 1. Scope and verification

This document describes the current browser game’s API calls and the **live Lovable Cloud function definitions**, not a proposed replacement API. Inspection was read-only: no gameplay submissions, registrations, database changes, sessions, settings changes, or publication.

Avalanche Run does **not** have a dedicated `/api/avalanche-run` controller. It uses the application’s configured Lovable Cloud REST API and generated browser client. Paths below are relative to that configured **backend origin**, not to `https://zerochill.com`. Obtain the approved backend configuration from the team; no private credentials are included here.

**Important version distinction:** older checked-in SQL describes a two-argument score function and a 100,000 ceiling. The live database has the three-argument function documented below and a **1,000,000** ceiling. `start_game_run` also exists live. Use the live contracts in this document; do not rebuild the integration from older migration text alone.

### Transport and identity

For HTTP calls:

```http
Content-Type: application/json
apikey: <approved public application key>
Authorization: Bearer <current player's access token>
```

The access token is required for player writes and private reads. Public RPC reads can use the approved public application key without a player session. Never embed an admin/service key in a game. Player identity comes from the verified session (`auth.uid()`), not a supplied player ID.

Using the existing generated browser client is preferred: it applies the configured origin, public key, and player session. The examples below use `backend` to mean that client, not a new API wrapper.

## 2. Endpoint inventory

| Method | Relative path | Purpose | Access |
|---|---|---|---|
| POST | `/rest/v1/rpc/start_game_run` | Issue a server run ID | Authenticated player only |
| POST | `/rest/v1/rpc/submit_avalanche_score` | Save the completed run and invoke existing reward/tournament processing | Authenticated player only |
| GET | `/rest/v1/avalanche_run_daily_scores` | Read the player's daily best | Authenticated; row-level access applies |
| POST | `/rest/v1/rpc/landing_board` | Daily leaderboard, own rank, all-time record | Public; own row requires session |
| POST | `/rest/v1/rpc/daily_pop_bars` | Shared Daily Reward bar status | Public; personalized values require session |
| POST | `/rest/v1/rpc/game_unlock_times` | Shared scheduled launch times | Public |

Live execution privileges were checked: anonymous callers cannot execute either write RPC; authenticated callers can. The three read RPCs permit anonymous and authenticated execution.

## 3. Recommended request sequence

1. Establish a valid Zero Chill player session using the existing sign-in flow.
2. On the landing screen, load `landing_board`, `daily_pop_bars`, and the player's daily best. Launch-time lookup is handled by the shared page gate.
3. For **each new attempt**, call `start_game_run` with `avalanche_run`.
4. Let play begin immediately, matching the existing browser's best-effort start behavior. Remember the latest successful run ID for this attempt; never reuse an older attempt's ID.
5. On crash/completion, submit the score once with a stable idempotency key and, if available, the run ID.
6. On transport failure, retry **the exact same arguments**. Do not mint a new key for a retry.
7. Read the entire response: a successful HTTP call is not enough to infer score acceptance or a reward. Refresh reward bars and leaderboard as needed.

There is no separate Avalanche heartbeat, checkpoint, abandon, replay-upload, or finalize endpoint in the current browser flow.

## 4. Start a run

**`POST /rest/v1/rpc/start_game_run`**

Live signature:

```sql
public.start_game_run(p_game text) RETURNS uuid
```

Request:

```json
{"p_game":"avalanche_run"}
```

Response: a JSON string containing the newly issued UUID, not an object with a `run_id` property.

```ts
const { data: runId, error } = await backend.rpc("start_game_run", {
  p_game: "avalanche_run",
});
```

### Live behavior and errors

- Requires an authenticated, non-banned player.
- Requires a game present in the server's run-rule catalog.
- Uses a per-account lock while opening the run.
- **One open run per account across games:** starting another run replaces existing open runs, not just another Avalanche attempt.
- Previous open runs older than two hours are marked expired; other previous open runs are marked replaced.
- Refuses another start when the account already has at least **120 starts within the preceding minute**.
- SQL exception messages include `not authenticated`, `account suspended`, `unknown game`, and `too many run starts`.

Current client behavior: failures return `null` through the shared helper and do not prevent local play. A sequence counter prevents a late response from an older start replacing the current attempt's run ID.

## 5. Submit a completed score

**`POST /rest/v1/rpc/submit_avalanche_score`**

Live signature:

```sql
public.submit_avalanche_score(
  p_distance integer,
  p_key text DEFAULT NULL,
  p_run_id text DEFAULT NULL
) RETURNS jsonb
```

| Field | Requirement | Meaning |
|---|---|---|
| `p_distance` | Required integer, inclusive **0–1,000,000** | Bonus-inclusive score returned as the engine's `stats.distance` |
| `p_key` | Optional in SQL; strongly recommended for every integration | Idempotency key, **8–128 characters** when nonempty |
| `p_run_id` | Optional text | UUID returned by `start_game_run`; omit when unavailable |

Illustrative request, not a real player result:

```json
{
  "p_distance": 1250,
  "p_key": "avalanche:2026-11-23:1795401000000:1250",
  "p_run_id": "11111111-1111-4111-8111-111111111111"
}
```

The example UUID is illustrative only; production requests must use the actual issued UUID.

### Critical scoring detail: “distance” includes bonuses

Despite the field name and metres label, the current engine reports:

```ts
stats.distance = Math.floor(physicalDistance) + nearMissBonusTotal;
```

Each qualifying near miss adds `25 * combo` to that bonus total. The current client sends:

```ts
p_distance: Math.max(0, Math.round(stats.distance))
```

**Do not replace this with raw physical travel distance** when porting the game. That would change leaderboard scores, reward metrics, and tournament submissions. The API does not receive a separate near-miss count, combo history, raw distance, crash cause, top speed, seed, or input replay.

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | RPC outcome flag; still inspect `counted` and `rejected` |
| `distance` | integer | Saved score; retries return the original stored value |
| `counted` | boolean | Whether this key's run counted |
| `duplicate` | boolean | Previously seen nonempty idempotency key |
| `xp_awarded` | boolean | Whether this call's reward step reported a grant |
| `xp`, `coins`, `credits_pending` | integer | Returned reward amounts; zero when none on this call |
| `xp_reason` | string or null | Reward-step explanation |
| `pop` | object or null | Shared Daily Reward result |

`pop`, when present, is consumed using this shared contract:

```ts
type PopOutcome = {
  metric: string;
  value: number | null;
  threshold: number;
  label: string;
  cleared: boolean;
  run_index: number | null;
  tier: "full" | "half" | "none";
  xp: number;
  xp_blocked_by_cap?: boolean;
};
```

### Idempotency and duplicate responses

- Deduplication is scoped to `(player_id, p_key)`.
- Empty key becomes null. With no key, each submission is considered new; it is **not safe to retry without a key**.
- Reusing a key does not change its stored distance or increment the daily run count again.
- Duplicate responses do **not** replay the original reward amounts. They can return `counted: true`, `duplicate: true`, and zero reward amounts with `pop: null`. Do not interpret this as the original reward being reversed.
- Use one key per completed attempt and keep it unchanged across automatic and manual retries.

### Rejections and exceptions

Missing, negative, or over-ceiling distance produces a normal JSON rejection and writes an internal rejection log:

```json
{
  "ok": false,
  "rejected": true,
  "reason": "distance out of range",
  "counted": false
}
```

No score or reward is counted for that response. Authentication/banned-account failures and malformed nonempty idempotency-key lengths raise database exceptions instead. Do not depend on an exact HTTP status mapping: gateway/error envelopes were not exercised with player writes during this read-only review.

### What acceptance changes

For a first-seen, allowed run, the function:

- Updates all-time `player_game_stats.best_score` with the greatest score.
- Updates today's `avalanche_run_daily_scores.best_distance` and increments `run_count`.
- Invokes existing `track_play_event('avalanche_run', 'avalanche_run.daily_run', key, score)` reward processing.
- For a positive score, invokes internal `_record_tournament_score(...)`.
- Marks the idempotency key counted.

A counted score can earn zero reward because of threshold, cooldown, taper, cap, or other existing server rules. **Reward exhaustion is not the same as score rejection.** Treat amounts and bar thresholds as server-owned configuration; do not hardcode old seeded reward values.

Tournament eligibility and overall daily Proof of Play qualification are separate server authorities. This RPC does not directly assign mining hash or credit a mineZCU account.

## 6. Run validation and trust boundary

The live score function invokes internal `zc_runs.check_run` with the run ID, game ID, key, and submitted score.

**Verified live Avalanche setting at review time:** `mode = observe`, `calibrated = false`, `max_metric_per_second = 87.8616`, with no separate score-rate limit or minimum-duration setting.

The server independently knows the issued run's owner, game, start time, status, and reuse history. It can flag missing/bad/unknown keys, wrong player/game, replaced/expired/reused runs, and the submitted metric exceeding its configured rate relative to server time.

**Observe mode logs these flags but returns allowed.** It does not block the run on those flags. The score's origin and gameplay are still client-reported: the server does not replay obstacles or verify near-miss bonuses independently. The inclusive numeric ceiling remains enforced separately. Do not describe current scoring as fully server-authoritative gameplay verification.

This document records existing behavior only; it does not enable enforcement or alter any security finding.

## 7. Read the player's daily best

**`GET /rest/v1/avalanche_run_daily_scores`**

Existing browser query:

```ts
const { data, error } = await backend
  .from("avalanche_run_daily_scores")
  .select("best_distance")
  .eq("date_key", utcDateKey)
  .maybeSingle();
```

Equivalent query parameters:

```text
select=best_distance&date_key=eq.2026-11-23
```

Client-consumed result: `{ "best_distance": number }` or `null` when no row exists.

Row-level policy allows authenticated players to read their own rows; admins may read all rows. The normal browser query relies on that policy instead of supplying `user_id`.

**Admin integration caveat:** because admins can see multiple players' rows, an unfiltered `.maybeSingle()` may fail. If this query is reused for an admin account, explicitly filter `user_id` to the signed-in subject as well. This review did not change the existing query.

The current UI keeps local best as a floor and raises it to the server value when that is greater. A failed daily-best read does not prevent play. Local storage is not evidence that a run was accepted server-side.

## 8. Leaderboard

**`POST /rest/v1/rpc/landing_board`**

```json
{"p_game":"avalanche_run","p_limit":5}
```

`p_limit` defaults to 10 in SQL and is clamped to **1–25**. The current landing component requests five rows.

```ts
type AvalancheBoard = {
  game: "avalanche_run";
  scope: "daily";
  metric: "score";
  lower_better: false;
  date_key: string;
  players: number;
  top: Array<{
    rank: number;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    score: number;
  }>;
  me: AvalancheBoard["top"][number] | null;
  record: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    score: number;
  } | null;
};
```

- Daily rows come from today's server-UTC `best_distance`, with positive scores only.
- Higher scores rank first. The live generic branch uses `row_number`; Avalanche ties have no explicit deterministic secondary tiebreak.
- `players` counts positive daily participants, not all registered accounts.
- `me` is the session player's daily row, including when outside the requested top rows; anonymous callers receive no personalized row.
- `record` comes from all-time `player_game_stats` for Avalanche, not just today's rows.
- Unsupported/null game identifiers return null.
- Prefer `display_name` with `username` fallback for display; both fields remain separate.

## 9. Daily Reward bars

**`POST /rest/v1/rpc/daily_pop_bars`**

Current browser request: `{}` (today). SQL also accepts optional `p_date` as a date.

Returns a JSON array for all applicable games. Select the entry where `game_id === 'avalanche_run'`; do not assume an array position.

Relevant fields:

```text
game_id, metric, threshold, base_threshold, label, base_label,
assist_pct, genuine_fails, next_ease_in, next_threshold,
date, cleared, clears_today, runs_today,
per_run_xp, xp_today, earned_today,
daily_max_xp, daily_max, exhausted, xp_blocked_by_cap
```

Threshold assistance and daily maximum are calculated server-side. `earned_today` aliases the displayed `xp_today`; `daily_max` aliases `daily_max_xp`. Current cap calculation counts the game's main play-rule XP, not server-issued skill-streak bonus XP. Use the existing shared `barTotals()` semantics, including the explicit exhausted/cap flags, rather than recomputing eligibility or caps in a new client.

Anonymous execution is allowed, but without a player session the personalized totals are not the signed-in player's totals.

## 10. Launch-time lookup

**`POST /rest/v1/rpc/game_unlock_times`**, request `{}`.

Returns a JSON object mapping game IDs with scheduled unlocks to timestamp values. Games with no non-null `public_unlock_at` are omitted; an empty result is `{}`.

The game page uses this shared lookup and device-local invitation/passcode state for its display gate. That display gate is **not** an API authorization or permission grant, and it is not included in the score payload.

## 11. Retries, dates, and implementation cautions

- Current shared submission helper allows **five total attempts** and reuses the same payload.
- Retry delays are approximately **700, 1,400, 2,800, and 5,600 ms**.
- It checks session freshness and avoids concurrent forced token refreshes.
- JSON `{rejected:true}` replies and database codes beginning `P0` return immediately, without automatic retries. Other failures can exhaust the remaining attempts.
- A lost/unrecoverable session is reported as requiring sign-in again.
- The manual retry closure exists only in the mounted game component. This is **not a durable offline submission queue**; reloading or closing the page can lose a pending submission. Local best storage does not contain a guaranteed recoverable server submission.
- Daily score writes use **server UTC at submission time**. The client's date in its idempotency key does not select the server's daily bucket. An attempt spanning midnight can therefore appear on the new UTC day's board.
- No separate game-supplied elapsed time is sent. The run validator uses server timing where a valid owned run ID exists.
- Do not call `track_play_event`, `_record_tournament_score`, or `zc_runs.check_run` independently from a game integration. They are internal steps owned by the score path.
- No production/preview Avalanche endpoint pair exists in this flow. Preview and published UI share the backend described here: a write from preview is still a real backend write. Use approved test accounts and avoid real-event test activity.

## 12. Developer handoff checklist

- [ ] Use the approved configured Lovable Cloud client and actual player session.
- [ ] Use `avalanche_run` exactly.
- [ ] Open one server run for every new attempt and retain only that attempt's ID.
- [ ] Submit the engine's bonus-inclusive score, not raw physical metres.
- [ ] Generate a stable, valid key for each completed attempt; reuse it on retries.
- [ ] Handle JSON rejection, SQL/transport error, duplicate, and counted-but-unrewarded cases separately.
- [ ] Do not invent reward amounts or recompute PoP qualification, caps, or mining credits.
- [ ] Refresh daily best, leaderboard, and reward bars using UTC-aware behavior.
- [ ] Distinguish local personal best from a confirmed accepted server run.
- [ ] Test with approved throwaway accounts; do not submit samples against real tournament players.

## 13. Source references and remaining verification limits

### Current code

| File | Relevant area |
|---|---|
| `src/routes/den.avalanche-run.tsx:15–54` | Page route, sign-in redirect, display unlock gate |
| `src/components/avalanche/AvalancheRun.tsx:76–95` | Daily best read |
| `src/components/avalanche/AvalancheRun.tsx:182–227` | Completed-run payload and result handling |
| `src/components/avalanche/AvalancheRun.tsx:242–249` | Best-effort start call |
| `src/components/avalanche/AvalancheRun.tsx:477,488,535` | Board and Daily Reward display integration |
| `src/game/avalanche/engine.ts:1251,1434–1435,1528` | Bonus-inclusive reported score and near-miss bonus |
| `src/lib/run-keys.ts:22–54` | Start sequence and remembered run ID |
| `src/lib/score-submit.ts:54–128` | Session freshness, retry behavior, rejection handling |
| `src/lib/landing-board.ts:12–37` | Shared board response contract |
| `src/components/landing/LandingBoard.tsx:22–49` | Board request and failure handling |
| `src/lib/pop.ts` | Shared reward response, bar reads, bar interpretation |
| `src/lib/manila-early-access.ts:61` | Shared scheduled unlock lookup |

### Live checks performed

Read-only catalog inspection confirmed the signatures, current definitions, and execution privileges of `start_game_run`, `submit_avalanche_score`, `landing_board`, `daily_pop_bars`, and `game_unlock_times`; the daily-score read policy; and Avalanche's run-validation settings. The score response and writes described above come from the live function body.

### Not verified by this handoff

No authenticated end-to-end HTTP score submission was executed. Exact gateway status envelopes, installed native game integrations, and publication parity of the browser bundle were not verified. Reward configuration can change after this document's timestamp. Recheck live contracts before a new release if these settings or shared functions have changed.

---
Part of the [Honest Money ecosystem](https://honest.money). Zero Chill: [Terms](https://zerochill.com/terms) · [Privacy](https://zerochill.com/privacy) · [Manifesto](https://zerochill.com/manifesto).
