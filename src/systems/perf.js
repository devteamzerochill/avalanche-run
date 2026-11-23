// Performance probe: an on-screen readout (?fps) and a scripted benchmark
// (?bench) that plays a bot run in real time and reports frame statistics.
// Results are shown on screen and, when the page is served by tools/bench.py,
// posted back to it so runs from different browsers can be compared.

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

  // Bench: wait for warm-up, record `seconds` of a bot run, report.
  async runBench(seconds) {
    const g = this.game;
    this.status = 'bench: warming up';
    await new Promise((r) => setTimeout(r, 1500));
    g.botOn = true;
    g.play();
    await new Promise((r) => setTimeout(r, 4500));
    this.frames.length = 0;
    this.cpu.length = 0;
    for (const k of Object.keys(this.parts)) this.parts[k].length = 0;
    this.recording = true;
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      this.status = `bench: recording ${((performance.now() - t0) / 1000).toFixed(0)}/${seconds} s`;
      await new Promise((r) => setTimeout(r, 250));
      if (g.state === 'end' || g.sim.phase !== 'ride') {
        g.play(true);
        await new Promise((r) => setTimeout(r, 3500));
      }
    }
    this.recording = false;
    const f = stats(this.frames);
    const result = {
      browser: browserName(),
      ua: navigator.userAgent,
      screen: `${g.stage.width}x${g.stage.height} @${(window.devicePixelRatio || 1).toFixed(2)}`,
      pixelRatio: +g.stage.renderer.getPixelRatio().toFixed(2),
      quality: g.qualityName(),
      seconds,
      fps: +(1000 / f.avg).toFixed(1),
      frameMs: { avg: +f.avg.toFixed(2), p50: +f.p50.toFixed(2), p95: +f.p95.toFixed(2), p99: +f.p99.toFixed(2), max: +f.max.toFixed(1) },
      longFrames: this.frames.filter((v) => v > 25).length,
      scriptMs: (() => {
        const c = stats(this.cpu);
        return { avg: +c.avg.toFixed(2), p95: +c.p95.toFixed(2) };
      })(),
      partsAvgMs: Object.fromEntries(Object.entries(this.parts).map(([k, v]) => [k, +stats(v).avg.toFixed(2)])),
      gl: (() => {
        const gl = g.stage.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })(),
    };
    this.status = `bench: ${result.fps} fps avg, p95 ${result.frameMs.p95} ms, ${result.longFrames} long`;
    window.__BENCH = result;
    try {
      await fetch('/bench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    } catch (err) {
      /* not served by tools/bench.py */
    }
    return result;
  }
}
