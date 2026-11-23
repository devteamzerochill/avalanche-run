// The mountain surface. One grid that follows the rider; height, shading and
// haze are computed on the GPU. The same height function exists in JS
// (sideHeight) so props can sit on the slope.
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const ROW = 4; // metres between rows; the grid snaps to this so it never swims
const BACK = 48;
const AHEAD = 372;
export const CLIFF_FACE = 3; // metres over which the drop happens (visual)

const COLS = [-140, -100, -72, -52, -38, -29, -22, -17, -13.5, -11, -9, -7.2, -5.4, -3.6, -1.8, 0, 1.8, 3.6, 5.4, 7.2, 9, 11, 13.5, 17, 22, 29, 38, 52, 72, 100, 140];

// Height of the off-piste snow relative to the piste. Must match the GLSL below.
export function sideHeight(x, d) {
  const a = Math.abs(x);
  const P = CONFIG.lane.pisteHalf;
  if (a < P) return 0;
  const n = Math.min(1, (a - P) / 5);
  const s = 1.4 * n * n * (3 - 2 * n);
  const r = Math.max(0, a - 15);
  const hills = (Math.sin(x * 0.06 + d * 0.011) * Math.sin(d * 0.035 + x * 0.02) * 0.5 + 0.1) * Math.min(7, r * 0.5 + 0.6);
  return s + r * 0.2 + r * r * 0.004 + hills * n;
}

const VERT = /* glsl */ `
uniform float uSnapD;
uniform vec4 uCliffs;
uniform float uBase;
varying vec3 vPos;
varying float vD;
varying vec3 vNormal;
varying float vFogDepth;

float side(float x, float d) {
  float a = abs(x);
  float n = clamp((a - ${CONFIG.lane.pisteHalf.toFixed(1)}) / 5.0, 0.0, 1.0);
  float s = 1.4 * n * n * (3.0 - 2.0 * n);
  float r = max(0.0, a - 15.0);
  float hills = (sin(x * 0.06 + d * 0.011) * sin(d * 0.035 + x * 0.02) * 0.5 + 0.1) * min(7.0, r * 0.5 + 0.6);
  return s + r * 0.2 + r * r * 0.004 + hills * n;
}
float ground(float rd) {
  float g = uBase;
  g -= ${CONFIG.air.cliffDrop.toFixed(2)} * smoothstep(uCliffs.x, uCliffs.x + ${CLIFF_FACE.toFixed(1)}, rd);
  g -= ${CONFIG.air.cliffDrop.toFixed(2)} * smoothstep(uCliffs.y, uCliffs.y + ${CLIFF_FACE.toFixed(1)}, rd);
  g -= ${CONFIG.air.cliffDrop.toFixed(2)} * smoothstep(uCliffs.z, uCliffs.z + ${CLIFF_FACE.toFixed(1)}, rd);
  g -= ${CONFIG.air.cliffDrop.toFixed(2)} * smoothstep(uCliffs.w, uCliffs.w + ${CLIFF_FACE.toFixed(1)}, rd);
  return g;
}
float height(float x, float rd) {
  return ground(rd) + side(x, uSnapD + rd);
}
void main() {
  vec3 p = position;
  float rd = -p.z;
  float h = height(p.x, rd);
  float e = 0.75;
  float hx = height(p.x + e, rd) - height(p.x - e, rd);
  float hz = height(p.x, rd - e) - height(p.x, rd + e);
  vNormal = normalize(vec3(-hx, 2.0 * e, -hz));
  p.y = h;
  vPos = p;
  vD = uSnapD + rd;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uSnow;
uniform vec3 uPiste;
uniform vec3 uShade;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uFogCol;
uniform float uFogNear;
uniform float uFogFar;
uniform float uShadowZ;
uniform float uShadowAmt;
uniform float uSparkle;
uniform float uBoost;
uniform vec3 uAccent;
varying vec3 vPos;
varying float vD;
varying vec3 vNormal;
varying float vFogDepth;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 n = normalize(vNormal);
  float ax = abs(vPos.x);
  float piste = 1.0 - smoothstep(${(CONFIG.lane.pisteHalf - 0.6).toFixed(1)}, ${(CONFIG.lane.pisteHalf + 1.2).toFixed(1)}, ax);
  vec3 base = mix(uSnow, uPiste, piste);
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  float lit0 = smoothstep(0.05, 0.75, diff);
  float lit = mix(lit0, floor(lit0 * 3.0 + 0.5) / 3.0, 0.8); // three flat bands, like the props
  vec3 col = mix(uShade, base, 0.5 + 0.5 * lit) * mix(vec3(1.0), uSunCol, 0.35 * lit);

  float near = 1.0 - smoothstep(50.0, 240.0, vFogDepth);
  float close = 1.0 - smoothstep(8.0, 70.0, vFogDepth);
  vec2 w = vec2(vPos.x, vD);
  vec2 wf = vec2(vPos.x + 150.0, mod(vD, 97.0)); // small numbers keep the hash well-behaved
  // Snow drifts: soft light and blue-shadowed patches, two scales.
  float drift = noise(w * vec2(0.16, 0.05)) * 0.6 + noise(w * vec2(0.5, 0.17) + 13.0) * 0.4;
  col = mix(col, uShade, (1.0 - smoothstep(0.37, 0.39, drift)) * 0.26 * near);
  col = mix(col, uShade, (1.0 - smoothstep(0.27, 0.285, drift)) * 0.22 * near);
  col += vec3(0.06) * smoothstep(0.68, 0.695, drift) * near;
  // Wind ripples running across the slope: these are what make speed readable.
  float warp = noise(w * vec2(0.22, 0.04) + 5.0) * 6.0;
  float ripple = sin(vD * 0.9 + warp + vPos.x * 0.15);
  col = mix(col, uShade, smoothstep(0.82, 0.86, ripple) * 0.22 * near);
  col += vec3(0.05) * smoothstep(0.86, 0.9, -ripple) * near;
  // Ink line where the banks meet the piste dressing, and along steep bank folds.
  float fold = smoothstep(0.62, 0.58, n.y) * (1.0 - piste);
  col = mix(col, uShade * 0.75, fold * 0.35);
  // Groomed corduroy on the piste, fading with distance so it never shimmers.
  float cord = sin(vPos.x * 9.0) * 0.5 + 0.5;
  col *= 1.0 - 0.11 * cord * piste * close;
  // Fine grain up close.
  col *= 1.0 - 0.035 * (hash(floor(wf * 12.0) * 0.37) - 0.5) * close;
  // Race-track kerbs along both edges: red and white blocks.
  float kerb = step(${CONFIG.lane.halfWidth.toFixed(1)}, ax) * step(ax, ${(CONFIG.lane.halfWidth + 0.9).toFixed(1)});
  float block = step(0.5, fract(vD / 5.0));
  vec3 kerbCol = mix(vec3(1.0, 0.16, 0.26), vec3(1.0), block) * (0.45 + 0.55 * lit) * mix(vec3(1.0), uSunCol, 0.3);
  col = mix(col, mix(kerbCol, uShade, 0.18), kerb * (0.35 + 0.65 * near));
  // Centre dashes, like a road: a strong speed cue.
  float dash = step(ax, 0.09) * step(0.55, fract(vD / 9.0));
  col = mix(col, uAccent, dash * 0.55 * near);
  // Boost: the whole piste flashes with streaks.
  float st = step(0.86, hash(vec2(floor(vPos.x * 2.0), 3.0))) * step(0.3, fract(vD / 14.0 + hash(vec2(floor(vPos.x * 2.0), 9.0))));
  col = mix(col, uAccent, st * uBoost * 0.5 * piste * near);
  // Sun sparkle.
  float sp = hash(floor(wf * 16.0) * 0.61 + 3.7);
  col += uSunCol * step(0.993, sp) * uSparkle * (0.4 + 0.6 * lit) * close * 0.9;
  // The avalanche's shadow creeping down the slope behind the rider.
  float sh = smoothstep(uShadowZ - 16.0, uShadowZ + 2.0, vPos.z);
  col = mix(col, uShade * 0.62, sh * uShadowAmt * (1.0 - smoothstep(15.0, 24.0, ax)));

  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  col = mix(col, uFogCol, fog);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Terrain {
  constructor() {
    const rows = Math.round((BACK + AHEAD) / ROW) + 1;
    const cols = COLS.length;
    const pos = new Float32Array(rows * cols * 3);
    let o = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        pos[o++] = COLS[c];
        pos[o++] = 0;
        pos[o++] = BACK - r * ROW;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        idx.push(a, b, d, b, e, d); // counter-clockwise seen from above
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    this.uniforms = {
      uSnapD: { value: 0 },
      uCliffs: { value: new THREE.Vector4(1e6, 1e6, 1e6, 1e6) },
      uBase: { value: 0 },
      uSnow: { value: new THREE.Color() },
      uPiste: { value: new THREE.Color() },
      uShade: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color() },
      uFogCol: { value: new THREE.Color() },
      uFogNear: { value: 90 },
      uFogFar: { value: 340 },
      uShadowZ: { value: 100 },
      uShadowAmt: { value: 0 },
      uSparkle: { value: 0.5 },
      uBoost: { value: 0 },
      uAccent: { value: new THREE.Color('#35d6ff') },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    this.mesh.frustumCulled = false;
    this.cliffs = []; // all cliff distances so far
    this.dist = 0;
  }

  setCliffs(list) {
    this.cliffs = list;
  }

  // Ground height of the piste at distance d (smooth face, for props and terrain).
  groundAt(d) {
    let g = 0;
    const list = this.cliffs;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (d <= c) continue;
      if (d >= c + CLIFF_FACE) g -= CONFIG.air.cliffDrop;
      else {
        const t = (d - c) / CLIFF_FACE;
        g -= CONFIG.air.cliffDrop * t * t * (3 - 2 * t);
      }
    }
    return g;
  }

  // Ground under the rider as the simulation sees it: a clean step at the lip.
  groundStep(d) {
    let g = 0;
    for (const c of this.cliffs) if (d >= c) g -= CONFIG.air.cliffDrop;
    return g;
  }

  heightAt(x, d) {
    return this.groundAt(d) + sideHeight(x, d);
  }

  update(dist) {
    this.dist = dist;
    const snap = Math.floor(dist / ROW) * ROW;
    this.mesh.position.z = -(snap - dist);
    const u = this.uniforms;
    u.uSnapD.value = snap;
    // Up to four cliffs inside the grid go to the shader; older ones fold into the base.
    let base = 0;
    const v = [1e6, 1e6, 1e6, 1e6];
    let n = 0;
    for (const c of this.cliffs) {
      const rd = c - snap;
      if (rd < -BACK - 8) base -= CONFIG.air.cliffDrop;
      else if (rd < AHEAD + 8 && n < 4) v[n++] = rd;
    }
    u.uBase.value = base;
    u.uCliffs.value.set(v[0], v[1], v[2], v[3]);
  }
}
