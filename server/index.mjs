// Race server. Locally: node index.mjs (needs the local Supabase running: npx
// supabase start in the game folder). On Colyseus Cloud the same file runs
// under PM2 (ecosystem.config.cjs) and listen() hands over to @colyseus/tools.
//
// Settings (environment): PORT (2567), CYCLE_SECONDS (300), LOCK_SECONDS (8),
// SUPABASE_URL / SUPABASE_ANON_KEY, and either RACE_SERVER_EMAIL +
// RACE_SERVER_PASSWORD (the race server's site account) or SUPABASE_SERVICE_KEY
// (local stack by default). Read from server/.env when it exists (never committed).
// SERVE_GAME=1 also serves dist/web/ on the same port, so one tunnel to this
// machine carries both the game and the race (open /?portrait&live&race=here).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineServer, defineRoom, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { CONFIG } from '../src/config.js';
import { EnduranceRoom } from './race-room.mjs';
import { Supabase, supabaseSettings } from './supabase.mjs';

// dist/web/ only: the rest of the project (server/.env included) is never served.
const web = path.resolve(fileURLToPath(new URL('../dist/web/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg', '.json': 'application/json' };
function serveGame(app) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p = decodeURIComponent(req.path);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(web, path.normalize(p));
    if (!file.startsWith(web + path.sep)) return next();
    fs.readFile(file, (err, data) => {
      if (err) return next();
      res.set({ 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.send(data);
    });
  });
}

// --cycle=60 on the command line: a short cycle for local testing.
const arg = (name) => +((process.argv.find((a) => a.startsWith('--' + name + '=')) || '').split('=')[1] || 0);

export async function startRaceServer(opts = {}) {
  const port = opts.port || +process.env.PORT || 2567;
  const settings = supabaseSettings();
  const db = new Supabase(settings);
  // Room options can be copied on the way in, so the settings (with the
  // database client) go through a static field instead.
  EnduranceRoom.settings = {
    db,
    cycleMs: (opts.cycleSeconds || arg('cycle') || +process.env.CYCLE_SECONDS || 300) * 1000,
    lockMs: (opts.lockSeconds || +process.env.LOCK_SECONDS || 8) * 1000, // 8 s: room for the intro (DECISIONS 70)
    dropTicks: opts.dropTicks || 180, // 3 s without inputs: out
    leadTicks: opts.leadTicks || 60, // inputs may run at most 1 s ahead of server time
    ramp: opts.ramp || CONFIG.race.ramp,
    grid: opts.grid || null, // tests: a flat grid keeps riders identical
    log: opts.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a)),
  };
  const server = defineServer({
    rooms: { endurance: defineRoom(EnduranceRoom) },
    transport: new WebSocketTransport(),
    greet: false,
    ...(process.env.SERVE_GAME === '1' ? { express: serveGame } : {}),
  });
  // Colyseus Cloud: its socket behind the proxy, and the 'ready' signal PM2 waits for (wait_ready).
  // Imported only there: @colyseus/tools loads server/.env as it loads, which must never reach the tests.
  if (process.env.COLYSEUS_CLOUD !== undefined) await (await import('@colyseus/tools')).listen(server);
  else await server.listen(port);
  // One race cycle for the whole game: the room is made here, once, and
  // players only ever join it. This needs exactly one process (see
  // ecosystem.config.cjs); a second process would run a second, separate cycle.
  const [existing] = await matchMaker.query({ name: 'endurance' });
  const room = existing || (await matchMaker.createRoom('endurance', {}));
  return { server, port, roomId: room.roomId };
}

// Started directly, or by PM2 (Colyseus Cloud; there argv[1] is PM2's own launcher).
// Tests import this file and must stay on the local stack.
if ((process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) || process.env.pm_id !== undefined) {
  const envFile = fileURLToPath(new URL('.env', import.meta.url));
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const { port } = await startRaceServer();
  console.log('race server on ws://localhost:' + port);
}
