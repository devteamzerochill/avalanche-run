import { test, eq, near, ok, report } from './harness.mjs';
import { CONFIG, airConstants, MISSIONS } from '../src/config.js';
import { Course, vBound, biomeAt } from '../src/core/course.js';
import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';
import { Recorder, Playback, resimulate, quantise } from '../src/core/replay.js';
import { dailySeed, utcDay, mulberry32, hashString } from '../src/core/rng.js';
import { validateCourse } from './validator.mjs';
import { runMetaTests, proofOfPlayCheck } from './meta.mjs';
import { runCatalogTests } from './catalog.mjs';

const dt = CONFIG.tick;
const strip = (list) => list.map((e) => [e.kind, +e.x.toFixed(4), +e.d.toFixed(4), e.r || 0, e.hw || 0, e.hd || 0, e.y || 0]);

function botRun(seed, limit, opts) {
  const sim = new Sim(seed);
  const bot = new Bot(opts);
  const rec = new Recorder();
  let guard = 60 * 600;
  while (sim.phase !== 'over' && sim.dist < limit && guard-- > 0) {
    const input = quantise(bot.decide(sim));
    rec.push(input);
    sim.step(input);
    sim.events.length = 0;
  }
  return { sim, rec };
}

// A simulation on an empty mountain, to test the maths in isolation.
function bare(entities) {
  const sim = new Sim(1);
  let id = 1;
  const list = (entities || []).map((e) => {
    const ext = e.r != null ? e.r : e.hd || 0;
    return Object.assign({ id: id++, d0: e.d - ext, d1: e.d + ext, lethal: false, jump: false, h: 0 }, e);
  });
  list.sort((a, b) => a.d0 - b.d0);
  sim.course = { entities: list, cliffs: [], ensure() {}, laneAt: () => 0 };
  sim.first = 0;
  return sim;
}
function run(sim, seconds, input) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n && sim.phase !== 'over'; i++) sim.step(typeof input === 'function' ? input(sim) : input || { tx: sim.tx, jump: false, grab: false });
}
const events = (sim, type) => sim.events.filter((e) => e.type === type);

// ---------------------------------------------------------------- determinism
test('rng: mulberry32 and seed hash are stable', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) eq(a(), b(), 'same seed, same stream');
  ok(mulberry32(1)() !== mulberry32(2)(), 'different seeds differ');
  eq(hashString('avalanche-run:2026-11-17'), dailySeed('2026-11-17'), 'daily seed');
  ok(dailySeed('2026-11-17') !== dailySeed('2026-11-18'), 'different days differ');
  eq(utcDay(new Date(Date.UTC(2026, 10, 17, 23, 59, 59))), '2026-11-17', 'UTC day');
  eq(utcDay(new Date(Date.UTC(2026, 10, 18, 0, 0, 0))), '2026-11-18', 'rolls at midnight UTC');
});

test('generator: same seed => identical course (10 seeds x 8 km)', () => {
  for (let s = 1; s <= 10; s++) {
    const a = new Course(s * 1013);
    const b = new Course(s * 1013);
    a.ensure(8000);
    // Generate b in many small steps: chunking must not matter.
    for (let d = 200; d <= 8000; d += 137) b.ensure(d);
    b.ensure(8000);
    eq(JSON.stringify(strip(a.entities)), JSON.stringify(strip(b.entities)), 'seed ' + s);
  }
});

test('generator: different seeds => different courses', () => {
  const a = new Course(1);
  const b = new Course(2);
  a.ensure(2000);
  b.ensure(2000);
  ok(JSON.stringify(strip(a.entities)) !== JSON.stringify(strip(b.entities)));
});

test('generator: opening rows are the scripted lesson for every seed', () => {
  for (const seed of [3, 99, 123456]) {
    const c = new Course(seed);
    c.ensure(400);
    const solid = c.entities.filter((e) => e.kind !== 'flake' && e.kind !== 'dash');
    eq(solid[0].kind, 'pine', 'row 1');
    eq(solid[1].kind, 'log', 'row 2');
    ok(solid.some((e) => e.kind === 'ramp' && e.d < 300), 'ramp lesson');
  }
});

test('simulation: same seed + same inputs => identical run', () => {
  const a = botRun(4242, 3000);
  const b = botRun(4242, 3000);
  eq(a.sim.fingerprint(), b.sim.fingerprint(), 'fingerprint');
  eq(a.sim.score, b.sim.score, 'score');
  eq(a.rec.encode(), b.rec.encode(), 'recording');
});

test('replay: recorded inputs re-simulate to the same result', () => {
  const { sim, rec } = botRun(777, 2500);
  const data = rec.encode();
  const play = new Playback(data);
  const again = new Sim(777);
  for (let i = 0; i < rec.ticks; i++) again.step(play.next());
  eq(again.fingerprint(), sim.fingerprint(), 'fingerprint');
  const re = resimulate({ version: CONFIG.version, seed: 777, data });
  eq(re.summary.score, sim.score, 'resimulate score');
  return `${rec.ticks} ticks -> ${data.length} chars`;
});

test('simulation uses no Math.random and no transcendental functions', () => {
  const names = ['random', 'sin', 'cos', 'tan', 'exp', 'pow', 'log', 'atan2', 'atan', 'hypot'];
  const saved = {};
  for (const n of names) {
    saved[n] = Math[n];
    Math[n] = () => {
      throw new Error('Math.' + n + ' called in the simulation');
    };
  }
  try {
    botRun(31337, 1500);
  } finally {
    for (const n of names) Math[n] = saved[n];
  }
});

// ------------------------------------------------------------------- fairness
test('fairness: no impossible pattern (60 seeds x 9 km, independent validator)', () => {
  let min = 99;
  for (let s = 0; s < 60; s++) {
    const seed = s < 5 ? dailySeed(utcDay(new Date(Date.UTC(2026, 10, 17 + s)))) : (s * 2654435761) >>> 0;
    const c = new Course(seed);
    c.ensure(9100);
    const v = validateCourse(c.entities, 9000);
    if (!v.ok) throw new Error(`seed ${seed}: ${v.problems[0]}`);
    min = Math.min(min, v.minWidth);
  }
  return `narrowest safe front ${min.toFixed(1)} m`;
});

test('fairness: race courses stay passable through the dense endgame (30 seeds x 14 km)', () => {
  let min = 99;
  let before = 0;
  let after = 0;
  for (let s = 0; s < 30; s++) {
    const c = new Course((s * 2246822519) >>> 0, CONFIG.race.ramp);
    c.ensure(14100);
    const v = validateCourse(c.entities, 14000);
    if (!v.ok) throw new Error(`race seed ${s}: ${v.problems[0]}`);
    min = Math.min(min, v.minWidth);
    for (const e of c.entities) if (e.lethal) e.d0 > 4000 && e.d0 < 7000 ? before++ : e.d0 > 11000 && e.d0 < 14000 ? after++ : 0;
  }
  ok(after > before * 1.15, 'the endgame is denser: ' + before + ' -> ' + after);
  return `narrowest safe front ${min.toFixed(1)} m; deadly hazards per 3 km ${Math.round(before / 30)} -> ${Math.round(after / 30)}`;
});

test('fairness: validator really rejects an impossible pattern', () => {
  const wall = [];
  for (let x = -7; x <= 7; x += 2) wall.push({ kind: 'pine', x, d: 500, r: 1.2, d0: 498.8, d1: 501.2, lethal: true, jump: false, h: 7 });
  ok(!validateCourse(wall, 1000).ok, 'a full wall of pines must fail');
  const trap = [
    { kind: 'log', x: 0, d: 500, hw: 7.5, hd: 0.3, d0: 499.7, d1: 500.3, lethal: false, jump: true, h: 0.7 },
    { kind: 'boulder', x: 0, d: 520, r: 7, d0: 513, d1: 527, lethal: true, jump: false, h: 2 },
  ];
  ok(!validateCourse(trap, 1000).ok, 'a log wall with a boulder in the landing must fail');
});

test('fairness: safe line never sits inside a deadly hazard and never jumps sideways', () => {
  for (let s = 1; s <= 20; s++) {
    const c = new Course(s * 7717);
    c.ensure(9000);
    for (const e of c.entities) {
      if (!e.lethal) continue;
      const half = e.r != null ? e.r : e.hw;
      for (const d of [e.d0, e.d, e.d1]) {
        const off = Math.abs(c.laneAt(d) - e.x);
        if (off < half + CONFIG.player.radius + 0.3) throw new Error(`seed ${s}: ${e.kind} at ${e.d.toFixed(0)} m is ${off.toFixed(2)} m from the safe line`);
      }
    }
    for (let i = 1; i < c.path.length; i++) {
      const a = c.path[i - 1];
      const b = c.path[i];
      if (b.d <= a.d) continue;
      const need = Math.abs(b.x - a.x) / ((b.d - a.d) / vBound(a.d));
      if (need > CONFIG.gen.planLat + 0.01) throw new Error(`seed ${s}: safe line needs ${need.toFixed(1)} m/s at ${a.d.toFixed(0)} m`);
    }
  }
});

test('fairness: hazards exist in every biome and the mix changes', () => {
  const c = new Course(2024);
  c.ensure(4000);
  const kinds = (from, to) => new Set(c.entities.filter((e) => e.d >= from && e.d < to).map((e) => e.kind));
  ok(!kinds(0, 1200).has('crevasse'), 'no crevasses in the forest');
  const all = new Set();
  for (let s = 1; s <= 8; s++) {
    const k = new Course(s);
    k.ensure(4000);
    for (const e of k.entities) all.add(e.kind);
  }
  for (const k of ['pine', 'boulder', 'log', 'ridge', 'crevasse', 'ramp', 'cliff', 'mogul', 'arch', 'pillar', 'ice', 'flake', 'dash']) ok(all.has(k), 'missing ' + k);
  eq(biomeAt(0).id, 'forest');
  eq(biomeAt(1300).id, 'glacier');
  eq(biomeAt(2700).id, 'storm');
  eq(biomeAt(3950).id, 'forest');
});

// ------------------------------------------------------------ scoring / combo
test('speed: 26 m/s start, +0.9 m/s per second, 61 m/s cap', () => {
  const sim = bare();
  run(sim, 10);
  near(sim.cruise, 26 + 0.9 * 10, 0.02, 'cruise at 10 s');
  near(sim.v, sim.cruise, 1.2, 'speed follows cruise');
  run(sim, 40);
  eq(sim.cruise, 61, 'cap');
});

test('jump: 0.72 s airtime, 1.55 m apex, buffered tap fires on landing', () => {
  const sim = bare();
  run(sim, 1);
  sim.step({ tx: 0, jump: true, grab: false });
  let apex = 0;
  let ticks = 1;
  while (sim.air) {
    sim.step({ tx: 0, jump: false, grab: false });
    apex = Math.max(apex, sim.y);
    ticks++;
  }
  near(ticks * dt, 0.72, 0.035, 'airtime');
  near(apex, 1.55, 0.05, 'apex');
  // buffered
  sim.step({ tx: 0, jump: true, grab: false });
  run(sim, 0.72 - 0.1);
  sim.step({ tx: 0, jump: true, grab: false }); // 0.1 s before landing
  run(sim, 0.2);
  ok(sim.air, 'second jump fired on touchdown');
  eq(sim.stats.jumps, 3, 'jumps');
});

test('score = floor(distance) + near-miss bonus (the zerochill.com formula); near miss = 25 x combo', () => {
  // Boulders 1.5 m apart in time, passed 0.6 m from their edge.
  const r = 1;
  const x = r + CONFIG.player.radius + 0.6;
  const sim = bare([
    { kind: 'boulder', x, d: 200, r, h: 1.25, lethal: true },
    { kind: 'boulder', x, d: 240, r, h: 1.25, lethal: true },
    { kind: 'boulder', x, d: 280, r, h: 1.25, lethal: true },
    { kind: 'boulder', x, d: 700, r, h: 1.25, lethal: true },
  ]);
  run(sim, 11);
  const nm = events(sim, 'nearMiss');
  eq(nm.length, 3, 'three near misses');
  eq(nm[0].pts, 25, 'first');
  eq(nm[1].pts, 50, 'second x2');
  eq(nm[2].pts, 75, 'third x3');
  eq(sim.bonus, 150, 'bonus');
  eq(sim.score, Math.floor(sim.dist) + 150, 'score');
  run(sim, 12);
  const all = events(sim, 'nearMiss');
  eq(all.length, 4);
  eq(all[3].pts, 25, 'combo expired after 3 s');
  eq(sim.stats.nearMisses, 4);
  eq(sim.stats.bestCombo, 3);
});

test('near miss: margin is 1.1 m; a wide pass scores nothing; a hit crashes', () => {
  const r = 1;
  const wide = bare([{ kind: 'boulder', x: r + CONFIG.player.radius + 1.3, d: 200, r, h: 1.25, lethal: true }]);
  run(wide, 8);
  eq(wide.bonus, 0, 'wide pass');
  const hit = bare([{ kind: 'boulder', x: 0.5, d: 200, r, h: 1.25, lethal: true }]);
  run(hit, 12);
  eq(hit.outcome, 'crash');
  eq(hit.cause, 'boulder');
  eq(hit.phase, 'over');
});

test('combo caps at x5', () => {
  const r = 1;
  const x = r + CONFIG.player.radius + 0.5;
  const list = [];
  for (let i = 0; i < 8; i++) list.push({ kind: 'boulder', x, d: 200 + i * 30, r, h: 1.25, lethal: true });
  const sim = bare(list);
  run(sim, 14);
  const nm = events(sim, 'nearMiss');
  eq(nm.length, 8);
  eq(nm[7].combo, CONFIG.score.comboMax, 'cap');
  eq(sim.bonus, 25 * (1 + 2 + 3 + 4 + 5 + 5 + 5 + 5), 'bonus');
});

test('log: hit = stumble (speed x0.55, avalanche 3 m closer, combo lost); jumped = clean +10 x combo', () => {
  const log = { kind: 'log', x: 0, hw: 3, hd: 0.32, h: 0.7, jump: true };
  const a = bare([Object.assign({ d: 200 }, log)]);
  run(a, 3);
  while (a.dist < 197) a.step({ tx: 0, jump: false, grab: false });
  const v0 = a.v;
  const gap0 = a.gap;
  run(a, 0.2);
  eq(a.stats.stumbles, 1, 'stumbled');
  ok(a.v < v0 * 0.62 && a.v > v0 * 0.5, 'speed about x0.55');
  ok(a.gap < gap0 - 2.5, 'avalanche closer');
  eq(a.phase, 'ride', 'a stumble is not a crash');

  const b = bare([Object.assign({ d: 200 }, log), Object.assign({ d: 290 }, log)]);
  run(b, 20, (s) => {
    const next = s.course.entities.find((e) => !e.done);
    const t = next ? (next.d - s.dist) / s.v : 9;
    return { tx: 0, jump: !s.air && t > 0 && t < 0.3, grab: false };
  });
  const clean = events(b, 'clean');
  eq(clean.length, 2);
  eq(clean[0].pts, 10);
  eq(clean[1].pts, 20, 'second clean jump x2');
  eq(b.stats.trickScore, 30, 'clean-jump points are trick points');
  eq(b.bonus, 0, 'clean jumps do not add to the score');
  eq(b.stats.stumbles, 0);
});

test('tricks: points grow with hold time; perfect doubles and boosts; sloppy loses everything', () => {
  const k = airConstants();
  const ramp = () => bare([{ kind: 'ramp', x: 0, d: 150, hw: 1.6, hd: 2.2 }]);
  near(k.rampTime, (2 * CONFIG.air.rampVy) / k.g, 1e-9);

  const perfect = ramp();
  run(perfect, 12, (s) => ({ tx: 0, jump: false, grab: s.air && s.timeToLand() > 0.17 }));
  const lp = events(perfect, 'land')[0];
  eq(lp.quality, 'perfect');
  eq(perfect.stats.perfects, 1);
  ok(lp.pts > 80 && lp.pts < 130, 'points ' + lp.pts);
  ok(events(perfect, 'boost').length === 1, 'boost');

  const okRun = ramp();
  run(okRun, 12, (s) => ({ tx: 0, jump: false, grab: s.air && s.timeToLand() > 0.5 }));
  const lo = events(okRun, 'land')[0];
  eq(lo.quality, 'ok');
  ok(lo.pts > 0 && lo.pts < lp.pts / 2 + 1, 'ok landing scores less than half a perfect');
  eq(events(okRun, 'boost').length, 0);

  const sloppy = ramp();
  let vBefore = 0;
  run(sloppy, 12, (s) => {
    if (s.air) vBefore = s.v;
    return { tx: 0, jump: false, grab: s.air };
  });
  const ls = events(sloppy, 'land')[0];
  eq(ls.quality, 'sloppy');
  eq(ls.pts, 0);
  eq(sloppy.stats.sloppy, 1);
  eq(sloppy.stats.trickScore, 0);
  eq(perfect.stats.trickScore, lp.pts, 'trick points go to their own stat');
  eq(perfect.bonus, 0, 'tricks do not add to the score');
  eq(perfect.score, Math.floor(perfect.dist), 'score is metres only (live site formula)');

  // With trick points switched on (everywhere but runs zerochill.com scores),
  // the same ride scores its trick points on top.
  CONFIG.score.tricks = true;
  const counted = ramp();
  CONFIG.score.tricks = false;
  run(counted, 12, (s) => ({ tx: 0, jump: false, grab: s.air && s.timeToLand() > 0.17 }));
  eq(counted.score, Math.floor(counted.dist) + counted.stats.trickScore, 'tricks on: metres + trick points');
  ok(counted.stats.trickScore > 80, 'the perfect landing counted');

  const none = ramp();
  run(none, 12);
  eq(events(none, 'land')[0].quality, 'ok');
  eq(none.bonus, 0);
});

test('boost: perfect landing lifts speed above cruise for about 1.8 s', () => {
  const sim = bare([{ kind: 'ramp', x: 0, d: 150, hw: 1.6, hd: 2.2 }]);
  let peak = 0;
  run(sim, 14, (s) => {
    peak = Math.max(peak, s.v - s.cruise);
    return { tx: 0, jump: false, grab: s.air && s.timeToLand() > 0.17 };
  });
  ok(peak > 5 && peak < CONFIG.boost.amount + 0.01, 'peak over cruise ' + peak.toFixed(1));
  near(sim.v, sim.cruise, 1, 'boost has faded');
});

test('avalanche: clean riding opens the gap, repeated stumbles get you caught', () => {
  const clean = bare();
  run(clean, 30);
  ok(clean.gap > CONFIG.avalanche.startGap, 'gap grows');
  ok(clean.gap <= CONFIG.avalanche.maxGap, 'gap capped');
  const logs = [];
  for (let i = 0; i < 60; i++) logs.push({ kind: 'log', x: 0, d: 150 + i * 28, hw: 7, hd: 0.32, h: 0.7, jump: true });
  const bad = bare(logs);
  run(bad, 90);
  eq(bad.outcome, 'caught');
  eq(bad.cause, 'caught');
  eq(bad.causeDetail, 'stumble');
  ok(bad.stats.stumbles >= 3, 'needs several stumbles, not one: ' + bad.stats.stumbles);
});

test('crevasse: deadly on the ground, hop across in the air for a bonus', () => {
  const crack = { kind: 'crevasse', x: 3, hw: 1, hd: 30, h: 0, lethal: true, d: 230 };
  const ground = bare([Object.assign({}, crack)]);
  run(ground, 14, (s) => ({ tx: s.dist > 205 ? 6 : 0, jump: false, grab: false }));
  eq(ground.cause, 'crevasse');
  const hop = bare([Object.assign({}, crack)]);
  run(hop, 9, (s) => ({ tx: s.dist > 205 ? 6 : 0, jump: !s.air && s.x > 1.2 && s.x < 2.0, grab: false }));
  eq(hop.phase, 'ride', 'survived the hop');
  eq(hop.stats.hops, 1);
  eq(events(hop, 'hop')[0].pts, 30);
  eq(hop.stats.trickScore, 30, 'hop points are trick points');
  eq(hop.bonus, 0, 'hops do not add to the score');
});

test('flakes are collected and counted, and do not change the score', () => {
  const list = [];
  for (let i = 0; i < 5; i++) list.push({ kind: 'flake', x: 0, d: 150 + i * 6, y: 0.9, hd: 0 });
  list.push({ kind: 'flake', x: 5, d: 160, y: 0.9, hd: 0 });
  const sim = bare(list);
  run(sim, 8);
  eq(sim.stats.flakes, 5);
  eq(sim.bonus, 0);
});

test('dash pad: riding over it boosts above cruise; jumping over it does nothing', () => {
  const pad = { kind: 'dash', x: 0, d: 150, hw: 1.4, hd: 2.4 };
  const on = bare([Object.assign({}, pad)]);
  let peak = 0;
  run(on, 8, (s) => {
    peak = Math.max(peak, s.v - s.cruise);
    return { tx: 0, jump: false, grab: false };
  });
  eq(on.stats.dashes, 1);
  ok(peak > 4, 'boost ' + peak.toFixed(1));
  const off = bare([Object.assign({}, pad)]);
  run(off, 8, () => ({ tx: 4, jump: false, grab: false }));
  eq(off.stats.dashes, 0);
});

test('milestone event every 500 m ridden (not the score)', () => {
  const sim = bare();
  run(sim, 45);
  const m = events(sim, 'milestone').map((e) => e.at);
  eq(m[0], 500);
  eq(m[1], 1000);
  eq(m[2], 1500);
});

test('carving: board chases the target, respects grip, never overshoots into the next lane', () => {
  const sim = bare();
  run(sim, 2);
  let maxX = 0;
  let maxVx = 0;
  run(sim, 1.2, (s) => {
    maxX = Math.max(maxX, s.x);
    maxVx = Math.max(maxVx, s.vx);
    return { tx: 4, jump: false, grab: false };
  });
  near(sim.x, 4, 0.05, 'settles on the target');
  ok(maxX < 4.15, 'overshoot ' + (maxX - 4).toFixed(2) + ' m');
  ok(maxVx <= CONFIG.player.latMax + 1e-9, 'lateral speed capped');
  // On blue ice the same move is slower.
  const ice = bare([{ kind: 'ice', x: 0, d: 400, hw: 8, hd: 400 }]);
  run(ice, 2);
  run(ice, 0.35, () => ({ tx: 4, jump: false, grab: false }));
  const snow = bare();
  run(snow, 2);
  run(snow, 0.35, () => ({ tx: 4, jump: false, grab: false }));
  ok(ice.x < snow.x - 0.4, `ice ${ice.x.toFixed(2)} m vs snow ${snow.x.toFixed(2)} m after 0.35 s`);
});

test('time cap ends the run with a timeout (playable-ad mode)', () => {
  const sim = new Sim(5, { timeCap: 3 });
  sim.course = { entities: [], cliffs: [], ensure() {}, laneAt: () => 0 };
  run(sim, 5);
  eq(sim.outcome, 'timeout');
  eq(sim.phase, 'over');
});

// ------------------------------------------------------------------------ bot
test('bot reaches 2,000 m on today\'s mountain and 40 other seeds', () => {
  const seeds = [dailySeed(utcDay())];
  for (let i = 1; i <= 40; i++) seeds.push((i * 40503) >>> 0);
  let worst = 1e9;
  let failed = [];
  for (const seed of seeds) {
    const { sim } = botRun(seed, 2000);
    worst = Math.min(worst, sim.dist);
    if (sim.dist < 2000) failed.push(`${seed}: ${Math.floor(sim.dist)} m (${sim.cause})`);
  }
  if (failed.length) throw new Error(failed.join('; '));
  return `${seeds.length}/${seeds.length} seeds, worst ${Math.floor(worst)} m`;
});

test('bot without tricks or near-miss luck still reaches 2,000 m (20 seeds)', () => {
  for (let i = 1; i <= 20; i++) {
    const { sim } = botRun(i * 90001, 2000, { tricks: false });
    if (sim.dist < 2000) throw new Error(`seed ${i * 90001}: ${Math.floor(sim.dist)} m (${sim.cause})`);
  }
});

test('bot long run: 8 km on 12 seeds (reports how far it gets)', () => {
  let reached = 0;
  const out = [];
  for (let i = 1; i <= 12; i++) {
    const { sim } = botRun(i * 31337, 8000);
    if (sim.dist >= 8000) reached++;
    else out.push(Math.floor(sim.dist));
  }
  ok(reached >= 9, `only ${reached}/12 reached 8 km`);
  return `${reached}/12 reached 8 km` + (out.length ? `, others: ${out.join(', ')} m` : '');
});

runMetaTests();
runCatalogTests();
ok(MISSIONS.length > 0);
let popError = '';
try {
  await proofOfPlayCheck();
} catch (err) {
  popError = String(err.message || err);
}
test('proof of play: honest run verifies; inflated score, wrong seed, wrong version are rejected', () => {
  if (popError) throw new Error(popError);
});
const failed = report();
process.exit(failed ? 1 : 0);
