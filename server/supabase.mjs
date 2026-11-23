// The race server's two links to Supabase: checking a player's sign-in, and the
// race ledger functions (service role only, never exposed to the browser).
import { execSync } from 'node:child_process';
import { CONFIG } from '../src/config.js';

export function supabaseSettings() {
  const url = (process.env.SUPABASE_URL || CONFIG.online.local.url).replace(/\/$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || CONFIG.online.local.anonKey;
  let service = process.env.SUPABASE_SERVICE_KEY || '';
  // Local development: read the local stack's own service key, so nobody has
  // to copy it around. Never done for a remote URL.
  if (!service && /127\.0\.0\.1|localhost/.test(url)) {
    const out = execSync('npx --yes supabase@latest status -o env', { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^SERVICE_ROLE_KEY="?([^"\r\n]+)"?/m);
    if (m) service = m[1];
  }
  if (!service) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return { url, anon, service };
}

export class Supabase {
  constructor(s) {
    this.s = s;
  }

  // The signed-in user behind an access token, or null.
  async user(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const res = await fetch(this.s.url + '/auth/v1/user', { headers: { apikey: this.s.anon, Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || !u.id) return null;
    // The name other riders see, from the site's profiles (avalanche_player_name);
    // the email prefix if that has nothing.
    const found = await this.rpc('avalanche_player_name', { p_user: u.id }).catch(() => null);
    const name = (typeof found === 'string' && found.trim()) || (u.email || 'rider').split('@')[0];
    return { id: u.id, email: u.email || '', name: name.trim().slice(0, 20) };
  }

  async rpc(name, args) {
    const res = await fetch(this.s.url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: this.s.service, Authorization: 'Bearer ' + this.s.service, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(name + ': ' + ((body && body.message) || res.status));
    return body;
  }
}
