// App icon and splash art, drawn from the game's own fox (DECISIONS 80).
// Runs inside the game page (/index.html?portrait): tools/app-icon.mjs loads it
// with headless Chrome and writes the PNGs into the Android project.
// The fox is rendered twice, on black and on white, and the two are compared to
// get clean transparent edges; the sky, peaks and avalanche are painted here.
import * as THREE from 'three';
import { RIDERS, BOARDS } from '../src/config.js';

const NAVY = '#0c1c35'; // the game's loading screen (#loader)

// The fox alone, front-on, as transparent pixels.
function renderFox(game, w, h) {
  const s = game.stage, r = game.rider, R = s.renderer, sc = s.scene;
  r.setSkin(RIDERS[0], BOARDS[0]);
  const path = new Set();
  for (let o = r.root; o; o = o.parent) path.add(o);
  const hidden = [];
  for (const a of path) for (const o of a.children) {
    if (path.has(o) || o.isLight || a === r.root || !o.visible) continue;
    o.visible = false;
    hidden.push(o);
  }
  const keep = { bg: sc.background, fog: sc.fog, rot: r.root.rotation.y, pr: R.getPixelRatio() };
  sc.fog = null;
  r.root.rotation.y = keep.rot + 0.9; // the idle pose looks off to one side
  r.root.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(30, w / h, 0.1, 50);
  cam.position.set(2.75, 2.0, -1.45);
  cam.lookAt(0.09, 1.55, -0.36);
  R.setPixelRatio(1);
  R.setSize(w, h, false);
  const grab = (col) => {
    sc.background = new THREE.Color(col);
    R.render(sc, cam);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.drawImage(R.domElement, 0, 0);
    return x.getImageData(0, 0, w, h).data;
  };
  const B = grab(0x000000), W = grab(0xffffff);
  for (const o of hidden) o.visible = true;
  sc.background = keep.bg;
  sc.fog = keep.fog;
  r.root.rotation.y = keep.rot;
  R.setPixelRatio(keep.pr);
  R.setSize(s.width, s.height, false);
  const out = new ImageData(w, h);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = Math.max(0, Math.min(255, 255 - (W[i] - B[i] + W[i + 1] - B[i + 1] + W[i + 2] - B[i + 2]) / 3));
    out.data[i + 3] = a;
    if (a) for (let k = 0; k < 3; k++) out.data[i + k] = Math.min(255, (B[i + k] * 255) / a);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  // Find the head: the top of the figure down to the chin is about 40% of the
  // way to the bottom of the render; its box sets where the fox sits in the icon.
  let top = h, left = w, right = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out.data[(y * w + x) * 4 + 3] > 40) { top = Math.min(top, y); break; }
  const chin = top + (h - top) * 0.42;
  for (let y = top; y < chin; y++) for (let x = 0; x < w; x++) if (out.data[(y * w + x) * 4 + 3] > 40) { left = Math.min(left, x); right = Math.max(right, x); }
  c.head = { top: top / w, cx: (left + right) / 2 / w, width: (right - left) / w };
  return c;
}

// A seeded random so the painting is the same every run.
function rand(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// Sky, low-poly peaks and the avalanche cloud, on a unit square scaled to `size`.
// `pad` widens the view for Android's adaptive layer (108 dp around a 72 dp view).
function paintBackground(x, size, pad = 1) {
  x.save();
  x.translate(size / 2, size / 2);
  x.scale(size / pad, size / pad);
  x.translate(-0.5, -0.5);
  const L = -(pad - 1) / 2, H = 1 + (pad - 1) / 2; // edges of the padded square
  const sky = x.createLinearGradient(0, L, 0, 0.75);
  sky.addColorStop(0, '#1f6fd1');
  sky.addColorStop(0.6, '#5fb4f2');
  sky.addColorStop(1, '#bfe6ff');
  x.fillStyle = sky;
  x.fillRect(L, L, H - L, H - L);
  // Peaks: each a lit face and a shaded face, with a snow cap.
  const peak = (cx, top, half, base, lit, dark) => {
    x.fillStyle = lit;
    x.beginPath();
    x.moveTo(cx, top);
    x.lineTo(cx - half, base);
    x.lineTo(cx + half * 0.1, base);
    x.closePath();
    x.fill();
    x.fillStyle = dark;
    x.beginPath();
    x.moveTo(cx, top);
    x.lineTo(cx + half * 0.1, base);
    x.lineTo(cx + half, base);
    x.closePath();
    x.fill();
    const k = 0.32; // snow line
    x.fillStyle = '#ffffff';
    x.beginPath();
    x.moveTo(cx, top);
    x.lineTo(cx - half * k, top + (base - top) * k);
    x.lineTo(cx - half * k * 0.35, top + (base - top) * k * 0.78);
    x.lineTo(cx + half * k * 0.05, top + (base - top) * k * 1.05);
    x.lineTo(cx + half * k * 0.1, top + (base - top) * k * 0.8);
    x.closePath();
    x.fill();
    x.fillStyle = '#d6e9f8';
    x.beginPath();
    x.moveTo(cx, top);
    x.lineTo(cx + half * k * 0.1, top + (base - top) * k * 0.8);
    x.lineTo(cx + half * k * 0.5, top + (base - top) * k * 0.95);
    x.lineTo(cx + half * k, top + (base - top) * k);
    x.closePath();
    x.fill();
  };
  peak(0.12, 0.3, 0.42, 0.85, '#7fb2e6', '#4d82c4');
  peak(0.9, 0.24, 0.45, 0.85, '#7fb2e6', '#4d82c4');
  peak(0.5, 0.12, 0.5, 0.9, '#a9cdf0', '#6c9fd8');
  // The avalanche: a bank of snow billows rolling in along the bottom.
  const rnd = rand(7);
  const puffs = [];
  for (let i = 0; i < 26; i++) {
    const u = rnd();
    puffs.push([L + u * (H - L), 0.78 + rnd() * 0.12 + Math.abs(u - 0.5) * -0.18, 0.09 + rnd() * 0.1]);
  }
  puffs.sort((a, b) => a[1] - b[1]);
  for (const [px, py, pr] of puffs) {
    const g = x.createRadialGradient(px - pr * 0.3, py - pr * 0.4, pr * 0.1, px, py, pr);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.7, '#eef6fd');
    g.addColorStop(1, '#bcd6ef');
    x.fillStyle = g;
    x.beginPath();
    x.arc(px, py, pr, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = '#f4f9ff';
  x.fillRect(L, 0.93, H - L, H - 0.93);
  // Flying snow.
  x.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 40; i++) {
    x.beginPath();
    x.arc(L + rnd() * (H - L), L + rnd() * (0.8 - L), 0.003 + rnd() * 0.006, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

// The fox placed on a unit square: head and shoulders, ears near the top.
// The head is sized to `width` of the view and its ear tips sit at `top`.
function paintFox(x, fox, size, pad = 1, width = 0.74, top = 0.06) {
  const view = size / pad, f = (view * width) / fox.head.width;
  const ox = (size - view) / 2;
  x.drawImage(fox, ox + view / 2 - fox.head.cx * f, ox + view * top - fox.head.top * f, f, f);
}

const canvas = (w, h = w) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// Everything the Android and iOS projects need: PNG data URLs keyed by path
// (Android res/, store/, ios/), and for the iOS icon raw RGB pixels, because
// Apple refuses an icon with an alpha channel and canvas PNGs always have one.
export function makeArt(game) {
  const fox = renderFox(game, 1024, 1024);
  const out = {};
  const png = (c) => c.toDataURL('image/png');
  // Full square icon (Play Store, legacy launchers).
  const full = (n, round) => {
    const c = canvas(n), x = c.getContext('2d');
    if (round) {
      x.beginPath();
      x.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2);
      x.clip();
    }
    paintBackground(x, n);
    paintFox(x, fox, n);
    return c;
  };
  out['store/icon-512.png'] = png(full(512));
  out['store/icon-1024.png'] = png(full(1024));
  // Adaptive layers are 108 dp; the launcher shows the middle 72 dp and may crop
  // to a circle, so the fox is drawn a little smaller there.
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const legacy = Math.round(48 * k), layer = Math.round(108 * k);
    out[`mipmap-${d}/ic_launcher.png`] = png(full(legacy));
    out[`mipmap-${d}/ic_launcher_round.png`] = png(full(legacy, true));
    const fg = canvas(layer);
    paintFox(fg.getContext('2d'), fox, layer, 1.5, 0.62, 0.17);
    out[`mipmap-${d}/ic_launcher_foreground.png`] = png(fg);
    const bg = canvas(layer);
    paintBackground(bg.getContext('2d'), layer, 1.5);
    out[`mipmap-${d}/ic_launcher_background.png`] = png(bg);
  }
  // Splash (Android 11 and older, and behind the Android 12+ system splash):
  // the game's navy with the round icon, matching the Loading screen after it.
  const splash = (w, h, name, k = 0.42) => {
    const c = canvas(w, h), x = c.getContext('2d');
    x.fillStyle = NAVY;
    x.fillRect(0, 0, w, h);
    const n = Math.round(Math.min(w, h) * k);
    x.drawImage(full(n, true), (w - n) / 2, (h - n) / 2 - n * 0.12);
    x.fillStyle = '#ffffff';
    x.textAlign = 'center';
    x.font = `italic 900 ${Math.round(n * 0.17)}px ${getComputedStyle(document.body).fontFamily}`;
    x.fillText('AVALANCHE RUN', w / 2, (h + n) / 2 + n * 0.14);
    out[name] = png(c);
  };
  const port = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
  for (const [d, [w, h]] of Object.entries(port)) {
    splash(w, h, `drawable-port-${d}/splash.png`);
    splash(h, w, `drawable-land-${d}/splash.png`);
  }
  splash(480, 320, 'drawable/splash.png');
  // iOS: one 2732 px square, cropped to fill the screen, so the art stays small
  // in the middle where every iPhone and iPad shape keeps it.
  splash(2732, 2732, 'ios/splash-2732x2732.png', 0.2);
  const icon = full(1024).getContext('2d').getImageData(0, 0, 1024, 1024).data;
  const rgb = new Uint8Array(1024 * 1024 * 3);
  for (let i = 0, j = 0; i < icon.length; i += 4) (rgb[j++] = icon[i]), (rgb[j++] = icon[i + 1]), (rgb[j++] = icon[i + 2]);
  let bin = '';
  for (let i = 0; i < rgb.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
  out['ios/AppIcon-512@2x.png'] = { rgb: btoa(bin), w: 1024, h: 1024 };
  return out;
}
