// The endurance race room: one long-lived room that runs a race every cycle.
//
// Cycle: check-in for the next race is always open. LOCK_MS before the start
// the entries close; with fewer than the minimum riders every fee is refunded,
// otherwise the countdown goes out and the race starts on the cycle boundary.
//
// Authority: each phone simulates its own ride and streams its inputs. The
// server replays every rider's inputs with the game's own simulation, so it
// alone decides who died when. Last alive wins; same-tick deaths are ranked by
// distance; an exact tie on both shares first place (and the prize).
import { randomInt } from 'node:crypto';
import { Room } from '@colyseus/core';
import { CONFIG } from '../src/config.js';
import { Sim } from '../src/core/sim.js';
import { Recorder } from '../src/core/replay.js';
import { judgeRide } from './scripted.mjs';

const TICKS_PER_S = 60;
const W = CONFIG.lane.halfWidth;

export class EnduranceRoom extends Room {
  maxClients = 500;
  autoDispose = false;
  maxMessagesPerSecond = 60;

  onCreate() {
    const options = EnduranceRoom.settings;
    this.db = options.db;
    this.cycleMs = options.cycleMs;
    this.lockMs = options.lockMs;
    this.dropTicks = options.dropTicks;
    this.leadTicks = options.leadTicks;
    this.ramp = options.ramp;
    this.practice = options.practice || (() => false);
    this.log = options.log || (() => {});
    this.next = null; // the race taking entries
    this.race = null; // the race being ridden
    this.users = new Map(); // user id -> client
    this.busy = Promise.resolve(); // ledger calls run one at a time

    this.onMessage('checkin', (client) => this.queue(() => this.checkIn(client)));
    this.onMessage('inputs', (client, m) => this.inputs(client, m));
    this.onMessage('balance', (client) => this.queue(() => this.sendBalance(client)));
    this.onMessage('board', (client) => this.queue(() => this.sendBoard(client)));
    // Rematch: the last fair race's slope and its top 3 riders' inputs, as ghosts.
    this.onMessage('rematch', (client) => client.send('rematch', this.lastRace || { race: null }));
    this.lastRace = null;

    this.queue(() => this.openNext(Date.now()));
    this.clock.setInterval(() => this.loop(), 100);
  }

  queue(fn) {
    this.busy = this.busy.then(fn).catch((err) => this.log('error', err.message));
    return this.busy;
  }

  async onAuth(client, options) {
    const user = await this.db.user(options && options.token);
    if (!user) throw new Error('sign in to race');
    return user;
  }

  onJoin(client) {
    const u = client.auth;
    // One connection per player: a second tab takes over.
    const old = this.users.get(u.id);
    if (old && old !== client) old.leave(4000, 'signed in elsewhere');
    this.users.set(u.id, client);
    client.send('hello', { serverNow: Date.now(), you: { name: nameOf(u) }, next: this.nextInfo(u.id), race: this.raceInfo(u.id), cycleMs: this.cycleMs });
    this.queue(() => this.sendBalance(client));
  }

  onLeave(client) {
    const u = client.auth;
    if (!u || this.users.get(u.id) !== client) return;
    this.users.delete(u.id);
    // Leaving mid-race counts as dying at the last confirmed tick.
    const r = this.race && this.race.riders.get(u.id);
    if (r && r.alive && this.race.goAt) this.out(r, 'left');
  }

  async sendBalance(client) {
    const b = await this.db.rpc('race_balance', { p_user: client.auth.id });
    client.send('balance', b);
  }

  // --- the cycle -----------------------------------------------------------------

  async openNext(now) {
    const startAt = Math.ceil((now + this.lockMs + 1000) / this.cycleMs) * this.cycleMs;
    // Unique even if the server restarts inside a cycle.
    const id = 'r' + startAt.toString(36) + '-' + randomInt(36 ** 4).toString(36);
    const seed = randomInt(1, 2 ** 31);
    const res = await this.db.rpc('race_open', { p_race: id, p_seed: seed });
    this.next = { id, seed, startAt, fee: res.fee, prizePct: res.prize_pct, entries: new Set(), pot: 0 };
    this.log('open', id, new Date(startAt).toISOString());
    this.broadcastNext();
  }

  nextInfo(userId) {
    const n = this.next;
    return n ? { id: n.id, startAt: n.startAt, fee: n.fee, prizePct: n.prizePct, riders: n.entries.size, pot: n.pot, in: n.entries.has(userId) } : null;
  }

  raceInfo(userId) {
    const r = this.race;
    if (!r) return null;
    return { id: r.id, seed: r.seed, goAt: r.goAt || r.startAt, ramp: this.ramp, riders: r.list.map((x) => ({ i: x.i, name: x.name })), me: r.riders.has(userId) ? r.riders.get(userId).i : -1, started: !!r.goAt };
  }

  broadcastNext() {
    for (const [id, c] of this.users) c.send('next', this.nextInfo(id));
  }

  // The race leaderboard (wins, then Shards won), with this rider's own row.
  async sendBoard(client) {
    const res = await this.db.rpc('race_board', { p_user: client.auth.id, p_limit: 8 });
    client.send('board', res);
  }

  async checkIn(client) {
    const n = this.next;
    if (!n) return client.send('checkin', { ok: false, reason: 'no race open' });
    const res = await this.db.rpc('race_check_in', { p_race: n.id, p_user: client.auth.id });
    if (res.ok) {
      n.entries.add(client.auth.id);
      n.pot = res.pot;
      n.names = n.names || new Map();
      n.names.set(client.auth.id, nameOf(client.auth));
      n.practice = n.practice || new Set();
      if (this.practice(client.auth)) n.practice.add(client.auth.id);
    }
    client.send('checkin', Object.assign({ race: n.id }, res));
    if (res.ok) this.broadcastNext();
  }

  loop() {
    const now = Date.now();
    const n = this.next;
    if (n && !n.locking && now >= n.startAt - this.lockMs) {
      n.locking = true;
      this.queue(() => this.lock(n, now));
    }
    const r = this.race;
    if (!r) return;
    if (!r.goAt && now >= r.startAt) this.go(r, now);
    if (r.goAt && !r.done) {
      const expected = Math.floor(((now - r.goAt) / 1000) * TICKS_PER_S);
      for (const x of r.list) {
        // Inputs stopped arriving: out at the last confirmed tick.
        if (x.alive && expected - x.sim.tick > this.dropTicks) this.out(x, 'dropped');
      }
      this.snapshot(r, expected);
      this.checkEnd(r);
    }
  }

  async lock(n, now) {
    // A race still running when the next one starts is cut short (the ramp
    // should make this impossible); the riders left are ranked by distance.
    if (this.race && !this.race.done) await this.finish(this.race, true);
    const started = await this.db.rpc('race_start', { p_race: n.id });
    const ids = started.ok ? started.riders : [];
    const min = 2;
    await this.openNext(now);
    if (ids.length < min) {
      const res = await this.db.rpc('race_cancel', { p_race: n.id });
      this.log('cancel', n.id, ids.length, 'riders');
      this.broadcast('cancelled', { race: n.id, refunded: res.refunded || 0, reason: 'not enough riders' });
      for (const id of ids) {
        const c = this.users.get(id);
        if (c) this.queue(() => this.sendBalance(c));
      }
      return;
    }
    const list = ids.map((id, i) => ({
      i,
      id,
      name: (n.names && n.names.get(id)) || 'rider',
      practice: !!(n.practice && n.practice.has(id)),
      sim: new Sim(n.seed, { ramp: this.ramp }),
      alive: true,
      deathTick: 0,
      dist: 0,
      reason: '',
      runs: [], // the full input record, kept for verification and ghosts later
    }));
    this.race = { id: n.id, seed: n.seed, startAt: n.startAt, pot: n.pot, list, riders: new Map(list.map((x) => [x.id, x])), goAt: 0, done: false };
    this.log('countdown', n.id, list.length, 'riders');
    for (const [id, c] of this.users) c.send('countdown', this.raceInfo(id));
  }

  go(r, now) {
    r.goAt = now;
    this.broadcast('go', { race: r.id });
    this.log('go', r.id);
  }

  // --- riding ----------------------------------------------------------------------

  inputs(client, m) {
    const r = this.race;
    if (!r || !r.goAt || r.done || !m || m.race !== r.id) return;
    const x = r.riders.get(client.auth.id);
    if (!x || !x.alive) return;
    if (!Array.isArray(m.runs) || m.from !== x.sim.tick) return this.out(x, 'out of sync');
    let total = 0;
    for (const run of m.runs) {
      if (!Array.isArray(run) || !Number.isInteger(run[0]) || run[0] < 1 || run[0] > 600 || typeof run[1] !== 'number' || !Number.isInteger(run[2]) || run[2] < 0 || run[2] > 3) return this.out(x, 'bad input');
      total += run[0];
    }
    // Inputs for ticks that have not happened yet mean a sped-up client.
    const expected = Math.floor(((Date.now() - r.goAt) / 1000) * TICKS_PER_S);
    if (x.sim.tick + total > expected + this.leadTicks) return this.out(x, 'ahead of time');
    const input = { tx: 0, jump: false, grab: false };
    for (const [count, txCm, flags] of m.runs) {
      input.tx = Math.max(-W * 100, Math.min(W * 100, Math.round(txCm))) / 100;
      input.jump = (flags & 1) !== 0;
      input.grab = (flags & 2) !== 0;
      x.runs.push([count, Math.round(input.tx * 100), flags]);
      for (let k = 0; k < count; k++) {
        x.sim.step(input);
        x.sim.events.length = 0;
        if (x.sim.phase !== 'ride') {
          x.alive = false;
          x.deathTick = x.sim.tick;
          x.dist = x.sim.dist;
          x.reason = x.sim.cause || 'crash';
          return;
        }
      }
    }
    x.dist = x.sim.dist;
  }

  out(x, reason) {
    if (!x.alive) return;
    x.alive = false;
    x.deathTick = x.sim.tick;
    x.dist = x.sim.dist;
    x.reason = reason;
    this.log('out', x.name, reason, 'tick', x.deathTick);
  }

  snapshot(r, expected) {
    const rows = r.list.map((x) => {
      const s = x.sim;
      return [x.i, Math.round(s.dist * 10) / 10, Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100, (x.alive ? 1 : 0) | (s.air ? 2 : 0) | (s.grab ? 4 : 0), s.tick];
    });
    this.broadcast('riders', { race: r.id, t: expected, left: r.list.filter((x) => x.alive).length, r: rows });
  }

  checkEnd(r) {
    const alive = r.list.filter((x) => x.alive);
    if (alive.length > 1) return;
    if (alive.length === 1) {
      // The survivor must be confirmed past the last death before it has won.
      const lastDeath = Math.max(0, ...r.list.filter((x) => !x.alive).map((x) => x.deathTick));
      if (alive[0].sim.tick < lastDeath) return;
    }
    r.done = true;
    this.queue(() => this.finish(r, false));
  }

  standings(r, cut) {
    const key = (x) => [x.alive ? 1 : 0, x.alive ? 0 : x.deathTick, Math.floor(x.dist * 100)];
    const sorted = r.list.slice().sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (cut) return kb[2] - ka[2] || kb[0] - ka[0]; // cut short: furthest first
      return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2];
    });
    let place = 0;
    let prev = null;
    return sorted.map((x, idx) => {
      const k = key(x).join();
      if (k !== prev) place = idx + 1;
      prev = k;
      return { x, place };
    });
  }

  async finish(r, cut) {
    r.done = true;
    if (r.finished) return;
    r.finished = true;
    const rows = this.standings(r, cut);
    const results = rows.map(({ x, place }) => ({ user_id: x.id, place, death_tick: x.alive ? x.sim.tick : x.deathTick, distance: Math.floor(x.dist) }));
    // A win that follows the game's own bot voids the race: nobody is paid and
    // every fee goes back (local practice riders are exempt).
    const flagged = rows.filter(({ x, place }) => place === 1 && !x.practice).filter(({ x }) => {
      const v = judgeRide(r.seed, this.ramp, x.runs);
      this.log('judge', x.name, JSON.stringify({ exact: +v.exact.toFixed(3), follow: +v.follow.toFixed(3), gap: +v.meanGap.toFixed(2), lag: v.lag, jumps: v.onCue + '/' + v.jumps, scripted: v.scripted }));
      return v.scripted;
    });
    let res;
    if (flagged.length) {
      res = await this.db.rpc('race_void', { p_race: r.id, p_results: results, p_reason: 'scripted win: ' + flagged.map(({ x }) => x.id).join(',') });
      res = { pot: res.pot, prize: 0, each: 0, house: 0, burned: 0, voided: 'scripted' };
      this.log('void', r.id, flagged.map(({ x }) => x.name).join(','));
    } else res = await this.db.rpc('race_settle', { p_race: r.id, p_results: results });
    const msg = {
      race: r.id,
      pot: res.pot,
      prize: res.prize,
      each: res.each,
      house: res.house || 0, // the fee to the house account; burned while none is set
      burned: res.burned,
      voided: res.voided || null,
      standings: rows.map(({ x, place }) => ({ i: x.i, name: x.name, place, dist: Math.floor(x.dist), tick: x.alive ? x.sim.tick : x.deathTick, time: Math.round(((x.alive ? x.sim.tick : x.deathTick) / TICKS_PER_S) * 10) / 10, reason: x.alive ? (cut ? 'time up' : 'last alive') : x.reason })),
    };
    this.log('result', r.id, JSON.stringify(msg.standings.map((s) => s.place + ':' + s.name + ':' + s.dist)));
    this.broadcast('results', msg);
    // Kept in memory only (gone on a restart); a voided race offers no rematch.
    if (!msg.voided) {
      this.lastRace = {
        race: r.id,
        seed: r.seed,
        ramp: this.ramp,
        riders: rows
          .filter(({ place }) => place <= 3)
          .slice(0, 3)
          .map(({ x, place }) => {
            const rec = new Recorder();
            rec.runs = x.runs;
            // end: the tick the rider went out (or the race ended); the inputs stop there.
            return { name: x.name, place, dist: Math.floor(x.dist), end: x.alive ? x.sim.tick : x.deathTick, data: rec.encode() };
          }),
      };
    }
    for (const { x } of rows) {
      const c = this.users.get(x.id);
      if (c) this.queue(() => this.sendBalance(c));
    }
  }
}

function nameOf(u) {
  return u.name || 'rider';
}
