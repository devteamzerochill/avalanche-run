// Bridge to the zerochill.com page that hosts the game in an iframe.
// The page owns the player session and makes every backend call with its
// existing client; the game only reports attempts and shows what comes back.
// The contract is written up in WEBSITE_INTEGRATION.md.
//
// Host mode is opt-in: the page must name its own origin with ?host=<origin>
// (or window.__ZC_HOST_ORIGIN). Without it, e.g. inside the claude.ai artifact
// iframe, the game stays fully local.
//
// ?live (outside an iframe) swaps the page for LiveBackend, which makes the same
// calls directly against the real backend, for testing before the website switches.
import { LiveBackend, liveRequested } from './live.js';

const PROTOCOL = 1;
const GAME = 'avalanche_run';

function hostOrigin() {
  let o = window.__ZC_HOST_ORIGIN || new URLSearchParams(location.search).get('host');
  if (!o || window.parent === window) return '';
  try {
    o = new URL(o).origin;
  } catch (err) {
    return '';
  }
  return o === 'null' ? '' : o;
}

export function utcDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// One key per completed attempt; retries reuse it. 8-128 characters.
export function attemptKey(startMs, score) {
  return 'avalanche:' + utcDateKey(startMs) + ':' + startMs + ':' + score;
}

export class Host {
  constructor() {
    this.origin = hostOrigin();
    this.live = !this.origin && liveRequested() ? new LiveBackend((m) => this.handle(m)) : null;
    this.active = !!this.origin || !!this.live;
    this.signedIn = null; // null until the page says
    this.board = null; // landing_board result
    this.bar = null; // this game's daily_pop_bars entry
    this.dailyBest = null; // today's best_distance on the server
    this.profile = null; // the server profile (snowflakes, unlocks, missions, streak) when signed in
    this.attempts = new Map(); // id -> {id, startMs, score, key, status, result}
    this.current = null;
    this.listeners = [];
    this.seq = 0;
    if (!this.active) return;
    if (this.origin) window.addEventListener('message', (e) => this.receive(e));
    this.send('hello', { game: GAME });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  emit(what, data) {
    for (const fn of this.listeners) fn(what, data);
  }

  send(type, data) {
    if (!this.active) return;
    const msg = Object.assign({ source: 'avalanche-run', protocol: PROTOCOL, type }, data || {});
    if (this.live) {
      // Answer asynchronously, as a page would, so callers finish their own state first.
      setTimeout(() => this.live.receive(msg), 0);
      return;
    }
    try {
      window.parent.postMessage(msg, this.origin);
    } catch (err) {
      /* the page went away; nothing to do */
    }
  }

  receive(e) {
    if (e.source !== window.parent || e.origin !== this.origin) return;
    this.handle(e.data);
  }

  handle(m) {
    if (!m || m.source !== 'zerochill' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'session':
        this.signedIn = !!m.signedIn;
        if (!this.signedIn) this.profile = null;
        break;
      case 'profile':
        this.profile = m.profile && typeof m.profile === 'object' && Array.isArray(m.profile.missions) ? m.profile : null;
        break;
      case 'item_result':
        break;
      case 'board':
        this.board = m.board && m.board.game === GAME ? m.board : null;
        break;
      case 'bars':
        this.bar = m.bar && m.bar.game_id === GAME ? m.bar : null;
        break;
      case 'daily_best':
        this.dailyBest = typeof m.best === 'number' ? m.best : null;
        break;
      case 'race_token': {
        // Only for the race server: resolved here, never passed to listeners.
        if (this.tokenWait) this.tokenWait(typeof m.token === 'string' && m.token.length >= 20 ? m.token : null);
        return;
      }
      case 'submit_result': {
        const a = this.attempts.get(m.attempt);
        if (!a) return;
        a.status = ['counted', 'duplicate', 'rejected', 'failed', 'signin'].includes(m.status) ? m.status : 'failed';
        a.result = m.result && typeof m.result === 'object' ? m.result : null;
        a.reason = typeof m.reason === 'string' ? m.reason : '';
        if (a.status === 'signin') this.signedIn = false;
        break;
      }
      default:
        return;
    }
    this.emit(m.type, m);
  }

  // A new attempt starts: the page opens a server run for it.
  startAttempt() {
    if (!this.active) return null;
    const startMs = Date.now();
    const id = startMs.toString(36) + '-' + ++this.seq;
    const a = { id, startMs, score: 0, key: '', status: 'playing', result: null, reason: '' };
    this.attempts.set(id, a);
    this.current = a;
    // Keep only recent attempts so a long session doesn't grow without bound.
    if (this.attempts.size > 20) this.attempts.delete(this.attempts.keys().next().value);
    this.send('attempt_start', { attempt: id });
    return a;
  }

  // The attempt is over: the page submits the score once, with this key, and
  // the run summary the server uses for snowflakes, missions and the streak.
  // check(key): the replay check (DECISIONS 72), which must be recorded before
  // the page submits; the score goes either way (the site decides).
  endAttempt(score, stats, check) {
    const a = this.current;
    if (!a || a.status !== 'playing') return null;
    a.score = Math.max(0, Math.round(score));
    a.key = attemptKey(a.startMs, a.score);
    a.status = 'saving';
    a.stats = stats || {};
    const send = () => this.send('attempt_end', { attempt: a.id, score: a.score, key: a.key, stats: a.stats });
    if (check) Promise.resolve().then(() => check(a.key)).catch(() => {}).finally(send);
    else send();
    return a;
  }

  // Manual retry after a failure: exactly the same arguments.
  retry(id) {
    const a = this.attempts.get(id);
    if (!a || (a.status !== 'failed' && a.status !== 'signin')) return;
    a.status = 'saving';
    this.send('retry', { attempt: a.id, score: a.score, key: a.key, stats: a.stats });
    this.emit('retry', a);
  }

  // The player's own session token, for the race server only (RACE_HANDOFF.md).
  // One request at a time; null if the page doesn't answer within 10 s.
  raceToken() {
    if (!this.origin) return Promise.resolve(null);
    if (!this.tokenReq) {
      this.tokenReq = new Promise((resolve) => {
        const timer = setTimeout(() => this.tokenWait(null), 10000);
        this.tokenWait = (token) => {
          clearTimeout(timer);
          this.tokenWait = this.tokenReq = null;
          resolve(token);
        };
        this.send('race_token');
      });
    }
    return this.tokenReq;
  }

  refresh() {
    this.send('refresh');
  }

  // Server profile: unlocks are bought and worn through the page.
  buy(type, id) {
    this.send('buy', { itemType: type, id });
  }

  select(type, id) {
    this.send('select', { itemType: type, id });
  }
}
