// Plays real endurance races against the race server with Node clients:
// sign-up, check-in, input streaming in real time, the server's verdict and the
// Shards ledger. Uses a short cycle and a steep ramp so races take seconds.
//
// Needs the local Supabase (npx supabase start). Run: node test.mjs
import { randomUUID } from 'node:crypto';
import { Client } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';
import { quantise, Playback } from '../src/core/replay.js';
import { test, eq, ok, report } from '../tests/harness.mjs';
import { startRaceServer } from './index.mjs';

const PORT = 2599;
const RAMP = { from: 3, rate: 4 }; // races end within seconds
const logs = [];
// The 'bot' rider stands in for a local practice rider, so its wins are paid.
await startRaceServer({ port: PORT, cycleSeconds: 20, lockSeconds: 3, ramp: RAMP, practice: (u) => u.email.startsWith('bot-'), log: (...a) => logs.push(a.join(' ')) });

const LOCAL = CONFIG.online.local;
async function signUp(tag, displayName) {
  const email = tag + '-' + randomUUID().slice(0, 6) + '@example.test';
  const r = await fetch(LOCAL.url + '/auth/v1/signup', { method: 'POST', headers: { apikey: LOCAL.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: randomUUID(), data: displayName ? { display_name: displayName } : {} }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('sign-up failed');
  return j.access_token;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function until(fn, ms, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const v = fn();
      if (v) {
        clearInterval(id);
        resolve(v);
      } else if (Date.now() - t0 > ms) {
        clearInterval(id);
        reject(new Error('timed out: ' + label));
      }
    }, 50);
  });
}

// A rider: joins, keeps the latest messages, and rides a race with `brain`.
async function rider(tag, brain, displayName) {
  const token = await signUp(tag, displayName);
  const client = new Client('ws://localhost:' + PORT);
  const room = await client.join('endurance', { token });
  const me = { tag, room, brain, msgs: {}, results: [], balance: null, localDeath: 0 };
  for (const type of ['hello', 'next', 'checkin', 'cancelled', 'countdown', 'go']) room.onMessage(type, (m) => (me.msgs[type] = m));
  room.onMessage('balance', (m) => {
    me.balance = m.balance;
    me.stats = m;
  });
  room.onMessage('results', (m) => me.results.push(m));
  room.onMessage('board', (m) => (me.board = m));
  room.onMessage('rematch', (m) => (me.rematch = m));
  room.onMessage('riders', () => {});
  room.onMessage('countdown', (m) => {
    me.msgs.countdown = m;
    if (m.me >= 0) me.race = { id: m.id, sim: new Sim(m.seed, { ramp: m.ramp }), bot: new Bot() };
  });
  room.onMessage('go', (m) => {
    if (!me.race || me.race.id !== m.race) return;
    if (brain === 'cheat') return room.send('inputs', { race: m.race, from: 0, runs: [[600, 0, 0]] });
    if (brain === 'leave') return setTimeout(() => room.leave(), 1500);
    me.timer = setInterval(() => sendTicks(me), 100);
  });
  await until(() => me.msgs.hello && me.balance != null, 5000, tag + ' hello');
  return me;
}

function sendTicks(me) {
  const { sim, bot, id } = me.race;
  const from = sim.tick;
  const runs = [];
  for (let k = 0; k < CONFIG.race.sendEvery && sim.phase === 'ride'; k++) {
    const input = quantise(me.brain === 'bot' ? bot.decide(sim) : { tx: 0, jump: false, grab: false });
    const tx = Math.round(input.tx * 100);
    const flags = (input.jump ? 1 : 0) | (input.grab ? 2 : 0);
    const last = runs[runs.length - 1];
    if (last && last[1] === tx && last[2] === flags) last[0]++;
    else runs.push([1, tx, flags]);
    sim.step(input);
    sim.events.length = 0;
  }
  if (runs.length) me.room.send('inputs', { race: id, from, runs });
  if (sim.phase !== 'ride') {
    me.localDeath = sim.tick;
    clearInterval(me.timer);
  }
}

const checkIn = async (riders) => {
  for (const r of riders) r.room.send('checkin');
  await until(() => riders.every((r) => r.msgs.checkin && r.msgs.checkin.ok && r.msgs.next && r.msgs.next.in), 5000, 'check-in');
  return riders[0].msgs.next.id;
};
const resultFor = (r, id) => r.results.find((x) => x.race === id);

// --- 1. one rider: cancelled, refunded --------------------------------------------
const solo = await rider('solo', 'none');
const soloRace = await checkIn([solo]);
const soloPaid = solo.msgs.checkin.balance;
await until(() => solo.msgs.cancelled && solo.msgs.cancelled.race === soloRace, 25000, 'cancel');
await wait(500);
const soloAfter = solo.balance;
solo.room.leave();

// --- 2. bot vs a rider who doesn't steer vs a cheater ------------------------------
const A = await rider('bot', 'bot', 'bot Rider');
const B = await rider('still', 'none');
const C = await rider('cheat', 'cheat');
const race2 = await checkIn([A, B, C]);
const race2Pct = A.msgs.next.prizePct;
await until(() => resultFor(A, race2), 60000, 'race 2 result');
await wait(800);

// --- 3. two identical riders tie; a third leaves mid-race ----------------------------
const D = await rider('twinA', 'none');
const E = await rider('twinB', 'none');
const F = await rider('quitter', 'leave');
const race3 = await checkIn([D, E, F]);
await until(() => resultFor(D, race3), 60000, 'race 3 result');
await wait(800);

// --- 4. the game's bot wins on a normal account: the race is voided -----------------
const G = await rider('robot', 'bot');
const H = await rider('human', 'none');
const race4 = await checkIn([G, H]);
await until(() => resultFor(G, race4), 60000, 'race 4 result');
await wait(800);

A.room.send('board');
G.room.send('board');
await until(() => A.board && G.board, 5000, 'race board');
H.room.send('rematch');
await until(() => H.rematch, 5000, 'rematch');

const byName = (res, r) => res.standings.find((s) => s.name.startsWith(r.tag.toLowerCase()));

test('fewer than 2 riders: race cancelled and the fee refunded', () => {
  eq(soloPaid, 90, 'fee taken at check-in');
  eq(solo.msgs.cancelled.refunded, 1);
  eq(soloAfter, 100, 'refunded');
});

test('last alive wins; the server replays inputs to decide it', () => {
  const res = resultFor(A, race2);
  eq(byName(res, A).place, 1, 'bot wins');
  eq(byName(res, B).place, 2);
  eq(byName(res, C).place, 3);
  eq(byName(res, A).reason, 'last alive');
});

test('server and phone agree on when a rider died', () => {
  const res = resultFor(A, race2);
  eq(byName(res, B).tick, B.localDeath, 'death tick');
});

test('inputs ahead of server time are refused: the cheater is out', () => {
  eq(byName(resultFor(A, race2), C).reason, 'ahead of time');
});

test('riders see display names; the race record counts races, wins and Shards won', () => {
  eq(byName(resultFor(A, race2), A).name, 'bot Rider');
  eq(A.stats.races + '|' + A.stats.wins + '|' + A.stats.won, '1|1|27');
  eq(B.stats.races + '|' + B.stats.wins + '|' + B.stats.won, '1|0|0');
});

test('payout: 90% of the pot to the winner, 10% burned', () => {
  const res = resultFor(A, race2);
  eq(race2Pct, 90, 'the race announces the prize share from the config');
  eq(res.pot + '|' + res.prize + '|' + res.burned, '30|27|3');
  eq(A.balance, 117, 'winner: 100 - 10 + 27');
  eq(B.balance, 90);
  eq(C.balance, 90);
});

test('identical riders tie on tick and distance and split the prize; leaving counts as dying', () => {
  const res = resultFor(D, race3);
  eq(byName(res, D).place, 1);
  eq(byName(res, E).place, 1);
  eq(byName(res, F).place, 3);
  eq(byName(res, F).reason, 'left');
  eq(res.each + '|' + res.prize + '|' + res.burned, '13|26|4', 'whole Shards: the odd one is burned');
  eq(D.balance, 103);
  eq(E.balance, 103);
});

test('a win that follows the bot is voided and every entry refunded', () => {
  const res = resultFor(G, race4);
  eq(byName(res, G).place, 1, 'the bot still rode furthest');
  eq(res.voided, 'scripted');
  eq(res.prize + '|' + res.burned, '0|0');
  eq(G.balance, 100, 'bot refunded, no prize');
  eq(H.balance, 100, 'the other rider refunded');
  eq(G.stats.races + '|' + G.stats.wins, '0|0', 'a voided race is not on the record');
});

test('fair winners are judged and paid (no false call on the tie race)', () => {
  ok(!resultFor(D, race3).voided, 'race 3 not voided');
  ok(logs.some((l) => l.startsWith('judge twina')), 'the winner was judged');
});

test('race board: wins from settled races only, with my own row', () => {
  eq(A.board.me.wins + '|' + A.board.me.won + '|' + A.board.me.name, '1|27|bot Rider', 'the payout winner is on the board');
  eq(G.board.me, null, 'the voided winner has no settled races');
  ok(A.board.top.length <= 8 && A.board.top.every((r, i, a) => !i || a[i - 1].wins >= r.wins), 'top 8, by wins');
});

test('rematch: the last fair race (not the voided one), its top 3, and replays that end where the server said', () => {
  const m = H.rematch;
  eq(m.race, race3, 'race 4 was voided, so the rematch is race 3');
  eq(m.riders.length, 3);
  const res = resultFor(D, race3);
  for (const r of m.riders) {
    const sim = new Sim(m.seed, { ramp: m.ramp });
    const play = new Playback(r.data);
    while (sim.phase === 'ride' && sim.tick < r.end) sim.step(play.next());
    const s = res.standings.find((x) => x.name === r.name);
    eq(Math.floor(sim.dist) + '|' + r.end, s.dist + '|' + s.tick, r.name + ' replays to the same distance and tick');
  }
});

const failed = report();
if (failed) console.log(logs.join('\n'));
process.exit(failed ? 1 : 0);
