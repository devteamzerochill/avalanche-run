# Avalanche Run — game design

Endless snowboard run down a daily mountain, chased by an avalanche. Mobile-first, portrait and landscape, three.js. Ships as a web build and as one self-contained HTML playable.

## 1. Pillars

1. **Speed you can read.** Everything that can kill you is visible, distinct and avoidable at any speed the game can reach.
2. **One thumb, three verbs.** Carve, jump, grab. Each verb has a risk and a reward.
3. **The wall is always there.** The avalanche is something you see, hear and feel, not a meter.
4. **Same mountain, every rider.** A deterministic simulation makes the daily mountain, ghosts and run verification possible.

## 2. Core loop

Ride → dodge and jump → chain near misses, clean jumps and tricks into a combo → perfect landings give boost → boost opens the gap to the avalanche → the mountain gets denser and changes biome → crash or get caught → end card explains why → missions, flakes and unlocks → ride again against your ghost.

**Score** = distance (m) + bonuses. Bonuses are always "metres", so one number tells the story.

## 3. Controls

| Input | Touch (default) | Touch (tap-steer option) | Keyboard |
|---|---|---|---|
| Carve | Drag; a full carve takes 60 % of the screen width | Hold the left or right side | ← → or A D |
| Jump | Tap | JUMP button | Space, ↑ or W |
| Grab | Press and hold while airborne, release before landing | Hold the JUMP button while airborne | Hold Space, ↓ or S while airborne |

A jump tapped within 0.15 s before touchdown is remembered and fires on landing (kept from the prototype). A second finger can tap to jump while the first keeps steering.

## 4. Simulation

Fixed step, 60 Hz, no wall clock, no `Math.random`, no transcendental functions (only `+ − × ÷ √`), so a seed plus the recorded inputs reproduces a run exactly. Input per tick: target x (centimetres), jump edge, grab level.

### Carving
The thumb sets a target line, not the board position. The board chases it with a lateral velocity:

- wanted `vx = clamp((targetX − x) · 14, ±16 m/s)`
- change in `vx` per second is limited by **edge grip**: 78 m/s² on snow, ×0.62 in the glacier, ×0.35 on blue ice, ×0.6 in moguls
- when the wanted change exceeds grip the board **drifts**: it slides, throws spray and scrubs speed (up to 3 m/s²)
- in the air you keep your lateral speed, with weak air control (16 m/s²)
- carve drag as in the prototype: `min(4, |vx| · 0.12)` m/s²

### Speed
`cruise = min(61, 26 + 0.9·t)`. `v` eases to `cruise + boost` (rate 1.1/s, 4/s while boosting).

### Air
Ballistic: gravity 23.9 m/s² and take-off speed 8.61 m/s give the prototype's 0.72 s and 1.55 m. Ramps launch at 13.5 m/s (1.13 s, 3.8 m). Cliffs drop the ground 3.2 m from under you.

### Tricks and landings
Press and hold in the air to grab. Trick points grow while you hold (60 m per second, ×combo). How you let go decides the landing:

| Landing | Condition | Result |
|---|---|---|
| **Perfect** | Grab held ≥ 0.22 s and released 0.05–0.30 s before touchdown | Trick points ×2, boost +9 m/s for 1.8 s, avalanche +3 m back, combo +1 |
| **OK** | Released earlier, or no grab | Trick points ×1 |
| **Sloppy** | Still grabbing at touchdown | Trick points lost, speed ×0.78, avalanche 2 m closer, combo lost |

A ring around the rider shrinks towards touchdown and turns green in the perfect window.

### Combo
One multiplier for all skill actions: near miss, clean jump, landed trick, perfect landing. +1 per action, cap ×5, lost 3 s after the last action or on a stumble or sloppy landing.

| Action | Bonus |
|---|---|
| Near miss (pass a deadly hazard within 1.1 m) | 25 m × combo, avalanche +4 m back |
| Close call (within 0.45 m) | as above, plus a slow-motion beat |
| Clean jump over a log or ridge | 10 m × combo |
| Trick | 60 m/s held × combo (×2 if perfect) |
| Flake | currency, +1 (does not score) |

### Avalanche
`gap` in metres, 0–60, starts at 46. `gap += (v − avSpeed)·dt`, with `avSpeed = cruise · (0.94 + 0.05·smoothstep(35, 60, gap)) ` adjusted by the pressure parameter. A clean rider drifts to a tense ~55 m lead instead of pinning the meter; after a mistake the wall is slower to close, so one stumble never kills.

What the player sees: an intro shot looking back up at the wall; flanks of the avalanche that run ahead on both sides of the piste as danger rises; a shadow front creeping down the snow from behind; snow boulders overtaking; frost on the lens; rumble; and a camera that swings round to the wall when it wins.

## 5. Hazards and terrain

| Thing | Biome | Rule | Reads as |
|---|---|---|---|
| Pine | all | deadly, steer round | tall dark cone |
| Boulder | all | deadly, steer round | grey rock |
| Log | forest, storm | jump it, or stumble | low brown bar, chevron marker |
| Ice ridge | glacier, storm | jump it, or stumble | low cyan shards, chevron marker |
| Crevasse | glacier, storm | a crack running **down** the slope, longer than any jump; deadly if you touch down in it, hop **across** it if you dare | dark blue slot with a lit rim |
| Ramp | all (from 300 m) | launches big air: time for a long grab | orange-striped kicker |
| Cliff | glacier, storm | full-width drop: forced air | flag line and a lip |
| Moguls | all (from 800 m) | not deadly; drag and less grip while you rattle through | field of bumps |
| Ice arches (tunnel) | glacier, storm | a 5 m wide gallery: steady boost, a line of flakes; pillars at the mouth are deadly, the sides just push you out | row of blue arches |
| Blue ice | glacier, storm | low grip: you drift | glossy patch |
| Flake | all | currency | spinning gold crystal |

Deadly and jumpable hazards differ in **shape and brightness**, not just hue. Jumpables carry a chevron ground marker; the colour-blind option adds a cross marker under every deadly hazard and thickens both.

### Biomes
Forest (0 m) → Glacier (1,200 m) → Night storm (2,600 m) → the cycle repeats every 3,900 m with a harder tier. Each has its own hazard mix, sky, fog, light, snowfall and music filter. The storm adds crosswind that pushes you in the air.

### Route choices
- Wide safe gap, or a narrow gap with a line of flakes.
- Ramp over a hazard cluster, or steer around.
- Ice arches (safe, fast, no score chances), or outside (near-miss chances).
- Either side of a crevasse; hop across for a bonus line.

## 6. Course generator and fairness

The generator plans a **safe line** first and dresses the mountain around it.

1. Rows are spaced in *time*, not metres: 1.0 s apart at the start, 0.62 s at the top tier, measured at the fastest speed physically possible at that distance (`v_bound = min(61, √(676 + 1.8d)) + 10`).
2. Each row moves the safe line by at most `8 m/s × (row time − 0.25 s)`: a gentle carve after a quarter-second reaction, half of what the board can really do.
3. A corridor around the safe line (half-width 1.9 m → 1.35 m) never contains a deadly hazard.
4. A jumpable may cross the corridor only if its **jump envelope** is empty: no deadly hazard in its lane from half a jump before it to a full jump plus 0.25 s after it.
5. Ramps, cliffs and log walls reserve a clear landing zone sized for their airtime at `v_bound`.
6. Crevasses and arches lock the safe line to one side or inside for their whole length.
7. First three rows are a scripted lesson: steer, jump, grab.

An independent validator (in the test suite, sharing no code with the generator) sweeps a reachability front down each course on a 2 m grid with a 9 m/s lateral limit at `v_bound` and fails if the set of safe positions ever becomes empty.

## 7. Meta and retention

- **Daily mountain.** Seed = hash of the UTC date. New mountain at midnight UTC.
- **Local leaderboard.** Your best runs today, plus clearly labelled CPU riders whose scores are seeded from the date.
- **Streak rewards.** Day 2: 40 flakes, day 3: a board, day 5: 120 flakes, day 7: a rider, then 60 flakes a day.
- **Riders and boards.** 5 riders, 5 boards, cosmetic only so the leaderboard stays fair. Bought with flakes or earned from streaks and missions.
- **Missions.** Three active at a time from a pool of 14, each pays flakes and is replaced when claimed.
- **Ghost.** Your best run of the day is stored as inputs and re-simulated beside you as a translucent rider.
- **Online features** (`src/systems/services.js`): `LeaderboardService`, `TournamentService`, `ProofOfPlayService` are interfaces with local implementations. Proof of Play already works locally: it re-simulates a recorded run and compares the score.

## 8. Look and sound

Stylised low-poly with flat-lit Lambert materials, no shadow maps (soft blob shadows instead), a custom snow shader (blue shadowed side-slopes, groomed piste lines, sun sparkle, distance haze), a gradient sky with sun, stars and a storm mood, layered mountain silhouettes, and one particle system for spray, powder, bursts and sparkles. The rider is a procedural jointed figure so poses (carve lean, tuck, grab, stomp, flail) are driven directly by the simulation.

Audio reuses the prototype's music and eight samples, adds synthesised effects for flakes, tricks, perfect landings, boost, combo and UI, a low-pass on the music in slow motion, and separate music and effects volumes.

## 9. Accessibility and options

Colour-blind hazard markers, reduced motion (no slow motion, FOV kicks, speed lines or camera roll), camera-shake strength, music and effects volume, haptics, tap-steer, language (en, es, zh), graphics quality (auto, low, medium, high).

## 10. Performance

No shadow maps, no post-processing, instanced hazards and scenery, terrain displaced on the GPU, pooled particles, DOM HUD updated only on change. Four quality levels; the game measures frame time and steps down (pixel ratio, particles, scenery density) on slow devices.

## 11. Playable-ad layer

Same parameters as the prototype through `window.__PARAMS`, store links through `window.__STORE`, CTA on the end card (MRAID-aware), 300 s time cap, Morning and Midday lighting for the forest, and `window.__GAME` for automated tests (`step`, `info`, `bot`, `begin`, `stats`).

## 12. Code layout

```
src/config.js            every tuning value
src/core/                deterministic, no DOM: rng, course, sim, bot, replay
src/systems/             input, audio, save, meta, services, haptics, i18n
src/render/              scene, terrain, props, rider, avalanche, particles, camera
src/ui/                  DOM screens and HUD
src/main.js              game loop and glue
tools/build.mjs          web build + single-file playable
tests/                   unit tests, fairness validator, bot runs
```
