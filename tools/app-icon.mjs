// Writes the app icon and splash PNGs (tools/app-icon.js) into the Android
// project and mobile/store/. Needs Chrome and the dev server on port 8124:
//   node tools/serve.mjs 8124   then   node tools/app-icon.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const res = path.join(root, 'mobile/android/app/src/main/res');
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
  const art = await run(`import('/tools/app-icon.js').then(async (m) => { await document.fonts.ready; return m.makeArt(__GAME.game); })`);
  for (const [name, url] of Object.entries(art)) {
    const file = name.startsWith('store/') ? path.join(root, 'mobile', name) : path.join(res, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  }
  console.log(`wrote ${Object.keys(art).length} images`);
  ws.close();
} finally {
  proc.kill();
}
