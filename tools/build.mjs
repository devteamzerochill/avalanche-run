// Build script. No dependencies: node tools/build.mjs
//
// Outputs
//   dist/web/                         index.html + game.js + assets/   (normal web build)
//   dist/avalanche-run-playable.html  one self-contained file           (playable ad)
//   dist/avalanche-run.html           one self-contained file           (web player, no ad layer)
//   dist/avalanche-run-artifact.html  the web player without its document skeleton (claude.ai artifact)
//
// The bundler understands the subset of ES modules this project uses:
//   import { a, b as c } from './x.js';   import * as NS from 'three';
//   export const|let|function|class NAME   export { a as b, c };
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ALIAS = { three: 'vendor/three.module.min.js' };

function resolve(from, spec) {
  if (ALIAS[spec]) return ALIAS[spec];
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
}

const modules = new Map(); // file -> {id, code}
const order = [];

function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = { id: '__m' + modules.size, code: '' };
  modules.set(file, mod);
  let src = read(file);
  const vendor = file.startsWith('vendor/');
  const exportsList = [];

  // imports
  src = src.replace(/^\s*import\s+(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"];?/gm, (m, ns, names, spec) => {
    const dep = load(resolve(file, spec));
    if (ns) return `const ${ns} = ${dep.id};`;
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${parts.join(', ')} } = ${dep.id};`;
  });
  // export lists:  export { a as b, c };
  src = src.replace(/export\s*\{([^}]*)\}\s*;?/g, (m, names) => {
    for (const part of names.split(',')) {
      const s = part.trim();
      if (!s) continue;
      const mm = s.split(/\s+as\s+/);
      exportsList.push(mm.length === 2 ? `${mm[1]}: ${mm[0]}` : s);
    }
    return '';
  });
  // export declarations
  if (!vendor) {
    src = src.replace(/^export\s+((?:async\s+)?(?:function\*?|class|const|let|var))\s+([\w$]+)/gm, (m, kw, name) => {
      exportsList.push(name);
      return `${kw} ${name}`;
    });
    if (/^\s*export\s/m.test(src)) throw new Error('unsupported export syntax in ' + file);
    if (/^\s*import\s/m.test(src)) throw new Error('unsupported import syntax in ' + file);
    src = squeeze(src);
  }
  mod.code = `const ${mod.id} = (function () {\n${src}\nreturn { ${exportsList.join(', ')} };\n})();`;
  order.push(mod);
  return mod;
}

// Light, safe minification for our own sources: drop comment lines and indentation.
function squeeze(src) {
  return src
    .replace(/\/\* glsl \*\/ ?/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

function minifyCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, '').replace(/\s*([{};,])\s*/g, '$1').replace(/;}/g, '}');
}

const t0 = Date.now();
load('src/main.js');
const bundle = '(function(){\n"use strict";\n' + order.map((m) => m.code).join('\n') + '\n})();\n';
const css = minifyCss(read('src/ui/style.css'));
const html = read('index.html');
const pkg = JSON.parse(read('package.json'));

function page(styleTag, scriptTags) {
  return html
    .replace(/<!--BUILD:STYLE-->[\s\S]*?<!--\/BUILD:STYLE-->/, () => styleTag)
    .replace(/<!--BUILD:SCRIPT-->[\s\S]*?<!--\/BUILD:SCRIPT-->/, () => scriptTags)
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'web/assets/audio'), { recursive: true });

// --- web build ---
fs.writeFileSync(path.join(dist, 'web/game.js'), bundle);
const gameTag = `<script src="game.js?v=${zlib.crc32 ? zlib.crc32(bundle).toString(36) : bundle.length.toString(36)}"></script>`;
fs.writeFileSync(path.join(dist, 'web/index.html'), page(`<style>${css}</style>`, gameTag));
const audioDir = path.join(root, 'assets/audio');
const audio = fs.readdirSync(audioDir).filter((f) => f.endsWith('.mp3'));
for (const f of audio) fs.copyFileSync(path.join(audioDir, f), path.join(dist, 'web/assets/audio', f));
// The race client loads on demand (src/systems/race.js), from vendor/ next to the page.
fs.mkdirSync(path.join(dist, 'web/vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'vendor/colyseus.js'), path.join(dist, 'web/vendor/colyseus.js'));

// --- phone apps: the web build with window.__APP (live sign-in first, Cloud
// races, a lasting session); the native shell in mobile/ packages dist/app/
// (DECISIONS 75, 79). Android's back button goes to the game first; it exits
// only when the game says so (the second press on the title).
const appBack = `(function(){var A=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.App;if(!A)return;` +
  `A.addListener('backButton',function(){if(!(window.__appBack&&window.__appBack()))A.exitApp();});})();`;
fs.cpSync(path.join(dist, 'web'), path.join(dist, 'app'), { recursive: true });
fs.writeFileSync(path.join(dist, 'app/index.html'), page(`<style>${css}</style>`, `<script>window.__APP=true;window.__PORTRAIT=true;${appBack}</script>
` + gameTag));

// --- single-file playable ---
const assets = {};
for (const f of audio) assets[f.replace('.mp3', '')] = fs.readFileSync(path.join(audioDir, f)).toString('base64');
const adConfig =
  '<script>window.__AD_BUILD=true;window.__NETWORK="universal";window.__STORE=window.__STORE||{"ios":"","android":""};' +
  'window.__PARAMS=window.__PARAMS||{};window.__LANG=window.__LANG||"";</script>';
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const single = page(
  `<style>${css}</style>`,
  `${adConfig}\n<script>window.__ASSETS__=${JSON.stringify(assets)};</script>\n<script>${safe(bundle)}</script>`
);
const singlePath = path.join(dist, 'avalanche-run-playable.html');
fs.writeFileSync(singlePath, single);

// --- single-file web player (no ad layer: no time cap, no store button) ---
const player = page(
  `<style>${css}</style>`,
  `<script>window.__PORTRAIT=true;window.__PARAMS=window.__PARAMS||{};window.__LANG=window.__LANG||"";</script>\n<script>window.__ASSETS__=${JSON.stringify(assets)};</script>\n<script>${safe(bundle)}</script>`
);
const playerPath = path.join(dist, 'avalanche-run.html');
fs.writeFileSync(playerPath, player);

// --- claude.ai artifact: the player without its own document skeleton
// (the host wraps the page in one), keeping the title, styles and game.
const artifact = player
  .replace(/<!doctype html>\n?/i, '')
  .replace(/<\/?html[^>]*>\n?/gi, '')
  .replace(/<\/?head>\n?/gi, '')
  .replace(/<meta (charset|name="viewport"|name="theme-color"|name="apple-mobile-web-app-capable")[^>]*>\n?/gi, '')
  .replace(/<link rel="icon"[^>]*>\n?/i, '')
  .replace(/<body([^>]*)>/i, (m, attrs) => {
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    return cls ? `<script>document.body.classList.add(${cls.split(/\s+/).map((c) => JSON.stringify(c)).join(',')})</script>` : '';
  })
  .replace(/<\/body>\n?/i, '');
const artifactPath = path.join(dist, 'avalanche-run-artifact.html');
fs.writeFileSync(artifactPath, artifact);

// --- report ---
const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const size = (p) => fs.statSync(p).size;
const own = order.filter((m) => m.id !== modules.get('vendor/three.module.min.js').id).reduce((n, m) => n + m.code.length, 0);
const webFiles = ['web/index.html', 'web/game.js'].map((f) => path.join(dist, f));
const audioBytes = audio.reduce((n, f) => n + size(path.join(audioDir, f)), 0);
console.log(`avalanche-run ${pkg.version}: ${modules.size} modules bundled in ${Date.now() - t0} ms`);
console.log(`  game code            ${kb(own)}`);
console.log(`  three.js             ${kb(bundle.length - own)}`);
console.log(`  audio (8 mp3)        ${kb(audioBytes)}`);
console.log(`web build   dist/web/`);
console.log(`  index.html + game.js ${kb(webFiles.reduce((n, f) => n + size(f), 0))}   gzip ${kb(webFiles.reduce((n, f) => n + gz(fs.readFileSync(f)), 0))}`);
console.log(`  total with audio     ${kb(webFiles.reduce((n, f) => n + size(f), 0) + audioBytes)}`);
console.log(`app build   dist/app/ (web build for the phone apps)`);
console.log(`playable    dist/avalanche-run-playable.html`);
console.log(`  single file          ${kb(size(singlePath))}   gzip ${kb(gz(fs.readFileSync(singlePath)))}`);
console.log(`player      dist/avalanche-run.html (single file, no ad layer)  ${kb(size(playerPath))}`);
