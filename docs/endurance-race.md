# Multiplayer race (endurance race): design

Players see it as **Multiplayer race** (owner, 2026-11-23). Code and server names keep `endurance`.

A live multiplayer tournament that runs every 5 minutes. Players pay a Shards entry fee to check in, everyone rides the same mountain at the same time, and the last rider alive wins the pot.

Status: design agreed so far (2026-11-23); a local prototype is built (see "Prototype" below). Items under "Open" are not decided.

## Agreed

**Format**
- An ongoing tournament: a new race every 5 minutes. Players check in for the next race.
- Last rider alive wins.
- Every rider in a race rides the same seed. Riders don't collide; the others are shown as live ghosts.

**Server: Colyseus**
- The race runs in a Colyseus room (https://colyseus.io/), not Supabase Realtime.
- The server is the authority. Each phone plays its own simulation for instant controls and streams its inputs; the server replays every rider's inputs with the game's own deterministic simulation (`src/core/`) and decides deaths, placements and the winner.
- Local only for now: built and tested on this PC. Hosting is decided when it is ready to go live.

**Accounts**
- Racing needs a zerochill.com sign-in. The Colyseus server verifies the player's Supabase session when they join, so results belong to real accounts.
- On the website this means the page passes the game a session token, which changes DECISIONS 54 ("the game holds no keys or tokens").

**Entry and prize**
- Entry costs Shards, the website's existing currency.
- One fixed entry fee for every race, set on the server so it can be tuned without a game update.
- 90% of the pot goes to the winner. The other 10% is a house fee paid to one Zero Chill account (`avalanche_race_config.house_user`, owner's decision 2026-11-24, DECISIONS 60). Until that account is set, the fee is burned (nobody receives it). Results show it as "Fee", or "Burned" while no account is set.

**Race size**
- 2 to 50 riders per race. If more than 50 check in, a second race opens in the same cycle.
- Fewer than 2 checked in: no race, everyone is refunded.

**Ending**
- After a set time the avalanche speeds up and the slope gets denser until nobody can survive, so every race ends naturally (target: within about 4 minutes) and the next cycle starts on time.

**Lobby, chat and spectating** (DECISIONS 66, 67, 69)
- Checking in opens the race lobby: a slim panel at the bottom with a clock that runs to 0, and quick chat (six phrases and six emotes from `QUICK_CHAT`, never free text, at most one line every 1.5 s). Chat reaches only the riders of the same lobby or race.
- Behind the panel the checked-in riders stand on the start grid in their own look, in check-in order, with name tags. A rider who sends quick chat shows it on their tag, and an emote makes them hop. The title stack is hidden while the lobby is open. The camera is a set shot from in front of the grid (`raceShot` in main.js, `s.shot` in camera.js).
- Until check-in locks (8 s before the start, `LOCK_SECONDS`) a rider may leave the lobby and gets the whole fee back (`race_withdraw`, migration `20261126000000_race_withdraw`). Each withdrawal is counted so a second check-in is charged with a fresh ref instead of being skipped as a retry.
- The lobby clock ends 7 s before the start. A 4 s flyover (`CONFIG.race.introSeconds`) sweeps from the lobby shot over the grid and settles behind the fox, under a race banner (riders and pot); then the 3-2-1 (`CONFIG.race.slopeCount`) plays on the slope with the HUD.

**Start grid and looks** (DECISIONS 70, 71)
- At the lock the server shuffles the riders into the grid (`gridStart` in sim.js: rows of 4, 2 m lanes, rows 3 m apart, front row furthest down). A rider's index is their slot; the countdown sends each rider's `start`, and every Sim of that ride (phone, server, bot check, rematch) starts from it.
- The server reads each rider's outfit, board and trail from their profile (`race_looks`, migration `20261128000000_race_looks`) at check-in and again at the lock, and sends them in the lobby (`next.looks`, `next.me`) and the countdown (`riders[].look`). A failed read leaves the default look.
- Other riders are full riders in that look (`src/render/racers.js`) with their worn trail and sparks: 6 on high quality, 4 on medium, 3 on low (each is about 125 meshes). A rider that would hide the fox or the slope just ahead of it fades to 30 % with its ink outline off.
- Tested: the race server suite rides a 5-rider grid race (slots, starts, death ticks agree, looks). In the browser against four Node riders: the lobby grid with tags and emotes, leaving the lobby, a full 5-rider race from the grid, and the intro stepped frame by frame (lobby shot, flyover, 3-2-1 behind the fox); fading and trails checked in numbers and one screenshot. Not yet seen: a phone, Safari, the banner animation (the hidden pane freezes CSS animations).
- A rider who is out while at least two others still ride follows one of them (switchable with the arrows) until the results, and can still send quick chat. Leave goes back to the title.

**Ties and disconnects**
- Riders who die on the same simulation frame are ranked by distance travelled; only an exact tie on distance too splits the 90%.
- A rider whose inputs stop arriving is out at their last confirmed frame. No refund.

## Needs from the website (Lovable)

Shards are not in the API handoff. The race server needs server-only functions (never callable from the browser) to:
- hold a player's entry fee at check-in (escrow),
- pay the winner and the 10% house fee (burned while no house account is set),
- refund every entry when a race is cancelled.

Until those exist, the local build uses stand-in test Shards.

## Risks to settle before real Shards

- **Legal:** checked without a lawyer on 2026-11-24, see `docs/race-legal-check.md`. Shards can be bought with money, so a paid entry for a Shards prize is risky in several US states, and it conflicts with the site's Terms ("No purchase is ever needed to enter an event or win a prize"). The 10% house cut adds to the risk. The owner kept paid entry, limited by the Terms only (DECISIONS 61); the website team updates the Terms (`RACE_HANDOFF.md` section 5).
- **Bots:** the game is deterministic, so a bot could play for someone. Agreed defence (below): a win that follows the game's own bot voids the race. A bot written from scratch is not caught yet.

## Before publishing (owner, 2026-11-24)

**The practice riders are removed** (done on this branch, merged at publish time): `server/bots.mjs`, `server/test-accounts.mjs`, the `@avalanche.test` exemption from the bot check (`practice` in `server/index.mjs` and `server/race-room.mjs`) and the `&racebot` switch. Every race winner is now judged, locally too. `server/test.mjs` wins its paid race with a rider who holds hard left, which outlasts a rider who doesn't steer on that short slope without riding like the bot.

## Open

- Check-in window and countdown timings. (Entry fee: the owner kept 10 test Shards for testing, 2026-11-23; revisit against real Shard balances before going live.)
- Legal: checked 2026-11-24 (`docs/race-legal-check.md`); the owner kept paid entry, limited by the Terms (DECISIONS 61).

**Hosting (owner, 2026-11-23): Colyseus Cloud.** Its docs require the `defineServer()` setup, and by default it runs one process per CPU in every region; the race needs exactly one process in one region (one race cycle). The website side is in `RACE_HANDOFF.md` (draft).
- Done: `server/index.mjs` uses `defineServer`; `server/ecosystem.config.cjs` pins PM2 to one fork process; `@colyseus/tools` is installed (Colyseus hands `listen()` to it on Cloud); `npm run build` is a no-op. Names come from `avalanche_player_name` (local stand-in in `shards_wallet.sql`); `race_board` is PL/pgSQL so it can be created before that function exists.
- Website path: the game asks the page for `race_token` and connects with it (`src/systems/host.js`). `tools/host-mock.html` has "Race on" and signs a local test account in to answer it. Checked: connect as the chosen account, signed out (no in-game sign-in button), back in.
- **Deployed (2026-11-25):** app "Avalanche Run", one region (Singapore), at `https://sg-sgp-b4a82550.colyseus.cloud`. That address serves the game and the race: riders open `https://sg-sgp-b4a82550.colyseus.cloud/?portrait&live&race=here`. Every push to `main` redeploys it. The PC server and tunnel (`docs/race-from-this-pc.md`) are retired.

## Colyseus Cloud setup (done 2026-11-25)

From the Colyseus Cloud docs ([cloud](https://docs.colyseus.io/cloud), [continuous deployment](https://docs.colyseus.io/cloud/continuous-deployment), [environment variables](https://docs.colyseus.io/cloud/environment-variables), [compute plans](https://docs.colyseus.io/cloud/compute-plans)). The owner signs in and clicks through; nothing here needs a code change.

**Create now (owner, in the Cloud dashboard):**
1. Create an application. Pick **one region** only (each push deploys to every region the app has, and the race needs exactly one race cycle). Choose the region nearest most players.
2. Settings → Build & Deployment: connect the GitHub repository `devteamzerochill/avalanche-run`, branch `main`.
3. **Root directory:** `server` (it holds `package.json` and `ecosystem.config.cjs`). **Build command:** leave the default (`npm run build`). It builds the game into `dist/web/` (`node ../tools/build.mjs`), which the server serves when `SERVE_GAME=1`, so the Cloud address carries both the game and the race, like the tunnel did.
4. **Watch paths:** `**` minus `!docs/**`, `!tests/**`, `!supabase/**`, `!videos/**`, `!*.md`. The server runs the game's simulation from `src/core/` and serves the built game, so a game change must redeploy it.
5. Compute plan: the smallest plan that is always on is enough for the first races (one process; the replay is light).

**Environment variables** (Settings → Environment variables, encrypted): `SUPABASE_URL` for zerochill.com, `RACE_SERVER_EMAIL` and `RACE_SERVER_PASSWORD` (the race server's own site account, entered by the owner; DECISIONS 64), and `SERVE_GAME=1`. No anon key is needed: for the live URL the server uses the public one in `CONFIG.online`.

**How Cloud starts it:** PM2 runs `server/ecosystem.config.cjs` (one fork process, `wait_ready`). Cloud hands the variables over in `/etc/environment` and `.env.cloud`, which `@colyseus/tools` loads when it is imported, so `server/index.mjs` imports it first under PM2 (`pm_id` set), then listens on Cloud's socket with its `listen()`, which also sends PM2's ready signal. The tests never import `@colyseus/tools`: it would load `server/.env` and point them at the live site.

**Checked on the first deploy (2026-11-25):** Cloud keeps the whole repository (`../src/` resolves) and runs Node 24. The address serves the game. A join with a bad token is refused with "sign in to race". The race account opened a race on the live ledger. Only **one** process runs (`instances: 1`); two would run two race cycles.

**The game races on Cloud (2026-11-25):** `CONFIG.race.server` is `wss://sg-sgp-b4a82550.colyseus.cloud`. Local Supabase sessions keep the local server (`CONFIG.race.localServer`, `ws://localhost:2567`): `?live=local`, or a page on localhost without `?live` (`tools/host-mock.html`). `?race=here` still means the server serving the page. Checked: the choice for each case, and a cross-origin join from a localhost page reaching Cloud's matchmaker. Still to do: send the address to the website team for their CSP (`RACE_HANDOFF.md`).

## Prototype (local, 2026-11-23)

Built and tested on this PC with the local Supabase and test Shards. Nothing is deployed.

**Pieces**
- `server/`: the Colyseus 0.18 race server, its own Node package (`npm install` there once). `race-room.mjs` runs the cycle and replays every rider with `src/core/sim.js`; `supabase.mjs` checks sign-ins and calls the ledger; `test.mjs` plays real races.
- `supabase/migrations/20261125000000_endurance_race.sql`: race config, races, entries, and the server-only ledger functions (check-in escrow, start, cancel with refunds, settle with payout and house fee). It calls three wallet functions the site would provide; locally they are `supabase/local-standins/shards_wallet.sql` (every wallet starts with 100 test Shards).
- Game: `src/systems/race.js` (client; loads `vendor/colyseus.js` only with `?race`), race wiring in `src/main.js`, the race button, HUD counter and panel in `src/ui/ui.js`. The avalanche ramp is `opts.ramp` in `src/core/sim.js`, values in `CONFIG.race`.

**How a race runs**
- Check-in is always open for the next race. 5 s before the start, entries close; fewer than 2 riders means every fee is refunded.
- The countdown takes over the game wherever the player is. Each phone simulates on the server's clock (every due tick, so slow frames never fall behind) and sends its inputs 10 times a second.
- The server steps each rider's simulation with those inputs. A death is the tick the simulation leaves riding. Out also: inputs stop for 3 s, the player leaves, inputs arrive more than 1 s ahead of server time, or the input stream doesn't line up.
- The others are drawn (nearest 6; in their own look since DECISIONS 71) from the server's positions, 10 updates a second.
- The race is decided once one rider is left and confirmed past the last death. The winner keeps riding; everyone sees the standings, prize and fee.
- The ramp (0.3 m/s per second after 190 s) catches even the best test bot by about 4:10.

**Run it locally**
1. `npx --yes supabase@latest start` in the game folder.
2. Race server: the `race-server` launch entry (`node server/index.mjs --cycle=60`, a race every minute; leave out `--cycle` for 5 minutes).
3. Game: `/index.html?portrait&live=local&race`, sign in with an account from `supabase/local-standins/test-account.json` (a `db reset` deletes them; sign up again through the local stack).

**Verified**
- `node server/test.mjs` (7/7 then; 9/9 with the bot defence): cancel and refund; last alive wins; server and phone agree on the death tick; a sped-up client is out; display names and race record; 90% payout and 10% burn (no house account); an exact tie splits the prize and, with a house account set, it gets the fee and the odd Shard; leaving counts as dying.
- In the browser against two practice riders: check-in, countdown, riders-left counter, ghosts placed from server positions (checked in numbers, not caught in a screenshot), out panel, results, prize credited, back to title, and a daily run afterwards.

**Polish (2026-11-23)**
- In the race: place and gap in the HUD (other riders are carried forward to this phone's tick before comparing), an "X is out" side feed, name tags over the ghosts, the riders either side by name on the card, pass and gap lines in the side feed (DECISIONS 62), and a winner banner with confetti.
- Names come from the account's display name (falling back to the email prefix). The race record (races, wins, Shards won) comes from the entries.
- The client reconnects by itself (2 s doubling to 15 s), except after a refused sign-in. When the server rules a rider out (dropped, out of sync), the phone stops too and shows the out panel.
- The race panel: a countdown hero with a time bar, pot / checked in / winner gets, a Check in button styled like Play (a "You're in" badge after), the record as tiles, and the rules as three lines. It uses the game's italic display type. The race UI is in en, es and zh.
- The race HUD: a place card beside the pause button (place, riders left, ▲ lead over the next rider or ▼ distance to the leader), with a pack strip under it showing every rider still in within 100 m either side. Name tags use the callout style and the leader's has a crown; "X is out" callouts are coral with a ✖. Checked on screen in a live race (in Chinese): the card behind and in the lead, the strip, the tags and crown, and a win with the banner. The out callout was checked through its computed style, not caught in a screenshot.
- Results: your own place as a hero card (gold, with your prize, when you win), a podium for the top three (medal, name, distance, time and how they went out; your column outlined), rows for 4th to 10th, and Prize / Burned chips. Riders who weren't in the race see the same podium under "Last race". Checked after a real 3-rider race: the content (place #3 of 3, podium order, prize 27, burned 3) and the layout by measurement (equal columns, stepped bars, no text overflow). The browser window was out of view, so no screenshot of it yet, and the winning version was not seen.
- Smooth ghosts: along the slope, the drawn position moves every tick at a smoothed speed (from the last six updates, eased in over about a third of a second) and eases towards each new estimate, snapping only if more than 15 m off. Across and up, ghosts are drawn 8 ticks behind the newest update and blended between updates. Offline, on real sims with bursty 10 Hz updates and steady 60 fps frames, wobble along the slope fell from 5x the rider's real motion to about 2x (0.004 vs 0.002 m per frame), and sideways from 3x to under 2x. Cost: ghosts are drawn about 1.4 m behind where they really are on average (the HUD place and gap use the exact estimate). Not yet watched in the browser: the pane kept going hidden.
- The main ghost shake: for drawing, the rider and camera are carried forward by the part of a tick not yet simulated (`lead` in render), but ghosts were placed in whole ticks, so each ghost slid back up to one tick of travel (about 0.8 m at 50 m/s) against the rider every frame. In a race, frames land at random points inside a tick (the sim runs on the server clock), so this showed as vibration, worst up close. Ghosts (race and daily replay) are now carried forward by the same lead. The owner confirmed in a race (2026-11-23): smooth now.
- No scrolling (2026-11-23, owner chose tabs): the race panel has Race / Results / Record tabs. Race: the out card while waiting, the countdown card, Check in, Back. Results: your place in one row, the podium, 4th to 8th plus your own row if further down (one line each), Prize / Burned chips, Back; it opens by itself when a race you rode ends, and a dot marks unseen results. Record: Shards, the three stat tiles and the rules. Measured with animations off on the 450x800 layout: every tab fits in the worst case (a 12-rider result with your card and Back, winning or not). How to play uses compact rows and fits too.
- No pausing: pause() refuses during a race (Esc, P, the button, a hidden tab and a sideways phone all go through it), and the pause button is hidden while racing, with the place card moved into its corner. Checked in a live race: no button, Esc and P do nothing; after the race, a daily run has the button and pauses.
- Title race card (2026-11-23, owner: the race is the highlight): a bold card (since moved below PLAY at the owner's request) replaces the old chip, with a LIVE badge, the countdown, pot and riders in, and one button for the next step (Sign in to race, Check in, You're in, Not enough Shards, or Open while connecting). Tapping the card opens the race panel. The tagline hides while the card shows, so nothing reaches the logo. Checked in the browser: check-in by a real tap, the in, low-Shards and signed-out states, and en/es/zh widths.
- Checked in the browser: check-in by click, the panel's ready and checked-in states (Spanish and three-digit fees fit on one line), the stats tiles, reconnect after a reload, and a dropped rider shown as "connection lost" in the results. Not yet seen on screen: the out hero, the winner banner, and the es/zh panels.

**Race length (2026-11-23, owner chose about 4 minutes)**
- The avalanche ramp now starts at 190 s (+0.3 m/s per second). On seeds 1-6 the perfect bot is caught at 3:38-3:52 and the human-like bot at 3:47-4:07, which leaves about a minute for results and check-in in the 5-minute cycle.

**Dense endgame (2026-11-23, owner chose: by distance, shared, 2:00 to 3:00)**
- From 7,000 m to 11,000 m (about 2:00 to 3:00 into a race) the slope builds up: rows end 30% closer and the chances of extra hazards in a row rise by half. Every rider on the seed sees the same slope. It travels with the race's ramp (`denseFrom`, `denseTo`, `denseRows`, `denseExtra` in `CONFIG.race.ramp`), so the server can tune it; daily runs are unchanged.
- At full density there are about 28% more deadly hazards per km (74 to 94 per 3 km). A new test runs the independent fairness validator on 30 race courses to 14 km; the narrowest safe line is still 1.9 m.
- Both test bots still last until the avalanche ramp (perfect bot 3:44-3:57, human-like bot 3:58-4:11 on seeds 1-8), so races still end around 4 minutes. How much it thins real riders in minute three can only be seen with people.

**Race leaders (2026-11-23, owner chose: leaderboard in Ranks)**
- With races on, Ranks has Today / Race tabs. Race shows your record (races, wins, Shards won) and the top 8 riders by wins, then Shards won, with your row pinned below when you're further down. Only settled races count. It comes from `race_board` (service role) through a `board` message on the race server. Names come from the account's display name, else the email prefix; on the website this will need Lovable's profile names.
- Checked in the browser by real taps: both tabs, no scrolling. Server test: the payout winner's row, the voided winner absent, top 8 by wins.

**Rematch (2026-11-23, owner chose: against the podium)**
- On the Results tab between races, "Ride it again" rides the last fair race's slope (same seed, ramp and dense endgame) against the ghosts of its top 3, replayed on the phone from their inputs. Practice only: no fee, nothing saved or counted, and a race countdown takes over as usual. Each ghost stops at the tick its rider went out. Afterwards it goes back to the title with a toast ("Rematch: #2 of 4 · 1393 m").
- The server keeps only the last race, in memory (a restart forgets it, and the button then says the race can't be ridden again). A voided race offers no rematch.
- Server test: the rematch is the last fair race, not the voided one, and every ghost replays to the server's exact distance and tick. In the browser: a full rematch against three recorded rides (ghosts with medal tags, the place card, the end toast) and the button by a real tap. Not yet seen: a rematch started from a real 4-minute race.

**Home screen (2026-11-23, owner)**
- PLAY and the race are two panels side by side with separate backgrounds: Solo (best today, best and streak, PLAY) and the multiplayer race (LIVE on the top edge, countdown, pot and riders, a two-line CHECK IN with the fee). The bests line folds into the Solo panel while races are on. Checked in en/es/zh with nothing cut off (Spanish uses "CARRERA" and "UNIRME"), PLAY by a real tap, and the page without races unchanged.

**Bot defence (2026-11-23, owner chose: void the race, refund all)**
- There is no back office or anyone to review replays, so the server decides on its own. When a race ends, the server replays each winner's inputs next to a shadow copy of the game's `Bot` that sees the same slope (`server/scripted.mjs`). If the win follows the bot, the race is voided: nobody is paid, nothing is burned, every fee goes back, and the standings are kept with the reason (`race_void`, status `voided`, `void_reason`). A voided race is not on anyone's record. Riders see "RACE VOIDED" with "Entries refunded".
- Flagged as scripted (after at least 5 s of riding): the same target as the shadow on 90% of the ticks it aims off the centre line (the plain bot), or steering within 0.5 m of the shadow on 75% of ticks at the best delay up to 24 ticks, with a mean gap of 0.45 m or less, and at least 5 jumps with 90% of them 0-6 ticks after the shadow's (the human-like bot).
- Short races (added 2026-11-24): a win with fewer than 5 jumps is too short to judge jump timing, and before this a human-like bot win in a short race was paid. Now, on ticks where the shadow aims off the centre line, steering within 0.5 m of it on 72% of them with a mean gap of 0.38 m or less, at least 5 s of such ticks, and every jump (if any) on the shadow's cue, is scripted. Measured on 40 HumanBot rides on the race slope: caught 27/40 at 10 s (most have under 5 s of off-centre steering), 38/40 at 20 s, 39/40 at 30 s, 40/40 at 45 s. In a real local race (practice exemption off) a 17.9 s HumanBot win with 2 jumps was voided. The owner then won two real local races with the bot check on (2026-11-24): a 24 s win (off-centre following 39%, gap 0.78 m, 1 of 13 jumps on cue) and a 45 s win (46%, 0.76 m, 1 of 22). Both were paid. Neither came under the short rule, because people jump far more than the bot (13-22 jumps against the bot's few), but their steering sits far from the 72% / 0.38 m line either way.
- Calibrated on the owner's real run (seed 3424911021, 57 s) against three seeds of each bot: exact matches 0.2% (human) vs 100% (bot); following 45% / 1.02 m / 5 of 19 jumps on cue (human) vs 84-88% / 0.22-0.32 m / every jump (human-like bot, full races and 60 s runs). Only one human run was available, so collect more real races before real stakes.
- The client no longer runs `?bot` or `__GAME.bot` in a race. Every winner is judged; the local practice exemption was removed before publishing.
- Checking a winner replays the whole race once (about 0.3 s of server time for a 190 s race), only for place-1 riders.
- `node server/test.mjs` (9/9) adds: a bot win on a normal account is voided and both riders are refunded with nothing on their record; the tie race's winners are judged and paid.

**Known gaps**
- A hidden tab stops sending inputs and is dropped after 3 s (as agreed: a drop is a death).
- A bot written from scratch (not the game's own) is not detected; the check only catches riders who follow the shipped bot.
- A bot win in a race shorter than about 10 s of steering is not judged (too little to tell). From 2026-11-24 a short win (fewer than 5 jumps) is judged on steering away from the centre line instead of jump timing; two real short-ish wins by the owner (24 s and 45 s) passed with a wide margin. That is still only three human rides in all, from one person; a player who rarely jumps has not been measured.
