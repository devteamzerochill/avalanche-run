# Avalanche Run

Endless snowboard run down a daily mountain, chased by an avalanche. three.js, mobile-first, portrait and landscape.

## Run

Development (no build step, any static server):

```bash
node tools/serve.mjs 8123
```

Open `http://localhost:8123/`. Useful query flags: `?bot=1` (bot plays), `?seed=123`, `?test` (fixed seed, muted, no saves), `?ad` (playable-ad behaviour).

Tests and build need Node 18+ and nothing else:

```bash
node tests/run.mjs
node tests/db.mjs     # server APIs, needs the local Supabase (see LOVABLE_HANDOFF.md)
node server/test.mjs  # endurance race server (see docs/endurance-race.md)
```

```bash
node tools/build.mjs
```

The build writes `dist/web/` (index.html, game.js, assets/), `dist/avalanche-run-playable.html` (one self-contained file, playable-ad behaviour), `dist/avalanche-run.html` (one self-contained file with no ad layer: no time cap, no store button) and `dist/avalanche-run-artifact.html` (the same without its own `<html>`/`<head>`/`<body>`, for publishing as a claude.ai artifact).

## Gameplay video

A frame-exact 60 fps recorder (macOS with Xcode; no other installs). It plays the scripted scenario in `tools/record-scenario.js` with the human-like bot. With the dev server running on port 8123:

```bash
swiftc -O tools/record.swift -o build/record
```

```bash
build/record --seconds 60 --out videos/avalanche-run-gameplay-60fps.mp4
```

Options: `--url` (defaults to `dist/web/index.html?record&seed=777`), `--width`/`--height` (1080×1920), `--fps`, and `--scenario-opts '{"play":5.5,"letGo":43,"hold":6.5}'` (seconds: press PLAY, bot gets distracted, end-card hold). `build/probe video.mp4 outdir 1,30` prints frame count and loudness, and saves sample frames.

## Controls

| | Touch | Keyboard |
|---|---|---|
| Carve | drag (or hold left / right with the tap-steer option) | ← → or A D |
| Jump | tap | Space, ↑, W |
| Grab | press and hold while in the air, let go just before landing | hold Space, ↓ or S in the air |
| Pause | pause button | Esc or P |

## Layout

```
src/config.js      every tuning value
src/core/          deterministic simulation: rng, course generator, sim, bot, replay
src/systems/       input, audio, save, meta, services (online stand-ins), i18n, haptics, playable-ad layer
src/render/        stage and moods, terrain shader, props, rider, avalanche, particles, camera
src/ui/            DOM screens, HUD, styles
tools/             build.mjs, serve.mjs, extract_proto.py
tests/             run.mjs (suite), validator.mjs (independent fairness check), smoke.mjs (bot survey)
```

## Playable-ad parameters

Set before the game script: `window.__PARAMS` (same keys as the prototype, e.g. `startSpeed`, `maxSpeed`, `cameraFov`, `background`, `uiAccent`, `endTitle`, `ctaText`, `maxPlayTime`), `window.__STORE = {ios, android}`, `window.__LANG`. Lifecycle events are dispatched as `avalanche:event` (`boot`, `gameplay_start`, `endcard`, `replay`, `cta`). `window.__GAME` exposes `info()`, `step(n, dt)`, `begin()`, `bot(on)`, `stats()`.

## Hosting on zerochill.com

The website embeds `dist/web/` in an iframe with `?portrait&host=<page origin>` and makes every API call itself; see WEBSITE_INTEGRATION.md. For local testing open `/tools/host-mock.html` from the dev server: a fake host that answers like the live API and can force each outcome.

See TEARDOWN.md, DESIGN.md and DECISIONS.md.
