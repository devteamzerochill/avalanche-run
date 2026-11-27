// Solo scores checked by replay (DECISIONS 72). The game posts each finished
// run here before it submits the score; the server re-simulates the inputs with
// the game's own src/core and records the outcome on the site
// (avalanche_run_check). The site counts a score only against a passing check
// once avalanche_run_check_config.enforce is on.
import { Worker } from 'node:worker_threads';
import { CONFIG } from '../src/config.js';
import { resimulate, Playback } from '../src/core/replay.js';
import { dailySeed, utcDay } from '../src/core/rng.js';
import { judgeRide } from './scripted.mjs';

const MAX_BODY = 1 << 20; // a 5-minute run is well under 100 KB of inputs

export function readJson(req, max = MAX_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        resolve(null);
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// The daily mountains a run may have been on: today's, or yesterday's for a run
// that started before UTC midnight.
function dailySeeds(now) {
  const t = now || Date.now();
  return [dailySeed(utcDay(new Date(t))), dailySeed(utcDay(new Date(t - 86400000)))];
}

// What the inputs really produce, and why the claim fails if it does.
export function judgeRun(run, now) {
  const seed = run.seed >>> 0;
  if (!dailySeeds(now).includes(seed)) return { ok: false, reason: 'seed', scripted: false };
  if (run.version !== CONFIG.version) return { ok: false, reason: 'version', scripted: false };
  // Trick points count as this server's build says, never as the player says.
  const re = resimulate({ seed, version: run.version, data: run.data, tricks: CONFIG.score.tricksLive });
  if (!re) return { ok: false, reason: 'replay', scripted: false };
  const s = re.summary;
  const scripted = judgeRide(seed, null, new Playback(run.data).runs).scripted;
  if (s.score !== run.score) return { ok: false, reason: 'score', score: s.score, metres: s.distance, scripted };
  if (s.distance !== run.metres) return { ok: false, reason: 'metres', score: s.score, metres: s.distance, scripted };
  return { ok: true, reason: null, score: s.score, metres: s.distance, scripted };
}

// A 5-minute run takes about 0.4 s to replay: do it in a worker thread.
function judgeOffThread(run) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./run-check-worker.mjs', import.meta.url), { workerData: { seed: run.seed, version: run.version, data: run.data, score: run.score, metres: run.metres } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error('replay worker exited ' + code)));
  });
}

const busy = new Set(); // one check at a time per player

export function runCheckRoute(app, db, log) {
  app.use('/run-check', async (req, res) => {
    // Any page may ask (the token in the body is the credential; no cookies).
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).end();
    const run = await readJson(req);
    const valid = run && typeof run.token === 'string' && typeof run.key === 'string' && run.key.length > 0 && run.key.length <= 128 &&
      typeof run.data === 'string' && Number.isInteger(run.seed) && Number.isInteger(run.score) && Number.isInteger(run.metres) && Number.isInteger(run.version);
    if (!valid) return res.status(400).json({ error: 'bad run' });
    const user = await db.user(run.token).catch(() => null);
    if (!user) return res.status(401).json({ error: 'sign in' });
    if (busy.has(user.id)) return res.status(429).json({ error: 'busy' });
    busy.add(user.id);
    try {
      const v = await judgeOffThread(run);
      const stored = await db.rpc('avalanche_run_check', {
        p_user: user.id, p_key: run.key, p_score: run.score, p_metres: run.metres, p_seed: run.seed >>> 0,
        p_ok: v.ok, p_reason: v.reason || '', p_scripted: v.scripted,
      });
      log('run check', user.name, run.score, v.ok ? 'ok' : v.reason + (v.score != null ? ' (replay ' + v.score + ')' : ''), v.scripted ? 'scripted' : '');
      res.json({ ok: !!stored.ok, reason: stored.reason || null, enforce: !!stored.enforce });
    } catch (err) {
      log('run check failed', err.message);
      res.status(500).json({ error: 'check failed' });
    } finally {
      busy.delete(user.id);
    }
  });
}
