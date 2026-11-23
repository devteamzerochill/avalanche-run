// Independent fairness validator. Shares no code with the generator: it only
// reads the finished entity list and the published physics limits.
//
// It sweeps a "front" of safe lateral positions down the course on a fine grid.
// Between grid lines the front may widen by what a rider can cover sideways at
// LAT m/s while travelling at the fastest speed possible at that distance.
// Cells covered by a deadly hazard (grown by the rider's size and a clearance)
// are removed. A jumpable hazard removes its cells unless the jump over it is
// provably safe from that cell. If the front is ever empty, the course is unfair.
import { CONFIG, airConstants } from '../src/config.js';

const CELL = 0.1;
const STEP = 1; // metres
const LAT = 9; // m/s, a little over half of what the board can do
const CLEAR = 0.3; // extra clearance on top of the rider's radius

function fastest(d) {
  const p = CONFIG.player;
  return Math.min(p.maxSpeed, Math.sqrt(p.startSpeed * p.startSpeed + 2 * p.speedRamp * d)) + CONFIG.gen.boostAllowance;
}

export function validateCourse(entities, length) {
  const W = CONFIG.lane.halfWidth;
  const R = CONFIG.player.radius;
  const depth = CONFIG.player.depth;
  const T = CONFIG.air.jumpTime;
  const air = airConstants();
  const n = Math.round((2 * W) / CELL) + 1;
  const cellX = (i) => -W + i * CELL;
  let front = new Uint8Array(n).fill(1);
  let next = new Uint8Array(n);
  const solid = entities.filter((e) => e.kind !== 'flake' && e.kind !== 'dash');
  const deadly = solid.filter((e) => e.lethal);
  const jumpable = solid.filter((e) => e.jump);
  const half = (e) => (e.r != null ? e.r : e.hw);
  const problems = [];
  let minWidth = 99;

  // Is anything in the way of a flight over lane x between d0 and d1?
  const blockedFlight = (x, d0, d1, self) => {
    for (const e of deadly) {
      if (e.kind === 'crevasse') continue; // you fly over a crack
      if (e.d1 < d0 || e.d0 > d1) continue;
      if (Math.abs(x - e.x) < half(e) + R + CLEAR) return true;
    }
    return false;
  };
  const badLanding = (x, d0, d1, self) => {
    for (const e of solid) {
      if (e === self || e.kind === 'ramp' || e.kind === 'cliff' || e.kind === 'mogul' || e.kind === 'ice' || e.kind === 'arch' || e.kind === 'dash') continue;
      if (e.d1 < d0 || e.d0 > d1) continue;
      if (Math.abs(x - e.x) < half(e) + R + CLEAR) return true;
    }
    return false;
  };

  // Forced air: cliffs and ramps need a clean flight and landing whatever the rider does.
  for (const e of solid) {
    const vb = fastest(e.d);
    if (e.kind === 'cliff') {
      const tMax = (air.jumpVy + Math.sqrt(air.jumpVy * air.jumpVy + 2 * air.g * CONFIG.air.cliffDrop)) / air.g;
      for (let x = -W; x <= W; x += 0.5) {
        if (badLanding(x, e.d - 8, e.d + tMax * vb, e)) {
          problems.push(`cliff at ${e.d.toFixed(0)} m: something in the landing zone at x=${x.toFixed(1)}`);
          break;
        }
      }
    }
    if (e.kind === 'ramp') {
      for (let x = e.x - e.hw - 2; x <= e.x + e.hw + 2; x += 0.5) {
        if (blockedFlight(x, e.d, e.d + air.rampTime * vb, e)) {
          problems.push(`ramp at ${e.d.toFixed(0)} m: deadly hazard under the flight at x=${x.toFixed(1)}`);
          break;
        }
      }
    }
  }

  let budget = 0;
  let lo = 0; // sliding window into `solid` (sorted by d0)
  for (let d = 0; d <= length; d += STEP) {
    const vb = fastest(d);
    // 1. widen the front by lateral reach
    budget += (LAT * STEP) / vb / CELL;
    const k = Math.floor(budget);
    budget -= k;
    if (k > 0) {
      next.fill(0);
      let run = -1e9;
      for (let i = 0; i < n; i++) {
        if (front[i]) run = i;
        if (i - run <= k) next[i] = 1;
      }
      run = 1e9;
      for (let i = n - 1; i >= 0; i--) {
        if (front[i]) run = i;
        if (run - i <= k) next[i] = 1;
      }
      const tmp = front;
      front = next;
      next = tmp;
    }
    // 2. remove unsafe cells
    while (lo < solid.length && solid[lo].d1 + depth < d - 80) lo++;
    for (let j = lo; j < solid.length; j++) {
      const e = solid[j];
      if (e.d0 - depth > d + STEP) break;
      if (e.d1 + depth < d) continue;
      if (e.lethal) {
        const grow = half(e) + R + CLEAR;
        for (let i = 0; i < n; i++) if (Math.abs(cellX(i) - e.x) < grow) front[i] = 0;
      } else if (e.jump) {
        const J = T * vb;
        for (let i = 0; i < n; i++) {
          const x = cellX(i);
          if (Math.abs(x - e.x) >= e.hw + R) continue;
          // Take-off up to 0.35 jumps before it, touchdown up to 0.9 jumps after it.
          const unsafe = blockedFlight(x, e.d - 0.35 * J, e.d + 0.9 * J, e) || badLanding(x, e.d1 + depth, e.d + 0.9 * J, e);
          if (unsafe) front[i] = 0;
        }
      } else if (e.kind === 'arch') {
        // Walls cannot be crossed.
        for (let i = 0; i < n; i++) {
          const off = Math.abs(cellX(i) - e.x);
          if (off > e.hw - R && off < e.hw + R + 0.5) front[i] = 0;
        }
      }
    }
    let width = 0;
    for (let i = 0; i < n; i++) width += front[i];
    if (width === 0) {
      problems.push(`no safe position at ${d} m`);
      break;
    }
    if (width * CELL < minWidth) minWidth = width * CELL;
  }
  return { ok: problems.length === 0, problems, minWidth };
}
