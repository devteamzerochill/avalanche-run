// Audio: the prototype's samples plus synthesised effects, on two buses
// (music, effects) with separate volumes.
import { CONFIG } from '../config.js';
import { AUDIO_FILES, loadAudioBytes } from './assets.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.loops = {};
    this.musicVol = 0.6;
    this.sfxVol = 0.8;
    this.muted = false;
    this.started = false;
    this.lastPlay = {};
    this.log = []; // names of the last sounds, for tests
    this.chip = new Chiptune(this);
    this.ride = false;
  }

  // Must be called from a user gesture.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.offline) this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    // Record mode renders offline, locked to the video clock.
    this.offline = !!window.__REC;
    if (!AC && !this.offline) return;
    const ctx = this.offline ? window.__REC.audioContext() : new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.music = ctx.createGain();
    this.music.connect(this.musicFilter);
    this.musicFilter.connect(this.master);
    this.applyVolumes();
    this.noise = this.makeNoise();
    this.started = true;
    for (const name of AUDIO_FILES) this.load(name);
    if (this.ride) this.chip.start();
  }

  async load(name) {
    try {
      const bytes = await loadAudioBytes(name);
      const buf = await new Promise((res, rej) => this.ctx.decodeAudioData(bytes, res, rej));
      this.buffers[name] = buf;
      if (this.started && (name === 'music' || name === 'ambience' || name === 'rumble')) this.startLoop(name);
    } catch (err) {
      console.warn('audio load failed', name, err && err.message);
    }
  }

  makeNoise() {
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, len);
    const data = buf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) | 0;
      data[i] = (seed >>> 0) / 2147483648 - 1;
    }
    return buf;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.03);
    this.sfx.gain.setTargetAtTime(this.sfxVol * (CONFIG.audio.sfxVolume / 0.3) * 0.55, now, 0.03);
    this.music.gain.setTargetAtTime(this.musicVol * (CONFIG.audio.musicVolume / 0.2) * 0.42, now, 0.05);
  }

  duck(on) {
    if (!this.ctx) return;
    const base = this.musicVol * (CONFIG.audio.musicVolume / 0.2) * 0.42;
    this.music.gain.setTargetAtTime(on ? base * 0.4 : base, this.ctx.currentTime, on ? 0.05 : 0.25);
  }

  setVolumes(music, sfx) {
    this.musicVol = music;
    this.sfxVol = sfx;
    this.applyVolumes();
  }

  setMuted(m) {
    this.muted = m;
    this.applyVolumes();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running' && !this.offline) this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended' && !this.offline) this.ctx.resume();
  }

  startLoop(name) {
    if (!this.ctx || this.loops[name] || !this.buffers[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = name === 'music' && !this.ride ? 1 : 0;
    src.connect(gain);
    gain.connect(name === 'music' ? this.music : this.sfx);
    src.start();
    this.loops[name] = { src, gain };
  }

  // Called when a run starts.
  // The chiptune plays during a ride; the sampled track plays on menus.
  setRide(on) {
    this.ride = on;
    if (!this.ctx) return;
    if (on) this.chip.start();
    else this.chip.stop();
    if (this.loops.music) this.loops.music.gain.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.2);
  }

  startRun() {
    this.started = true;
    this.startLoop('music');
    this.startLoop('ambience');
    this.startLoop('rumble');
  }

  // Per-frame mix: wind with speed, rumble with danger, music filter in slow motion.
  mix(speed01, danger, slow, riding, boost) {
    if (!this.ctx) return;
    this.chip.energy = speed01;
    this.chip.boost = boost || 0;
    const now = this.ctx.currentTime;
    if (this.loops.ambience) this.loops.ambience.gain.gain.setTargetAtTime(riding ? 0.25 + 0.75 * speed01 : 0.12, now, 0.2);
    if (this.loops.rumble) {
      const r = Math.max(0, Math.min(1, (danger - 0.25) / 0.6));
      this.loops.rumble.gain.gain.setTargetAtTime(riding ? r * 1.6 : 0, now, 0.25);
    }
    if (this.loops.music) this.loops.music.src.playbackRate.setTargetAtTime(slow ? 0.82 : 1, now, 0.08);
    this.musicFilter.frequency.setTargetAtTime(slow ? 900 : riding ? 18000 : 5000, now, 0.08);
  }

  play(name, opts) {
    this.log.push(name);
    if (this.log.length > 40) this.log.shift();
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const o = opts || {};
    const minGap = o.minGap == null ? 0.03 : o.minGap;
    if (this.lastPlay[name] && now - this.lastPlay[name] < minGap) return;
    this.lastPlay[name] = now;
    const buf = this.buffers[name];
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = o.rate || 1;
      const g = this.ctx.createGain();
      g.gain.value = o.vol == null ? 1 : o.vol;
      src.connect(g);
      g.connect(this.sfx);
      src.start();
      return;
    }
    const synth = SYNTH[name];
    if (synth) synth(this, now, o);
  }

  // --- synth helpers ---
  tone(type, f0, f1, t0, dur, vol) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.sfx);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  hiss(f0, f1, t0, dur, vol, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q || 1;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfx);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }
}

const NOTE = (n) => 440 * Math.pow(2, n / 12);
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const SYNTH = {
  tap(a, t) {
    a.tone('triangle', 660, 880, t, 0.07, 0.25);
  },
  flake(a, t, o) {
    // Coin: a bright two-note blip that climbs while you keep a line going.
    const step = SCALE[Math.min(SCALE.length - 1, (o.n || 0) % SCALE.length)];
    a.tone('square', NOTE(10 + step), NOTE(10 + step), t, 0.06, 0.12);
    a.tone('square', NOTE(17 + step), NOTE(17 + step), t + 0.055, 0.16, 0.12);
    a.tone('triangle', NOTE(29 + step), NOTE(29 + step), t + 0.055, 0.1, 0.06);
  },
  jump(a, t) {
    a.tone('square', 260, 700, t, 0.16, 0.13);
  },
  bigjump(a, t) {
    a.tone('square', 220, 1100, t, 0.3, 0.14);
    a.tone('triangle', 330, 1650, t + 0.03, 0.3, 0.1);
  },
  dash(a, t) {
    a.tone('sawtooth', 180, 1400, t, 0.35, 0.16);
    a.tone('square', 360, 2800, t + 0.02, 0.3, 0.07);
    a.hiss(500, 7000, t, 0.5, 0.4, 0.7);
  },
  count(a, t) {
    a.tone('square', NOTE(-2), NOTE(-2), t, 0.16, 0.2);
  },
  go(a, t) {
    a.tone('square', NOTE(10), NOTE(10), t, 0.5, 0.22);
    a.tone('triangle', NOTE(17), NOTE(17), t, 0.5, 0.14);
  },
  panelOpen(a, t) {
    a.tone('triangle', 420, 840, t, 0.1, 0.2);
    a.hiss(1500, 5000, t, 0.12, 0.1, 1.5);
  },
  panelClose(a, t) {
    a.tone('triangle', 840, 420, t, 0.1, 0.18);
  },
  toggle(a, t) {
    a.tone('square', 700, 700, t, 0.04, 0.1);
    a.tone('square', 1050, 1050, t + 0.045, 0.06, 0.1);
  },
  select(a, t) {
    [0, 7].forEach((n, i) => a.tone('triangle', NOTE(7 + n), NOTE(7 + n), t + i * 0.05, 0.12, 0.2));
  },
  buy(a, t) {
    [0, 4, 7, 12, 19].forEach((n, i) => a.tone('square', NOTE(5 + n), NOTE(5 + n), t + i * 0.045, 0.16, 0.12));
  },
  deny(a, t) {
    a.tone('sawtooth', 160, 120, t, 0.14, 0.18);
    a.tone('sawtooth', 150, 110, t + 0.12, 0.16, 0.18);
  },
  start(a, t) {
    a.tone('square', 330, 990, t, 0.18, 0.14);
    a.hiss(800, 6000, t, 0.25, 0.25, 1);
  },
  pause(a, t) {
    a.tone('square', 660, 440, t, 0.09, 0.14);
  },
  resume(a, t) {
    a.tone('square', 440, 660, t, 0.09, 0.14);
  },
  release(a, t) {
    a.tone('triangle', 900, 500, t, 0.07, 0.14);
  },
  window(a, t) {
    a.tone('sine', NOTE(19), NOTE(19), t, 0.09, 0.22);
    a.tone('sine', NOTE(26), NOTE(26), t + 0.03, 0.09, 0.14);
  },
  comboEnd(a, t) {
    a.tone('triangle', 520, 260, t, 0.22, 0.14);
  },
  whoosh(a, t) {
    a.hiss(4000, 600, t, 0.22, 0.45, 1.4);
  },
  archExit(a, t) {
    a.hiss(2500, 500, t, 0.3, 0.3, 1);
  },
  ice(a, t) {
    a.tone('sine', 1900, 2600, t, 0.18, 0.1);
    a.hiss(6000, 9000, t, 0.2, 0.12, 4);
  },
  mogul(a, t) {
    a.tone('sine', 140, 70, t, 0.08, 0.35);
  },
  cliff(a, t) {
    a.tone('sine', 1300, 300, t, 0.5, 0.14);
    a.hiss(700, 2500, t, 0.5, 0.25, 0.8);
  },
  ghost(a, t) {
    a.tone('sine', 660, 1320, t, 0.3, 0.12);
    a.tone('sine', 663, 1326, t + 0.02, 0.3, 0.1);
  },
  mirror(a, t) {
    a.tone('triangle', 880, 880, t, 0.05, 0.12);
  },
  alert(a, t) {
    a.tone('square', 880, 880, t, 0.08, 0.16);
    a.tone('square', 880, 880, t + 0.13, 0.08, 0.16);
  },
  hurry(a, t) {
    a.tone('square', 1040, 1040, t, 0.05, 0.1);
  },
  wall(a, t) {
    a.tone('sine', 110, 60, t, 0.1, 0.4);
    a.hiss(900, 300, t, 0.1, 0.2, 1);
  },
  topSpeed(a, t) {
    [0, 5, 12].forEach((n, i) => a.tone('sawtooth', NOTE(n), NOTE(n + 0.5), t + i * 0.06, 0.2, 0.08));
  },
  buried(a, t) {
    a.tone('sine', 90, 30, t, 1.2, 1);
    a.hiss(1400, 60, t, 1.4, 1, 0.4);
    a.hiss(5000, 400, t, 0.5, 0.5, 0.6);
  },
  tally(a, t) {
    a.tone('square', NOTE(12), NOTE(12), t, 0.035, 0.08);
  },
  newBest(a, t) {
    [0, 4, 7, 12, 7, 12, 16, 24].forEach((n, i) => a.tone('square', NOTE(3 + n), NOTE(3 + n), t + i * 0.085, 0.2, 0.13));
  },
  mission(a, t) {
    [7, 12, 16, 19].forEach((n, i) => a.tone('triangle', NOTE(n), NOTE(n), t + i * 0.07, 0.25, 0.2));
  },
  streak(a, t) {
    [0, 7, 12, 19, 24].forEach((n, i) => a.tone('triangle', NOTE(n), NOTE(n), t + i * 0.06, 0.22, 0.18));
  },
  // Announcer stingers: a crowd roar under big calls, and a horn stab for the biggest.
  crowd(a, t, o) {
    const big = o.big ? 1 : 0;
    a.hiss(500, 1400, t, 1.1 + big * 0.5, 0.32 + big * 0.18, 0.6);
    a.hiss(1400, 2600, t + 0.05, 0.9 + big * 0.4, 0.2 + big * 0.1, 1.2);
    for (let i = 0; i < 3 + big * 3; i++) a.tone('sine', 900 + Math.random() * 900, 1300 + Math.random() * 900, t + 0.05 + Math.random() * 0.5, 0.12, 0.05);
  },
  horn(a, t) {
    [0, 4, 7].forEach((n) => {
      a.tone('sawtooth', NOTE(n - 2), NOTE(n - 2), t, 0.32, 0.09);
      a.tone('square', NOTE(n + 10), NOTE(n + 10), t, 0.28, 0.05);
    });
    [0, 4, 7].forEach((n) => a.tone('sawtooth', NOTE(n + 3), NOTE(n + 3), t + 0.36, 0.5, 0.09));
  },
  hype(a, t) {
    a.tone('square', NOTE(5), NOTE(17), t, 0.12, 0.1);
    a.hiss(1500, 6000, t, 0.25, 0.15, 1.2);
  },
  spark(a, t) {
    a.hiss(3000, 6000, t, 0.12, 0.12, 3);
  },
  grab(a, t) {
    a.tone('square', 300, 520, t, 0.08, 0.1);
    a.hiss(800, 2400, t, 0.18, 0.2, 2);
  },
  perfect(a, t) {
    [0, 4, 7, 12, 16].forEach((n, i) => a.tone('square', NOTE(5 + n), NOTE(5 + n), t + i * 0.05, 0.2, 0.13));
    [0, 4, 7, 12].forEach((n, i) => a.tone('triangle', NOTE(3 + n), NOTE(3 + n), t + i * 0.055, 0.22, 0.28));
  },
  trick(a, t) {
    [0, 7].forEach((n, i) => a.tone('triangle', NOTE(3 + n), NOTE(3 + n), t + i * 0.06, 0.16, 0.22));
  },
  sloppy(a, t) {
    a.tone('sawtooth', 220, 90, t, 0.28, 0.25);
  },
  boost(a, t) {
    a.hiss(300, 5000, t, 0.7, 0.5, 0.8);
    a.tone('sawtooth', 110, 440, t, 0.5, 0.12);
  },
  combo(a, t, o) {
    const n = SCALE[Math.min(SCALE.length - 1, (o.n || 1) + 1)];
    a.tone('square', NOTE(n - 9), NOTE(n - 9), t, 0.1, 0.12);
    a.tone('square', NOTE(n - 2), NOTE(n - 2), t + 0.07, 0.14, 0.12);
  },
  clean(a, t) {
    a.tone('triangle', NOTE(7), NOTE(12), t, 0.12, 0.2);
  },
  milestone(a, t) {
    [0, 4, 7, 12, 16].forEach((n, i) => a.tone('triangle', NOTE(n), NOTE(n), t + i * 0.07, 0.25, 0.22));
  },
  biome(a, t) {
    a.hiss(200, 3000, t, 1.4, 0.35, 0.6);
    [0, 7, 12].forEach((n, i) => a.tone('sine', NOTE(n - 12), NOTE(n - 12), t + i * 0.18, 0.9, 0.18));
  },
  ramp(a, t) {
    a.hiss(500, 4000, t, 0.35, 0.4, 1.2);
  },
  stumble(a, t) {
    a.tone('sawtooth', 160, 60, t, 0.25, 0.3);
    a.hiss(1200, 300, t, 0.25, 0.4, 0.8);
  },
  crash(a, t) {
    a.tone('sine', 120, 35, t, 0.6, 0.9);
    a.hiss(2500, 200, t, 0.7, 0.7, 0.5);
  },
  caught(a, t) {
    a.tone('sine', 70, 28, t, 1.6, 1);
    a.hiss(900, 80, t, 1.8, 1, 0.4);
  },
  win(a, t) {
    [0, 4, 7, 12, 16, 19].forEach((n, i) => a.tone('triangle', NOTE(n), NOTE(n), t + i * 0.09, 0.35, 0.24));
  },
  lose(a, t) {
    [7, 4, 0, -5].forEach((n, i) => a.tone('triangle', NOTE(n - 12), NOTE(n - 12), t + i * 0.16, 0.4, 0.22));
  },
  wind(a, t) {
    a.hiss(400, 1500, t, 1.2, 0.3, 0.7);
  },
};

// Procedural chiptune for the ride: an original four-chord loop built from
// square, triangle and noise voices. Tempo follows speed.
const PROG = [
  [2, 6, 9], // D
  [-3, 1, 4], // A
  [-1, 2, 6], // Bm
  [-5, -1, 2], // G
];
const LEAD = [0, 2, 1, 2, 0, 2, 1, -1, 0, 1, 2, 1, 2, -1, 1, -1];

export class Chiptune {
  constructor(engine) {
    this.a = engine;
    this.on = false;
    this.step = 0;
    this.next = 0;
    this.timer = null;
    this.energy = 0;
    this.boost = 0;
  }

  start() {
    const a = this.a;
    if (this.on || !a.ctx) return;
    this.on = true;
    this.step = 0;
    this.next = a.ctx.currentTime + 0.05;
    this.out = a.ctx.createGain();
    this.out.gain.value = 1.7; // matched to the menu track's loudness, so it carries over wind and carving
    this.out.connect(a.music);
    this.timer = setInterval(() => this.pump(), 60);
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    clearInterval(this.timer);
    const out = this.out;
    out.gain.setTargetAtTime(0, this.a.ctx.currentTime, 0.15);
    setTimeout(() => out.disconnect(), 900);
  }

  voice(type, freq, t, dur, vol) {
    const ctx = this.a.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  drum(kind, t) {
    const ctx = this.a.ctx;
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g);
      g.connect(this.out);
      o.start(t);
      o.stop(t + 0.16);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.a.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = kind === 'hat' ? 7000 : 1800;
    const g = ctx.createGain();
    const dur = kind === 'hat' ? 0.03 : 0.11;
    g.gain.setValueAtTime(kind === 'hat' ? 0.1 : 0.24, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    src.start(t, (this.step * 0.013) % 0.5);
    src.stop(t + dur + 0.02);
  }

  pump() {
    const ctx = this.a.ctx;
    if (!this.on || (ctx.state !== 'running' && !this.a.offline)) {
      if (ctx) this.next = Math.max(this.next, ctx.currentTime + 0.05);
      return;
    }
    const bpm = 146 + 22 * this.energy + 10 * this.boost;
    const s16 = 60 / bpm / 4;
    while (this.next < ctx.currentTime + 0.18) {
      const t = this.next;
      const i = this.step % 64;
      const chord = PROG[Math.floor(i / 16) % 4];
      const k = i % 16;
      const hz = (n) => 220 * Math.pow(2, n / 12);
      // Bass: driving eighths, octave jump on the off-beat.
      if (k % 2 === 0) this.voice('triangle', hz(chord[0] - 12 + (k % 4 === 2 ? 12 : 0)), t, s16 * 1.8, 0.34);
      // Arpeggio.
      this.voice('square', hz(chord[k % 3] + (k % 6 > 2 ? 12 : 0)), t, s16 * 0.9, 0.05 + 0.03 * this.energy);
      // Lead motif, second half of every bar pair louder.
      const l = LEAD[(k + (Math.floor(i / 16) % 2) * 3) % 16];
      if (l >= 0 && k % 2 === 0) this.voice('square', hz(chord[l] + 12), t, s16 * 1.7, 0.085);
      if (this.boost > 0.3) this.voice('sawtooth', hz(chord[(k + 1) % 3] + 24), t, s16 * 0.5, 0.035);
      if (k % 4 === 0) this.drum('kick', t);
      if (k % 8 === 4) this.drum('snare', t);
      if (k % 2 === 1 || this.energy > 0.6) this.drum('hat', t);
      this.next += s16;
      this.step++;
    }
  }
}
