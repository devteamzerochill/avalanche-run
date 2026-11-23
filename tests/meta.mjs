import { test, eq, ok } from './harness.mjs';
import { CONFIG, MISSIONS } from '../src/config.js';
import { Store } from '../src/systems/save.js';
import { rollDay, startRun, finishRun, buy, select, leaderboard, cpuRiders, dayBefore } from '../src/systems/meta.js';
import { LocalProofOfPlay } from '../src/systems/services.js';
import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';
import { Recorder, quantise } from '../src/core/replay.js';

function memory() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => (m[k] = String(v)), m };
}
const summary = (o) => Object.assign({ seed: 1, score: 0, distance: 0, time: 30, flakes: 0, nearMisses: 0, bestCombo: 0, cleanJumps: 0, tricks: 0, perfects: 0, trickScore: 0, topKmh: 0 }, o);

export function runMetaTests() {
  test('save: profile round-trips through storage and survives broken storage', () => {
    const mem = memory();
    const a = new Store(mem);
    a.profile.flakes = 77;
    a.profile.settings.tapSteer = true;
    a.save();
    const b = new Store(mem);
    eq(b.profile.flakes, 77);
    eq(b.profile.settings.tapSteer, true);
    eq(b.profile.missions.active.length, 3);
    const broken = new Store({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    eq(broken.profile.best, 0);
    broken.save();
    mem.setItem('avalanche-run-2', '{not json');
    eq(new Store(mem).profile.best, 0, 'corrupt save falls back to defaults');
  });

  test('daily: best-today, runs and ghost reset at the UTC day change; personal best stays', () => {
    const p = new Store(memory()).profile;
    startRun(p, '2026-11-17');
    finishRun(p, summary({ score: 1500, distance: 1400 }), { data: 'abc' });
    eq(p.bestToday, 1500);
    eq(p.ghost.score, 1500);
    ok(!rollDay(p, '2026-11-17'), 'same day: nothing to do');
    ok(rollDay(p, '2026-11-18'), 'new day');
    eq(p.bestToday, 0);
    eq(p.ghost, null);
    eq(p.runsToday.length, 0);
    eq(p.best, 1500);
  });

  test('streak: grows on consecutive days, resets after a gap, pays the listed rewards once', () => {
    const p = new Store(memory()).profile;
    eq(dayBefore('2026-03-01'), '2026-02-28');
    eq(startRun(p, '2026-11-10'), null, 'day 1: no reward');
    eq(p.streak, 1);
    eq(startRun(p, '2026-11-10'), null, 'second run the same day');
    eq(p.streak, 1);
    const d2 = startRun(p, '2026-11-11');
    eq(p.streak, 2);
    eq(d2.flakes, 40);
    eq(p.flakes, 40);
    const d3 = startRun(p, '2026-11-12');
    eq(d3.board, 'ember');
    ok(p.boards.includes('ember'));
    startRun(p, '2026-11-13');
    eq(startRun(p, '2026-11-14').flakes, 120);
    startRun(p, '2026-11-15');
    eq(startRun(p, '2026-11-16').rider, 'yeti');
    eq(startRun(p, '2026-11-17').flakes, CONFIG.meta.streakDailyFlakes, 'day 8+');
    startRun(p, '2026-11-20');
    eq(p.streak, 1, 'gap resets');
  });

  test('missions: per-run and cumulative goals, reward paid once, replaced on the next run', () => {
    const p = new Store(memory()).profile;
    startRun(p, '2026-11-17');
    eq(p.missions.active.map((m) => m.id).join(), 'dist1,near1,flake1');
    let r = finishRun(p, summary({ score: 500, distance: 500, nearMisses: 2, flakes: 25 }));
    eq(r.completed.length, 0);
    eq(p.missions.active[2].progress, 25, 'cumulative');
    eq(p.missions.active[0].progress, 500, 'best single run');
    r = finishRun(p, summary({ score: 900, distance: 850, nearMisses: 6, flakes: 20 }));
    eq(r.completed.sort().join(), 'dist1,flake1,near1');
    eq(r.missionFlakes, 90);
    eq(p.flakes, 25 + 20 + 90);
    r = finishRun(p, summary({ score: 900, distance: 900 }));
    eq(r.missionFlakes, 0, 'not paid twice');
    startRun(p, '2026-11-17');
    eq(p.missions.active.map((m) => m.id).join(), 'clean1,trick1,dist2', 'next three');
    eq(new Set(MISSIONS.map((m) => m.id)).size, MISSIONS.length, 'mission ids are unique');
  });

  test('unlocks: buying costs flakes, needs enough, streak-only items cannot be bought', () => {
    const p = new Store(memory()).profile;
    p.flakes = 160;
    ok(!buy(p, 'rider', 'blush'), 'too expensive');
    ok(buy(p, 'rider', 'pine'));
    eq(p.flakes, 10);
    eq(p.rider, 'pine');
    ok(!buy(p, 'rider', 'pine'), 'already owned');
    ok(!buy(p, 'rider', 'yeti'), 'streak-only');
    ok(select(p, 'rider', 'nova'));
    ok(!select(p, 'board', 'aurora'), 'not owned');
  });

  test('leaderboard: sorted, capped, same CPU riders all day, your runs marked', () => {
    const p = new Store(memory()).profile;
    startRun(p, '2026-11-17');
    eq(JSON.stringify(cpuRiders('2026-11-17')), JSON.stringify(cpuRiders('2026-11-17')));
    ok(JSON.stringify(cpuRiders('2026-11-17')) !== JSON.stringify(cpuRiders('2026-11-18')));
    const r = finishRun(p, summary({ score: 99999, distance: 9000 }));
    eq(r.rank, 1);
    const rows = leaderboard(p, '2026-11-17');
    ok(rows.length <= CONFIG.meta.leaderboardSize);
    ok(rows[0].you);
    for (let i = 1; i < rows.length; i++) ok(rows[i - 1].score >= rows[i].score, 'sorted');
    ok(rows.filter((x) => x.cpu).length > 0);
  });
}

// Proof of Play is async; run it outside the sync harness and fold it in.
export async function proofOfPlayCheck() {
  const sim = new Sim(2468);
  const bot = new Bot();
  const rec = new Recorder();
  while (sim.phase !== 'over' && sim.dist < 1200) {
    const input = quantise(bot.decide(sim));
    rec.push(input);
    sim.step(input);
  }
  const run = { seed: 2468, version: CONFIG.version, data: rec.encode(), score: sim.score };
  const pop = new LocalProofOfPlay();
  const good = await pop.verify(run);
  const bad = await pop.verify(Object.assign({}, run, { score: run.score + 500 }));
  const wrongSeed = await pop.verify(Object.assign({}, run, { seed: 2469 }));
  const wrongVersion = await pop.verify(Object.assign({}, run, { version: 0 }));
  if (!good.valid) throw new Error('honest run rejected');
  if (bad.valid) throw new Error('inflated score accepted');
  if (wrongSeed.valid) throw new Error('wrong seed accepted');
  if (wrongVersion.valid) throw new Error('wrong version accepted');
  return true;
}
