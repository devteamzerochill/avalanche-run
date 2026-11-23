// Practice riders for local testing: Node clients that sign in with the local
// test accounts, check in to every race and ride it with the game's human-like
// bot, streaming inputs in real time exactly like a phone. Each one loses
// focus at a random moment, so races end at different times.
//
//   node bots.mjs --count=2            (accounts 2..3 of the local test file)
//   node bots.mjs --focus=60           (stay focused at least 60 s: longer races)
//
// Local only: needs the local Supabase and the race server.
import fs from 'node:fs';
import { Client } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { Sim } from '../src/core/sim.js';
import { HumanBot } from '../src/core/bot.js';
import { quantise } from '../src/core/replay.js';

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=')[1] : def;
};
const count = +arg('count', 2);
const focus = +arg('focus', 8);
const L = CONFIG.online.local;
const accounts = JSON.parse(fs.readFileSync(new URL('../supabase/local-standins/test-account.json', import.meta.url), 'utf8')).accounts.slice(1, 1 + count);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function signIn(a) {
  const r = await fetch(L.url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: L.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(a.email + ': sign-in failed');
  return j.access_token;
}

async function rider(a) {
  const name = a.email.split('@')[0];
  const room = await new Client(CONFIG.race.server).join('endurance', { token: await signIn(a) });
  let race = null;
  room.onMessage('hello', (m) => m.next && !m.next.in && room.send('checkin'));
  room.onMessage('next', (m) => m && !m.in && room.send('checkin'));
  room.onMessage('checkin', (m) => log(name, m.ok ? 'checked in, balance ' + m.balance : 'check-in: ' + m.reason));
  room.onMessage('balance', () => {});
  room.onMessage('cancelled', () => log(name, 'race cancelled, refunded'));
  room.onMessage('riders', () => {});
  room.onMessage('countdown', (m) => {
    if (m.me < 0) return;
    const sim = new Sim(m.seed, { ramp: m.ramp });
    race = { id: m.id, sim, bot: new HumanBot(m.seed + m.me), focusFor: 60 * (focus + Math.random() * 50) };
  });
  room.onMessage('go', (m) => {
    if (!race || race.id !== m.race) return;
    const r = race;
    const goAt = Date.now();
    r.timer = setInterval(() => {
      // Step to the wall clock, not one batch per timer tick: timers run late.
      const due = Math.floor(((Date.now() - goAt) / 1000) * 60);
      const from = r.sim.tick;
      const runs = [];
      while (r.sim.tick < due && r.sim.phase === 'ride') {
        r.bot.distracted = r.sim.tick > r.focusFor;
        const input = quantise(r.bot.decide(r.sim));
        const tx = Math.round(input.tx * 100);
        const flags = (input.jump ? 1 : 0) | (input.grab ? 2 : 0);
        const last = runs[runs.length - 1];
        if (last && last[1] === tx && last[2] === flags) last[0]++;
        else runs.push([1, tx, flags]);
        r.sim.step(input);
        r.sim.events.length = 0;
      }
      if (runs.length) room.send('inputs', { race: r.id, from, runs });
      if (r.sim.phase !== 'ride') {
        clearInterval(r.timer);
        log(name, 'out at', Math.floor(r.sim.dist), 'm');
      }
    }, 100);
  });
  room.onMessage('results', (m) => {
    const me = m.standings.find((s) => s.name === name);
    if (me) log(name, 'placed', me.place, 'of', m.standings.length, me.place === 1 ? '(+' + m.each + ')' : '');
  });
  log(name, 'connected');
}

for (const a of accounts) await rider(a);
