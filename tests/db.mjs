// Tests the slice 1 profile APIs against the local Supabase (supabase/), the
// way the game calls them: real sign-up, REST calls with the player's token,
// row-level security. Day changes for the streak are simulated by moving the
// stored streak day back in the local database.
//
// Needs Docker and `npx supabase start`. Run: node tests/db.mjs
// Local only: it signs up throwaway accounts on the local stack, never live.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, eq, ok, report } from './harness.mjs';

const env = Object.fromEntries(
  execSync('npx --yes supabase@latest status -o env', { cwd: new URL('..', import.meta.url), encoding: 'utf8' })
    .split(/\r?\n/)
    .map((l) => l.match(/^(\w+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const URL_ = env.API_URL;
const ANON = env.ANON_KEY;
if (!URL_ || !ANON || !/127\.0\.0\.1|localhost/.test(URL_)) throw new Error('local Supabase is not running (npx supabase start)');

// Run SQL as the database owner inside the local container (test setup only).
function sql(q) {
  return execSync('docker exec -i supabase_db_avalanche-run psql -U postgres -At -v ON_ERROR_STOP=1', { input: q, encoding: 'utf8' }).trim();
}

async function signUp() {
  const email = 'test-' + randomUUID().slice(0, 8) + '@example.test';
  const password = randomUUID(); // throwaway, local stack only
  const r = await fetch(URL_ + '/auth/v1/signup', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('sign-up failed: ' + JSON.stringify(j));
  return { token: j.access_token, id: j.user.id };
}

async function rpc(user, name, args) {
  const headers = { apikey: ANON, 'Content-Type': 'application/json' };
  if (user) headers.Authorization = 'Bearer ' + user.token;
  const r = await fetch(URL_ + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(args || {}) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const run = (user, score, key, stats) => rpc(user, 'submit_avalanche_run', { p_distance: score, p_key: key, p_run_id: null, p_stats: stats });
const profile = async (user) => (await rpc(user, 'get_avalanche_profile')).body;
const ids = (p) => p.missions.map((m) => m.id + (m.done ? '*' : '') + ':' + m.progress).join(',');
const key = () => 'avalanche:test:' + randomUUID();
const stats = (o) => Object.assign({ distance: 0, flakes: 0, nearMisses: 0, bestCombo: 0, cleanJumps: 0, tricks: 0, perfects: 0, trickScore: 0, topKmh: 0 }, o);

const A = await signUp();
const B = await signUp();
const results = {};

results.anon = await rpc(null, 'get_avalanche_profile');
results.fresh = await profile(A);
const k1 = key();
results.run1 = await run(A, 850, k1, stats({ distance: 800, flakes: 19, nearMisses: 5, topKmh: 160 }));
results.afterRun1 = await profile(A);
results.dup = await run(A, 850, k1, stats({ distance: 800, flakes: 19, nearMisses: 5 }));
results.afterDup = await profile(A);
results.run2 = await run(A, 300, key(), stats({ distance: 300, flakes: 5 }));
results.afterRun2 = await profile(A);
results.clamp = await run(A, 100, key(), stats({ distance: 5000, flakes: 99999, nearMisses: 999, bestCombo: 50, topKmh: 9999 }));
results.rejected = await run(A, 2000000, key(), stats({ distance: 100, flakes: 10 }));
results.afterRejected = await profile(A);
results.badStats = await run(A, 120, key(), { distance: 100, flakes: 'lots' });
results.afterBad = await profile(A);

// Streak across days: move the stored day back, then submit.
const same = (a, b) => eq(JSON.stringify(a, Object.keys(a).sort()), JSON.stringify(b, Object.keys(b).sort()));
const day = async (shift, extra) => {
  sql(`update avalanche_profiles set streak_day = (now() at time zone 'utc')::date - ${shift}${extra || ''} where user_id = '${A.id}';`);
  return run(A, 200, key(), stats({ distance: 200 }));
};
results.day2 = await day(1);
results.day3 = await day(1);
results.gap = await day(3);
results.day8 = await day(1, ', streak = 7');
sql(`update avalanche_profiles set streak_day = (now() at time zone 'utc')::date - 2 where user_id = '${A.id}';`);
results.lapsed = await profile(A);

// Unlocks.
results.buyPoor = await rpc(B, 'buy_avalanche_item', { p_type: 'rider', p_id: 'pine' });
sql(`update avalanche_profiles set flakes = 500 where user_id = '${A.id}';`);
results.buy = await rpc(A, 'buy_avalanche_item', { p_type: 'board', p_id: 'sunrise' });
results.buyAgain = await rpc(A, 'buy_avalanche_item', { p_type: 'board', p_id: 'sunrise' });
results.buyStreakOnly = await rpc(A, 'buy_avalanche_item', { p_type: 'rider', p_id: 'yeti' });
results.buyUnknown = await rpc(A, 'buy_avalanche_item', { p_type: 'rider', p_id: 'dragon' });
results.selectOwned = await rpc(A, 'select_avalanche_item', { p_type: 'board', p_id: 'classic' });
results.selectNotOwned = await rpc(A, 'select_avalanche_item', { p_type: 'rider', p_id: 'frost' });

// Shards shop (DECISIONS 68): the stand-in wallet starts every player on 100 test Shards.
results.shop0 = await profile(B);
results.trailBuy = await rpc(B, 'buy_avalanche_item', { p_type: 'trail', p_id: 'aurora' });
results.trailAgain = await rpc(B, 'buy_avalanche_item', { p_type: 'trail', p_id: 'aurora' });
results.trailPoor = await rpc(B, 'buy_avalanche_item', { p_type: 'trail', p_id: 'neon' });
results.galaxyPoor = await rpc(B, 'buy_avalanche_item', { p_type: 'rider', p_id: 'galaxy' });
sql(`update standin_shards set balance = 900 where user_id = '${B.id}';`);
results.galaxy = await rpc(B, 'buy_avalanche_item', { p_type: 'rider', p_id: 'galaxy' });
results.trailOff = await rpc(B, 'select_avalanche_item', { p_type: 'trail', p_id: 'none' });
results.trailOn = await rpc(B, 'select_avalanche_item', { p_type: 'trail', p_id: 'aurora' });
results.trailNotOwned = await rpc(B, 'select_avalanche_item', { p_type: 'trail', p_id: 'ember' });
results.shopLog = sql(`select string_agg(amount || ':' || ref, ',' order by id) from standin_shards_log where user_id = '${B.id}';`);

// Row-level security: B sees only B's row and cannot write directly.
const rest = (user, method, path, body) =>
  fetch(URL_ + '/rest/v1/' + path, { method, headers: { apikey: ANON, Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
results.rlsRead = await rest(B, 'GET', 'avalanche_profiles?select=user_id,flakes');
results.rlsWrite = await rest(B, 'PATCH', 'avalanche_profiles?user_id=eq.' + B.id, { flakes: 99999 });
results.rlsWriteCheck = sql(`select flakes from avalanche_profiles where user_id = '${B.id}';`);
results.catalog = await fetch(URL_ + '/rest/v1/avalanche_items?select=id', { headers: { apikey: ANON } }).then((r) => r.json());

test('signed out: get_avalanche_profile is refused', () => ok(results.anon.status === 401 || results.anon.status === 403 || results.anon.status === 400, 'status ' + results.anon.status));

test('first use: fresh profile with defaults and three missions', () => {
  const p = results.fresh;
  eq(p.flakes, 0);
  eq(p.riders.join(), 'nova');
  eq(p.boards.join(), 'classic');
  eq(p.rider + '/' + p.board, 'nova/classic');
  eq(p.streak, 0);
  eq(ids(p), 'dist1:0,near1:0,flake1:0');
});

test('counted run: score path response kept, snowflakes, missions, streak and totals applied', () => {
  const r = results.run1.body;
  eq(r.counted, true);
  eq(r.distance, 850, 'submit_avalanche_score response is passed through');
  eq(r.avalanche.flakes_earned, 19);
  eq(r.avalanche.mission_flakes, 60, 'dist1 (800 m) + near1 (5 near misses)');
  eq(r.avalanche.completed.join(), 'dist1,near1');
  eq(r.avalanche.streak_reward.day, 1);
  const p = results.afterRun1;
  eq(p.flakes, 79);
  eq(p.streak, 1);
  eq(p.streak_today, true);
  eq(ids(p), 'dist1*:800,near1*:5,flake1:19');
  eq(p.totals.runs + '|' + p.totals.distance + '|' + p.totals.flakes + '|' + p.totals.nearMisses, '1|800|19|5');
  eq(p.best, 850);
});

test('retry with the same key: nothing paid twice', () => {
  eq(results.dup.body.duplicate, true, 'score path reports the duplicate');
  eq(results.dup.body.avalanche.duplicate, true);
  eq(results.afterDup.flakes, 79);
  eq(results.afterDup.totals.runs, 1);
});

test('next run: finished missions replaced in order, streak not advanced twice in a day', () => {
  eq(results.run2.body.avalanche.streak_reward, null);
  eq(ids(results.afterRun2), 'clean1:0,trick1:0,flake1:24');
  eq(results.afterRun2.flakes, 84);
  eq(results.afterRun2.best, 850, 'best keeps the higher score');
});

test('implausible stats are clamped to what the run could produce', () => {
  const a = results.clamp.body.avalanche;
  eq(a.flakes_earned, 32, 'distance is capped at the score (100), flakes at 100 / 8 + 20 (integer division)');
});

test('rejected score: no progression', () => {
  eq(results.rejected.body.rejected, true);
  eq(results.rejected.body.avalanche, undefined);
  eq(results.afterRejected.totals.runs, 3);
});

test('a progression error never undoes the counted score', () => {
  eq(results.badStats.body.counted, true);
  ok(typeof results.badStats.body.avalanche.error === 'string', 'error reported: ' + JSON.stringify(results.badStats.body.avalanche));
  eq(results.afterBad.totals.runs, 3, 'progression rolled back');
});

test('streak: consecutive days advance and pay, a gap resets, day 8+ pays the daily amount', () => {
  same(results.day2.body.avalanche.streak_reward, { day: 2, flakes: 40, rider: null, board: null });
  eq(results.day3.body.avalanche.streak_reward.board, 'ember');
  ok(results.day3.body.avalanche.profile.boards.includes('ember'), 'ember unlocked');
  eq(results.gap.body.avalanche.streak_reward.day, 1, 'gap resets to day 1');
  same(results.day8.body.avalanche.streak_reward, { day: 8, flakes: 60, rider: null, board: null });
  eq(results.lapsed.streak, 0, 'a streak older than yesterday shows as lapsed');
});

test('unlocks: price, balance, ownership and streak-only items are enforced by the server', () => {
  eq(results.buyPoor.body.reason, 'not enough snowflakes');
  eq(results.buy.body.ok, true);
  eq(results.buy.body.profile.flakes, 400);
  eq(results.buy.body.profile.board, 'sunrise', 'a bought item is worn');
  eq(results.buyAgain.body.reason, 'already owned');
  eq(results.buyStreakOnly.body.reason, 'streak reward only');
  eq(results.buyUnknown.body.reason, 'unknown item');
  eq(results.selectOwned.body.profile.board, 'classic');
  eq(results.selectNotOwned.body.reason, 'not owned');
});

test('Shards shop: priced in Shards, debited once, owned, worn, and trails can be taken off', () => {
  eq(results.shop0.shards, 100, 'profile shows the Shards balance');
  eq(JSON.stringify(results.shop0.trails), '[]');
  eq(results.shop0.trail, null);
  eq(results.trailBuy.body.ok, true);
  eq(results.trailBuy.body.profile.shards, 0, '100 Shards spent');
  eq(results.trailBuy.body.profile.trail, 'aurora', 'a bought trail is worn');
  eq(results.trailBuy.body.profile.flakes, results.shop0.flakes, 'snowflakes untouched');
  eq(results.trailAgain.body.reason, 'already owned');
  eq(results.trailPoor.body.reason, 'not enough shards');
  eq(results.galaxyPoor.body.reason, 'not enough shards');
  eq(results.galaxy.body.ok, true);
  eq(results.galaxy.body.profile.rider, 'galaxy');
  eq(results.galaxy.body.profile.shards, 400);
  eq(results.trailOff.body.profile.trail, null, 'no trail');
  eq(results.trailOn.body.profile.trail, 'aurora');
  eq(results.trailNotOwned.body.reason, 'not owned');
  eq(results.shopLog, '-100:avalanche shop trail aurora,-500:avalanche shop rider galaxy', 'one debit per purchase, nothing for refusals');
});

test('row-level security: players read only their own row and cannot write directly', () => {
  eq(results.rlsRead.status, 200);
  eq(results.rlsRead.body.length, 1);
  eq(results.rlsRead.body[0].user_id, B.id);
  ok(results.rlsWrite.status >= 400 || (Array.isArray(results.rlsWrite.body) && results.rlsWrite.body.length === 0), 'direct write refused: ' + results.rlsWrite.status);
  eq(results.rlsWriteCheck, '0', 'balance unchanged');
  eq(results.catalog.length, 17, 'catalogue readable without signing in');
});

report();
