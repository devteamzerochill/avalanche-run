// A bot that plays through the same input interface as a person: it only
// decides a target line, when to jump and when to grab. Used by the tests,
// by ?bot=1 and by the debug hook.
import { CONFIG } from '../config.js';
import { clamp } from './rng.js';

export class Bot {
  constructor(opts) {
    this.tricks = !opts || opts.tricks !== false;
    this.tx = 0;
    this.hold = 0;
    this.lat = 11; // m/s the bot assumes it can move sideways
    this.margin = 0.5;
    this.traj = new Float64Array(40);
  }

  // Predicted lateral position over time if the bot steered for x from now:
  // a coarse run of the same carve controller the simulation uses.
  plan(sim, x) {
    const P = CONFIG.player;
    let grip = sim.air ? P.airControl : P.grip * (sim.biome.id === 'glacier' ? CONFIG.surface.glacier : sim.biome.id === 'storm' ? CONFIG.surface.storm : 1);
    if (sim.surface === 'ice') grip = P.grip * CONFIG.surface.ice;
    grip *= 0.85;
    const out = this.traj;
    let px = sim.x;
    let vx = sim.vx;
    const h = 0.05;
    for (let i = 0; i < out.length; i++) {
      out[i] = px;
      const err = x - px;
      const a = Math.abs(err);
      const sp = Math.min(P.latMax, a * P.steerGain, Math.sqrt(2 * grip * a) * P.brakeShare);
      const want = err < 0 ? -sp : sp;
      vx += clamp(want - vx, -grip * h, grip * h);
      px += vx * h;
    }
  }

  at(sim, x, t) {
    const f = Math.min(this.traj.length - 1.001, Math.max(0, t / 0.05));
    const i = Math.floor(f);
    return this.traj[i] + (this.traj[i + 1] - this.traj[i]) * (f - i);
  }

  cost(sim, x, ents, horizon) {
    const P = CONFIG.player;
    const v = Math.max(8, sim.v);
    this.plan(sim, x);
    let cost = Math.abs(x - sim.x) * 0.05 + Math.abs(x) * 0.012 + Math.abs(x - this.tx) * 0.02;
    for (const e of ents) {
      const half = e.r != null ? e.r : e.hw;
      const need = half + P.radius + this.margin;
      if (e.lethal) {
        const t0 = Math.max(0, (e.d0 - P.depth - sim.dist) / v);
        const t1 = Math.max(0, (e.d1 + P.depth - sim.dist) / v);
        let worst = 99;
        for (let i = 0; i <= 8; i++) {
          const t = t0 + ((t1 - t0) * i) / 8;
          const off = Math.abs(this.at(sim, x, t) - e.x);
          if (off < worst) worst = off;
        }
        const urgency = 1 + 3 * (1 - clamp(t0 / horizon, 0, 1));
        if (worst < need) cost += 40 * urgency + (need - worst) * 10;
        else if (worst < need + 0.6) cost += 0.4;
        else if (worst < need + 1.2) cost -= 0.05; // a near miss is worth a little
      } else if (e.jump) {
        const t0 = Math.max(0, (e.d0 - sim.dist) / v);
        if (Math.abs(this.at(sim, x, t0) - e.x) < half + P.radius) cost += 0.6;
      } else if (e.kind === 'mogul' || e.kind === 'ice') {
        const t0 = Math.max(0, (e.d0 - sim.dist) / v);
        if (Math.abs(this.at(sim, x, t0) - e.x) < half) cost += e.kind === 'mogul' ? 1.2 : 0.5;
      } else if (e.kind === 'dash') {
        const t0 = Math.max(0, (e.d - sim.dist) / v);
        if (Math.abs(this.at(sim, x, t0) - e.x) < half) cost -= 0.4;
      } else if (e.kind === 'flake') {
        const t0 = Math.max(0, (e.d - sim.dist) / v);
        if (Math.abs(this.at(sim, x, t0) - e.x) < 0.7) cost -= 0.12;
      }
    }
    return cost;
  }

  decide(sim) {
    const P = CONFIG.player;
    const W = CONFIG.lane.halfWidth;
    const v = Math.max(8, sim.v);
    const horizon = 1.7;
    const list = sim.course.entities;
    const ents = [];
    for (let i = sim.first; i < list.length; i++) {
      const e = list[i];
      if (e.d0 > sim.dist + v * horizon) break;
      if (e.done || e.d1 < sim.dist - 1 || e.kind === 'cliff' || e.kind === 'ramp' || e.kind === 'arch') continue;
      ents.push(e);
    }
    let best = this.tx;
    let bestCost = this.cost(sim, this.tx, ents, horizon) - 0.3; // stickiness
    for (let x = -W + 0.3; x <= W - 0.3 + 1e-6; x += 0.3) {
      const c = this.cost(sim, x, ents, horizon);
      if (c < bestCost) {
        bestCost = c;
        best = x;
      }
    }
    this.tx = best;

    // Jump anything jumpable we are about to ride into.
    let jump = false;
    if (!sim.air) {
      for (const e of ents) {
        if (!e.jump || e.hit) continue;
        const t = (e.d0 - P.depth - sim.dist) / v;
        if (t > 0.02 && t < 0.3 && Math.abs(sim.x + sim.vx * t - e.x) < e.hw + P.radius + 0.3) jump = true;
      }
    }

    // Grab on big air, let go inside the perfect window.
    let grab = false;
    if (this.tricks && sim.air) {
      const left = sim.timeToLand();
      const big = sim.airKind === 'ramp' || sim.airKind === 'cliff';
      if (big && left > 0.17) grab = true;
    }
    return { tx: Math.round(this.tx * 100) / 100, jump, grab };
  }
}

// The same brain with human hands, for attract mode and gameplay videos.
// A finger drags towards the line the bot picked after a reaction delay, on a
// slightly underdamped spring (so it overshoots and settles), wobbles a little,
// and carves lazy S-turns when nothing is close. Jumps and grabs are a few
// frames early or late. Inputs are recorded, so replays are unaffected.
export class HumanBot {
  constructor(seed) {
    this.brain = new Bot();
    this.s = (seed >>> 0) || 12345;
    this.hist = []; // brain targets, newest last
    this.delay = 11; // ticks of reaction time
    this.intent = 0;
    this.finger = 0;
    this.fv = 0;
    this.still = 0; // seconds the intent has been steady
    this.weave = 0; // 0..1 how much lazy carving is mixed in
    this.wPhase = 0;
    this.wRate = 3.2;
    this.wAmp = 0.8;
    this.wob = 0;
    this.wobT = 0;
    this.jumpWait = -1;
    this.grabOn = false;
    this.grabAt = 0;
    this.letGo = 0.2;
    this.airSeen = false;
    this.wantTrick = false;
    this.distracted = false; // stops reading the slope ahead (for scripted wipeouts)
  }

  rnd() {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 4294967296;
  }

  // Anything lethal near the finger's path in the next `secs` seconds?
  busy(sim, secs, band) {
    const P = CONFIG.player;
    const v = Math.max(8, sim.v);
    const list = sim.course.entities;
    for (let i = sim.first; i < list.length; i++) {
      const e = list[i];
      if (e.d0 > sim.dist + v * secs) break;
      if (!e.lethal || e.done || e.d1 < sim.dist) continue;
      const half = e.r != null ? e.r : e.hw;
      if (Math.abs(e.x - this.finger) < half + P.radius + band) return true;
    }
    return false;
  }

  decide(sim) {
    const dt = 1 / 60;
    const W = CONFIG.lane.halfWidth;
    const b = this.brain.decide(sim);
    this.hist.push(b.tx);
    if (this.hist.length > 40) this.hist.shift();

    // Reaction: act on what the brain saw a moment ago, but react faster
    // (a startled human) when danger is close.
    const urgent = !this.distracted && this.busy(sim, 0.55, 0.4);
    const lag = urgent ? 4 : this.delay;
    const seen = this.hist[Math.max(0, this.hist.length - 1 - lag)];
    if (!this.distracted && Math.abs(seen - this.intent) > 0.25) {
      this.intent = seen;
      this.still = 0;
      this.delay = 8 + Math.floor(this.rnd() * 8);
    } else this.still += dt;

    // Lazy carving when the coast is clear.
    const calm = this.still > 0.5 && !sim.air && !this.busy(sim, 1.3, 1.6);
    this.weave += ((calm ? 1 : 0) - this.weave) * Math.min(1, dt * (calm ? 1.5 : 8));
    this.wPhase += dt * this.wRate;
    if (this.wPhase > Math.PI * 2) {
      this.wPhase -= Math.PI * 2;
      this.wRate = 2.6 + this.rnd() * 1.6;
      this.wAmp = 0.5 + this.rnd() * 0.7;
    }
    // Finger wobble: a slow random walk of a few centimetres.
    this.wobT -= dt;
    if (this.wobT <= 0) {
      this.wobT = 0.25 + this.rnd() * 0.5;
      this.wobGoal = (this.rnd() - 0.5) * 0.24;
    }
    this.wob += ((this.wobGoal || 0) - this.wob) * Math.min(1, dt * 4);

    const goal = clamp(this.intent + Math.sin(this.wPhase) * this.wAmp * this.weave + this.wob, -W + 0.2, W - 0.2);
    // Underdamped spring: about 8% overshoot, settles in roughly 0.4 s.
    const w = urgent ? 22 : 15;
    const z = 0.62;
    this.fv += (w * w * (goal - this.finger) - 2 * z * w * this.fv) * dt;
    this.fv = clamp(this.fv, urgent ? -30 : -18, urgent ? 30 : 18); // a thumb has a top speed
    this.finger += this.fv * dt;
    this.finger = clamp(this.finger, -W, W);

    // Jumps: the brain says "now"; the thumb lands 0-5 frames later.
    let jump = false;
    if (b.jump && !this.distracted && this.jumpWait < 0) this.jumpWait = Math.floor(this.rnd() * 6);
    if (this.jumpWait >= 0) {
      if (this.jumpWait === 0 || sim.air) {
        jump = !sim.air;
        this.jumpWait = -1;
      } else this.jumpWait--;
    }

    // Air tricks on any jump with enough hang time: decide on take-off
    // (usually yes), grab a beat later, let go somewhere around the perfect
    // window -- mostly in it, sometimes a touch late or early, like a person.
    let grab = false;
    if (sim.air) {
      if (!this.airSeen) {
        this.airSeen = true;
        this.wantTrick = !this.distracted && this.rnd() < 0.9;
        this.grabAt = 0.03 + this.rnd() * 0.1;
        const r = this.rnd();
        this.letGo = r < 0.8 ? 0.1 + this.rnd() * 0.16 : r < 0.92 ? 0.3 + this.rnd() * 0.08 : 0.06;
      }
      const left = sim.timeToLand();
      if (this.wantTrick && !this.grabOn && this.grabAt > 0) {
        this.grabAt -= dt;
        if (this.grabAt <= 0 && left > this.letGo + 0.16) this.grabOn = true;
      }
      if (this.grabOn && left < this.letGo) {
        this.grabOn = false;
        this.wantTrick = false;
      }
      grab = this.grabOn;
    } else {
      this.airSeen = false;
      this.grabOn = false;
    }
    return { tx: Math.round(this.finger * 100) / 100, jump, grab };
  }
}
