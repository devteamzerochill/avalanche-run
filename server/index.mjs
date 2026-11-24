// Race server. Locally: node index.mjs (needs the local Supabase running: npx
// supabase start in the game folder). On Colyseus Cloud the same file runs
// under PM2 (ecosystem.config.cjs) and listen() hands over to @colyseus/tools.
//
// Settings (environment): PORT (2567), CYCLE_SECONDS (300), LOCK_SECONDS (5),
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY (local stack by default).
import { pathToFileURL } from 'node:url';
import { defineServer, defineRoom, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { CONFIG } from '../src/config.js';
import { EnduranceRoom } from './race-room.mjs';
import { Supabase, supabaseSettings } from './supabase.mjs';

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
    lockMs: (opts.lockSeconds || +process.env.LOCK_SECONDS || 5) * 1000,
    dropTicks: opts.dropTicks || 180, // 3 s without inputs: out
    leadTicks: opts.leadTicks || 60, // inputs may run at most 1 s ahead of server time
    ramp: opts.ramp || CONFIG.race.ramp,
    log: opts.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a)),
  };
  const server = defineServer({
    rooms: { endurance: defineRoom(EnduranceRoom) },
    transport: new WebSocketTransport(),
    greet: false,
  });
  await server.listen(port);
  // One race cycle for the whole game: the room is made here, once, and
  // players only ever join it. This needs exactly one process (see
  // ecosystem.config.cjs); a second process would run a second, separate cycle.
  const [existing] = await matchMaker.query({ name: 'endurance' });
  const room = existing || (await matchMaker.createRoom('endurance', {}));
  return { server, port, roomId: room.roomId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startRaceServer();
  console.log('race server on ws://localhost:' + port);
}
