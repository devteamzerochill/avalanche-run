# Avalanche Run v01 — prototype teardown

Source: `avalanche-run-v01.html` (1.72 MB, one file). Everything below was read out of the minified bundle.

## 1. File anatomy

| Part | Size | Notes |
|---|---|---|
| HTML + CSS + favicon | ~25 KB | DOM UI: loader, title, how-to card, HUD, end card, frost overlay, speed-line canvas |
| `window.__PARAMS` | 1.6 KB | Live tuning values (snake_case and camelCase duplicates) |
| `window.CONFIG` | 6 KB | Parameter schema (label, group, min/max, `apply: live|restart`), camera family, palette, fixed test seed `20261115` |
| `window.STRINGS` | 6 KB | en / es / zh, 60 keys each |
| `window.__ASSETS__` | 916 KB base64 | 1 model + 8 sounds (below) |
| three.js (tree-shaken, minified) | ~430 KB | Bundled together with the game code |
| Playable framework + game code | ~105 KB | Parameter store, i18n, audio engine, auto-rigger, analytics hooks, game |

### Embedded assets

| Key | Type | Size | Verdict |
|---|---|---|---|
| `flex` | GLB | 417 KB | **Not rigged.** One AI-generated (Tripo) static mesh, 43,770 vertices, one WebP texture, no skeleton, no animations. The prototype builds a skeleton and poses for it at runtime. Replaced (see DECISIONS). |
| `snd_music` | MP3 | 181 KB | Reused |
| `snd_ambience`, `snd_rumble` | MP3 | 32 KB each | Reused (wind loop, avalanche loop) |
| `snd_action`, `snd_carve`, `snd_hit`, `snd_land`, `snd_nearmiss` | MP3 | 4–6 KB each | Reused |

The brief says 9 embedded sounds; the file holds 8. The other effects (`tap`, `pickup`, `stage`, `win`, `lose`, `timeout`) are synthesised with WebAudio.

## 2. Tuning values

| Parameter | Value | Range in schema |
|---|---|---|
| Start speed | 26 m/s | 16–40 |
| Top speed | 61 m/s (≈220 km/h) | 40–80 |
| Speed gain | 0.9 m/s per second | 0.3–2 |
| Thumb travel for a full carve | 60 % of screen width | 30–100 |
| Jump airtime | 0.72 s | 0.5–1.1 |
| Jump apex | 1.55 m (constant) | – |
| Obstacle density | 100 % | 50–160 |
| Hazard kinds at start | 4 | 2–5 |
| Avalanche pressure | 1.0× | 0.5–2 |
| Near-miss bonus | 25 m | 0–100 |
| Milestone every | 500 m | 250–1000 |
| SFX / music volume | 30 % / 20 % | |
| Camera distance / height / pitch | 6.4 m / 3.1 m / 14° | |
| Camera FOV / follow / look-ahead | 74° / 9 / 16 m | |
| Camera shake / intro zoom / crash zoom | 60 % / 1.0 / 1.15 | |
| Landscape horizontal FOV | 82° (vertical FOV clamped 40–70°) | |
| Slope angle | 11° (whole world group is tilted) | |
| Time cap | 300 s | 30–300 |
| Hint after idle | 3 s | 1–8 |
| Lighting | Morning / Midday | |
| Colours | snow `#EEF4FA`, piste `#E2ECF6`, sky `#2F7FD8`, haze `#CFE4F2`, board `#15161A` / `#1E6FE8`, boulder `#3A4148`, combo `#FFD23F`, accent `#3FD0F5` | |

Hard-coded constants: lane half-width 7.2 m, piste half-width 9 m, player radius 0.36 m, player depth 0.62 m, view distance 300 m, terrain chunk 40 m, max avalanche gap 60 m, starting gap 46 m, near-miss margin 1.1 m, combo window 3 s, combo cap ×4.

## 3. Systems and formulas

**Loop.** `requestAnimationFrame`, frame time clamped to 50 ms, simulation sub-stepped at ≤ 1/60 s. Not a fixed step: the sub-step length varies with the frame time.

**RNG and seed.** Mulberry32. Seed = FNV-1a hash of `"avalanche-run:" + YYYY-MM-DD` (UTC), or `?seed=`, or the fixed test seed in `?test` mode.

**Steering.** Pointer drag, relative to where the drag began: `targetX = x0 + sign · dx · (2·7.2) / (0.6 · screenWidth)`. `x` is set **directly** to `targetX` — there is no carving physics. Keys move `targetX` at 13 m/s. `vx` is only a derived value `(x − prevX)/dt` used for lean, spray and drag.

**Speed.** `cruise = min(61, 26 + 0.9·t)`. `v` eases to cruise with rate 1.1 (`v += (cruise − v)(1 − e^(−1.1·dt))`), minus carve drag `min(4, |vx|·0.12)` m/s².

**Jump.** `y = 4 · 1.55 · u · (1 − u)`, `u = airT / 0.72`. A tap while airborne is stored; if it happened < 0.15 s before landing the jump fires again on touchdown. Tap = pointer up after < 280 ms and < 10 px of travel.

**Avalanche.** `gap += (v − cruise · (1 − 0.06 / pressure)) · dt`, clamped to [−1, 60]. `danger = 1 − gap/60`. Near miss: `gap += 4`. Stumble: `v ×= 0.55`, `gap −= 3`. `gap ≤ 0` ends the run ("caught").

**Hazards.**

| Kind | Shape | Size | Jumpable | On hit |
|---|---|---|---|---|
| Pine | circle | scale 5.0–7.6, radius `0.36·s·0.92` | no | crash |
| Boulder | circle | radius `(0.95–1.65)·0.92` | no | crash |
| Log | box | width 3.4–6.2, half-depth 0.32, height 0.70 | yes | stumble |
| Ice ridge | box | width 3.0–5.4, half-depth 0.7, height 0.8 | yes | stumble |
| Crevasse | box | width 3.0–5.6, depth 2.2–3.4 | no (height 99) | crash |

Kinds available: 4 from the start, a 5th after 600 m (the "+1 after 1,400 m" step is clamped away at the default of 4).

**Generator.** Rows. Rows 1–3 are scripted (pine left, log centre, boulder + pine). After that, with `n = clamp(d/2400, 0, 1)`: 1 obstacle, +1 with probability `0.35 + 0.45n`, +1 with probability `0.5n·density`. One "safe x" is drawn per row; non-jumpable obstacles are re-rolled (up to 12 tries) if they cover it or overlap each other. Next row is `(34 − 13n)/density · U(0.8, 1.2)` metres on.

**Scoring.** `score = floor(distance + bonus)`. Near miss (passing a non-jumpable within 1.1 m): `combo = min(4, combo + 1)` if within 3 s of the last one, else 1; `bonus += 25 · combo`. Clearing a log or ridge shows "CLEAN!" but scores nothing. Milestone banner every 500 m.

**Tutorial.** First time a jumpable is < 0.9 s ahead in the player's lane, time scales to 0.22 until the player jumps. Hints: "drag" until the first drag, "tap" before the first jump, "AVALANCHE!" above 72 % danger, "drag" again after 3 s idle.

**Persistence.** `localStorage["zc-avalanche-run"] = {best, day, bestToday, streak, lastDay}`.

**Camera.** Chase camera in the tilted slope frame; FOV +5° with speed; sine shake scaled by danger and impacts; intro and "caught" poses blended by one factor.

**Rendering.** three.js `MeshStandardMaterial` everywhere, ACES tone mapping, one 1024² PCF-soft shadow map, 8 terrain chunks whose vertices are displaced and re-normalled on the CPU when recycled, 300 instanced pines + 70 rocks + 18 ice blocks as dressing, 2 particle systems (1800 + 420), the avalanche as 260 instanced boxes + 26 sprites, a 2D canvas for speed lines, a CSS frost overlay.

**Quality scaler.** Averages 90 frames; if a frame costs > 24 ms it steps down: pixel ratio 0.75 → 0.5 → shadows off → half particles.

**Playable-ad layer.** Network id, store URLs, live parameter store with `apply: live|restart`, 300 s cap, lifecycle events (`boot`, `gameplay_start`, `endcard`, `replay`), pause/mute hooks, and a large debug API (`step`, `info`, `bot`, `probe`, `project`, `stats`, …) with a built-in bot.

## 4. Weaknesses

**Feel**
- No carving physics: the board teleports to the thumb. No grip, no drift, no weight.
- Jumps are a fixed parabola with nothing to do in the air and no landing quality.
- The avalanche is behind the camera. You read it from a meter and a frost overlay, never as a wall.
- Crash is a 1.9 s spin, then a card. No slow motion, no haptics.

**Depth**
- Two verbs (steer, jump) and one scoring trick (near miss). Skill ceiling is reached in a few runs.
- "CLEAN!" jumps score nothing, so there is no reason to jump anything you can steer around.
- One biome, one look, five hazards. Nothing new after 600 m.
- No collectibles, no route choice, no terrain features.
- Difficulty tops out at 2,400 m.

**Fairness**
- Only one obstacle-free *point* per row is protected, not a corridor the rider fits through, and nothing checks that the safe point of one row can be reached from the last. At 61 m/s rows are 21 m (0.34 s) apart.
- Jumpable obstacles ignore what is behind them: a log can sit directly in front of a pine, so the jump that clears the log lands in the tree.
- The second and third obstacle of a row are offset ±3 m along the slope, enough to close a gap diagonally.
- Crevasses are 2–3 m long but "cannot be jumped", which contradicts what the player sees.
- The end card names the hazard, but not what the player did wrong.

**Meta**
- Best, today's best and a streak counter. No leaderboard, missions, unlocks, rewards or ghost. The title screen says "coming soon".

**Tech**
- Variable sub-step and `Math.random()` in gameplay-adjacent code: a run cannot be replayed or verified.
- One 200 KB minified file, no source structure; tuning is split between `__PARAMS`, `CONFIG` and literals.
- 43,770-vertex hero with runtime rigging, PBR materials and a shadow map on a mobile target.
- Terrain normals are recomputed on the CPU. 1.72 MB download, of which 556 KB is the hero model.
- No accessibility options, single volume toggle, drag-only on touch.
