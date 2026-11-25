// Writes the app icon and splash PNGs (tools/app-icon.js) into the Android and
// iOS projects and mobile/store/. Needs Chrome and the dev server on port 8124:
//   node tools/serve.mjs 8124   then   node tools/app-icon.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const res = path.join(root, 'mobile/android/app/src/main/res');
const ios = path.join(root, 'mobile/ios/App/App/Assets.xcassets');

// A plain RGB PNG (no alpha channel) from raw pixels.
function rgbPng(rgb, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(rows, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const port = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-chrome-'));
const proc = spawn(chrome, ['--headless=new', '--enable-unsafe-swiftshader', '--window-size=450,800', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'http://localhost:8124/index.html?portrait']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let tab;
  for (let i = 0; i < 50 && !tab; i++) {
    await sleep(300);
    tab = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const run = (expression) => new Promise((resolve) => {
    const me = ++id;
    ws.addEventListener('message', function on(e) {
      const m = JSON.parse(e.data);
      if (m.id !== me) return;
      ws.removeEventListener('message', on);
      resolve(m.result.result.value);
    });
    ws.send(JSON.stringify({ id: me, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  for (let i = 0; i < 60 && !(await run('!!(window.__GAME && __GAME.game && __GAME.game.state === "title")')); i++) await sleep(500);
  await sleep(1500); // let the title pose settle
  const names = await run(`import('/tools/app-icon.js').then(async (m) => { await document.fonts.ready; window.__art = m.makeArt(__GAME.game); return Object.keys(window.__art); })`);
  const art = {};
  // Big strings come over in slices; one large DevTools reply never arrives.
  const text = async (expr) => {
    const len = await run(`(${expr}).length`);
    let str = '';
    for (let i = 0; i < len; i += 256 * 1024) str += await run(`(${expr}).slice(${i}, ${i + 256 * 1024})`);
    return str;
  };
  for (const n of names) {
    const key = `window.__art[${JSON.stringify(n)}]`;
    art[n] = (await run(`typeof ${key}`)) === 'string' ? await text(key) : { rgb: await text(key + '.rgb'), w: await run(key + '.w'), h: await run(key + '.h') };
  }
  const iosFile = { 'ios/AppIcon-512@2x.png': 'AppIcon.appiconset/AppIcon-512@2x.png', 'ios/splash-2732x2732.png': 'Splash.imageset/splash-2732x2732.png' };
  for (const [name, v] of Object.entries(art)) {
    const file = name.startsWith('store/') ? path.join(root, 'mobile', name) : name.startsWith('ios/') ? path.join(ios, iosFile[name]) : path.join(res, name);
    const bytes = typeof v === 'string' ? Buffer.from(v.split(',')[1], 'base64') : rgbPng(Buffer.from(v.rgb, 'base64'), v.w, v.h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    // The iOS launch image set lists the same picture at 1x, 2x and 3x.
    if (name === 'ios/splash-2732x2732.png') for (const k of ['-1', '-2']) fs.writeFileSync(file.replace('.png', k + '.png'), bytes);
  }
  console.log(`wrote ${Object.keys(art).length} images`);
  ws.close();
} finally {
  proc.kill();
}
