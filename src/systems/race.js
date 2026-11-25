// Endurance race client (docs/endurance-race.md). Talks to the Colyseus race
// server: check-in, the countdown, streaming this phone's inputs, the other
// riders' positions and the result. The server replays every rider, so this
// side only reports inputs and shows what comes back.
//
// Opt-in with ?race. The Colyseus browser client (vendor/colyseus.js) loads
// only then, so it stays out of the artifact and playable-ad builds.
import { CONFIG } from '../config.js';
import { APP } from './live.js';

export function raceRequested() {
  return APP || new URLSearchParams(location.search).has('race');
}

// ?race=here: the race server is the one serving this page (Colyseus Cloud
// serves both). Local Supabase sessions (?live=local, or tools/host-mock.html on
// this PC) only work on the local race server; everything else races on Cloud.
export function raceServer() {
  const q = new URLSearchParams(location.search);
  if (q.get('race') === 'here') return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  if (APP && q.get('live') !== 'local') return CONFIG.race.server; // the app's page is served from localhost inside the phone
  const onThisPc = !q.has('live') && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  return q.get('live') === 'local' || onThisPc ? CONFIG.race.localServer : CONFIG.race.server;
}

// Solo runs are checked by replay on the race server (DECISIONS 72).
export function runCheckUrl() {
  return raceServer().replace(/^ws/, 'http') + '/run-check';
}

function loadSdk() {
  if (window.Colyseus) return Promise.resolve(window.Colyseus);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/colyseus.js';
    s.onload = () => (window.Colyseus ? resolve(window.Colyseus) : reject(new Error('race client failed to load')));
    s.onerror = () => reject(new Error('race client failed to load'));
    document.head.appendChild(s);
  });
}

export class RaceClient {
  constructor(onEvent) {
    this.onEvent = onEvent; // (type, msg) => void
    this.status = 'idle'; // idle | connecting | online | error
    this.error = '';
    this.room = null;
    this.offset = 0; // server clock minus ours
    this.you = null;
    this.balance = null;
    this.fee = null;
    this.next = null; // the race taking entries
    this.race = null; // the race being ridden (countdown info)
    this.snap = null; // latest rider positions
    this.left = 0;
    this.results = null; // the last race's result
    this.cancelled = null;
    this.checkinMsg = '';
    this.chat = []; // quick chat heard in this lobby or race: { name, id, me, at }
  }

  now() {
    return Date.now() + this.offset;
  }

  // getToken: () => Promise of a fresh access token (or null when signed out).
  async connect(getToken) {
    this.getToken = getToken;
    this.wanted = true;
    clearTimeout(this.retryT);
    if (this.status === 'connecting' || this.status === 'online') return;
    this.status = 'connecting';
    this.error = '';
    this.emit('status');
    try {
      const token = await getToken();
      if (!token) throw new Error('signed out');
      const Colyseus = await loadSdk();
      const client = new Colyseus.Client(raceServer());
      const room = await client.join('endurance', { token });
      this.room = room;
      this.status = 'online';
      this.tries = 0;
      this.wire(room);
    } catch (err) {
      this.status = 'error';
      this.error = (err && err.message) || String(err);
      this.retry();
    }
    this.emit('status');
  }

  // Lost the server (restart, network): keep trying, slower each time. A drop
  // during a race still counts as out; this only gets the player back in the lobby.
  retry() {
    // Refused sign-ins don't fix themselves; the player signs in again.
    if (!this.wanted || /signed in elsewhere|signed out|sign in to race/.test(this.error)) return;
    clearTimeout(this.retryT);
    const delay = Math.min(15000, 2000 * 2 ** (this.tries || 0));
    this.tries = (this.tries || 0) + 1;
    this.retryT = setTimeout(() => {
      if (this.status === 'error' && this.wanted) {
        this.status = 'idle';
        this.connect(this.getToken);
      }
    }, delay);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryT);
    const room = this.room;
    this.room = null;
    if (room) room.leave();
    this.status = 'idle';
    this.next = this.race = this.snap = null;
    this.emit('status');
  }

  wire(room) {
    room.onMessage('hello', (m) => {
      this.offset = m.serverNow - Date.now();
      this.you = m.you;
      this.cycleMs = m.cycleMs;
      this.next = m.next;
      this.race = m.race;
      this.emit('hello', m);
    });
    room.onMessage('balance', (m) => {
      this.balance = m.balance;
      this.fee = m.fee;
      this.prizePct = m.prize_pct;
      this.stats = { races: m.races || 0, wins: m.wins || 0, won: m.won || 0 };
      this.emit('balance', m);
    });
    room.onMessage('rematch', (m) => this.emit('rematch', m));
    room.onMessage('board', (m) => {
      this.board = m;
      this.emit('board', m);
    });
    room.onMessage('next', (m) => {
      this.next = m;
      this.emit('next', m);
    });
    room.onMessage('checkin', (m) => {
      if (typeof m.balance === 'number') this.balance = m.balance;
      this.checkinMsg = m.ok ? '' : m.reason || 'check-in failed';
      this.emit('checkin', m);
    });
    room.onMessage('withdraw', (m) => {
      if (typeof m.balance === 'number') this.balance = m.balance;
      this.checkinMsg = m.ok ? '' : m.reason || 'could not leave';
      this.emit('withdraw', m);
    });
    room.onMessage('chat', (m) => {
      // One lobby or race at a time: a new one starts a fresh log.
      if (this.chatRace !== m.race) (this.chat = []), (this.chatRace = m.race);
      this.chat.push(Object.assign({ at: performance.now() }, m));
      if (this.chat.length > 30) this.chat.shift();
      this.emit('chat', m);
    });
    room.onMessage('cancelled', (m) => {
      this.cancelled = m;
      this.emit('cancelled', m);
    });
    room.onMessage('countdown', (m) => {
      // The last race's results stay up (Results tab) until this race's arrive.
      this.race = m;
      this.snap = null;
      this.left = m.riders.length;
      this.emit('countdown', m);
    });
    room.onMessage('go', (m) => this.emit('go', m));
    room.onMessage('riders', (m) => {
      if (!this.race || m.race !== this.race.id) return;
      this.snap = m;
      this.snapAt = performance.now();
      this.left = m.left;
      this.emit('riders', m);
    });
    room.onMessage('results', (m) => {
      this.results = m;
      this.emit('results', m);
    });
    room.onLeave((code) => {
      if (this.room !== room) return; // a room we left on purpose
      this.room = null;
      this.status = 'error';
      this.error = code === 4000 ? 'signed in elsewhere' : 'disconnected';
      this.retry();
      this.emit('status');
    });
  }

  emit(type, m) {
    this.onEvent(type, m);
  }

  requestRematch() {
    if (this.room) this.room.send('rematch');
  }

  requestBoard() {
    if (this.room) this.room.send('board');
  }

  checkIn() {
    if (this.room) this.room.send('checkin');
  }

  // Leave the lobby: the server cancels the check-in and refunds the fee.
  withdraw() {
    if (this.room) this.room.send('withdraw');
  }

  say(id) {
    if (this.room) this.room.send('chat', { id });
  }

  // A batch of this rider's inputs, [count, txCm, flags] runs from tick `from`.
  sendInputs(race, from, runs) {
    if (this.room && runs.length) this.room.send('inputs', { race, from, runs });
  }

  nameOf(i) {
    const r = this.race && this.race.riders.find((x) => x.i === i);
    return r ? r.name : '';
  }
}
