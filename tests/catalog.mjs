// The server catalogue (supabase migration) must match the game's config, or
// the server would price, reward or hand out missions differently from what
// the game shows.
import fs from 'node:fs';
import { test, eq, ok } from './harness.mjs';
import { CONFIG, RIDERS, BOARDS, MISSIONS } from '../src/config.js';

const SQL = fs.readFileSync(new URL('../supabase/migrations/20261124000000_avalanche_profiles.sql', import.meta.url), 'utf8');

export function runCatalogTests() {
  test('server catalogue matches the game: rider and board prices', () => {
    const rows = [...SQL.matchAll(/\('(rider|board)', '([a-z]+)', (-?\d+)\)/g)].map((m) => m[1] + ':' + m[2] + ':' + m[3]);
    const want = RIDERS.map((r) => 'rider:' + r.id + ':' + r.cost).concat(BOARDS.map((b) => 'board:' + b.id + ':' + b.cost));
    eq(rows.sort().join(','), want.sort().join(','));
  });

  test('server catalogue matches the game: missions, in order', () => {
    const rows = [...SQL.matchAll(/\('(\w+)', (\d+), '(\w+)', (\d+), (\d+), (true|false)\)/g)].map((m) => [m[1], +m[2], m[3], +m[4], +m[5], m[6] === 'true']);
    eq(rows.length, MISSIONS.length, 'count');
    rows.forEach((r, i) => {
      const m = MISSIONS[i];
      eq(r.join('|'), [m.id, i + 1, m.stat, m.goal, m.reward, !!m.total].join('|'), 'mission ' + m.id);
    });
  });

  test('server catalogue matches the game: streak rewards', () => {
    const rows = [...SQL.matchAll(/\((\d+), (\d+), (null|'\w+'), (null|'\w+')\)/g)].map((m) => [+m[1], +m[2], m[3].replace(/'/g, ''), m[4].replace(/'/g, '')].join('|'));
    const want = CONFIG.meta.streakRewards.map((r) => [r.day, r.flakes || 0, r.rider || 'null', r.board || 'null'].join('|'));
    eq(rows.join(','), want.join(','));
    ok(SQL.includes('p.flakes + ' + CONFIG.meta.streakDailyFlakes + ';'), 'daily streak flakes after the last reward = ' + CONFIG.meta.streakDailyFlakes);
  });
}
