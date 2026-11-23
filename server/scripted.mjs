// Does a ride follow the game's own bot? The bot ships inside the client
// (?bot=1, __GAME.bot), so it is the easiest way to script a win. We replay the
// rider's inputs next to a shadow Bot that sees the same slope and compare.
//
// Calibrated on 2026-11-23 against the owner's own run and three seeds of each
// bot (docs/endurance-race.md, "Bot defence"):
//   steering within 0.5 m of the shadow (best lag)   human 45%   HumanBot 87-89%   Bot 100%
//   mean steering gap at that lag                    human 1.02 m   HumanBot 0.22-0.26 m
//   jumps 0-6 ticks after the shadow's jump          human 5/19   HumanBot every one
// The thresholds sit well inside the bot side, because a false call takes a
// real win away. A bot someone has written from scratch is not caught by this.
import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';

const MAX_LAG = 24; // ticks: covers the HumanBot's 8-15 tick reaction time
const MIN_TICKS = 300; // under 5 s of riding says too little

export function judgeRide(seed, ramp, runs) {
  const sim = new Sim(seed, { ramp });
  const shadow = new Bot();
  const ring = new Int32Array(MAX_LAG + 1); // shadow targets in cm, newest at t % size
  const near = new Float64Array(MAX_LAG + 1);
  const gap = new Float64Array(MAX_LAG + 1);
  const seen = new Float64Array(MAX_LAG + 1);
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
        const d = Math.abs(txCm - ring[(ticks - L) % ring.length]) / 100;
        if (d < 0.5) near[L]++;
        gap[L] += d;
        seen[L]++;
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
  const v = { ticks, exact: offCentre >= 120 ? exact / offCentre : 0, follow, meanGap, lag, jumps, onCue };
  // The plain Bot: the same target as the shadow nearly every tick.
  const perfect = v.exact >= 0.9;
  // The HumanBot (or any delayed copy of the bot): trails the shadow closely
  // and jumps on its cue every time.
  const delayed = follow >= 0.75 && meanGap <= 0.45 && jumps >= 5 && onCue >= 0.9 * jumps;
  v.scripted = ticks >= MIN_TICKS && (perfect || delayed);
  return v;
}
