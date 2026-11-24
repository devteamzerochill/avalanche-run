# Avalanche Run: working notes

A mobile-first arcade snowboard runner (three.js r160, vendored) rebuilt from a minified playable-ad prototype. You ride as the **Zero Chill fox** (the owner's company mascot) and outrun an avalanche down a seeded daily mountain. The owner directs the look and feel; read `DECISIONS.md` (65 numbered entries) before changing anything. It records why each choice was made.

## Commands

No npm dependencies; Node 18+ only.

```bash
node tests/run.mjs        # 39 tests: determinism, fairness validator, scoring, bot reaching 2,000 m, server catalogue matches config
node tests/db.mjs         # server profile APIs against the local Supabase (needs Docker + npx supabase start)
node tools/build.mjs      # writes dist/ (see below)
node server/test.mjs      # endurance race server: real races against the local Supabase (npm install in server/ once)
node tools/serve.mjs 8124     # dev server from this folder; open /index.html, /dist/web/index.html or /tools/host-mock.html
```

The project moved from a Mac to a Windows PC (2026-11-23). The PC has Node 24 and no Python, so use `tools/serve.mjs` (also what `.claude/launch.json` runs). Git: private repo `devteamzerochill/avalanche-run` (set up 2026-11-23 for the Colyseus Cloud deploy, which pulls the whole project because the race server runs `src/core/`). `main` started empty; work goes on branches and pull requests. When testing in a browser, mute the game (`__GAME.game.audio.setMuted(true)`, which doesn't touch saved volumes).

Build outputs in `dist/`:
- `web/`: multi-file web build.
- `avalanche-run-playable.html`: single-file playable ad (ad layer, 300 s cap, store CTA, landscape layout allowed).
- `avalanche-run.html`: single-file web player (no ad layer, portrait lock).
- `avalanche-run-artifact.html`: the player without `<html>/<head>/<body>`, for the claude.ai artifact.

Useful query flags: `?bot=1`, `?seed=123`, `?test`, `?ad`, `?portrait`, `?fps`, `?bench=20`, `?record`. Debug hook: `window.__GAME` (`info()`, `begin()`, `back()`, `bot(on, { human: true })`, `step(n)`, `game`).

## zerochill.com integration

The live site hosts the game in an iframe; the page makes every API call and the game talks to it over `postMessage` (`src/systems/host.js`). The contract is in `WEBSITE_INTEGRATION.md`; the API handoff it is based on is `docs/api-handoff-2026-11-23.md`. The owner has no access to the website repo, so the website side is built by its own team. `tools/host-mock.html` is a fake host that answers like the live API and can force every outcome (counted, no reward, duplicate, rejected, network failure, session lost); test online changes there, never against the real backend. The score is `floor(metres) + near-miss bonuses` to match the old game (DECISIONS 53); trick points are added everywhere except runs zerochill.com scores, which wait for `CONFIG.score.tricksLive` until the site agrees (DECISIONS 63, `LOVABLE_HANDOFF.md`). The handoff is the source of truth for what the backend offers; don't propose asking Lovable about features it doesn't list. The handoff has no streak or profile endpoints, so we are building them (DECISIONS 58).

**Server APIs we add:** developed on a local Supabase in `supabase/` (`npx --yes supabase@latest start`, Docker Desktop required), then handed to Lovable. `supabase/migrations/` is what Lovable applies; `supabase/local-standins/` copies the live functions for local testing only and is never deployed. Slice 1 (profile: snowflakes, unlocks, missions, streak) is written up in `LOVABLE_HANDOFF.md` and is not live yet. `/index.html?portrait&live=local` plays against the local stack with the account in `supabase/local-standins/test-account.json` (a `db reset` deletes it). New APIs wrap the live functions; they never modify them.

**Multiplayer race** (shown to players as "Multiplayer race"; internally still "endurance": the Colyseus room, file names, i18n keys): a live last-rider-standing race every 5 minutes with a Shards entry fee (the 10% house fee goes to `avalanche_race_config.house_user`, burned until the site sets it), on a Colyseus server in `server/` that replays every rider with `src/core/` (DECISIONS 59). Design, how to run it locally and known gaps: `docs/endurance-race.md`. Opt-in with `?race` (with `?live=local`). The race server is the `race-server` launch entry; The practice riders, their exemption from the bot check and `&racebot` were removed before publishing (owner, 2026-11-24); a local race needs two signed-in accounts. The browser pane only draws about one frame a second when it is not focused, which gets a race rider dropped; drive frames with `setInterval(() => __GAME.step(4, 1/60), 100)` and stop it before a person plays. The race ledger is live on zerochill.com (migration 0310) and real races run from the owner's PC through a Cloudflare quick tunnel, with real Shards and a race server account instead of the service key (DECISIONS 64, `docs/race-from-this-pc.md`); local development still uses test Shards. Races get denser from 7 to 11 km (race-only course setting in `CONFIG.race.ramp`). Ranks has a Race leaders tab, and Results offers a rematch against the last race's podium. A win that follows the game's own bot voids the race and refunds everyone (`server/scripted.mjs`). Live hosting will be Colyseus Cloud (server already in its `defineServer` setup, one process); the website side is `RACE_HANDOFF.md`, and `tools/host-mock.html` can race with "Race on". `supabase/local-standins/test-account.json` holds local accounts (a `db reset` deletes them).

**Live test mode:** `/index.html?portrait&live` connects straight to the real backend (`src/systems/live.js`, DECISIONS 57) with an in-game email + password sign-in. Writes are real and public: counted runs show on today's zerochill.com board. Never type the owner's password; they sign in themselves. Read-only checks (`landing_board`, `daily_pop_bars`) need no sign-in. Lovable confirmed (2026-11-23): CORS is open, no origin checks, email confirmation off, no test flag for this game, no tournament live. First live save verified 2026-11-23 with the owner's account: start_game_run issued a run id, submit_avalanche_score counted 3262, rewards and Daily Reward came back, and the run showed on the public board.

## Published artifact

The game is published at https://claude.ai/artifact/JnTQMKbipLCs5inWNdTe4D (version 6 since 2026-11-24, shared "anyone with the link"). Artifacts block every outside connection, so the artifact plays offline: no live saves, no races. To update it, rebuild and publish `dist/avalanche-run-artifact.html` to that URL. A new session must read the artifact first, then publish with `url`.

## Gameplay video

`tools/record.swift` is a frame-exact 60 fps recorder (macOS + Xcode, nothing else). `?record` puts the game on a virtual clock; the audio renders offline in lockstep. The script is in `tools/record-scenario.js` (title → play → human-like bot → distracted wipeout → end card → title). See README "Gameplay video". `tools/probe.swift` checks output. The 60 s video lives in `videos/` and is not in the zip.

## Architecture in one breath

- `src/core/`: deterministic sim (fixed 60 Hz, only + − × ÷ √, seed + inputs → replay). `course.js` plans a safe line first. `bot.js` has the test `Bot` and the `HumanBot` (reaction delay, spring finger, lazy carves, air tricks, `distracted`). Bump `CONFIG.version` if sim rules change. For drawing, `main.js` carries the rider forward by the part of a tick not yet simulated (`this.lead`); anything else drawn relative to `sim.dist` (ghosts, race riders) must add its own speed × `lead`, or it shakes against the rider.
- `src/render/`: toon materials + inverted-hull ink outlines, GPU terrain, avalanche lobe, particles. `rider.js` is the IK rig; `fox.js` is the sculpted head, ears and fur texture.
- `src/systems/`: audio (samples + synth SFX + procedural chiptune), save, meta, input, i18n (en/es/zh), perf, record, host (zerochill.com bridge).
- `src/ui/`: DOM HUD and menus, `style.css`, `frame.js` (portrait frame: fixed 450×800 layout scaled to fit on screens wider than 9:16).

## The owner's standing preferences (from the conversation)

- Arcade look in the spirit of Mario Kart / Sonic, but all original assets. Keep the core avalanche mechanics.
- The avalanche is a wall/lobe of snow, never a monster. It sits close behind the rider and is narrow (about 40 m), not screen-wide.
- Ink strokes are light (about 0.42× of the first pass).
- UI theme: **Glacier** is the default, with coral danger accents; **Arcade** must stay selectable. The scrolling stripe and dot patterns must loop seamlessly, and must animate in Safari (no `var()` inside `@keyframes`).
- Feedback callouts (near miss, grab, …) go in a side feed, never over the path ahead. Coins are toned down, not glaring.
- The rear-view mirror shows only occasionally (every 12 s, when danger > 50 %, after a stumble).
- Deaths end with the avalanche burying the rider.
- Announcer voice is off for now (`CONFIG.announcer = false`); the code stays.
- The fox: Zero Chill mascot colours, black hoodie with the chest print, blue-ringed headphones, big **all-black snowboard goggles covering the top half of the face** (eyes hidden; `GOGGLES_DOWN` in `rider.js`). Looks downhill while riding; faces the camera only on menus.
- The web player is locked to portrait so the UI is identical on every screen.
- Board spray comes off the tail of the board at any frame rate.
- Menus and panels use the game's heavy italic display type for headings and numbers. Every striped (primary) button uses the Play button's lettering: heavy italic, all caps, wide letter spacing.
- Panels should fit the 450×800 portrait layout without scrolling; split long ones into tabs (the race panel has Race / Results / Record).
- The home screen stays roomy (owner, 2026-11-23). With races on, PLAY and the race sit in two panels side by side, each with its own background: Solo (best today, best and streak, PLAY) and the multiplayer race (countdown, pot, riders, CHECK IN); without races, PLAY stands alone under the bests line. Otherwise: the bests are one slim line, the account is a small chip in the top bar, and the Daily Reward is a thin bar on the Missions button with the full bar at the top of the Missions panel. Don't add new blocks to the title stack.
- Use they/them for anyone whose pronouns are unknown.

## Verifying changes

Run the tests and the build, then look at it in a browser: phone portrait, a landscape desktop window, and Safari if possible. Safari in Low Power Mode caps at 30 fps; auto quality ignores steady caps. A background browser tab freezes CSS animations, so layout measurements taken there can be wrong.
