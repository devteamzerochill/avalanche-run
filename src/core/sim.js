// The simulation: fixed 60 Hz step, no DOM, no wall clock, no Math.random,
// no transcendental functions. Seed + inputs => the same run, everywhere.
import { CONFIG, airConstants } from '../config.js';
import { Course, biomeAt } from './course.js';
import { clamp, smoothstep, hashString } from './rng.js';

export const NO_INPUT = { tx: 0, jump: false, grab: false };

export class Sim {
  constructor(seed, opts) {
    const P = CONFIG.player;
    this.seed = seed >>> 0;
    this.timeCap = (opts && opts.timeCap) || 0;
    this.tricks = CONFIG.score.tricks;
    // Endurance races only: after ramp.from seconds the avalanche gains
    // ramp.rate m/s every second until it outruns any rider, so every race ends.
    this.ramp = (opts && opts.ramp) || null;
    this.course = new Course(this.seed, this.ramp);
    this.k = airConstants();
    this.events = [];

    this.tick = 0;
    this.t = 0;
    this.phase = 'ride'; // ride | wipe | over
    this.outcome = null; // crash | caught | timeout
    this.cause = null; // hazard kind, or 'caught'
    this.causeDetail = '';
    this.dist = 0;
    this.bonus = 0; // near-miss points only: the score is metres plus this, as on zerochill.com
    this.cruise = P.startSpeed;
    this.v = P.startSpeed * 0.6;
    this.x = 0;
    this.tx = 0;
    this.vx = 0;
    this.y = 0;
    this.vy = 0;
    this.air = false;
    this.airT = 0;
    this.airKind = '';
    this.jumpQueuedT = -9;
    this.grab = false;
    this.grabT = 0;
    this.grabRelT = -9;
    this.drift = 0;
    this.surface = 'snow';
    this.inArch = null;
    this.boostT = 0;
    this.boostNow = 0;
    this.gap = CONFIG.avalanche.startGap;
    this.danger = 1 - this.gap / CONFIG.avalanche.maxGap;
    this.combo = 0;
    this.comboT = -9;
    this.wind = 0;
    this.wipeT = 0;
    this.wipeV = 0;
    this.first = 0; // index of the first entity still relevant
    this.nextMilestone = CONFIG.score.milestoneEvery;
    this.biome = biomeAt(0);
    this.lastStumbleT = -99;
    this.lastSloppyT = -99;
    this.stats = {
      nearMisses: 0,
      bestCombo: 0,
      topSpeed: 0,
      flakes: 0,
      cleanJumps: 0,
      tricks: 0,
      perfects: 0,
      sloppy: 0,
      trickScore: 0,
      stumbles: 0,
      jumps: 0,
      hops: 0,
      dashes: 0,
    };
    this.course.ensure(CONFIG.lane.viewDist + 80);
  }

  get score() {
    return Math.floor(this.dist) + this.bonus + (this.tricks ? this.stats.trickScore : 0);
  }

  emit(type, data) {
    const e = data || {};
    e.type = type;
    e.t = this.t;
    this.events.push(e);
  }

  // Seconds until touchdown on the current arc (0 on the ground).
  timeToLand() {
    if (!this.air) return 0;
    const g = this.k.g;
    return (this.vy + Math.sqrt(this.vy * this.vy + 2 * g * Math.max(0, this.y))) / g;
  }

  step(input) {
    if (this.phase === 'over') return;
    const dt = CONFIG.tick;
    this.tick++;
    if (this.phase === 'wipe') {
      this.stepWipe(dt);
      return;
    }
    const P = CONFIG.player;
    const A = CONFIG.air;
    const W = CONFIG.lane.halfWidth;
    this.t += dt;
    this.cruise = Math.min(P.maxSpeed, P.startSpeed + P.speedRamp * this.t);

    // --- combo timeout ---
    if (this.combo > 0 && this.t - this.comboT > CONFIG.score.comboWindow) {
      this.combo = 0;
      this.emit('comboEnd');
    }

    // --- lateral: carve towards the target line ---
    this.tx = clamp(input.tx, -W, W);
    let grip = P.grip;
    if (this.air) grip = P.airControl;
    else if (this.surface === 'ice') grip *= CONFIG.surface.ice;
    else if (this.surface === 'mogul') grip *= CONFIG.surface.mogul;
    else if (this.biome.id === 'glacier') grip *= CONFIG.surface.glacier;
    else if (this.biome.id === 'storm') grip *= CONFIG.surface.storm;
    // Wanted lateral speed: proportional to the error, but never more than the
    // edge can stop again before the target line (so low grip means a slower,
    // sliding carve rather than an overshoot into whatever is beside the line).
    const err = this.tx - this.x;
    const aerr = err < 0 ? -err : err;
    const stoppable = Math.sqrt(2 * grip * aerr) * P.brakeShare;
    const speed = Math.min(P.latMax, aerr * P.steerGain, stoppable);
    const want = err < 0 ? -speed : speed;
    if (!this.air) {
      const maxDv = grip * dt;
      const dv = want - this.vx;
      const adv = dv < 0 ? -dv : dv;
      this.drift = clamp((adv - maxDv) / (P.driftSpan * dt), 0, 1);
      this.vx += clamp(dv, -maxDv, maxDv);
    } else {
      const maxDv = P.airControl * dt;
      this.vx += clamp(want - this.vx, -maxDv, maxDv);
      this.vx += this.wind * CONFIG.wind.accel * dt;
      this.drift = 0;
    }
    this.x += this.vx * dt;
    if (this.x > W) {
      this.x = W;
      if (this.vx > 0) this.vx = 0;
    } else if (this.x < -W) {
      this.x = -W;
      if (this.vx < 0) this.vx = 0;
    }

    // --- forward speed ---
    let boost = 0;
    if (this.boostT > 0) {
      this.boostT -= dt;
      boost = CONFIG.boost.amount * clamp(this.boostT / CONFIG.boost.fade, 0, 1);
    }
    if (this.inArch && boost < CONFIG.boost.tunnelAmount) boost = CONFIG.boost.tunnelAmount;
    this.boostNow = boost;
    const target = this.cruise + boost;
    const rate = boost > 0 && this.v < target ? P.boostAccelRate : P.accelRate;
    this.v += (target - this.v) * rate * dt;
    if (!this.air) {
      const avx = this.vx < 0 ? -this.vx : this.vx;
      this.v -= Math.min(P.carveDragMax, avx * P.carveDragPerVx) * dt;
      this.v -= this.drift * P.driftDrag * dt;
      if (this.surface === 'mogul') this.v -= CONFIG.mogulDrag * dt;
    }
    if (this.v < 4) this.v = 4;
    if (this.v > this.stats.topSpeed) this.stats.topSpeed = this.v;
    const prevDist = this.dist;
    this.dist += this.v * dt;

    // --- avalanche ---
    const AV = CONFIG.avalanche;
    const factor = AV.baseFactor + AV.surgeFactor * smoothstep(AV.surgeFrom, AV.surgeTo, this.gap);
    let avSpeed = this.cruise * (1 - (1 - factor) / AV.chase);
    if (this.ramp && this.t > this.ramp.from) avSpeed += this.ramp.rate * (this.t - this.ramp.from);
    this.gap = clamp(this.gap + (this.v - avSpeed) * dt, -1, AV.maxGap);
    this.danger = clamp(1 - this.gap / AV.maxGap, 0, 1);

    // --- vertical ---
    if (input.jump) {
      if (!this.air) this.jump();
      else this.jumpQueuedT = this.t;
    }
    if (this.air) {
      this.airT += dt;
      this.y += this.vy * dt - 0.5 * this.k.g * dt * dt;
      this.vy -= this.k.g * dt;
      if (input.grab && this.airT > A.grabDelay) {
        if (!this.grab) {
          this.grab = true;
          this.emit('grab');
        }
        this.grabT += dt;
      } else if (this.grab) {
        this.grab = false;
        this.grabRelT = this.t;
        this.emit('release');
      }
      if (this.y <= 0) this.land();
    }

    // --- world ---
    this.biome = this.updateBiome();
    this.course.ensure(this.dist + CONFIG.lane.viewDist + 80);
    this.collide(prevDist);
    if (this.phase !== 'ride') return;

    if (this.gap <= 0) {
      this.caught();
      return;
    }
    if (this.score >= this.nextMilestone) {
      this.emit('milestone', { at: this.nextMilestone });
      this.nextMilestone += CONFIG.score.milestoneEvery;
    }
    if (this.timeCap > 0 && this.t >= this.timeCap) {
      this.outcome = 'timeout';
      this.cause = 'timeout';
      this.phase = 'over';
      this.emit('over');
    }
  }

  updateBiome() {
    const b = biomeAt(this.dist);
    if (b.start !== this.biome.start) this.emit('biome', { id: b.id, cycle: b.cycle });
    if (b.id === 'storm') {
      // Triangle wave in distance: gusts you can see coming.
      const p = CONFIG.wind.period;
      const u = (this.dist % p) / p;
      const tri = u < 0.25 ? u * 4 : u < 0.75 ? 2 - u * 4 : u * 4 - 4;
      this.wind = tri;
    } else this.wind = 0;
    return b;
  }

  jump() {
    this.air = true;
    this.airT = 0;
    this.airKind = 'jump';
    this.vy = this.k.jumpVy;
    this.y = 0.0001;
    this.stats.jumps++;
    this.emit('jump');
  }

  comboUp() {
    const S = CONFIG.score;
    this.combo = this.combo > 0 && this.t - this.comboT <= S.comboWindow ? Math.min(S.comboMax, this.combo + 1) : 1;
    this.comboT = this.t;
    if (this.combo > this.stats.bestCombo) this.stats.bestCombo = this.combo;
    return this.combo;
  }

  land() {
    const A = CONFIG.air;
    const sinceRelease = this.t - this.grabRelT;
    let quality = 'ok';
    let pts = 0;
    if (this.grab && this.grabT >= A.perfectMinHold) quality = 'sloppy';
    else if (this.grabT >= A.perfectMinHold && sinceRelease >= A.perfectWindowMin && sinceRelease <= A.perfectWindowMax) quality = 'perfect';
    const tricked = this.grabT >= 0.12;
    if (quality === 'sloppy') {
      this.v *= A.sloppySpeedMul;
      this.gap -= A.sloppyGapLoss;
      this.combo = 0;
      this.stats.sloppy++;
      this.lastSloppyT = this.t;
    } else if (tricked) {
      this.stats.tricks++;
      const combo = this.comboUp();
      pts = Math.round(this.grabT * A.trickRate) * combo;
      if (quality === 'perfect') {
        pts *= 2;
        this.stats.perfects++;
        this.boostT = CONFIG.boost.time;
        this.gap = Math.min(CONFIG.avalanche.maxGap, this.gap + CONFIG.boost.perfectGapGain);
        this.emit('boost');
      }
      this.stats.trickScore += pts;
    }
    this.emit('land', { quality, pts, tricked, airKind: this.airKind, airT: this.airT, combo: this.combo });
    this.air = false;
    this.y = 0;
    this.vy = 0;
    this.grab = false;
    this.grabT = 0;
    this.grabRelT = -9;
    if (this.t - this.jumpQueuedT < A.jumpBuffer) this.jump();
  }

  collide(prevDist) {
    const list = this.course.entities;
    const P = CONFIG.player;
    const S = CONFIG.score;
    const F = CONFIG.hazards.flake;
    while (this.first < list.length && list[this.first].d1 < this.dist - 45) this.first++;
    let surface = 'snow';
    let arch = null;
    for (let i = this.first; i < list.length; i++) {
      const e = list[i];
      if (e.d0 > this.dist + 4) break;
      if (e.done) continue;
      const dz = e.d - this.dist; // > 0: ahead
      const dx = this.x - e.x;
      const adx = dx < 0 ? -dx : dx;
      const adz = dz < 0 ? -dz : dz;
      const kind = e.kind;

      if (kind === 'flake') {
        if (adz < 1.3 && adx < F.radius) {
          const dy = this.y + F.height - e.y;
          if (dy < 1.5 && dy > -1.5) {
            e.done = true;
            e.got = true;
            this.stats.flakes++;
            this.emit('flake', { x: e.x, y: e.y, d: e.d, n: this.stats.flakes });
            continue;
          }
        }
        if (dz < -2) e.done = true;
        continue;
      }

      if (e.r != null) {
        // Deadly circle: pine, boulder, pillar.
        if (adz < e.r + P.depth && this.y < e.h) {
          const edge = Math.max(0, adz - P.depth * 0.4);
          if (adx * adx + edge * edge < (e.r + P.radius) * (e.r + P.radius)) {
            this.crash(e);
            return;
          }
        }
        if (dz < -(e.r + P.depth)) {
          e.done = true;
          const gapEdge = adx - e.r - P.radius;
          if (gapEdge > 0 && gapEdge <= S.nearMissMargin && this.y < e.h) this.nearMiss(e, gapEdge, dx);
        }
        continue;
      }

      if (kind === 'log' || kind === 'ridge') {
        if (!e.hit && adx < e.hw + P.radius && adz < e.hd + P.depth && this.y < e.h) this.stumble(e);
        if (dz < -(e.hd + P.depth)) {
          e.done = true;
          if (!e.hit && adx < e.hw + P.radius && this.air) {
            this.stats.cleanJumps++;
            const combo = this.comboUp();
            const pts = S.cleanJumpBonus * combo;
            this.stats.trickScore += pts;
            this.emit('clean', { pts, combo, x: e.x });
          }
        }
        continue;
      }

      if (kind === 'crevasse') {
        const inLen = this.dist > e.d0 && this.dist < e.d1;
        if (inLen) {
          if (adx < e.hw + 0.1) {
            if (this.y < 0.15) {
              this.crash(e);
              return;
            }
            if (!e.hopped) {
              e.hopped = true;
              this.stats.hops++;
              const combo = this.comboUp();
              const pts = 30 * combo;
              this.stats.trickScore += pts;
              this.emit('hop', { pts, combo });
            }
          }
          const edge = adx - e.hw - P.radius;
          if (edge > 0 && (e.minEdge == null || edge < e.minEdge)) e.minEdge = edge;
        }
        if (this.dist > e.d1 + P.depth) {
          e.done = true;
          if (!e.hopped && e.minEdge != null && e.minEdge <= S.nearMissMargin) this.nearMiss(e, e.minEdge, dx);
        }
        continue;
      }

      if (kind === 'ramp') {
        if (!this.air && adx < e.hw && adz < e.hd) {
          e.done = true;
          e.used = true;
          this.air = true;
          this.airT = 0;
          this.airKind = 'ramp';
          this.vy = CONFIG.air.rampVy;
          this.y = 0.0001;
          this.stats.jumps++;
          this.emit('ramp');
        } else if (dz < -e.hd) e.done = true;
        continue;
      }

      if (kind === 'dash') {
        if (!this.air && adx < e.hw + P.radius * 0.5 && adz < e.hd) {
          e.done = true;
          e.used = true;
          this.boostT = Math.max(this.boostT, CONFIG.boost.dashTime);
          this.gap = Math.min(CONFIG.avalanche.maxGap, this.gap + CONFIG.boost.dashGapGain);
          this.stats.dashes++;
          this.emit('dash', { x: e.x });
        } else if (dz < -e.hd) e.done = true;
        continue;
      }

      if (kind === 'cliff') {
        if (prevDist < e.d && this.dist >= e.d) {
          e.done = true;
          this.y += CONFIG.air.cliffDrop;
          if (!this.air) {
            this.air = true;
            this.airT = 0;
            this.airKind = 'cliff';
            this.vy = 0;
            this.stats.jumps++;
          }
          this.emit('cliff');
        }
        continue;
      }

      if (kind === 'mogul' || kind === 'ice') {
        if (this.dist > e.d1) e.done = true;
        else if (!this.air && this.dist > e.d0 && adx < e.hw) {
          if (kind === 'mogul') surface = 'mogul';
          else if (surface !== 'mogul') surface = 'ice';
        }
        continue;
      }

      if (kind === 'arch') {
        if (this.dist > e.d1) {
          e.done = true;
          if (e.inside) this.emit('archExit');
          continue;
        }
        if (this.dist >= e.d0) {
          if (e.inside == null) {
            e.inside = adx < e.hw;
            if (e.inside) this.emit('archEnter');
          }
          const lim = e.hw - P.radius;
          if (e.inside) {
            arch = e;
            if (dx > lim) {
              this.x = e.x + lim;
              if (this.vx > 0) this.vx = 0;
            } else if (dx < -lim) {
              this.x = e.x - lim;
              if (this.vx < 0) this.vx = 0;
            }
          } else {
            const out = e.hw + P.radius + 0.5;
            if (adx < out) {
              this.x = e.x + (dx < 0 ? -out : out);
              this.vx = 0;
            }
          }
        }
      }
    }
    if (surface !== this.surface) {
      this.surface = surface;
      this.emit('surface', { surface });
    }
    this.inArch = arch;
  }

  nearMiss(e, edge, dx) {
    const S = CONFIG.score;
    const combo = this.comboUp();
    const pts = S.nearMissBonus * combo;
    this.stats.nearMisses++;
    this.bonus += pts;
    this.gap = Math.min(CONFIG.avalanche.maxGap, this.gap + CONFIG.avalanche.nearMissGain);
    this.emit('nearMiss', { pts, combo, close: edge <= S.closeCallMargin, kind: e.kind, x: e.x, side: dx < 0 ? -1 : 1 });
  }

  stumble(e) {
    const AV = CONFIG.avalanche;
    e.hit = true;
    this.stats.stumbles++;
    this.v *= AV.stumbleSpeedMul;
    this.gap -= AV.stumbleLoss;
    this.combo = 0;
    this.lastStumbleT = this.t;
    this.emit('stumble', { kind: e.kind });
  }

  crash(e) {
    e.hit = true;
    this.outcome = 'crash';
    this.cause = e.kind;
    this.causeDetail = this.air ? 'air' : this.drift > 0.5 || this.surface === 'ice' ? 'drift' : '';
    this.startWipe();
    this.emit('crash', { kind: e.kind, x: e.x, d: e.d, detail: this.causeDetail });
  }

  caught() {
    this.outcome = 'caught';
    this.cause = 'caught';
    this.causeDetail = this.t - this.lastStumbleT < 12 ? 'stumble' : this.t - this.lastSloppyT < 10 ? 'sloppy' : 'slow';
    this.startWipe();
    this.emit('caught', { detail: this.causeDetail });
  }

  startWipe() {
    this.phase = 'wipe';
    this.wipeT = 0;
    this.wipeV = this.v;
    this.combo = 0;
    this.boostT = 0;
    this.boostNow = 0;
  }

  stepWipe(dt) {
    this.wipeT += dt;
    this.v = Math.max(0, this.v - Math.max(18, this.wipeV * 1.4) * dt);
    this.dist += this.v * dt;
    if (this.y > 0) {
      this.vy -= this.k.g * dt;
      this.y = Math.max(0, this.y + this.vy * dt);
    }
    this.vx *= 0.92;
    this.gap -= (this.cruise * 0.9 - this.v) * dt * (this.cause === 'caught' ? 1.6 : 0.5);
    if (this.gap < -1.5) this.gap = -1.5;
    this.danger = clamp(1 - this.gap / CONFIG.avalanche.maxGap, 0, 1);
    if (this.wipeT > 1.9) {
      this.phase = 'over';
      this.emit('over');
    }
  }

  summary() {
    const s = this.stats;
    return {
      seed: this.seed,
      score: this.score,
      distance: Math.floor(this.dist),
      bonus: Math.floor(this.bonus),
      time: this.t,
      ticks: this.tick,
      outcome: this.outcome,
      cause: this.cause,
      causeDetail: this.causeDetail,
      biome: this.biome.id,
      topKmh: Math.round(s.topSpeed * 3.6),
      nearMisses: s.nearMisses,
      bestCombo: s.bestCombo,
      flakes: s.flakes,
      cleanJumps: s.cleanJumps,
      tricks: s.tricks,
      perfects: s.perfects,
      trickScore: s.trickScore,
      stumbles: s.stumbles,
    };
  }

  // Compact fingerprint of the state, for determinism checks and Proof of Play.
  fingerprint() {
    const r = (v) => Math.round(v * 1000);
    return hashString(
      [this.tick, r(this.dist), r(this.bonus), r(this.x), r(this.y), r(this.v), r(this.gap), this.combo, this.stats.flakes, this.phase, this.cause].join('|')
    );
  }
}
