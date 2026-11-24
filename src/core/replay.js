// Input recording. A run is its seed plus one (targetX, flags) pair per tick,
// run-length encoded. Ghosts and Proof of Play re-simulate from this.
import { CONFIG } from '../config.js';
import { Sim } from './sim.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '';
    out += i + 2 < bytes.length ? B64[c & 63] : '';
  }
  return out;
}

function fromBase64(str) {
  const n = Math.floor((str.length * 3) / 4);
  const bytes = new Uint8Array(n);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < str.length; i++) {
    acc = (acc << 6) | B64.indexOf(str[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 255;
    }
  }
  return bytes;
}

// Inputs are quantised before they reach the simulation so that what is
// recorded is exactly what was simulated.
export function quantise(input) {
  return { tx: Math.round(input.tx * 100) / 100, jump: !!input.jump, grab: !!input.grab };
}

export class Recorder {
  constructor() {
    this.runs = []; // [count, txCm, flags]
    this.ticks = 0;
  }

  push(input) {
    const tx = Math.round(input.tx * 100);
    const flags = (input.jump ? 1 : 0) | (input.grab ? 2 : 0);
    const last = this.runs[this.runs.length - 1];
    if (last && last[1] === tx && last[2] === flags && last[0] < 65535) last[0]++;
    else this.runs.push([1, tx, flags]);
    this.ticks++;
  }

  encode() {
    const bytes = new Uint8Array(this.runs.length * 5);
    let o = 0;
    for (const [count, tx, flags] of this.runs) {
      const u = tx & 0xffff;
      bytes[o++] = count & 255;
      bytes[o++] = count >> 8;
      bytes[o++] = u & 255;
      bytes[o++] = u >> 8;
      bytes[o++] = flags;
    }
    return toBase64(bytes);
  }
}

export class Playback {
  constructor(data) {
    const bytes = fromBase64(data || '');
    this.runs = [];
    for (let o = 0; o + 4 < bytes.length; o += 5) {
      let tx = bytes[o + 2] | (bytes[o + 3] << 8);
      if (tx & 0x8000) tx -= 0x10000;
      this.runs.push([bytes[o] | (bytes[o + 1] << 8), tx, bytes[o + 4]]);
    }
    this.i = 0;
    this.left = this.runs.length ? this.runs[0][0] : 0;
    this.input = { tx: 0, jump: false, grab: false };
  }

  get done() {
    return this.i >= this.runs.length;
  }

  next() {
    if (this.done) {
      this.input.jump = false;
      return this.input;
    }
    const r = this.runs[this.i];
    this.input.tx = r[1] / 100;
    this.input.jump = (r[2] & 1) !== 0;
    this.input.grab = (r[2] & 2) !== 0;
    if (--this.left <= 0) {
      this.i++;
      this.left = this.i < this.runs.length ? this.runs[this.i][0] : 0;
    }
    return this.input;
  }
}

// Re-simulate a recorded run. Returns the summary the inputs really produce.
// record.tricks: whether trick points count (the server passes its own value,
// never the player's); otherwise this build's CONFIG.score.tricks.
export function resimulate(record) {
  if (!record || record.version !== CONFIG.version) return null;
  const sim = new Sim(record.seed, { timeCap: record.timeCap || 0 });
  if (typeof record.tricks === 'boolean') sim.tricks = record.tricks;
  const play = new Playback(record.data);
  let guard = 60 * 60 * 30;
  while (sim.phase !== 'over' && guard-- > 0) {
    if (play.done && sim.phase === 'ride') break;
    sim.step(play.next());
  }
  return { summary: sim.summary(), fingerprint: sim.fingerprint() };
}
