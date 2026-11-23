// Record mode (?record): a virtual clock for frame-exact video capture.
// Timers, animation frames, performance.now, CSS animations and the audio
// clock (an OfflineAudioContext) all advance exactly one frame per step(),
// however long the capture of each frame takes. Imported first by main.js.
export const RECORD = typeof location !== 'undefined' && new URLSearchParams(location.search).has('record');

if (RECORD) install();

function install() {
  const FPS = +new URLSearchParams(location.search).get('record') || 60;
  const FRAME = 1000 / FPS;
  const AUDIO_SECONDS = 600;
  const realTimeout = window.setTimeout.bind(window);
  let vt = 0;
  let frame = -1;
  let nextId = 1;
  const timers = new Map();
  let raf = [];

  window.setTimeout = (fn, ms, ...a) => {
    const id = nextId++;
    timers.set(id, { fn, at: vt + Math.max(0, +ms || 0), a });
    return id;
  };
  window.setInterval = (fn, ms, ...a) => {
    const id = nextId++;
    const every = Math.max(1, +ms || 0);
    timers.set(id, { fn, at: vt + every, every, a });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (fn) => {
    raf.push(fn);
    return raf.length;
  };
  window.cancelAnimationFrame = () => {};
  performance.now = () => vt;
  // The capture view may be off screen; the page should behave as if it is in front.
  Object.defineProperty(document, 'hidden', { get: () => false });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });

  const runTimers = () => {
    for (let guard = 0; guard < 1000; guard++) {
      let id = -1;
      let best = null;
      for (const [k, t] of timers) if (t.at <= vt && (!best || t.at < best.at)) (best = t), (id = k);
      if (!best) return;
      if (best.every) best.at += best.every;
      else timers.delete(id);
      try {
        typeof best.fn === 'function' ? best.fn(...best.a) : 0;
      } catch (e) {
        console.error('record timer', e);
      }
    }
  };

  // CSS animations and transitions are paused and driven from the virtual clock.
  const anims = new Map();
  const driveAnimations = () => {
    for (const an of document.getAnimations()) {
      let s = anims.get(an);
      if (s == null) {
        s = vt;
        anims.set(an, s);
        an.pause();
      }
      an.currentTime = vt - s;
    }
  };

  // Audio: one long offline render that is suspended at every frame boundary,
  // so ctx.currentTime equals the video clock when the game schedules sound.
  let actx = null;
  let rendering = null;
  const REC = {
    fps: FPS,
    get time() {
      return vt / 1000;
    },
    get frame() {
      return frame;
    },
    script: null,
    audioContext() {
      if (!actx) actx = new OfflineAudioContext(2, 44100 * AUDIO_SECONDS, 44100);
      return actx;
    },
    wait: (ms) => new Promise((r) => realTimeout(r, ms)),
    async step() {
      frame++;
      vt = frame * FRAME;
      if (REC.script) {
        try {
          REC.script(frame, vt / 1000);
        } catch (e) {
          console.error('record script', e);
        }
      }
      runTimers();
      const cbs = raf;
      raf = [];
      for (const cb of cbs) cb(vt);
      driveAnimations();
      if (actx) {
        const t = ((frame + 1) * FRAME) / 1000;
        const p = actx.suspend(t);
        if (!rendering) rendering = actx.startRendering();
        else actx.resume();
        await p;
      }
      return frame;
    },
    // Renders the rest of the audio and returns it as base64 16-bit WAV, cut to `seconds`.
    async finish(seconds) {
      if (!actx) return '';
      actx.resume();
      const buf = await rendering;
      const n = Math.min(buf.length, Math.round(seconds * buf.sampleRate));
      const ch = [buf.getChannelData(0), buf.getChannelData(1)];
      const out = new DataView(new ArrayBuffer(44 + n * 4));
      const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
      str(0, 'RIFF');
      out.setUint32(4, 36 + n * 4, true);
      str(8, 'WAVEfmt ');
      out.setUint32(16, 16, true);
      out.setUint16(20, 1, true);
      out.setUint16(22, 2, true);
      out.setUint32(24, buf.sampleRate, true);
      out.setUint32(28, buf.sampleRate * 4, true);
      out.setUint16(32, 4, true);
      out.setUint16(34, 16, true);
      str(36, 'data');
      out.setUint32(40, n * 4, true);
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[0][i]), Math.abs(ch[1][i]));
      const gain = peak > 0.98 ? 0.98 / peak : 1;
      for (let i = 0; i < n; i++) {
        out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, ch[0][i] * gain)) * 32767, true);
        out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, ch[1][i] * gain)) * 32767, true);
      }
      const bytes = new Uint8Array(out.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      REC.wav = btoa(bin);
      return REC.wav.length;
    },
    chunk(i, size) {
      return REC.wav.slice(i * size, (i + 1) * size);
    },
  };
  window.__REC = REC;
}
