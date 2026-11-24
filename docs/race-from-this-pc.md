# Racing from this PC against zerochill.com

**Retired 2026-11-25:** the race now runs on Colyseus Cloud at `https://sg-sgp-b4a82550.colyseus.cloud/?portrait&live&race=here` (`docs/endurance-race.md`, "Colyseus Cloud setup"). Keep this as the fallback if Cloud is down. Never run both at once: each would open its own race for the same slot.

How the multiplayer race runs before the game is on the site (DECISIONS 64). The race server and the web game run on this PC, a Cloudflare quick tunnel gives them one public https link, and riders use their real zerochill.com accounts and real Shards.

## What is live on the site

- **Migration 0310** (`drizzle/migrations/0310_avalanche_race_ledger.sql` in the site's repo, accepted 2026-11-24): `supabase/migrations/20261125000000_endurance_race.sql` plus `supabase/live/avalanche_race_wallet.sql`.
- **`avalanche_race_config`:**
  - `server_user` is the race server's own account, whose login is in `server/.env`;
  - `house_user` is `avalanche_qa04`, which receives the 10% fee.
- **Shards** move through the site's `reward_entries` as ADJUST entries:
  - `source_id` is `avalanche_run.race`;
  - each movement's idempotency key is `avalanche_race:` followed by its reference (for example `avalanche race <id> entry`).

## Run it

1. **Build the game:** `node tools/build.mjs`. It writes `dist/web/`, including `vendor/colyseus.js`.
2. **Check `server/.env`.** It is never committed. It needs:
   - `SUPABASE_URL=https://llnwrhbftwtgkzpvsbwj.supabase.co`
   - `SERVE_GAME=1`
   - `PORT=2567`
   - `RACE_SERVER_EMAIL` and `RACE_SERVER_PASSWORD`, filled in by the owner.
3. **Start the race server:** `node server/index.mjs` (from `server/`). It reads `.env` only when started this way; the tests always use the local stack.
4. **Start the tunnel:** `tools/cloudflared/cloudflared.exe tunnel --no-autoupdate --url http://localhost:2567`. It prints a `https://….trycloudflare.com` address.
5. **Send riders that address with `/?portrait&live&race=here`.**

**cloudflared:** 2026.11.2, from Cloudflare's GitHub releases. Its SHA-256 matched the release notes and it is signed by Cloudflare, Inc. It sits in `tools/cloudflared/`, which git ignores.

**The link changes every time the tunnel restarts.** The link works only while both processes run and the PC is awake.

The server only ever serves `dist/web/`. Other paths, `server/.env` included, return 404.

## Checks

- **The ledger nets to zero** across all race movements:

  ```sql
  select player_id, sum(amount)
  from reward_entries
  where source_id = 'avalanche_run.race'
  group by player_id;
  ```

  The sum over every player is 0: fees in, prizes, house fees and refunds out.
- **Lock the server out:** change the race server account's password, or set `server_user` to null.

## Verified 2026-11-24

- **A refund race:** one rider, cancelled, 10 Shards back.
- **Three settled races** with 2 and 3 riders: 80 Shards of fees, 72 to winners and 8 to the house. The race ledger nets to 0.
- **The bot check** judged every winner as a real player.
- **Access:** players who aren't signed in get 401. In local tests, signed-in players are refused by `_race_guard`.

## Known gaps

- **The Terms** still say no purchase is needed to enter an event (DECISIONS 61).
- **Last alive wins.** A rider can ride further and still lose to one who stayed alive a few ticks longer; the results don't explain this yet.
- **One PC:** if it sleeps, the races in progress drop. A rider who disconnects is out with no refund.
