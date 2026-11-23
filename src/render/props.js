// Hazards, terrain features, collectibles and off-piste dressing.
// Everything is instanced: one draw call per kind, matrices rewritten each frame
// from the simulation's entity list.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { mulberry32 } from '../core/rng.js';
import { biomeAt } from '../core/course.js';

const col = (hex) => new THREE.Color(hex);

// --- geometry helpers ---------------------------------------------------
function paint(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const out = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    fn(c, pos.getX(i), pos.getY(i), pos.getZ(i), nor.getX(i), nor.getY(i), nor.getZ(i));
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(out, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const colr = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    colr.set(g.attributes.color.array, o);
    o += g.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  return out;
}

function pineGeo() {
  // Chunky cartoon pine: fat scalloped tiers, bright green, crisp snow caps.
  const trunk = paint(new THREE.CylinderGeometry(0.26, 0.34, 1.1, 6).translate(0, 0.55, 0), (c) => c.set('#8a4b2a'));
  const parts = [trunk];
  const tiers = [
    [1.75, 2.3, 0.75, '#12a060'],
    [1.4, 2.1, 2.1, '#1cc074'],
    [1.0, 1.9, 3.4, '#3ee08e'],
  ];
  for (const [r, h, y, hex] of tiers) {
    const green = col(hex);
    const dark = col(hex).multiplyScalar(0.72);
    const snow = col('#ffffff');
    parts.push(
      paint(new THREE.ConeGeometry(r, h, 8).translate(0, y + h / 2, 0), (c, x, py, z, nx, ny) => {
        const t = (py - y) / h;
        c.copy(t > 0.5 ? snow : ny < -0.5 ? dark : green);
      })
    );
  }
  parts.push(paint(new THREE.SphereGeometry(0.3, 6, 5).translate(0, 5.35, 0), (c) => c.set('#ffffff')));
  return merge(parts);
}

function rockGeo(seed, enemy) {
  const rng = mulberry32(seed);
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  // Jitter by vertex direction so shared vertices stay welded.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = 0.82 + 0.3 * Math.abs(Math.sin(x * 5.1 + seed) * Math.cos(y * 4.3 + z * 3.7 + seed));
    pos.setXYZ(i, x * k, y * k * 0.95 + 0.35, z * k);
  }
  void rng;
  void enemy;
  const dark = col('#3b3f8a');
  const mid = col('#6b74d6');
  const snow = col('#ffffff');
  return paint(g, (c, x, y, z, nx, ny) => c.copy(ny > 0.62 ? snow : ny > 0.1 ? mid : dark));
}

function logGeo() {
  const bark = col('#6b452b');
  const barkDark = col('#4d3120');
  const snow = col('#f3f8fd');
  const end = col('#d9b07a');
  const body = paint(new THREE.CylinderGeometry(0.34, 0.34, 1, 10).rotateZ(Math.PI / 2).translate(0, 0.34, 0), (c, x, y, z, nx, ny) => {
    if (Math.abs(nx) > 0.9) c.copy(end);
    else c.copy(ny > 0.45 ? snow : ny < -0.2 ? barkDark : bark);
  });
  return body;
}

function ridgeGeo() {
  const ice = col('#7fdcf5');
  const deep = col('#2f9cc9');
  const tip = col('#f2fdff');
  const parts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const h = 0.62 + 0.42 * ((i * 7) % 4) / 3;
    const g = new THREE.ConeGeometry(0.5 / n + 0.07, h, 4)
      .rotateY(i * 1.3)
      .rotateZ(((i % 3) - 1) * 0.22)
      .translate(-0.5 + (i + 0.5) / n, h / 2, ((i * 5) % 3 - 1) * 0.16);
    parts.push(paint(g, (c, x, y) => c.copy(y > h * 0.62 ? tip : y > h * 0.25 ? ice : deep)));
  }
  parts.push(paint(new THREE.BoxGeometry(1, 0.22, 0.9).translate(0, 0.11, 0), (c, x, y, z, nx, ny) => c.copy(ny > 0.5 ? tip : deep)));
  return merge(parts);
}

function rampGeo() {
  // Wedge rising towards -z (downhill). Unit: 1 wide, 1 long, 1 high.
  const stripes = 5;
  const pos = [];
  const colr = [];
  const orange = col('#ff7a1e');
  const white = col('#fff6e8');
  const side = col('#274b7a');
  const push = (a, b, c2, colour) => {
    pos.push(...a, ...b, ...c2);
    for (let i = 0; i < 3; i++) colr.push(colour.r, colour.g, colour.b);
  };
  for (let i = 0; i < stripes; i++) {
    const x0 = -0.5 + i / stripes;
    const x1 = -0.5 + (i + 1) / stripes;
    const c = i % 2 ? white : orange;
    // Curved kicker: three segments.
    const prof = [[0.5, 0], [0.1, 0.22], [-0.25, 0.58], [-0.5, 1]];
    for (let s = 0; s < 3; s++) {
      const [z0, y0] = prof[s];
      const [z1, y1] = prof[s + 1];
      push([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], c);
      push([x0, y0, z0], [x1, y1, z1], [x0, y1, z1], c);
    }
  }
  // Sides and back.
  for (const sx of [-0.5, 0.5]) {
    const a = [sx, 0, 0.5];
    const b = [sx, 0, -0.5];
    const t = [sx, 1, -0.5];
    const m = [sx, 0.22, 0.1];
    const m2 = [sx, 0.58, -0.25];
    if (sx < 0) {
      push(a, m, b, side);
      push(m, m2, b, side);
      push(m2, t, b, side);
    } else {
      push(a, b, m, side);
      push(m, b, m2, side);
      push(m2, b, t, side);
    }
  }
  push([-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], side);
  push([-0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5], side);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.computeVertexNormals();
  return g;
}

function archGeo() {
  const ice = col('#8fdcf2');
  const deep = col('#3a9fcf');
  const tip = col('#f2fdff');
  // Half ring standing over the lane; feet at x = +-1.
  const ring = new THREE.TorusGeometry(1, 0.085, 5, 14, Math.PI);
  return paint(ring, (c, x, y, z, nx, ny) => c.copy(ny > 0.5 ? tip : y < 0.3 ? deep : ice));
}

function pillarGeo() {
  const ice = col('#8fdcf2');
  const deep = col('#2f8fc0');
  const tip = col('#f2fdff');
  return paint(new THREE.CylinderGeometry(0.75, 1, 1, 6).translate(0, 0.5, 0), (c, x, y, z, nx, ny) => c.copy(ny > 0.5 ? tip : y < 0.25 ? deep : ice));
}

function flagGeo() {
  const pole = paint(new THREE.CylinderGeometry(0.045, 0.045, 1.6, 5).translate(0, 0.8, 0), (c) => c.set('#ff5b2e'));
  const flag = paint(new THREE.BoxGeometry(0.5, 0.3, 0.03).translate(0.27, 1.42, 0), (c) => c.set('#ffd23f'));
  return merge([pole, flag]);
}

function seracGeo() {
  const ice = col('#bfe9f7');
  const deep = col('#6fbfe0');
  const g = new THREE.CylinderGeometry(0.45, 1, 1.6, 5).translate(0, 0.8, 0);
  return paint(g, (c, x, y, z, nx, ny) => c.copy(ny > 0.5 ? col('#ffffff') : y < 0.5 ? deep : ice));
}

// Ink outlines (inverted hull): the same navy line the UI uses.
export const INK = '#14182a';
const OUT_VERT = /* glsl */ `
uniform float uWidth;
varying float vDepth;
void main() {
  vec3 p = position + normal * uWidth;
  #ifdef USE_INSTANCING
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  #else
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  #endif
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const OUT_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
varying float vDepth;
void main() {
  gl_FragColor = vec4(mix(uInk, uFog, smoothstep(uFogNear, uFogFar, vDepth)), 1.0);
  #include <colorspace_fragment>
}`;
export const outlineFog = { uFog: { value: new THREE.Color('#b9ecff') }, uFogNear: { value: 110 }, uFogFar: { value: 400 } };
export function outlineMaterial(width) {
  return new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: width }, uInk: { value: new THREE.Color(INK) }, uFog: outlineFog.uFog, uFogNear: outlineFog.uFogNear, uFogFar: outlineFog.uFogFar },
    vertexShader: OUT_VERT,
    fragmentShader: OUT_FRAG,
    side: THREE.BackSide,
  });
}
// Same shape with normals averaged per position, so the hull has no cracks.
export function outlineGeo(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const sum = new Map();
  const key = (i) => Math.round(pos.getX(i) * 200) + '|' + Math.round(pos.getY(i) * 200) + '|' + Math.round(pos.getZ(i) * 200);
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const v = sum.get(k) || [0, 0, 0];
    v[0] += nor.getX(i);
    v[1] += nor.getY(i);
    v[2] += nor.getZ(i);
    sum.set(k, v);
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = sum.get(key(i));
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    out[i * 3] = v[0] / l;
    out[i * 3 + 1] = v[1] / l;
    out[i * 3 + 2] = v[2] / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos);
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  if (geo.index) g.setIndex(geo.index);
  return g;
}

// Three-step toon ramp shared by every lit material.
let RAMP = null;
export function toonRamp() {
  if (RAMP) return RAMP;
  const data = new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  RAMP = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  RAMP.minFilter = RAMP.magFilter = THREE.NearestFilter;
  RAMP.needsUpdate = true;
  return RAMP;
}

function coinGeo() {
  // A chunky coin: dark rim, raised face, embossed six-point snowflake.
  const rim = col('#d9801a');
  const edge = col('#b8660f');
  const face = col('#ffc93c');
  const hi = col('#fff0b0');
  const parts = [
    paint(new THREE.CylinderGeometry(0.5, 0.5, 0.14, 18).rotateX(Math.PI / 2), (c, x, y, z, nx, ny, nz) => c.copy(Math.abs(nz) > 0.5 ? rim : edge)),
    paint(new THREE.CylinderGeometry(0.39, 0.41, 0.2, 18).rotateX(Math.PI / 2), (c, x, y, z, nx, ny, nz) => c.copy(Math.abs(nz) > 0.5 ? face : rim)),
    paint(new THREE.CylinderGeometry(0.09, 0.09, 0.27, 6).rotateX(Math.PI / 2), (c) => c.copy(hi)),
  ];
  for (let i = 0; i < 3; i++) parts.push(paint(new THREE.BoxGeometry(0.56, 0.075, 0.25).rotateZ((i * Math.PI) / 3), (c) => c.copy(hi)));
  return merge(parts);
}

function candyPoleGeo() {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const hex = i % 2 ? '#ffffff' : '#ff3355';
    parts.push(paint(new THREE.CylinderGeometry(0.09, 0.09, 0.3, 6).translate(0, 0.15 + i * 0.3, 0), (c) => c.set(hex)));
  }
  parts.push(paint(new THREE.SphereGeometry(0.17, 7, 5).translate(0, 1.95, 0), (c) => c.set('#ffd23f')));
  return merge(parts);
}

function gateGeo() {
  // Checkered banner over the piste on candy-striped posts. Unit: metres.
  const parts = [];
  const W = 9.8;
  for (const sx of [-W, W]) {
    for (let i = 0; i < 7; i++) {
      const hex = i % 2 ? '#ffffff' : '#ff3355';
      parts.push(paint(new THREE.CylinderGeometry(0.32, 0.32, 1, 8).translate(sx, 0.5 + i, 0), (c) => c.set(hex)));
    }
    parts.push(paint(new THREE.SphereGeometry(0.55, 8, 6).translate(sx, 7.4, 0), (c) => c.set('#ffd23f')));
  }
  const cols = 20;
  const cw = (W * 2) / cols;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < 2; j++) {
      const hex = (i + j) % 2 ? '#ffffff' : '#14182a';
      parts.push(paint(new THREE.BoxGeometry(cw, 0.8, 0.25).translate(-W + cw * (i + 0.5), 5.7 + j * 0.8, 0), (c) => c.set(hex)));
    }
  }
  parts.push(paint(new THREE.BoxGeometry(W * 2 + 0.6, 0.22, 0.4).translate(0, 7.2, 0), (c) => c.set('#ff3355')));
  parts.push(paint(new THREE.BoxGeometry(W * 2 + 0.6, 0.22, 0.4).translate(0, 5.2, 0), (c) => c.set('#ffd23f')));
  return merge(parts);
}

function snowmanGeo() {
  const white = (c, x, y, z, nx, ny) => c.set(ny < -0.3 ? '#cfe2f5' : '#ffffff');
  return merge([
    paint(new THREE.SphereGeometry(0.75, 9, 7).translate(0, 0.6, 0), white),
    paint(new THREE.SphereGeometry(0.55, 9, 7).translate(0, 1.55, 0), white),
    paint(new THREE.SphereGeometry(0.4, 9, 7).translate(0, 2.3, 0), white),
    paint(new THREE.ConeGeometry(0.09, 0.45, 6).rotateX(Math.PI / 2).translate(0, 2.3, 0.55), (c) => c.set('#ff8a1e')),
    paint(new THREE.TorusGeometry(0.4, 0.12, 5, 10).rotateX(Math.PI / 2).translate(0, 1.98, 0), (c) => c.set('#ff3355')),
    paint(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 8).translate(0, 2.85, 0), (c) => c.set('#2a2f55')),
    paint(new THREE.CylinderGeometry(0.46, 0.46, 0.07, 8).translate(0, 2.62, 0), (c) => c.set('#2a2f55')),
  ]);
}

function balloonGeo() {
  const g = new THREE.SphereGeometry(0.8, 10, 8).scale(1, 1.2, 1).translate(0, 1, 0);
  const knot = new THREE.ConeGeometry(0.14, 0.25, 5).translate(0, -0.05, 0);
  const string = new THREE.CylinderGeometry(0.02, 0.02, 2.4, 3).translate(0, -1.3, 0);
  return merge([paint(g, (c, x, y, z, nx, ny) => c.set(ny > 0.5 ? '#ffffff' : '#e6e6e6')), paint(knot, (c) => c.set('#dddddd')), paint(string, (c) => c.set('#8899aa'))]);
}

function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const CREV_VERT = /* glsl */ `
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const CREV_FRAG = /* glsl */ `
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform float uBold;
varying vec2 vUv;
varying float vDepth;
void main() {
  float ex = abs(vUv.x - 0.5) * 2.0;
  // Jagged lips and pointed ends.
  float jag = 0.06 * sin(vUv.y * 90.0) + 0.04 * sin(vUv.y * 37.0 + 1.3);
  float taper = smoothstep(0.0, 0.07, vUv.y) * smoothstep(1.0, 0.93, vUv.y);
  float w = taper * (0.9 + jag);
  if (ex > w) discard;
  float rim = smoothstep(w - 0.22 - uBold * 0.12, w, ex);
  vec3 deep = mix(vec3(0.01, 0.03, 0.09), vec3(0.03, 0.16, 0.34), ex);
  vec3 col = mix(deep, vec3(0.62, 0.93, 1.0), rim);
  col = mix(col, uFog, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Props {
  constructor(stage) {
    this.stage = stage;
    this.group = new THREE.Group();
    stage.world.add(this.group);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.colorblind = false;
    this.sceneryShare = 1;

    const lambert = (extra) => { const o = Object.assign({ vertexColors: true, gradientMap: toonRamp() }, extra || {}); delete o.flatShading; return new THREE.MeshToonMaterial(o); };
    const iceMat = lambert({ emissive: '#1d8fc5', emissiveIntensity: 0.55 });
    const reward = CONFIG.look.rewardColor;
    this.sets = {};
    this.outlines = [];
    const add = (name, geo, mat, count, order, ink) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.frustumCulled = false;
      mesh.count = 0;
      if (order) mesh.renderOrder = order;
      this.group.add(mesh);
      this.sets[name] = { mesh, n: 0, max: count };
      if (ink) {
        // Outline hull sharing the same instance matrices.
        const hull = new THREE.InstancedMesh(outlineGeo(geo), outlineMaterial(ink), count);
        hull.instanceMatrix = mesh.instanceMatrix;
        hull.frustumCulled = false;
        hull.count = 0;
        this.group.add(hull);
        this.outlines.push([hull, this.sets[name]]);
      }
    };
    add('pine', pineGeo(), lambert(), 90, 0, 0.038);
    add('boulder', rockGeo(11, CONFIG.look.enemyColor), lambert(), 70, 0, 0.029);
    add('pillar', pillarGeo(), iceMat, 10, 0, 0.05);
    add('log', logGeo(), lambert(), 40, 0, 0.021);
    add('ridge', ridgeGeo(), iceMat, 40, 0, 0.021);
    add('ramp', rampGeo(), lambert({ side: THREE.DoubleSide }), 8, 0, 0.017);
    add('rib', archGeo(), iceMat, 90, 0, 0.013);
    add('flag', candyPoleGeo(), lambert(), 60, 0, 0.013);
    add('cflag', flagGeo(), lambert(), 12);
    add('gate', gateGeo(), lambert({ side: THREE.DoubleSide }), 3, 0, 0.029);
    add('bump', new THREE.SphereGeometry(1, 8, 5), new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp() }), 280);
    add('flake', coinGeo(), lambert({ emissive: '#ff9a1e', emissiveIntensity: 0.1 }), 240, 0, 0.03);

    // Ground decals.
    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const decal = (tex, opacity, extra) =>
      new THREE.MeshBasicMaterial(Object.assign({ map: tex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, extra || {}));
    const blob = canvasTexture(64, 64, (g) => {
      const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      grad.addColorStop(0, 'rgba(20,45,90,0.85)');
      grad.addColorStop(0.6, 'rgba(20,45,90,0.45)');
      grad.addColorStop(1, 'rgba(20,45,90,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    });
    const chevron = canvasTexture(128, 128, (g) => {
      g.lineJoin = 'miter';
      for (let i = 0; i < 3; i++) {
        const y = 22 + i * 38;
        for (const [w, c] of [[20, '#1c2a44'], [11, '#ffd23f']]) {
          g.strokeStyle = c;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(14, y + 22);
          g.lineTo(64, y - 6);
          g.lineTo(114, y + 22);
          g.stroke();
        }
      }
    });
    const cross = canvasTexture(128, 128, (g) => {
      for (const [w, c] of [[26, '#ffffff'], [15, '#d81e5b']]) {
        g.strokeStyle = c;
        g.lineWidth = w;
        g.beginPath();
        g.arc(64, 64, 46, 0, Math.PI * 2);
        g.moveTo(34, 34);
        g.lineTo(94, 94);
        g.moveTo(94, 34);
        g.lineTo(34, 94);
        g.stroke();
      }
    });
    const iceTex = canvasTexture(64, 128, (g) => {
      const grad = g.createRadialGradient(32, 64, 4, 32, 64, 62);
      grad.addColorStop(0, 'rgba(150,225,255,0.95)');
      grad.addColorStop(0.75, 'rgba(110,200,245,0.8)');
      grad.addColorStop(1, 'rgba(110,200,245,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 128);
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.moveTo(10 + i * 9, 30 + i * 6);
        g.lineTo(26 + i * 8, 70 + i * 9);
        g.stroke();
      }
    });
    this.dashTex = canvasTexture(128, 128, (g) => {
      g.fillStyle = '#1b6cff';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#35d6ff';
      g.fillRect(0, 0, 10, 128);
      g.fillRect(118, 0, 10, 128);
      for (let i = 0; i < 2; i++) {
        const y = 14 + i * 64;
        g.fillStyle = i % 2 ? '#ffd23f' : '#ff8a1e';
        g.beginPath();
        g.moveTo(20, y + 44);
        g.lineTo(64, y);
        g.lineTo(108, y + 44);
        g.lineTo(108, y + 20 + 44);
        g.lineTo(64, y + 20);
        g.lineTo(20, y + 20 + 44);
        g.fill();
      }
    });
    this.dashTex.wrapS = this.dashTex.wrapT = THREE.RepeatWrapping;
    add('dash', flat, decal(this.dashTex, 1), 12, 2);
    add('shadow', flat, decal(blob, 0.55), 200, 1);
    add('ice', flat, decal(iceTex, 0.85), 14, 1);
    add('chevron', flat, decal(chevron, 0.95), 70, 2);
    add('cross', flat, decal(cross, 0.95), 160, 2);

    this.crevUniforms = { uFog: { value: new THREE.Color() }, uFogNear: { value: 90 }, uFogFar: { value: 380 }, uBold: { value: 0 } };
    add('crevasse', flat, new THREE.ShaderMaterial({ uniforms: this.crevUniforms, vertexShader: CREV_VERT, fragmentShader: CREV_FRAG, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 8, 1);

    // Off-piste dressing.
    add('sPine', pineGeo(), lambert(), 240, 0, 0.038);
    add('sRock', rockGeo(5, '#59626d'), lambert(), 60, 0, 0.021);
    add('sSerac', seracGeo(), iceMat, 70, 0, 0.025);
    add('sSnowman', snowmanGeo(), lambert(), 26, 0, 0.021);
    add('sBalloon', balloonGeo(), lambert(), 44, 0, 0.021);
    const palette = ['#ff3355', '#ffd23f', '#35d6ff', '#7a5cff', '#3ddc84', '#ff8a1e'];
    const tmpC = new THREE.Color();
    for (let i = 0; i < 44; i++) this.sets.sBalloon.mesh.setColorAt(i, tmpC.set(palette[i % palette.length]));
    this.scenery = { sPine: [], sRock: [], sSerac: [], sSnowman: [], sBalloon: [] };
    this.rng = mulberry32(99);
    this.resetScenery(0);
  }

  put(name, x, y, z, sx, sy, sz, ry, rx, rz) {
    const set = this.sets[name];
    if (set.n >= set.max) return;
    this.e.set(rx || 0, ry || 0, rz || 0);
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.set(sx, sy, sz);
    this.m.compose(this.p, this.q, this.s);
    set.mesh.setMatrixAt(set.n++, this.m);
  }

  // --- scenery ------------------------------------------------------------
  sceneryVisible(kind, d) {
    const b = biomeAt(d).id;
    if (kind === 'sSnowman') return this.rng() < (b === 'forest' ? 0.9 : 0.4);
    if (kind === 'sBalloon') return this.rng() < (b === 'storm' ? 0.9 : 0.75);
    const share = kind === 'sPine' ? { forest: 1, glacier: 0.12, storm: 0.6 } : kind === 'sSerac' ? { forest: 0, glacier: 1, storm: 0.45 } : { forest: 0.6, glacier: 0.8, storm: 0.8 };
    return this.rng() < share[b];
  }

  placeScenery(kind, item, d) {
    const r = this.rng;
    const sideSign = r() < 0.5 ? -1 : 1;
    item.d = d;
    item.yaw = r() * 6.28;
    if (kind === 'sPine') {
      const nearRow = r() < 0.66;
      item.x = sideSign * (nearRow ? 10.8 + r() * 9 : 20 + r() * 48);
      item.s = (nearRow ? 0.9 : 1.15) + r() * 0.85;
    } else if (kind === 'sRock') {
      item.x = sideSign * (12.5 + r() * 40);
      item.s = 1.4 + r() * 4.5;
    } else if (kind === 'sSnowman') {
      item.x = sideSign * (10.2 + r() * 2.6);
      item.s = 0.9 + r() * 0.5;
      item.yaw = sideSign > 0 ? -1.2 : 1.2;
    } else if (kind === 'sBalloon') {
      item.x = sideSign * (10 + r() * 14);
      item.s = 0.9 + r() * 0.8;
      item.h = 4 + r() * 7;
    } else {
      item.x = sideSign * (12 + r() * 46);
      item.s = 1.6 + r() * 3.4;
    }
    item.on = this.sceneryVisible(kind, d);
  }

  resetScenery(dist) {
    const span = CONFIG.lane.viewDist + 110;
    this.rng = mulberry32(99);
    for (const kind of Object.keys(this.scenery)) {
      const list = this.scenery[kind];
      const max = this.sets[kind].max;
      list.length = 0;
      for (let i = 0; i < max; i++) {
        const item = {};
        this.placeScenery(kind, item, dist - 50 + this.rng() * span);
        list.push(item);
      }
    }
  }

  updateScenery(dist, terrain) {
    const span = CONFIG.lane.viewDist + 110;
    for (const kind of Object.keys(this.scenery)) {
      const list = this.scenery[kind];
      const use = Math.floor(list.length * this.sceneryShare);
      if (!this.time) this.time = 0;
      for (let i = 0; i < use; i++) {
        const it = list[i];
        if (it.d < dist - 50) this.placeScenery(kind, it, it.d + span);
        if (!it.on) continue;
        const y = terrain.heightAt(it.x, it.d);
        if (kind === 'sBalloon') {
          const bob = Math.sin(this.time * 1.4 + i) * 0.5;
          this.put(kind, it.x + Math.sin(this.time * 0.7 + i * 2) * 0.4, y + it.h + bob, -(it.d - dist), it.s, it.s, it.s, it.yaw, 0, Math.sin(this.time + i) * 0.12);
          continue;
        }
        if (kind === 'sSnowman') {
          this.put(kind, it.x, y - 0.1, -(it.d - dist), it.s, it.s, it.s, it.yaw);
          continue;
        }
        const sink = kind === 'sPine' ? 0.15 : 0.3 * it.s;
        this.put(kind, it.x, y - sink, -(it.d - dist), it.s, kind === 'sPine' ? it.s : it.s * 0.9, it.s, it.yaw);
      }
    }
  }

  // --- per frame ------------------------------------------------------------
  update(sim, time) {
    const terrain = this.stage.terrain;
    const dist = sim.dist;
    this.time = time;
    this.dashTex.offset.y = (time * 2.2) % 1;
    for (const k of Object.keys(this.sets)) this.sets[k].n = 0;
    const list = sim.course.entities;
    const far = dist + CONFIG.lane.viewDist + 40;
    const W = CONFIG.lane.halfWidth;
    const mood = this.stage.mood;
    this.crevUniforms.uFog.value.copy(mood.fog);
    this.crevUniforms.uFogNear.value = mood.fogNear;
    this.crevUniforms.uFogFar.value = mood.fogFar;
    this.crevUniforms.uBold.value = this.colorblind ? 1 : 0;
    const bold = this.colorblind ? 1.25 : 1;

    for (let i = sim.first; i < list.length; i++) {
      const e = list[i];
      if (e.d0 > far) break;
      const z = -(e.d - dist);
      const y = terrain.groundAt(e.d);
      const kind = e.kind;
      if (kind === 'flake') {
        if (e.got) continue;
        // A wave runs down each line of coins: they spin, bob and swell in sequence,
        // and lean in and grow as the rider closes on them.
        const ph = time * 5 - e.d * 0.32;
        const near = Math.max(0, 1 - Math.abs(z + 6) / 26);
        const sc = 1.05 + 0.14 * Math.sin(ph) + 0.25 * near;
        const bob = Math.sin(ph) * 0.14;
        this.put('flake', e.x, y + e.y + bob, z, sc, sc, sc, time * 3.4 - e.d * 0.22, 0, Math.sin(ph * 0.5) * 0.18);
        if (e.y < 1.6) this.put('shadow', e.x, y + 0.03, z, 1.1, 1, 1.1, 0);
      } else if (kind === 'pine') {
        const s = e.r / 1.1;
        this.put('pine', e.x, y - 0.1, z, s, s, s, e.id * 1.7);
        this.put('shadow', e.x + 0.5, y + 0.03, z - 0.4, e.r * 3.6, 1, e.r * 3.6, 0);
        if (this.colorblind) this.put('cross', e.x, y + 0.05, z, e.r * 2.6, 1, e.r * 2.6, 0);
      } else if (kind === 'boulder') {
        this.put('boulder', e.x, y - 0.25 * e.r, z, e.r * 1.06, e.r * 1.06, e.r * 1.06, e.id * 1.7);
        this.put('shadow', e.x + 0.3, y + 0.03, z - 0.2, e.r * 3.1, 1, e.r * 3.1, 0);
        if (this.colorblind) this.put('cross', e.x, y + 0.05, z + e.r + 0.9, 1.7, 1, 1.7, 0);
      } else if (kind === 'pillar') {
        this.put('pillar', e.x, y - 0.1, z, e.r, e.h, e.r, e.id);
        this.put('shadow', e.x, y + 0.03, z, e.r * 4, 1, e.r * 4, 0);
        if (this.colorblind) this.put('cross', e.x, y + 0.05, z + e.r + 0.9, 1.5, 1, 1.5, 0);
      } else if (kind === 'log' || kind === 'ridge') {
        const hit = e.hit ? 1 : 0;
        const wob = ((e.id * 7) % 5) * 0.012 - 0.024;
        if (kind === 'log') this.put('log', e.x, y - hit * 0.12, z, e.hw * 2, 1, 1, wob + hit * 0.25, 0, hit * 0.1);
        else this.put('ridge', e.x, y - hit * 0.3, z, e.hw * 2, 1 - hit * 0.3, 1.5, wob);
        this.put('shadow', e.x, y + 0.03, z - 0.1, e.hw * 2.3, 1, 1.9, 0);
        this.put('chevron', e.x, y + 0.05, z + 3.6 * bold, Math.min(e.hw * 1.5, 3) * bold, 1, 4.4 * bold, 0);
      } else if (kind === 'crevasse') {
        this.put('crevasse', e.x, y + 0.04, z, (e.hw * 2 + 0.5) * (this.colorblind ? 1.12 : 1), 1, e.hd * 2 + 2, 0);
      } else if (kind === 'ramp') {
        this.put('ramp', e.x, y, z, e.hw * 2, 1.25, e.hd * 2, 0);
        this.put('shadow', e.x, y + 0.03, z - 1, e.hw * 3, 1, e.hd * 2.6, 0);
      } else if (kind === 'dash') {
        this.put('dash', e.x, y + 0.045, z, e.hw * 2, 1, e.hd * 2, 0);
      } else if (kind === 'ice') {
        this.put('ice', e.x, y + 0.035, z, e.hw * 2, 1, e.hd * 2, 0);
      } else if (kind === 'mogul') {
        const nx = Math.max(2, Math.round((e.hw * 2) / 1.7));
        const nz = Math.max(3, Math.round((e.hd * 2) / 2.4));
        for (let a = 0; a < nx; a++) {
          for (let b = 0; b < nz; b++) {
            const h = ((e.id * 31 + a * 17 + b * 7) % 10) / 10;
            const bx = e.x - e.hw + ((a + 0.5 + (b % 2) * 0.35) / nx) * e.hw * 2;
            const bd = e.d0 + ((b + 0.5) / nz) * e.hd * 2;
            this.put('bump', bx, terrain.groundAt(bd) - 0.05, -(bd - dist), 0.7 + h * 0.25, 0.3 + h * 0.14, 0.95 + h * 0.3, 0);
          }
        }
      } else if (kind === 'arch') {
        const n = Math.max(2, Math.floor((e.hd * 2) / 6));
        for (let a = 0; a <= n; a++) {
          const d = e.d0 + (a / n) * e.hd * 2;
          const zz = -(d - dist);
          if (zz > 30) continue;
          this.put('rib', e.x, terrain.groundAt(d) - 0.05, zz, e.hw + 0.45, 3.9, 3.2, 0);
        }
      } else if (kind === 'cliff') {
        for (let a = 0; a < 7; a++) {
          const fx = -W + (a / 6) * 2 * W;
          this.put('cflag', fx, y, z + 1.2, 1.3, 1.3, 1.3, 0.4);
        }
        // A row of chevrons says "drop ahead".
        for (let a = 0; a < 3; a++) this.put('chevron', -4.5 + a * 4.5, y + 0.05, z + 7, 2.6 * bold, 1, 3 * bold, 0);
      }
    }

    // Piste poles every 25 m on both edges.
    const first = Math.floor((dist - 30) / 25) * 25;
    for (let d = first; d < dist + 280; d += 25) {
      const y = terrain.groundAt(d);
      const z = -(d - dist);
      this.put('flag', -W - 0.5, y, z, 1, 1, 1, 0);
      this.put('flag', W + 0.5, y, z, 1, 1, 1, Math.PI);
    }

    // Checkered gates: one at the start, then every 500 m.
    for (let k = Math.max(0, Math.floor((dist - 40) / 500)); k * 500 < dist + 300; k++) {
      const d = k === 0 ? 34 : k * 500;
      if (d < dist - 40) continue;
      this.put('gate', 0, terrain.groundAt(d) - 0.2, -(d - dist), 1, 1, 1, 0);
    }

    this.updateScenery(dist, terrain);
    for (const k of Object.keys(this.sets)) {
      const set = this.sets[k];
      set.mesh.count = set.n;
      set.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [hull, set] of this.outlines) hull.count = set.n;
    outlineFog.uFog.value.copy(mood.fog);
    outlineFog.uFogNear.value = mood.fogNear;
    outlineFog.uFogFar.value = mood.fogFar;
  }
}

