// Performance probe: an on-screen readout (?fps) and a scripted benchmark
// (?bench) that plays a bot run in real time and reports frame statistics.
// Results are shown on screen and posted to the race server's /bench
// (server/bench.mjs), so a report from a player's own phone reaches us without
// a cable (DECISIONS 94).
import { benchUrl } from './race.js';
import { setInk } from '../render/props.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(list) {
  const a = list.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0;
  const sum = a.reduce((s, v) => s + v, 0);
  return { n: a.length, avg: sum / Math.max(1, a.length), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: a[a.length - 1] || 0 };
}

function browserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chromium';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

export class Perf {
  constructor(game, opts) {
    this.game = game;
    this.show = opts.show;
    this.bench = opts.bench;
    this.frames = []; // ms between frames
    this.cpu = []; // ms of script time per frame
    this.parts = { sim: [], world: [], render: [], mirror: [] };
    this.cur = {};
    this.el = null;
    if (this.show || this.bench) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:20;font:600 11px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.72);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
      this.el = el;
    }
    this.lastShow = 0;
  }

  mark(name) {
    this.cur[name] = performance.now();
  }

  span(name, from) {
    const t = performance.now() - this.cur[from];
    if (this.recording) this.parts[name].push(t);
    return t;
  }

  frame(rawMs, cpuMs) {
    if (this.recording) {
      this.frames.push(rawMs);
      this.cpu.push(cpuMs);
    }
    if (this.el && performance.now() - this.lastShow > 250) {
      this.lastShow = performance.now();
      const g = this.game;
      const r = g.stage.renderer;
      this.el.textContent =
        `${browserName()}  ${g.fps.toFixed(0)} fps  ${g.frameMs.toFixed(1)} ms\n` +
        `script ${cpuMs.toFixed(1)} ms  calls ${r.info.render.calls}  tris ${(r.info.render.triangles / 1000).toFixed(0)}k\n` +
        `quality ${g.qualityName()}  dpr ${r.getPixelRatio().toFixed(2)}  ${g.stage.width}x${g.stage.height}` +
        (this.status ? '\n' + this.status : '');
    }
  }

  async startBot() {
    const g = this.game;
    this.status = 'bench: warming up';
    await wait(1500);
    g.botOn = true;
    g.play();
    await wait(4500);
  }

  // Records `seconds` of the bot riding (restarting it after a crash, which
  // isn't recorded) and returns the frame times.
  async record(seconds, label) {
    const g = this.game;
    this.frames.length = 0;
    this.cpu.length = 0;
    for (const k of Object.keys(this.parts)) this.parts[k].length = 0;
    this.recording = true;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      this.status = `bench: ${label} ${((performance.now() - t0) / 1000).toFixed(0)}/${seconds} s`;
      await wait(250);
      if (g.state === 'end' || g.sim.phase !== 'ride') {
        this.recording = false;
        g.play(true);
        await wait(3500);
        this.recording = true;
      }
    }
    this.recording = false;
    return stats(this.frames);
  }

  async send(result) {
    window.__BENCH = result;
    try {
      const res = await fetch(benchUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result), signal: AbortSignal.timeout(10000) });
      this.status += res.ok ? '\nreport sent' : '\nreport not sent (' + res.status + ')';
    } catch (err) {
      this.status += '\nreport not sent (offline?)';
    }
  }

  // ?bench=parts: the same bot run measured again and again at high quality,
  // each time with one part of the picture switched off, so the part that costs
  // the frames on a slow phone shows up as the jump in fps (DECISIONS 95).
  async runParts(seconds = 7) {
    const g = this.game;
    const st = g.stage;
    const hullOf = (m) => st.world.children.find((c) => c !== m && c.instanceMatrix && c.instanceMatrix === m.instanceMatrix);
    const app = [...document.querySelectorAll('#app > *')].filter((el) => el.id !== 'game');
    const hideEls = (els) => ({ on: () => els.forEach((el) => (el.style.visibility = 'hidden')), off: () => els.forEach((el) => (el.style.visibility = '')) });
    const byId = (id) => document.getElementById(id);
    // The title screen as it was before DECISIONS 96: faded out but still painted, its animations running.
    const old = document.createElement('style');
    old.textContent = '#title.bench-old,#title.bench-old *{visibility:visible!important;animation-play-state:running!important}';
    // Each variant: objects hidden from the main camera, or a setup step and its undo.
    // `high` runs first and last: the gap between the two is how much the phone slowed as it warmed up.
    const variants = [
      { name: 'high' },
      { name: 'title-as-before', on: () => (document.head.appendChild(old), byId('title').classList.add('bench-old')), off: () => (byId('title').classList.remove('bench-old'), old.remove()) },
      { name: 'no-ui', ...hideEls(app) },
      { name: 'no-hud', ...hideEls([byId('hud')]) },
      { name: 'no-speedfx', ...hideEls([byId('speedfx')]) },
      { name: 'no-css-filters', on: () => document.body.classList.add('q-low'), off: () => document.body.classList.remove('q-low') },
      { name: 'no-ink', on: () => setInk(false), off: () => setInk(true) },
      { name: 'no-terrain', hide: () => [st.terrain.mesh] },
      { name: 'no-scenery', hide: () => [g.props.group] },
      { name: 'no-avalanche', hide: () => [g.avalanche.wall, g.avalanche.chunks, hullOf(g.avalanche.chunks)] },
      { name: 'no-particles', hide: () => [g.particles.points, g.snowfall.points, g.trail.mesh, g.speedTrail.mesh] },
      { name: 'no-sky', hide: () => [st.sky, st.backdrop] },
      { name: 'no-rider', hide: () => [g.rider.root, g.shadow] },
      { name: 'empty-scene', hide: () => [st.world, st.sky, st.backdrop] },
      { name: 'no-draw', skip: true },
      { name: 'quarter-res', on: () => st.resize(0.25), off: () => st.resize(1) },
      { name: 'low', on: () => g.setQuality(0), off: () => g.setQuality(2) },
      { name: 'high-again' },
    ];
    const auto = g.q.auto;
    g.q.auto = false;
    g.setQuality(2);
    const render = st.render;
    let hidden = [];
    let skip = false;
    let calls = 0;
    let tris = 0;
    let n = 0;
    st.render = (t) => {
      if (skip) return;
      const was = hidden.map((o) => o.visible);
      hidden.forEach((o) => (o.visible = false));
      render.call(st, t);
      hidden.forEach((o, i) => (o.visible = was[i]));
      if (this.recording) {
        calls += st.renderer.info.render.calls;
        tris += st.renderer.info.render.triangles;
        n++;
      }
    };
    await this.startBot();
    const results = [];
    for (const v of variants) {
      if (v.on) v.on();
      hidden = v.hide ? v.hide().filter(Boolean) : [];
      skip = !!v.skip;
      calls = tris = n = 0;
      await wait(500); // let the change settle before measuring
      const f = await this.record(seconds, v.name);
      results.push({
        name: v.name,
        fps: +(1000 / f.avg).toFixed(1),
        p50: +f.p50.toFixed(1),
        p95: +f.p95.toFixed(1),
        calls: n ? Math.round(calls / n) : 0,
        ktris: n ? +(tris / n / 1000).toFixed(1) : 0,
      });
      if (v.off) v.off();
      hidden = [];
      skip = false;
    }
    st.render = render;
    g.q.auto = auto;
    const result = { kind: 'parts', ...this.device(), seconds, variants: results };
    this.status = 'bench: ' + results.map((r) => `${r.name} ${r.fps}`).join(', ');
    await this.send(result);
    return result;
  }

  device() {
    const g = this.game;
    const gl = g.stage.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      browser: browserName(),
      ua: navigator.userAgent,
      screen: `${g.stage.width}x${g.stage.height} @${(window.devicePixelRatio || 1).toFixed(2)}`,
      gl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      // Safari can hold a page at 30 fps (Low Power Mode, or a frame from another site), which looks like a slow phone.
      framed: window.self !== window.top,
      page: location.host + location.pathname + ' ' + [...new URLSearchParams(location.search).keys()].join('&'), // flag names only, never values
    };
  }

  // Bench: wait for warm-up, record `seconds` of a bot run, report.
  async runBench(seconds) {
    const g = this.game;
    await this.startBot();
    const f = await this.record(seconds, 'recording');
    const c = stats(this.cpu);
    const result = {
      ...this.device(),
      pixelRatio: +g.stage.renderer.getPixelRatio().toFixed(2),
      quality: g.qualityName(),
      seconds,
      fps: +(1000 / f.avg).toFixed(1),
      frameMs: { avg: +f.avg.toFixed(2), p50: +f.p50.toFixed(2), p95: +f.p95.toFixed(2), p99: +f.p99.toFixed(2), max: +f.max.toFixed(1) },
      longFrames: this.frames.filter((v) => v > 25).length,
      scriptMs: { avg: +c.avg.toFixed(2), p95: +c.p95.toFixed(2) },
      partsAvgMs: Object.fromEntries(Object.entries(this.parts).map(([k, v]) => [k, +stats(v).avg.toFixed(2)])),
    };
    this.status = `bench: ${result.fps} fps avg, p95 ${result.frameMs.p95} ms, ${result.longFrames} long`;
    await this.send(result);
    return result;
  }
}
