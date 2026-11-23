// Creates the three local test accounts (with display names) and writes them to
// supabase/local-standins/test-account.json. Run again after a database reset.
// Local Supabase only; the passwords are throwaway values for the local stack.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '../src/config.js';

const L = CONFIG.online.local;
const people = [
  ['player', 'Player One'],
  ['rival', 'Rival Fox'],
  ['racer3', 'Racer Three'],
];
const accounts = [];
for (const [id, display_name] of people) {
  const email = id + '@avalanche.test';
  const password = 'local-' + randomUUID().slice(0, 12);
  const r = await fetch(L.url + '/auth/v1/signup', { method: 'POST', headers: { apikey: L.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, data: { display_name } }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(email + ': ' + JSON.stringify(j));
  accounts.push({ email, password, name: display_name });
}
const file = new URL('../supabase/local-standins/test-account.json', import.meta.url);
const note = 'Local Supabase only (npx supabase start). Throwaway accounts for ?live=local playtests and races; a db reset deletes them (recreate: node server/test-accounts.mjs).';
fs.writeFileSync(file, JSON.stringify({ note, email: accounts[0].email, password: accounts[0].password, accounts }, null, 2) + '\n');
console.log('created', accounts.map((a) => a.name).join(', '));
