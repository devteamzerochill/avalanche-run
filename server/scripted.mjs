// Does a ride follow the game's own bot? The bot ships inside the client
// (?bot=1, __GAME.bot), so it is the easiest way to script a win. We replay the
// rider's inputs next to a shadow Bot that sees the same slope and compare.
//
// Calibrated on 2026-11-23 against the owner's own run and three seeds of each
// bot (docs/endurance-race.md, "Bot defence"):
//   steering within 0.5 m of the shadow (best lag)   human 45%   HumanBot 87-89%   Bot 100%
//   mean steering gap at that lag                    human 1.02 m   HumanBot 0.22-0.26 m
//   jumps 0-6 ticks after the shadow's jump          human 5/19   HumanBot every one
// Short rides (fewer than 5 jumps, measured 2026-11-24 on 40 HumanBot rides
// of 10-45 s): on ticks where the shadow aims off the centre line, the
// HumanBot steers within 0.5 m of it 67-86% of the time with a mean gap of
// at most 0.37 m. Two real wins by the owner (24 s and 45 s, 2026-11-24)
// scored 39-46% at 0.76-0.78 m, and jumped 13-22 times, far from the bot.
// The thresholds sit well inside the bot side, because a false call takes a
// real win away. A bot someone has written from scratch is not caught by this.
import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';

const MAX_LAG = 24; // ticks: covers the HumanBot's 8-15 tick reaction time
const MIN_TICKS = 300; // under 5 s of riding says too little
const MIN_OFF_TICKS = 300; // a short ride needs 5 s of the shadow steering off centre

export function judgeRide(seed, ramp, runs) {
  const sim = new Sim(seed, { ramp });
  const shadow = new Bot();
  const ring = new Int32Array(MAX_LAG + 1); // shadow targets in cm, newest at t % size
  const near = new Float64Array(MAX_LAG + 1);
  const gap = new Float64Array(MAX_LAG + 1);
  const seen = new Float64Array(MAX_LAG + 1);
  // The same, only on ticks where the shadow aimed off the centre line: at the
  // start everyone sits on it, which says nothing in a short ride.
  const nearOff = new Float64Array(MAX_LAG + 1);
  const seenOff = new Float64Array(MAX_LAG + 1);
  let exact = 0;
  let offCentre = 0; // ticks the shadow aimed off the centre line
  let ticks = 0;
  let jumps = 0;
  let onCue = 0;
  let lastShadowJump = -99;
  let wasJump = false;
  let shadowWasJump = false;
  const input = { tx: 0, jump: false, grab: false };
  for (const [count, txCm, flags] of runs) {
    input.tx = txCm / 100;
    input.jump = (flags & 1) !== 0;
    input.grab = (flags & 2) !== 0;
    for (let k = 0; k < count && sim.phase === 'ride'; k++) {
      const b = shadow.decide(sim);
      const bCm = Math.round(b.tx * 100);
      ring[ticks % ring.length] = bCm;
      if (b.jump && !shadowWasJump) lastShadowJump = ticks;
      shadowWasJump = b.jump;
      // The centre line is where anyone sits before steering, so only
      // matches away from it count.
      if (bCm !== 0) {
        offCentre++;
        if (bCm === txCm) exact++;
      }
      for (let L = 0; L <= MAX_LAG && L <= ticks; L++) {
        const target = ring[(ticks - L) % ring.length];
        const d = Math.abs(txCm - target) / 100;
        if (d < 0.5) near[L]++;
        gap[L] += d;
        seen[L]++;
        if (target !== 0) {
          seenOff[L]++;
          if (d < 0.5) nearOff[L]++;
        }
      }
      if (input.jump && !wasJump) {
        jumps++;
        if (ticks - lastShadowJump <= 6) onCue++;
      }
      wasJump = input.jump;
      sim.step(input);
      sim.events.length = 0;
      ticks++;
    }
  }
  let lag = 0;
  for (let L = 1; L <= MAX_LAG; L++) if (seen[L] && near[L] / seen[L] > near[lag] / seen[lag]) lag = L;
  const follow = seen[lag] ? near[lag] / seen[lag] : 0;
  const meanGap = seen[lag] ? gap[lag] / seen[lag] : 9;
  const followOff = seenOff[lag] ? nearOff[lag] / seenOff[lag] : 0;
  const v = { ticks, exact: offCentre >= 120 ? exact / offCentre : 0, follow, followOff, offTicks: seenOff[lag], meanGap, lag, jumps, onCue };
  // The plain Bot: the same target as the shadow nearly every tick.
  const perfect = v.exact >= 0.9;
  // The HumanBot (or any delayed copy of the bot): trails the shadow closely
  // and jumps on its cue every time.
  const delayed = follow >= 0.75 && meanGap <= 0.45 && jumps >= 5 && onCue >= 0.9 * jumps;
  // A short ride has too few jumps to judge timing, so it is judged on
  // steering away from the centre line, more strictly, and any jumps it has
  // must still be on the shadow's cue.
  const short = jumps < 5 && onCue === jumps && v.offTicks >= MIN_OFF_TICKS && followOff >= 0.72 && meanGap <= 0.38;
  v.scripted = ticks >= MIN_TICKS && (perfect || delayed || short);
  return v;
}
