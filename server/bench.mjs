// Benchmark reports from players' own phones (?bench, src/systems/perf.js), so
// a slow device can be measured without a cable to this PC. Owner's choice
// (2026-11-27): kept in memory only, the last 50, so a redeploy wipes them and
// nothing about a player is stored for good. No IP address is kept; it is used
// only to limit how often one address may post.
import { readJson } from './run-check.mjs';

const KEEP = 50;
const MAX_BODY = 16 * 1024; // a report is under 2 KB
const PER_HOUR = 20;

const reports = [];
const recent = new Map(); // address -> post times in the last hour

function allowed(addr, now) {
  const times = (recent.get(addr) || []).filter((t) => now - t < 3600e3);
  if (times.length >= PER_HOUR) return false;
  times.push(now);
  recent.set(addr, times);
  if (recent.size > 1000) for (const [k, v] of recent) if (!v.some((t) => now - t < 3600e3)) recent.delete(k);
  return true;
}

export function benchRoute(app, log) {
  app.use('/bench', async (req, res) => {
    // Any page may post: the web build, the zerochill.com frame and the phone apps all have different origins.
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method === 'GET') return res.json(reports);
    if (req.method !== 'POST') return res.status(405).end();
    const now = Date.now();
    const addr = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowed(addr, now)) return res.status(429).json({ error: 'too many' });
    const r = await readJson(req, MAX_BODY);
    // A single run has an fps; a ?bench=parts run has one per variant.
    const parts = r && Array.isArray(r.variants) && r.variants.length > 0 && r.variants.every((v) => v && typeof v.fps === 'number');
    if (!r || typeof r !== 'object' || Array.isArray(r) || (typeof r.fps !== 'number' && !parts)) return res.status(400).json({ error: 'bad report' });
    reports.unshift({ at: new Date(now).toISOString(), ...r });
    reports.length = Math.min(reports.length, KEEP);
    log('bench report', r.browser, parts ? r.variants.length + ' variants' : r.fps + ' fps', r.quality || '');
    res.json({ ok: true });
  });
}
