// Direct connection to the zerochill.com backend (Lovable Cloud, Supabase REST)
// for testing the game outside the website. It plays the website's part of the
// bridge in-process: same messages in, same answers out, so the game's screens
// and save statuses behave exactly as they will on zerochill.com.
//
// Opt-in with ?live. Every write is real: counted runs show on the public daily
// board. Only the public app key is used; the player's password goes straight
// to the auth endpoint and is never stored. The session lives in sessionStorage,
// so it ends with the browser tab.
import { CONFIG } from '../config.js';

const GAME = 'avalanche_run';
const SESSION_KEY = 'avalanche-run-live-session';
const RETRY_DELAYS = [700, 1400, 2800, 5600]; // the website's helper: five attempts in all

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// ?live talks to zerochill.com; ?live=local to the local Supabase in supabase/.
export function liveTarget() {
  const q = new URLSearchParams(location.search);
  if (!q.has('live')) return null;
  const t = q.get('live') === 'local' ? CONFIG.online.local : CONFIG.online;
  return t && t.url && t.anonKey ? t : null;
}

export function liveRequested() {
  return !!liveTarget();
}

class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.msg || body.error_description || body.error)) || 'HTTP ' + status);
    this.status = status;
    this.code = body && body.code;
  }
}

export class LiveBackend {
  constructor(reply) {
    this.reply = reply; // (msg) => void, delivers a page-to-game message
    const target = liveTarget();
    this.url = target.url.replace(/\/$/, '');
    this.key = target.anonKey;
    // The profile APIs (submit_avalanche_run and friends) exist only where the
    // slice 1 migration is applied.
    this.profileApi = !!target.profile;
    this.session = this.loadSession();
    this.runs = new Map(); // attempt -> server run id
    this.startSeq = 0;
  }

  // --- session ---------------------------------------------------------------
  loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      return s && s.access_token ? s : null;
    } catch (err) {
      return null;
    }
  }

  saveSession(s) {
    this.session = s && s.access_token ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600), user: s.user ? { id: s.user.id, email: s.user.email } : null } : null;
    try {
      if (this.session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* private mode: the session just lasts for this page */
    }
  }

  get email() {
    return this.session && this.session.user ? this.session.user.email : '';
  }

  async auth(grant, body) {
    const res = await fetch(this.url + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.key },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  async signIn(email, password) {
    this.saveSession(await this.auth('password', { email, password }));
    this.pushAll();
  }

  async signOut() {
    const token = this.session && this.session.access_token;
    this.saveSession(null);
    if (token) fetch(this.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: this.key, Authorization: 'Bearer ' + token } }).catch(() => {});
    this.pushAll();
  }

  // Refresh a session that is about to expire; false means sign in again.
  async fresh(force) {
    const s = this.session;
    if (!s) return false;
    if (!force && s.expires_at - 60 > Date.now() / 1000) return true;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.auth('refresh_token', { refresh_token: s.refresh_token })
      .then((n) => {
        this.saveSession(n);
        return true;
      })
      .catch((err) => {
        if (err.status >= 400 && err.status < 500) this.saveSession(null);
        return false;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  // --- REST --------------------------------------------------------------------
  async call(method, path, body, needsUser) {
    if (needsUser && !(await this.fresh())) throw new ApiError(401, { message: 'not authenticated', code: 'SESSION' });
    for (let pass = 0; pass < 2; pass++) {
      const headers = { 'Content-Type': 'application/json', apikey: this.key };
      if (this.session) headers.Authorization = 'Bearer ' + this.session.access_token;
      const res = await fetch(this.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => null);
      if (res.ok) return json;
      // An expired token: refresh once and repeat the same request.
      if (res.status === 401 && pass === 0 && this.session && (await this.fresh(true))) continue;
      throw new ApiError(res.status, json);
    }
    return null;
  }

  rpc(name, args, needsUser) {
    return this.call('POST', '/rest/v1/rpc/' + name, args || {}, needsUser);
  }

  // --- the website's part of the bridge -------------------------------------------
  receive(m) {
    if (m.type === 'hello' || m.type === 'refresh') this.pushAll();
    else if (m.type === 'attempt_start') this.startRun(m.attempt);
    else if (m.type === 'attempt_end' || m.type === 'retry') this.submit(m);
    else if ((m.type === 'buy' || m.type === 'select') && this.profileApi) this.item(m);
  }

  async item(m) {
    let res = null;
    try {
      res = await this.rpc(m.type === 'buy' ? 'buy_avalanche_item' : 'select_avalanche_item', { p_type: m.itemType, p_id: m.id }, true);
    } catch (err) {
      res = { ok: false, reason: err.message };
    }
    this.send({ type: 'item_result', action: m.type, itemType: m.itemType, id: m.id, ok: !!(res && res.ok), reason: (res && res.reason) || '' });
    if (res && res.profile) this.send({ type: 'profile', profile: res.profile });
  }

  send(msg) {
    this.reply(Object.assign({ source: 'zerochill', protocol: 1 }, msg));
  }

  async pushAll() {
    this.send({ type: 'session', signedIn: !!this.session });
    const [board, bars, best, profile] = await Promise.all([
      this.rpc('landing_board', { p_game: GAME, p_limit: 25 }).catch(() => null),
      this.rpc('daily_pop_bars', {}).catch(() => null),
      this.dailyBest().catch(() => null),
      this.profileApi && this.session ? this.rpc('get_avalanche_profile', {}, true).catch(() => null) : null,
    ]);
    if (this.profileApi) this.send({ type: 'profile', profile });
    this.send({ type: 'board', board });
    this.send({ type: 'bars', bar: Array.isArray(bars) ? bars.find((b) => b && b.game_id === GAME) || null : null });
    this.send({ type: 'daily_best', best });
  }

  async dailyBest() {
    if (!this.session || !this.session.user) return null;
    // Filter by user too: an admin account can read every player's rows.
    const rows = await this.call('GET', '/rest/v1/avalanche_run_daily_scores?select=best_distance&date_key=eq.' + utcDateKey() + '&user_id=eq.' + this.session.user.id, null, true);
    return Array.isArray(rows) && rows[0] ? rows[0].best_distance : null;
  }

  // Best effort, like the website: play never waits for this.
  async startRun(attempt) {
    const seq = ++this.startSeq;
    if (!this.session) return;
    try {
      const id = await this.rpc('start_game_run', { p_game: GAME }, true);
      if (seq === this.startSeq && typeof id === 'string') this.runs.set(attempt, id);
    } catch (err) {
      console.warn('start_game_run failed:', err.message);
    }
  }

  async submit(m) {
    const args = { p_distance: Math.max(0, Math.round(m.score)), p_key: m.key };
    // Metres ridden, apart from the score: the site's Daily Reward bar and run
    // check measure metres, while the score also carries trick points (DECISIONS 65).
    if (m.stats && Number.isFinite(m.stats.distance)) args.p_metres = Math.max(0, Math.floor(m.stats.distance));
    const run = this.runs.get(m.attempt);
    if (run) args.p_run_id = run;
    if (this.profileApi) args.p_stats = m.stats || {};
    let status = 'failed';
    let reason = '';
    let result = null;
    for (let i = 0; i < 5; i++) {
      try {
        result = await this.rpc(this.profileApi ? 'submit_avalanche_run' : 'submit_avalanche_score', args, true);
        if (result && result.rejected) {
          status = 'rejected';
          reason = result.reason || '';
        } else if (result && result.duplicate) status = 'duplicate';
        else if (result && result.counted) status = 'counted';
        else reason = 'unexpected response';
        break;
      } catch (err) {
        reason = err.message;
        if (err.code === 'SESSION' || /not authenticated/i.test(err.message)) {
          status = 'signin';
          break;
        }
        // Database exceptions (P0...) and client errors won't change on a retry.
        if ((err.code && String(err.code).startsWith('P0')) || (err.status >= 400 && err.status < 500)) break;
        if (i < 4) await wait(RETRY_DELAYS[i]);
      }
    }
    this.send({ type: 'submit_result', attempt: m.attempt, status, reason, result });
    this.pushAll();
  }
}
