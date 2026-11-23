// Course generator. Deterministic for a seed. Plans a safe line first, then
// dresses the mountain around it (see DESIGN.md section 6).
import { CONFIG, airConstants } from '../config.js';
import { mulberry32, clamp, lerp } from './rng.js';

// Fastest speed physically possible at distance d: always at cruise from the
// start (d = 26t + 0.45t^2  =>  v = sqrt(26^2 + 1.8d)), plus the boost allowance.
export function vBound(d) {
  const p = CONFIG.player;
  const v = Math.sqrt(p.startSpeed * p.startSpeed + 2 * p.speedRamp * Math.max(0, d));
  return Math.min(p.maxSpeed, v) + CONFIG.gen.boostAllowance;
}

export function tierAt(d) {
  return clamp(d / CONFIG.gen.tierDistance, 0, 1);
}

export function biomeAt(d) {
  const b = CONFIG.biomes;
  const cycle = Math.floor(Math.max(0, d) / b.cycle);
  const local = Math.max(0, d) - cycle * b.cycle;
  let index = 0;
  for (let i = 0; i < b.starts.length; i++) if (local >= b.starts[i]) index = i;
  return { id: b.order[index], index, cycle, start: cycle * b.cycle + b.starts[index] };
}

const KIND_WEIGHTS = {
  forest: [['pine', 0.5], ['boulder', 0.18], ['log', 0.32]],
  glacier: [['boulder', 0.4], ['pine', 0.14], ['ridge', 0.46]],
  storm: [['pine', 0.32], ['boulder', 0.28], ['log', 0.2], ['ridge', 0.2]],
};

const FEATURES = {
  forest: [['ramp', 3], ['wall', 2], ['gate', 2], ['mogul', 2]],
  glacier: [['ramp', 2], ['wall', 1.5], ['crevasse', 3], ['cliff', 2], ['arch', 2], ['mogul', 1], ['gate', 1]],
  storm: [['ramp', 2], ['wall', 2], ['crevasse', 2], ['cliff', 1.5], ['arch', 1.5], ['gate', 2], ['mogul', 1]],
};
const FEATURE_FROM = { ramp: 300, wall: 480, gate: 420, mogul: 800, crevasse: 0, cliff: 0, arch: 0 };

export class Course {
  // race: the endurance race's ramp (CONFIG.race.ramp), whose dense* fields make
  // the slope denser by distance; the same for every rider on the seed.
  constructor(seed, race) {
    this.seed = seed >>> 0;
    this.race = race && race.denseTo > race.denseFrom ? race : null;
    this.rng = mulberry32(this.seed);
    this.entities = []; // sorted by d0
    this.path = [{ d: 0, x: 0 }]; // safe line way-points
    this.cliffs = []; // distances, for the renderer
    this.d = CONFIG.gen.firstRowAt; // next row distance
    this.lane = 0;
    this.row = 0;
    this.nextId = 1;
    this.envelopes = []; // {x0,x1,d0,d1,all}  all=true: nothing at all, false: nothing deadly
    this.locks = []; // {x0,x1,d0,d1,inside}  the safe line may not cross / must stay inside
    this.zones = []; // {x0,x1,d0,d1} hazards must not overlap (ramps, moguls, crevasses, arches)
    this.featureIn = this.int(CONFIG.gen.featureEvery);
    this.flakeIn = 1;
    this.dashIn = 3;
    this.lastFeature = '';
  }

  int(range) {
    return range[0] + Math.floor(this.rng() * (range[1] - range[0] + 1));
  }

  range(r) {
    return r[0] + this.rng() * (r[1] - r[0]);
  }

  ensure(dTo) {
    while (this.d < dTo) this.nextRow();
  }

  // --- entity helpers ---------------------------------------------------
  add(e) {
    e.id = this.nextId++;
    const ext = e.r != null ? e.r : e.hd || 0;
    e.d0 = e.d - ext;
    e.d1 = e.d + ext;
    const list = this.entities;
    let i = list.length;
    while (i > 0 && list[i - 1].d0 > e.d0) i--;
    list.splice(i, 0, e);
    return e;
  }

  circle(kind, x, d, r, h) {
    return this.add({ kind, x, d, r, h, lethal: true, jump: false });
  }

  box(kind, x, d, hw, hd, h, lethal, jump) {
    return this.add({ kind, x, d, hw, hd, h, lethal, jump });
  }

  flake(x, d, y) {
    const W = CONFIG.lane.halfWidth - 0.5;
    return this.add({ kind: 'flake', x: clamp(x, -W, W), d, y, hd: 0, h: 0, lethal: false, jump: false });
  }

  half(e) {
    return e.r != null ? e.r : e.hw;
  }

  // 0 before the race's dense stretch, rising to 1 at its end.
  endgame(d) {
    const r = this.race;
    return r ? clamp((d - r.denseFrom) / (r.denseTo - r.denseFrom), 0, 1) : 0;
  }

  corridor(d) {
    return lerp(CONFIG.gen.corridorStart, CONFIG.gen.corridorEnd, tierAt(d));
  }

  jumpDist(d) {
    return CONFIG.air.jumpTime * vBound(d);
  }

  // True if a hazard spanning [x-half, x+half] x [d-depth, d+depth] may be placed.
  free(x, d, half, depth, lethal) {
    for (const z of this.zones) {
      if (d + depth > z.d0 && d - depth < z.d1 && x + half > z.x0 && x - half < z.x1) return false;
    }
    for (const v of this.envelopes) {
      if (!lethal && !v.all) continue;
      if (d + depth > v.d0 && d - depth < v.d1 && x + half > v.x0 && x - half < v.x1) return false;
    }
    return true;
  }

  // Any deadly hazard already placed inside the box?
  deadlyIn(x0, x1, d0, d1) {
    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.d1 < d0 - 120) break;
      if (!e.lethal) continue;
      const half = this.half(e);
      if (e.d1 > d0 && e.d0 < d1 && e.x + half > x0 && e.x - half < x1) return true;
    }
    return false;
  }

  prune(d) {
    const keep = (a) => a.filter((v) => v.d1 > d - 20);
    this.envelopes = keep(this.envelopes);
    this.locks = keep(this.locks);
    this.zones = keep(this.zones);
  }

  // Move the safe line for a row at distance d, coming from the previous way-point.
  moveLane(d, stay) {
    const g = CONFIG.gen;
    const W = CONFIG.lane.halfWidth;
    let prev = this.path[this.path.length - 1];
    // The line may not leave a lock before the lock ends: pin a way-point there.
    for (const k of this.locks) {
      if (prev.d < k.d1 && d > k.d1) {
        prev = { d: k.d1, x: this.lane };
        this.path.push(prev);
      }
    }
    const time = (d - prev.d) / vBound(prev.d);
    const reach = g.planLat * Math.max(0, time - g.planReact);
    const c = this.corridor(d);
    let lo = Math.max(-W + c, this.lane - reach);
    let hi = Math.min(W - c, this.lane + reach);
    for (const k of this.locks) {
      if (d < k.d0 - 6 || d > k.d1 + 6) continue;
      if (k.inside) {
        lo = Math.max(lo, k.x0);
        hi = Math.min(hi, k.x1);
      } else if (this.lane < (k.x0 + k.x1) / 2) hi = Math.min(hi, k.x0 - c);
      else lo = Math.max(lo, k.x1 + c);
    }
    if (hi < lo) {
      // Locks are built so this cannot happen; hold the line if it ever does.
      lo = hi = clamp(this.lane, Math.min(lo, hi), Math.max(lo, hi));
    }
    const r = this.rng();
    const r2 = this.rng();
    if (!stay) {
      // Bias towards real movement so the line wanders across the piste.
      const t = r2 < 0.25 ? 0.5 : r;
      this.lane = clamp(lo + (hi - lo) * t, lo, hi);
    } else this.lane = clamp(this.lane, lo, hi);
    this.path.push({ d, x: this.lane });
    return this.lane;
  }

  // Safe-line x at distance d (linear between way-points).
  laneAt(d) {
    const p = this.path;
    for (let i = p.length - 1; i > 0; i--) {
      if (p[i - 1].d <= d) {
        const a = p[i - 1];
        const b = p[i];
        if (b.d <= a.d) return b.x;
        return lerp(a.x, b.x, clamp((d - a.d) / (b.d - a.d), 0, 1));
      }
    }
    return p[0].x;
  }

  // --- rows -----------------------------------------------------------
  nextRow() {
    const g = CONFIG.gen;
    this.row++;
    const d = this.d;
    this.prune(d);
    if (this.row <= 4) return this.tutorialRow(d);

    const tier = tierAt(d);
    const vb = vBound(d);
    const biome = biomeAt(d);
    const end = this.endgame(d);
    const rowTime = (lerp(g.rowTimeStart, g.rowTimeEnd, tier) / Math.max(0.5, g.density)) * (0.85 + this.rng() * 0.3) * (end ? lerp(1, this.race.denseRows, end) : 1);
    const spacing = rowTime * vb;

    if (--this.featureIn <= 0) {
      this.featureIn = this.int(g.featureEvery);
      const used = this.feature(d, biome, tier, vb, spacing);
      if (used > 0) {
        this.d = d + used;
        return;
      }
    }

    this.moveLane(d, false);
    this.hazardRow(d, biome, tier, vb);
    if (--this.flakeIn <= 0) {
      this.flakeIn = this.int(g.flakeEvery);
      this.flakeLine(d, spacing);
    }
    if (--this.dashIn <= 0) {
      this.dashIn = this.int(g.dashEvery);
      this.dashPad(d, spacing);
    }
    this.d = d + spacing;
  }

  tutorialRow(d) {
    const A = CONFIG.air;
    const h = CONFIG.hazards;
    if (this.row === 1) {
      // Lesson 1: steer. A pine left of the line.
      this.moveLane(d, true);
      this.circle('pine', -2.6, d, 1.1, h.pine.height);
      for (let i = 0; i < 5; i++) this.flake(1.2, d - 16 + i * 6, 0.9);
      this.d = d + 38;
    } else if (this.row === 2) {
      // Lesson 2: jump. A log across the line, nothing behind it.
      this.moveLane(d, true);
      const log = this.box('log', 0.4, d, 2.6, h.log.halfDepth, h.log.height, false, true);
      this.envelopes.push({ x0: -99, x1: 99, d0: d - 10, d1: d + this.jumpDist(d) + 14, all: true });
      this.arc(log.x, d, 26, 1.5, 5);
      this.d = d + 44;
    } else if (this.row === 3) {
      // Lesson 3: a pair to thread.
      this.moveLane(d, true);
      this.circle('boulder', 3.1, d, 1.1, 1.1 * h.boulder.heightPerRadius);
      this.circle('pine', -4.6, d + 4, 1.15, h.pine.height);
      this.d = d + 40;
    } else {
      // Lesson 4: a ramp on the line and time to grab.
      this.moveLane(d, true);
      this.ramp(d, this.lane, vBound(d));
      this.d = d + (airConstants().rampTime + 0.3) * vBound(d);
    }
    void A;
  }

  pickKind(biome, onlyLethal) {
    const table = KIND_WEIGHTS[biome.id];
    let total = 0;
    for (const [k, w] of table) if (!onlyLethal || k === 'pine' || k === 'boulder') total += w;
    let r = this.rng() * total;
    for (const [k, w] of table) {
      if (onlyLethal && k !== 'pine' && k !== 'boulder') continue;
      r -= w;
      if (r <= 0) return k;
    }
    return 'pine';
  }

  hazardRow(d, biome, tier, vb) {
    const g = CONFIG.gen;
    const W = CONFIG.lane.halfWidth;
    const c = this.corridor(d);
    const end = this.endgame(d);
    const dens = g.density * (end ? lerp(1, this.race.denseExtra, end) : 1);
    let n = 1;
    if (this.rng() < lerp(g.extraChanceStart, g.extraChanceEnd, tier) * dens) n++;
    if (this.rng() < g.thirdChanceEnd * tier * dens) n++;
    if (this.rng() < g.fourthChanceEnd * tier * dens) n++;
    let jumpables = 0;
    if (biome.id !== 'forest' && this.rng() < 0.22) {
      // Blue ice: low grip, never deadly. Kept off the safe line.
      const spec = CONFIG.hazards.ice;
      const hw = this.range(spec.halfWidth);
      const hd = this.range(spec.halfDepth);
      const x = -W + this.rng() * 2 * W;
      if (Math.abs(x - this.lane) > hw + c && this.free(x, d + hd, hw, hd, false)) {
        this.box('ice', clamp(x, -W + hw, W - hw), d + hd, hw, hd, 0, false, false);
      }
    }
    for (let i = 0; i < n; i++) {
      let kind = this.pickKind(biome, false);
      if ((kind === 'log' || kind === 'ridge') && jumpables >= 1) kind = this.pickKind(biome, true);
      for (let attempt = 0; attempt < 12; attempt++) {
        const x = -W + this.rng() * 2 * W;
        const dd = d + (i ? (this.rng() - 0.5) * 5 : 0);
        if (this.tryPlace(kind, x, dd, c, vb)) {
          if (kind === 'log' || kind === 'ridge') jumpables++;
          break;
        }
      }
    }
  }

  tryPlace(kind, x, d, c, vb) {
    const h = CONFIG.hazards;
    const W = CONFIG.lane.halfWidth;
    const lane = this.lane;
    if (kind === 'pine' || kind === 'boulder') {
      const r = kind === 'pine' ? this.range(h.pine.radius) : this.range(h.boulder.radius);
      if (Math.abs(x - lane) < r + c) return false;
      if (!this.free(x, d, r + 0.5, r + 0.5, true)) return false;
      if (this.overlapsRecent(x, d, r + 0.8)) return false;
      this.circle(kind, x, d, r, kind === 'pine' ? h.pine.height : r * h.boulder.heightPerRadius);
      return true;
    }
    // Jumpable bar.
    const spec = h[kind];
    const hw = this.range(spec.halfWidth);
    x = clamp(x, -W + hw * 0.6, W - hw * 0.6);
    if (!this.free(x, d, hw + 0.4, spec.halfDepth + 1, false)) return false;
    if (this.overlapsRecent(x, d, hw + 0.8)) return false;
    const J = CONFIG.air.jumpTime * vb;
    // Nothing deadly in its lane for half a jump before it...
    if (this.deadlyIn(x - hw - 0.9, x + hw + 0.9, d - CONFIG.gen.envelopeBefore * J, d + 2)) return false;
    this.box(kind, x, d, hw, spec.halfDepth, spec.height, false, true);
    // ...and nothing at all until a full jump (plus recovery) after it.
    this.envelopes.push({
      x0: x - hw - 0.9,
      x1: x + hw + 0.9,
      d0: d + spec.halfDepth + 0.5,
      d1: d + J + CONFIG.gen.envelopeAfterExtra * vb,
      all: true,
    });
    return true;
  }

  overlapsRecent(x, d, half) {
    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.d1 < d - 14) break;
      if (e.kind === 'flake') continue;
      if (Math.abs(e.d - d) < 7 && Math.abs(e.x - x) < half + this.half(e)) return true;
    }
    return false;
  }

  flakeLine(d, spacing) {
    // Five flakes along the safe line leading into this row.
    const prev = this.path[this.path.length - 2] || this.path[0];
    const from = Math.max(prev.d, d - spacing);
    for (let i = 0; i < 5; i++) {
      const dd = from + ((d - from) * (i + 1)) / 6;
      if (!this.free(this.laneAt(dd), dd, 0.4, 0.4, false)) continue;
      this.flake(this.laneAt(dd), dd, 0.9);
    }
  }

  // A dash pad on the safe line, half-way to this row: a reward for holding the line.
  dashPad(d, spacing) {
    const spec = CONFIG.hazards.dash;
    const dd = d - spacing * 0.5;
    const x = this.laneAt(dd);
    if (!this.free(x, dd, spec.halfWidth, spec.halfDepth, false)) return;
    if (this.overlapsRecent(x, dd, spec.halfWidth + 0.5)) return;
    this.box('dash', x, dd, spec.halfWidth, spec.halfDepth, 0, false, false);
  }

  // Flakes on a parabola: a reward line for a jump.
  arc(x, d, length, height, count) {
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      this.flake(x, d - length * 0.35 + length * u, 0.9 + 4 * height * u * (1 - u));
    }
  }

  // --- features ---------------------------------------------------------
  feature(d, biome, tier, vb, spacing) {
    const table = FEATURES[biome.id].filter(([k]) => d >= FEATURE_FROM[k] && k !== this.lastFeature);
    let total = 0;
    for (const [, w] of table) total += w;
    let r = this.rng() * total;
    let pick = table[0][0];
    for (const [k, w] of table) {
      r -= w;
      if (r <= 0) {
        pick = k;
        break;
      }
    }
    // A feature never starts inside another one's lock.
    for (const k of this.locks) if (d < k.d1 + 10) return 0;
    this.lastFeature = pick;
    if (pick === 'ramp') return this.rampFeature(d, vb);
    if (pick === 'wall') return this.wall(d, biome, vb);
    if (pick === 'gate') return this.gate(d, biome, vb, spacing);
    if (pick === 'mogul') return this.moguls(d, vb, spacing);
    if (pick === 'crevasse') return this.crevasse(d, vb, spacing);
    if (pick === 'cliff') return this.cliff(d, vb);
    if (pick === 'arch') return this.arch(d, vb, spacing);
    return 0;
  }

  ramp(d, x, vb) {
    const spec = CONFIG.hazards.ramp;
    const W = CONFIG.lane.halfWidth;
    x = clamp(x, -W + spec.halfWidth + 0.4, W - spec.halfWidth - 0.4);
    const flight = airConstants().rampTime * vb;
    this.box('ramp', x, d, spec.halfWidth, spec.halfDepth, 0, false, false);
    this.zones.push({ x0: x - spec.halfWidth - 1, x1: x + spec.halfWidth + 1, d0: d - 8, d1: d + 4 });
    // Landing zone: nothing deadly anywhere the flight can drift to.
    this.envelopes.push({ x0: x - spec.halfWidth - 3.2, x1: x + spec.halfWidth + 3.2, d0: d - 4, d1: d + flight + 0.3 * vb, all: true });
    // Something to fly over, early in the flight so it is cleared at any speed.
    const bar = biomeAt(d).id === 'glacier' ? 'ridge' : 'log';
    const bs = CONFIG.hazards[bar];
    this.box(bar, x, d + flight * 0.3, 2.2, bs.halfDepth, bs.height, false, true);
    for (let i = 0; i < 6; i++) {
      const u = (i + 1) / 7;
      this.flake(x, d + flight * 0.72 * u, 1 + 4 * 3.3 * u * (1 - u));
    }
    return flight;
  }

  rampFeature(d, vb) {
    // On the line (you take it unless you steer off) or beside it (a choice).
    this.moveLane(d, true);
    const side = this.rng() < 0.5 ? -1 : 1;
    const offset = this.rng() < 0.45 ? 0 : side * (3.2 + this.rng() * 1.2);
    const W = CONFIG.lane.halfWidth;
    let x = this.lane + offset;
    if (Math.abs(x) > W - 2.2) x = this.lane - offset;
    this.ramp(d, x, vb);
    return 0.55 * CONFIG.gen.rowTimeEnd * vb;
  }

  wall(d, biome, vb) {
    // Jumpables across the whole piste: the jump is the only clean way through.
    const kind = biome.id === 'glacier' ? 'ridge' : biome.id === 'storm' && this.rng() < 0.5 ? 'ridge' : 'log';
    const spec = CONFIG.hazards[kind];
    const W = CONFIG.lane.halfWidth;
    const J = CONFIG.air.jumpTime * vb;
    const d0 = d + CONFIG.gen.envelopeBefore * J;
    if (this.deadlyIn(-99, 99, d0 - CONFIG.gen.envelopeBefore * J, d0 + 2)) return 0;
    this.moveLane(d0, true);
    const pieces = 3;
    const hw = (2 * W) / pieces / 2 + 0.15;
    for (let i = 0; i < pieces; i++) {
      const x = -W + ((i + 0.5) * 2 * W) / pieces;
      this.box(kind, x, d0 + (i % 2 ? 0.5 : -0.5), hw, spec.halfDepth, spec.height, false, true);
    }
    this.arc(this.lane, d0, J * 0.75, 1.5, 5);
    const end = d0 + J + CONFIG.gen.envelopeAfterExtra * vb;
    this.envelopes.push({ x0: -99, x1: 99, d0: d0 - 6, d1: end, all: true });
    return end - d;
  }

  gate(d, biome, vb, spacing) {
    // A line of deadly hazards with a wide gap on the safe line and a narrow,
    // flake-baited gap elsewhere.
    const W = CONFIG.lane.halfWidth;
    const h = CONFIG.hazards;
    this.moveLane(d, false);
    const c = this.corridor(d) + 0.5;
    const narrow = CONFIG.player.radius + 0.85;
    let gx = this.lane + (this.lane > 0 ? -1 : 1) * (4.2 + this.rng() * 3);
    gx = clamp(gx, -W + 2.2, W - 2.2);
    if (Math.abs(gx - this.lane) < c + narrow + 2) gx = clamp(-this.lane, -W + 2.2, W - 2.2);
    const hasNarrow = Math.abs(gx - this.lane) >= c + narrow + 2;
    let x = -W + 0.6 + this.rng() * 0.6;
    while (x < W - 0.3) {
      const kind = this.pickKind(biome, true);
      const r = kind === 'pine' ? this.range(h.pine.radius) : h.boulder.radius[0] + this.rng() * 0.3;
      const cx = x + r;
      const okLane = Math.abs(cx - this.lane) >= r + c;
      const okGap = !hasNarrow || Math.abs(cx - gx) >= r + narrow;
      const dd = d + (this.rng() - 0.5) * 2.4;
      if (okLane && okGap && this.free(cx, dd, r + 0.3, r + 0.5, true) && !this.overlapsRecent(cx, dd, r + 0.25)) {
        this.circle(kind, cx, dd, r, kind === 'pine' ? h.pine.height : r * h.boulder.heightPerRadius);
        x = cx + r + 0.35 + this.rng() * 0.5;
      } else x += 0.45;
    }
    if (hasNarrow) for (let i = 0; i < 5; i++) this.flake(gx, d - 14 + i * 7, 0.9);
    void vb;
    return spacing * 1.15;
  }

  moguls(d, vb, spacing) {
    const spec = CONFIG.hazards.mogul;
    const W = CONFIG.lane.halfWidth;
    this.moveLane(d, false);
    const hw = this.range(spec.halfWidth);
    const hd = this.range(spec.halfDepth) * (vb / 46);
    const c = this.corridor(d);
    const side = this.lane > 0 ? -1 : 1;
    let x = this.lane + side * (hw + c + 0.4 + this.rng() * 1.5);
    x = clamp(x, -W + hw, W - hw);
    if (Math.abs(x - this.lane) < hw + c) return 0;
    const dc = d + hd;
    if (!this.free(x, dc, hw, hd, false)) return 0;
    this.box('mogul', x, dc, hw, hd, 0, false, false);
    this.zones.push({ x0: x - hw, x1: x + hw, d0: dc - hd, d1: dc + hd });
    // Reward the clean line beside the field.
    for (let i = 0; i < 4; i++) this.flake(this.lane, d + (i + 0.5) * (hd / 2), 0.9);
    this.moveLane(d + hd * 2, true);
    this.hazardRow(d + hd * 2, biomeAt(d), tierAt(d), vb);
    return Math.max(spacing, hd * 2 + spacing * 0.5);
  }

  crevasse(d, vb, spacing) {
    // A crack running down the slope, longer than any jump.
    const spec = CONFIG.hazards.crevasse;
    const W = CONFIG.lane.halfWidth;
    this.moveLane(d, true);
    const hw = this.range(spec.halfWidth);
    const length = spec.jumpsLong * CONFIG.air.jumpTime * vb + 6;
    const c = this.corridor(d);
    const side = this.rng() < 0.5 ? -1 : 1;
    let x = this.lane + side * (hw + c + 0.8 + this.rng() * 1.6);
    if (Math.abs(x) > W - hw - 0.5) x = this.lane - side * (hw + c + 0.8 + this.rng() * 1.6);
    if (Math.abs(x) > W - hw - 0.5) return 0;
    const d0 = d + spacing * 0.6;
    const dc = d0 + length / 2;
    if (!this.free(x, dc, hw + 0.5, length / 2, true)) return 0;
    if (this.deadlyIn(x - hw - 1, x + hw + 1, d0 - 4, d0 + length)) return 0;
    this.box('crevasse', x, dc, hw, length / 2, 0, true, false);
    this.zones.push({ x0: x - hw - 1.2, x1: x + hw + 1.2, d0: d0 - 6, d1: d0 + length + 4 });
    this.locks.push({ x0: x - hw, x1: x + hw, d0, d1: d0 + length, inside: false });
    this.envelopes.push({ x0: x - hw - 0.6, x1: x + hw + 0.6, d0: d0 + length - 2, d1: d0 + length + 0.25 * vb, all: false });
    // Flakes on the far side: hop across for them, or leave them.
    const far = x + (x > this.lane ? 1 : -1) * (hw + 1.6);
    if (Math.abs(far) < W - 0.8) for (let i = 0; i < 4; i++) this.flake(far, d0 + length * (0.3 + i * 0.12), 0.9);
    return spacing; // normal rows continue alongside
  }

  cliff(d, vb) {
    // Full-width drop. Clear run-in and a landing zone for the longest possible air.
    const A = CONFIG.air;
    const k = airConstants();
    const dc = d + 16;
    if (this.deadlyIn(-99, 99, dc - 14, dc + 2)) return 0;
    this.moveLane(dc, true);
    const airMax = (k.jumpVy + Math.sqrt(k.jumpVy * k.jumpVy + 2 * k.g * A.cliffDrop)) / k.g;
    this.add({ kind: 'cliff', x: 0, d: dc, hd: 0, h: 0, lethal: false, jump: false });
    this.cliffs.push(dc);
    const end = dc + (airMax + 0.3) * vb;
    this.envelopes.push({ x0: -99, x1: 99, d0: dc - 14, d1: end, all: true });
    const fall = Math.sqrt((2 * A.cliffDrop) / k.g) * vb;
    for (let i = 0; i < 5; i++) {
      const u = (i + 1) / 6;
      this.flake(this.lane, dc + fall * 0.8 * u, 0.9 + A.cliffDrop * (1 - u) * (1 - u) * 0.25);
    }
    return end - d;
  }

  arch(d, vb, spacing) {
    // Ice arches: a gallery centred on the safe line.
    const spec = CONFIG.hazards.arch;
    const W = CONFIG.lane.halfWidth;
    const cx = clamp(this.lane, -W + spec.halfWidth + 1.2, W - spec.halfWidth - 1.2);
    const d0 = d + spacing * 0.8;
    const length = this.range(spec.seconds) * vb;
    const dc = d0 + length / 2;
    const out = spec.halfWidth + spec.pillarRadius * 2 + 0.4;
    if (this.deadlyIn(cx - out - 1, cx + out + 1, d0 - 0.5 * CONFIG.air.jumpTime * vb, d0 + length)) return 0;
    if (!this.free(cx, dc, out, length / 2 + 2, true)) return 0;
    this.box('arch', cx, dc, spec.halfWidth, length / 2, 0, false, false);
    const px = spec.halfWidth + spec.pillarRadius;
    this.circle('pillar', cx - px, d0, spec.pillarRadius, spec.pillarHeight);
    this.circle('pillar', cx + px, d0, spec.pillarRadius, spec.pillarHeight);
    this.zones.push({ x0: cx - out, x1: cx + out, d0: d0 - 0.5 * CONFIG.air.jumpTime * vb, d1: d0 + length + 3 });
    this.locks.push({ x0: cx - 1.1, x1: cx + 1.1, d0, d1: d0 + length, inside: true });
    // Nothing deadly in front of the exit for half a second.
    this.envelopes.push({ x0: cx - out - 0.5, x1: cx + out + 0.5, d0: d0 + length - 2, d1: d0 + length + 0.5 * vb, all: false });
    this.moveLane(d0, true); // way-point at the mouth, inside the gallery
    const n = Math.floor(length / 9);
    for (let i = 0; i < n; i++) this.flake(cx, d0 + 6 + i * 9, 0.9);
    return spacing; // rows continue outside the gallery
  }
}
