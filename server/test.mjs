// Plays real endurance races against the race server with Node clients:
// sign-up, check-in, input streaming in real time, the server's verdict and the
// Shards ledger. Uses a short cycle and a steep ramp so races take seconds.
//
// Needs the local Supabase (npx supabase start). Run: node test.mjs
import { randomUUID } from 'node:crypto';
import { Client } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { Sim } from '../src/core/sim.js';
import { Bot, HumanBot } from '../src/core/bot.js';
import { judgeRide } from './scripted.mjs';
import { quantise, Playback } from '../src/core/replay.js';
import { test, eq, ok, report } from '../tests/harness.mjs';
import { startRaceServer } from './index.mjs';
import { Supabase, supabaseSettings } from './supabase.mjs';

const PORT = 2599;
const RAMP = { from: 3, rate: 4 }; // races end within seconds
const logs = [];
await startRaceServer({ port: PORT, cycleSeconds: 20, lockSeconds: 3, ramp: RAMP, log: (...a) => logs.push(a.join(' ')) });

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
  for (const type of ['hello', 'next', 'checkin', 'withdraw', 'cancelled', 'countdown', 'go']) room.onMessage(type, (m) => (me.msgs[type] = m));
  room.onMessage('balance', (m) => {
    me.balance = m.balance;
    me.stats = m;
  });
  room.onMessage('results', (m) => me.results.push(m));
  room.onMessage('board', (m) => (me.board = m));
  room.onMessage('rematch', (m) => (me.rematch = m));
  room.onMessage('riders', () => {});
  me.chat = [];
  room.onMessage('chat', (m) => me.chat.push(m));
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
    // 'left' holds hard left: on this short slope it outlasts a rider who doesn't
    // steer by about 12 ticks on any seed, without riding like the bot.
    const input = quantise(me.brain === 'bot' ? bot.decide(sim) : { tx: me.brain === 'left' ? -1 : 0, jump: false, grab: false });
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

// --- 0. the lobby: quick chat, leaving with a refund, checking in again ------------
const L1 = await rider('lobbyA', 'none', 'lobby A');
const L2 = await rider('lobbyB', 'none');
const L3 = await rider('outsider', 'none');
const fee0 = L1.balance;
await checkIn([L1, L2]);
const feeTaken = fee0 - L1.msgs.checkin.balance;
L1.room.send('chat', { id: 'gl' });
L1.room.send('chat', { id: 'gg' }); // within 1.5 s: dropped
L2.room.send('chat', { id: 'not a phrase' });
L2.room.send('chat', { id: 'e_fire' });
L3.room.send('chat', { id: 'hi' }); // not in the lobby: heard by nobody
await until(() => L1.chat.length >= 2 && L2.chat.length >= 2, 5000, 'lobby chat');
await wait(400);
const chatSeen = { L1: L1.chat.map((m) => m.id), L2: L2.chat.map((m) => m.id), L3: L3.chat.length, mine: L1.chat.find((m) => m.id === 'gl').me, name: L2.chat.find((m) => m.id === 'gl').name };
L1.msgs.next = null;
L1.room.send('withdraw');
await until(() => L1.msgs.withdraw && L1.msgs.next && !L1.msgs.next.in, 5000, 'withdraw');
await wait(300);
const afterLeave = { balance: L1.balance, riders: L1.msgs.next.riders, names: L1.msgs.next.names };
L1.msgs.checkin = null;
await checkIn([L1]);
const afterRejoin = L1.msgs.checkin.balance;
L1.msgs.withdraw = null;
L1.room.send('withdraw');
L2.room.send('withdraw');
await until(() => L1.msgs.withdraw && L2.msgs.withdraw, 5000, 'both leave');
await wait(300);
const afterSecondLeave = L1.balance;
for (const r of [L1, L2, L3]) r.room.leave();

// --- 1. one rider: cancelled, refunded --------------------------------------------
const solo = await rider('solo', 'none');
const soloRace = await checkIn([solo]);
const soloPaid = solo.msgs.checkin.balance;
await until(() => solo.msgs.cancelled && solo.msgs.cancelled.race === soloRace, 25000, 'cancel');
await wait(500);
const soloAfter = solo.balance;
solo.room.leave();

// --- 2. a fair rider vs a rider who doesn't steer vs a cheater ---------------------
const A = await rider('left', 'left', 'left Rider');
const B = await rider('still', 'none');
const C = await rider('cheat', 'cheat');
const race2 = await checkIn([A, B, C]);
const race2Pct = A.msgs.next.prizePct;
await until(() => resultFor(A, race2), 60000, 'race 2 result');
await wait(800);

// --- 3. two identical riders tie; a third leaves mid-race ----------------------------
// With a house account set: the fee goes to it instead of being burned.
const db = new Supabase(supabaseSettings());
const houseId = JSON.parse(Buffer.from((await signUp('house')).split('.')[1], 'base64url')).sub;
const setHouse = (id) => fetch(db.s.url + '/rest/v1/avalanche_race_config?id=eq.1', { method: 'PATCH', headers: { apikey: db.s.service, Authorization: 'Bearer ' + db.s.service, 'Content-Type': 'application/json' }, body: JSON.stringify({ house_user: id }) });
const houseBefore = await db.rpc('shards_balance', { p_user: houseId });
await setHouse(houseId);
const D = await rider('twinA', 'none');
const E = await rider('twinB', 'none');
const F = await rider('quitter', 'leave');
const race3 = await checkIn([D, E, F]);
await until(() => resultFor(D, race3), 60000, 'race 3 result');
await wait(800);
await setHouse(null);
const houseAfter = await db.rpc('shards_balance', { p_user: houseId });

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

test('lobby quick chat: heard by the lobby only, unknown ids and spam dropped', () => {
  eq(chatSeen.L1.join(','), 'gl,e_fire', 'L1 hears its own phrase and the emote');
  eq(chatSeen.L2.join(','), 'gl,e_fire');
  eq(chatSeen.L3, 0, 'a player outside the lobby hears nothing');
  eq(chatSeen.mine, true);
  eq(chatSeen.name.toLowerCase().startsWith('lobby a'), true, 'name: ' + chatSeen.name);
});

test('leaving the lobby refunds the fee; checking in again charges it again', () => {
  ok(feeTaken > 0, 'fee taken');
  eq(afterLeave.balance, fee0, 'full refund');
  eq(afterLeave.riders, 1, 'one rider left in the lobby');
  eq(afterLeave.names.length, 1);
  eq(afterRejoin, fee0 - feeTaken, 'charged again (not skipped as a retry)');
  eq(afterSecondLeave, fee0, 'second refund');
});

test('fewer than 2 riders: race cancelled and the fee refunded', () => {
  eq(soloPaid, 90, 'fee taken at check-in');
  eq(solo.msgs.cancelled.refunded, 1);
  eq(soloAfter, 100, 'refunded');
});

test('last alive wins; the server replays inputs to decide it', () => {
  const res = resultFor(A, race2);
  eq(byName(res, A).place, 1, 'the steering rider wins');
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
  eq(byName(resultFor(A, race2), A).name, 'left Rider');
  eq(A.stats.races + '|' + A.stats.wins + '|' + A.stats.won, '1|1|27');
  eq(B.stats.races + '|' + B.stats.wins + '|' + B.stats.won, '1|0|0');
});

test('payout: 90% of the pot to the winner, 10% burned while no house account is set', () => {
  const res = resultFor(A, race2);
  eq(race2Pct, 90, 'the race announces the prize share from the config');
  eq(res.pot + '|' + res.prize + '|' + res.house + '|' + res.burned, '30|27|0|3');
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
  eq(res.each + '|' + res.prize + '|' + res.house + '|' + res.burned, '13|26|4|0', 'whole Shards: the odd one joins the house fee');
  eq(D.balance, 103);
  eq(E.balance, 103);
  eq(houseAfter - houseBefore, 4, 'the house account was paid the fee');
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

test('a short win that follows the human-like bot is caught (fewer than 5 jumps)', () => {
  // 20 s rides on the live race slope: too short for the jump-timing check.
  let caught = 0;
  let short = 0;
  for (let k = 1; k <= 10; k++) {
    const seed = k * 7919;
    const sim = new Sim(seed, { ramp: CONFIG.race.ramp });
    const bot = new HumanBot(k * 31);
    const runs = [];
    while (sim.phase === 'ride' && sim.tick < 1200) {
      const i = quantise(bot.decide(sim));
      const tx = Math.round(i.tx * 100);
      const fl = (i.jump ? 1 : 0) | (i.grab ? 2 : 0);
      const last = runs[runs.length - 1];
      if (last && last[1] === tx && last[2] === fl) last[0]++;
      else runs.push([1, tx, fl]);
      sim.step(i);
      sim.events.length = 0;
    }
    const v = judgeRide(seed, CONFIG.race.ramp, runs);
    if (v.jumps < 5) short++;
    if (v.scripted) caught++;
  }
  ok(short >= 8, 'most 20 s rides have fewer than 5 jumps (' + short + '/10)');
  ok(caught >= 9, 'caught ' + caught + '/10');
});

test('fair winners are judged and paid (no false call on the tie race)', () => {
  ok(!resultFor(D, race3).voided, 'race 3 not voided');
  ok(logs.some((l) => l.startsWith('judge twina')), 'the winner was judged');
});

test('race board: wins from settled races only, with my own row', () => {
  eq(A.board.me.wins + '|' + A.board.me.won + '|' + A.board.me.name, '1|27|left Rider', 'the payout winner is on the board');
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

// --- 5. the race server's own site account instead of the service key ----------------
const acct = { email: 'raceserver-' + randomUUID().slice(0, 6) + '@example.test', password: randomUUID() };
const made = await (await fetch(LOCAL.url + '/auth/v1/signup', { method: 'POST', headers: { apikey: LOCAL.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(acct) })).json();
const setServer = (id) => fetch(db.s.url + '/rest/v1/avalanche_race_config?id=eq.1', { method: 'PATCH', headers: { apikey: db.s.service, Authorization: 'Bearer ' + db.s.service, 'Content-Type': 'application/json' }, body: JSON.stringify({ server_user: id }) });
const asAccount = new Supabase({ url: LOCAL.url, anon: LOCAL.anonKey, account: acct });
const asPlayer = await signUp('nosy');
const callAs = (token, fn, args) => fetch(LOCAL.url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: LOCAL.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }).then((r) => r.status);
const refusedBefore = await asAccount.rpc('race_balance', { p_user: made.user.id }).then(() => false, () => true);
await setServer(made.user.id);
const asServer = await asAccount.rpc('race_balance', { p_user: made.user.id }).catch((e) => e.message);
const serverName = await asAccount.rpc('race_player_name', { p_user: made.user.id }).catch((e) => e.message);
const playerStatus = await callAs(asPlayer, 'race_check_in', { p_race: race2, p_user: made.user.id });
const anonStatus = await callAs(LOCAL.anonKey, 'race_balance', { p_user: made.user.id });
const nameStatus = await callAs(asPlayer, 'avalanche_player_name', { p_user: made.user.id });
await setServer(null);
const refusedAfter = await asAccount.rpc('race_balance', { p_user: made.user.id }).then(() => false, () => true);

test('only the race server account (or the service role) may call the ledger', () => {
  ok(refusedBefore, 'refused before it is set as server_user');
  eq(typeof asServer === 'object' && asServer.fee, 10, 'race_balance works once set: ' + JSON.stringify(asServer));
  eq(serverName, made.user.email.split('@')[0], 'names through race_player_name');
  ok(playerStatus >= 400, 'a signed-in player is refused (' + playerStatus + ')');
  ok(anonStatus >= 400, 'anon is refused (' + anonStatus + ')');
  ok(nameStatus >= 400, 'players cannot call avalanche_player_name (' + nameStatus + ')');
  ok(refusedAfter, 'refused again once server_user is cleared');
});

const failed = report();
if (failed) console.log(logs.join('\n'));
process.exit(failed ? 1 : 0);
