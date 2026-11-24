# Avalanche Run: multiplayer race for zerochill.com

**Draft for the owner's review (2026-11-23, house fee added 2026-11-24). Not sent yet.**

What the zerochill.com backend and page need so the multiplayer race can run against the real site. Players pay a Shards entry fee to check in, everyone rides the same mountain live every 5 minutes, and the last rider standing wins 90% of the pot. The other 10% is a house fee paid to one Zero Chill account. Fewer than 2 riders, or a win that follows the game's own bot, refunds everyone.

## Who runs what

| Part | Where | Who |
|---|---|---|
| Race server (Colyseus) | Colyseus Cloud | Zero Chill (the owner's account) |
| Race tables and ledger functions | zerochill.com Supabase | You apply one migration |
| Shards wallet and player names | zerochill.com Supabase | You provide four small functions (below) |
| House account for the 10% fee | zerochill.com Supabase | You create it and set it in the config (below) |
| Session token for the game | `/den/avalanche-run` page | You add two messages |
| Terms of Service | zerochill.com | You update them for paid races (below) |

The race server talks to Supabase with the project URL, the anon key and the **service role key**. The owner enters these in Colyseus Cloud's encrypted settings. The service key is never in the game, the page or any repository.

## 1. Apply

One file: [`supabase/migrations/20261125000000_endurance_race.sql`](supabase/migrations/20261125000000_endurance_race.sql). It only adds objects; nothing existing changes.

| New | What it is |
|---|---|
| `avalanche_race_config` | Entry fee (10), prize share (90%), riders per race (2 to 50), and `house_user`, the account that receives the fee. One row, tunable without a game update. |
| `avalanche_races` | One row per race: seed, start time, pot, status (`open`, `racing`, `settled`, `cancelled`, `voided`), prize, `house` (fee paid to the house account), `burned` (fee burned because no house account was set), void reason. |
| `avalanche_race_entries` | One row per rider per race: fee paid, place, distance, prize. |
| `race_open`, `race_check_in`, `race_start`, `race_cancel`, `race_settle`, `race_void` | The race ledger. Check-in holds the fee; every race then ends in exactly one of settle (pay the winner 90%, the house account 10%), cancel (refund all) or void (refund all). |
| `race_balance`, `race_board` | A player's Shards, race record and the race leaderboard. |

Every function is **service role only**: `anon` and `authenticated` cannot call them. The tables are read-only to clients: config and races are public, and a signed-in player sees only their own entries. There are no client write policies.

Do **not** apply anything in `supabase/local-standins/`. Those are local copies for testing.

## 2. Provide four functions

The migration calls these. Locally they are stand-ins with test Shards (`supabase/local-standins/shards_wallet.sql`); on the live site they wrap the real Shards wallet and profiles.

| Function | Must |
|---|---|
| `shards_balance(p_user uuid) returns integer` | Return the player's current Shards. |
| `shards_debit(p_user uuid, p_amount integer, p_ref text) returns boolean` | Take `p_amount`, or return `false` and change nothing if the balance is too low. Never go negative. |
| `shards_credit(p_user uuid, p_amount integer, p_ref text)` | Add `p_amount`. |
| `avalanche_player_name(p_user uuid) returns text` | The name other players see: the same `display_name`, then `username`, the site's leaderboards use. |

- They must be plain SQL or PL/pgSQL in the same database, so a check-in, payout or refund commits or rolls back together with the race tables. No HTTP calls inside.
- Revoke them from `public`, `anon` and `authenticated`, like the race functions. Grant `avalanche_player_name` to `service_role`: the race server reads names with it when a player joins.
- `p_ref` describes the movement (`avalanche race <id> entry`, `... prize`, `... house fee`, `... refund`, `... voided, refund`) for your Shards history.

## 3. Create the house account

The 10% of each pot that the winner doesn't get goes to one Zero Chill account. **It doesn't exist yet: please create it.**

1. Create a normal site account for it (no player plays on it). The race pays it through `shards_credit`, so it needs whatever your Shards wallet needs to hold a balance.
2. Send the owner its user id, and set it:

   ```sql
   update avalanche_race_config set house_user = '<user id>';
   ```

- Each settled race credits it once with `pot − prize`: the 10% plus any odd Shard left when a tie splits the prize. Ref: `avalanche race <id> house fee`.
- Cancelled and voided races take no fee; everyone gets their entry back.
- **The race does not wait for this account.** Races open, run and pay the winner as normal without it; until `house_user` is set, the 10% is simply burned (nobody receives it). Fees burned before then are not paid later, so set it as soon as the account exists.
- Changing `house_user` later applies to races settled from then on.

## 4. Page changes

The race server must know who a player is, so the game needs the player's own Supabase access token (never a service key). This changes one rule in [`WEBSITE_INTEGRATION.md`](WEBSITE_INTEGRATION.md): the game now holds the player's session token while racing.

- Add `race` to the iframe URL: `...index.html?portrait&race&host=...`. Without it the race stays off.
- Game to page: `{ type: 'race_token' }` when it needs a token (joining, or reconnecting after the old one expired).
- Page to game: `{ type: 'race_token', token, expiresAt }` with the current session's `access_token` and `expires_at`, refreshed through the existing client first if it expires within a minute. `token: null` when signed out.

- If the site sends a Content Security Policy, allow the race server in `connect-src` (`wss://<race server host>`; the owner sends the exact address after the first deploy). Without it the race can't connect.

The game sends the token only to the race server, which checks it once with `/auth/v1/user`. The existing score path (`start_game_run`, `submit_avalanche_score` / `submit_avalanche_run`) is untouched; race results never count as daily runs.

## 5. Update the Terms

The race takes a paid entry (Shards, which players can buy) for a Shards prize, with a 10% house fee. Today's Terms say the opposite in section 6: "No purchase is ever needed to enter an event or win a prize". The owner decided (2026-11-24) to keep paid entry and to set who may race in the Terms only; the game and the server don't check age or location. Please update the Terms before races go live. Suggested points, for you to word to fit:

- **Section 6:** events are free to enter, **except the Avalanche Run multiplayer race**, which has a Shards entry fee.
- **Who may enter paid races:** 18 or older, and not resident in or playing from a place where paid skill contests are not allowed. List at least: Arizona, Arkansas, Delaware, Louisiana, Montana, South Carolina and Tennessee (see `docs/race-legal-check.md` for why these).
- **How it works:** the last rider standing wins 90% of the pot; ties split it and any odd Shard goes with the fee; the other 10% is a house fee; fewer than 2 riders, or a win the server finds was played by a bot, refunds every entry; a rider who disconnects is out with no refund; the server's replay decides every result.

The game's race panel shows these rules in short form ("Record" tab and How to play). Send us the link to the final Terms and we'll link it from the race panel.

## Guarantees to check

- **The browser can't touch Shards.** Only the race server (service role) can call the ledger, and only through the four functions above.
- **Every fee is accounted for.** It is held at check-in, and each race ends in one of: paid out (90% to the winner, 10% plus any odd Shards to the house account, or burned while none is set), or refunded in full (cancelled or voided).
- **The server decides the result.** It replays every rider's inputs with the game's own simulation; phones only send inputs.
- **A bot win is voided.** A winning ride that follows the game's own bot refunds everyone.

## Tested locally

On a local Supabase with stand-in Shards, `node server/test.mjs` passes 12/12: cancel and refund; last rider standing wins; server and phone agree on the death tick; a sped-up client is out; names and race record; 90% payout and 10% burned with no house account; an exact tie splits the prize and the house account gets the fee and the odd Shard; leaving counts as dying; a bot win voided with both riders refunded; a short win by the human-like bot caught; the race leaderboard counts settled races only; rematch data. Also played in the browser against practice riders: check-in, countdown, cancel, a voided race, a win and a rematch.

**Not tested against the live database.** To confirm there:

1. Where Shards live, and that the three wallet functions can wrap them in the same transaction.
2. Where display names live, for `avalanche_player_name`.
3. The Terms are updated for paid races (section 5).
4. The house account is created and set in `avalanche_race_config.house_user`.
5. A test check-in and refund with a throwaway account.

## Our side

Done and tested locally: the race server in Colyseus Cloud's setup (`defineServer`, one PM2 process), names through `avalanche_player_name`, and the game's side of `race_token` (try it in `tools/host-mock.html` with "Race on"). Still to do, in order: the first deploy to Colyseus Cloud (one region), with the three Supabase settings entered there; then point the game at the deployed server (`CONFIG.race.server`, today `ws://localhost:2567`) and hand over the rebuilt game files together with its `wss://` address.
