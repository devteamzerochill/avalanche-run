// The race server's two links to Supabase: checking a player's sign-in, and the
// race ledger functions (never exposed to the browser).
//
// The ledger accepts two callers (supabase/migrations/..._endurance_race.sql):
// the service role, or the race server's own site account set as
// avalanche_race_config.server_user. Locally the service key is read from the
// local stack; on the live site the server signs in as its account
// (RACE_SERVER_EMAIL / RACE_SERVER_PASSWORD in server/.env, never committed),
// because Lovable Cloud doesn't hand out the service key.
import { execSync } from 'node:child_process';
import { CONFIG } from '../src/config.js';

export function supabaseSettings() {
  const url = (process.env.SUPABASE_URL || CONFIG.online.local.url).replace(/\/$/, '');
  const local = /127\.0\.0\.1|localhost/.test(url);
  const anon = process.env.SUPABASE_ANON_KEY || (local ? CONFIG.online.local.anonKey : url === CONFIG.online.url ? CONFIG.online.anonKey : '');
  if (!anon) throw new Error('SUPABASE_ANON_KEY is not set');
  const email = process.env.RACE_SERVER_EMAIL || '';
  const password = process.env.RACE_SERVER_PASSWORD || '';
  if (email && password) return { url, anon, account: { email, password } };
  let service = process.env.SUPABASE_SERVICE_KEY || '';
  // Local development: read the local stack's own service key, so nobody has
  // to copy it around. Never done for a remote URL.
  if (!service && local) {
    const out = execSync('npx --yes supabase@latest status -o env', { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?/m);
    if (m) service = m[1];
  }
  if (!service) throw new Error('set RACE_SERVER_EMAIL and RACE_SERVER_PASSWORD (or SUPABASE_SERVICE_KEY)');
  return { url, anon, service };
}

export class Supabase {
  constructor(s) {
    this.s = s;
    this.session = null; // the server account's session: { token, refresh, expires } (ms)
    this.signing = null;
  }

  // The token the ledger calls carry: the service key, or the server account's
  // access token, renewed a minute before it expires.
  async bearer() {
    if (this.s.service) return this.s.service;
    if (this.session && Date.now() < this.session.expires - 60000) return this.session.token;
    if (!this.signing) this.signing = this.signIn().finally(() => (this.signing = null));
    return this.signing;
  }

  async signIn() {
    const grant = async (type, body) => {
      const res = await fetch(this.s.url + '/auth/v1/token?grant_type=' + type, {
        method: 'POST',
        headers: { apikey: this.s.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => null);
      if (!res.ok || !b || !b.access_token) throw new Error('race server sign-in: ' + ((b && (b.error_description || b.msg || b.message)) || res.status));
      return b;
    };
    let b = null;
    if (this.session && this.session.refresh) b = await grant('refresh_token', { refresh_token: this.session.refresh }).catch(() => null);
    if (!b) b = await grant('password', this.s.account);
    this.session = { token: b.access_token, refresh: b.refresh_token, expires: Date.now() + (b.expires_in || 3600) * 1000, user: b.user && b.user.id };
    return this.session.token;
  }

  // The signed-in user behind an access token, or null.
  async user(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const res = await fetch(this.s.url + '/auth/v1/user', { headers: { apikey: this.s.anon, Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || !u.id) return null;
    // The name other riders see, from the site's profiles (race_player_name);
    // the email prefix if that has nothing.
    const found = await this.rpc('race_player_name', { p_user: u.id }).catch(() => null);
    const name = (typeof found === 'string' && found.trim()) || (u.email || 'rider').split('@')[0];
    return { id: u.id, email: u.email || '', name: name.trim().slice(0, 20) };
  }

  async rpc(name, args) {
    const bearer = await this.bearer();
    const res = await fetch(this.s.url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: this.s.service || this.s.anon, Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(name + ': ' + ((body && body.message) || res.status));
    return body;
  }
}
