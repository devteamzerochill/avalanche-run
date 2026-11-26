// The server catalogue (supabase migration) must match the game's config, or
// the server would price, reward or hand out missions differently from what
// the game shows.
import fs from 'node:fs';
import { test, eq, ok } from './harness.mjs';
import { CONFIG, RIDERS, BOARDS, TRAILS, MISSIONS } from '../src/config.js';

const SQL = fs.readFileSync(new URL('../supabase/migrations/20261124000000_avalanche_profiles.sql', import.meta.url), 'utf8');
// Later price changes: (type, id, price) rows under "set cost" or "set shards".
const BUMP = fs.readFileSync(new URL('../supabase/migrations/20261202000000_price_bump.sql', import.meta.url), 'utf8');
const bumps = (col) => new Map([...(BUMP.split('set ' + col + ' =')[1] || '').split('where')[0].matchAll(/\('(\w+)', '(\w+)', (\d+)\)/g)].map((m) => [m[1] + ':' + m[2], m[3]]));
const COST = bumps('cost');
const SHARDS = bumps('shards');
// Shards items are added across several migrations.
const SHOP = ['20261127000000_shards_shop.sql', '20261130000000_gold_skin.sql'].map((f) => fs.readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8')).join('\n');

export function runCatalogTests() {
  test('server catalogue matches the game: rider and board prices', () => {
    const rows = [...SQL.matchAll(/\('(rider|board)', '([a-z]+)', (-?\d+)\)/g)].map((m) => m[1] + ':' + m[2] + ':' + (COST.get(m[1] + ':' + m[2]) || m[3]));
    const snow = (it) => !it.shards;
    const want = RIDERS.filter(snow).map((r) => 'rider:' + r.id + ':' + r.cost).concat(BOARDS.filter(snow).map((b) => 'board:' + b.id + ':' + b.cost));
    eq(rows.sort().join(','), want.sort().join(','));
  });

  test('server catalogue matches the game: Shards shop prices', () => {
    const rows = [...SHOP.matchAll(/\('(rider|board|trail)', '([a-z]+)', (-?\d+), (\d+)\)/g)].map((m) => [m[1], m[2], m[3], SHARDS.get(m[1] + ':' + m[2]) || m[4]].join(':'));
    const items = (type, list) => list.filter((it) => it.shards).map((it) => [type, it.id, -1, it.shards].join(':'));
    const want = items('rider', RIDERS).concat(items('board', BOARDS), items('trail', TRAILS));
    eq(rows.sort().join(','), want.sort().join(','));
  });

  test('server catalogue matches the game: No ads for Shards', () => {
    const sql = fs.readFileSync(new URL('../supabase/migrations/20261203000000_no_ads.sql', import.meta.url), 'utf8');
    ok(sql.includes("('perk', 'no_ads', -1, " + CONFIG.store.noAds.shards + ')'), 'No ads costs ' + CONFIG.store.noAds.shards + ' Shards');
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
    ok(SQL.includes("'flakes', p.flakes + " + CONFIG.meta.streakDailyFlakes + ')'), 'daily streak flakes after the last reward = ' + CONFIG.meta.streakDailyFlakes);
  });
}
