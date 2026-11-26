// Particles, snowfall, the carve trail and the rider's blob shadow.
// Particle motion is analytic on the GPU: the CPU only writes a particle when
// it is born.
import * as THREE from 'three';

const P_VERT = /* glsl */ `
attribute vec4 aStart; // x, y, d, tint
attribute vec4 aVel;   // vx, vy, vd, gravity
attribute vec4 aInfo;  // birth, life, size, alpha
uniform float uTime;
uniform float uDist;
uniform float uScale;
varying float vAlpha;
varying float vTint;
void main() {
  float age = uTime - aInfo.x;
  float u = age / max(aInfo.y, 0.001);
  if (u < 0.0 || u > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec3 p = vec3(aStart.x + aVel.x * age, aStart.y + aVel.y * age - 0.5 * aVel.w * age * age, -(aStart.z + aVel.z * age - uDist));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aInfo.z * (1.0 + u * 1.6) * uScale / max(0.5, -mv.z);
  vAlpha = aInfo.w * pow(1.0 - u, 1.4) * smoothstep(0.0, 0.08, u);
  vTint = aStart.w;
}`;
const P_FRAG = /* glsl */ `
uniform vec3 uSnow;
uniform vec3 uGold;
uniform vec3 uIce;
varying float vAlpha;
varying float vTint;
// Trail sparks: tint 10 + hue is a saturated colour, 20 + hue a pastel one.
vec3 hueColor(float h, float s) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, s);
}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  if (r > 1.0) discard;
  float a = (1.0 - r) * (1.0 - r) * vAlpha;
  vec3 col = vTint > 19.5 ? hueColor(fract(vTint), 0.3) : vTint > 9.5 ? hueColor(fract(vTint), 1.0) : vTint < 0.5 ? uSnow : vTint < 1.5 ? uGold : vTint < 2.5 ? uIce : vTint < 3.5 ? vec3(1.0, 0.25, 0.75) : vTint < 4.5 ? vec3(1.0, 0.5, 0.08) : vec3(0.35, 1.0, 0.5);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class Particles {
  constructor(stage, max) {
    this.max = max || 1400;
    this.next = 0;
    this.share = 1;
    this.dirty = false;
    const geo = new THREE.BufferGeometry();
    this.start = new THREE.BufferAttribute(new Float32Array(this.max * 4), 4);
    this.vel = new THREE.BufferAttribute(new Float32Array(this.max * 4), 4);
    this.info = new THREE.BufferAttribute(new Float32Array(this.max * 4).fill(-99), 4);
    for (const a of [this.start, this.vel, this.info]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    geo.setAttribute('aStart', this.start);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aInfo', this.info);
    this.uniforms = {
      uTime: { value: 0 },
      uDist: { value: 0 },
      uScale: { value: 600 },
      uSnow: { value: new THREE.Color('#ffffff') },
      uGold: { value: new THREE.Color('#ffd23f') },
      uIce: { value: new THREE.Color('#9fe6ff') },
    };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: P_VERT, fragmentShader: P_FRAG, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    stage.world.add(this.points);
    this.time = 0;
  }

  // Position (x, y, d) and velocity (vx, vy, vd) are in slope coordinates; d is distance.
  emit(x, y, d, vx, vy, vd, life, size, alpha, gravity, tint) {
    if (this.share < 1 && Math.random() > this.share) return;
    const i = this.next;
    this.next = (i + 1) % this.max;
    this.start.setXYZW(i, x, y, d, tint || 0);
    this.vel.setXYZW(i, vx, vy, vd, gravity);
    this.info.setXYZW(i, this.time, life, size, alpha);
    this.dirty = true;
  }

  burst(n, x, y, d, spread, up, fwd, life, size, alpha, tint) {
    for (let i = 0; i < n; i++) {
      this.emit(
        x + (Math.random() - 0.5) * 0.6, y + Math.random() * 0.3, d + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * spread * 2, up * (0.4 + Math.random() * 1.4), fwd + (Math.random() - 0.5) * spread,
        life * (0.6 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6), alpha, 9, tint || 0
      );
    }
  }

  update(time, dist, height, snowColor) {
    this.time = time;
    this.uniforms.uTime.value = time;
    this.uniforms.uDist.value = dist;
    this.uniforms.uScale.value = height * 0.9;
    if (snowColor) this.uniforms.uSnow.value.copy(snowColor).lerp(WHITE, 0.6);
    if (this.dirty) {
      this.start.needsUpdate = true;
      this.vel.needsUpdate = true;
      this.info.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear() {
    this.info.array.fill(-99);
    this.dirty = true;
  }
}
const WHITE = new THREE.Color('#ffffff');

const S_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform float uTime;
uniform float uDist;
uniform float uWindX;
uniform float uScale;
uniform float uAmount;
varying float vAlpha;
void main() {
  vec3 box = vec3(60.0, 26.0, 80.0);
  vec3 p = aSeed * box;
  p.x += uWindX + sin(uTime * 0.7 + aSeed.y * 20.0) * 1.2;
  p.y -= uTime * (3.0 + aSeed.x * 3.5);
  p.z += uDist * 0.9;
  p = mod(p, box) - vec3(30.0, 3.0, 70.0);
  vec4 mv = modelViewMatrix * vec4(p + vec3(cameraPosition.x * 0.0, 0.0, 0.0), 1.0);
  gl_Position = projectionMatrix * mv;
  // A few big, soft foreground flakes among many small ones.
  float big = step(0.82, fract(aSeed.x * 7.3));
  gl_PointSize = (0.2 + aSeed.z * 0.2 + big * 0.5) * uScale / max(0.5, -mv.z);
  vAlpha = step(aSeed.z, uAmount) * (1.0 - big * 0.3);
}`;
const S_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  if (r > 1.0 || vAlpha < 0.01) discard;
  gl_FragColor = vec4(1.0, 1.0, 1.0, (1.0 - r) * vAlpha);
}`;

export class Snowfall {
  constructor(stage, count) {
    const n = count || 520;
    const seed = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    this.uniforms = { uTime: { value: 0 }, uDist: { value: 0 }, uWindX: { value: 0 }, uScale: { value: 600 }, uAmount: { value: 0.2 } };
    this.lastTime = 0;
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: S_VERT, fragmentShader: S_FRAG, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.position.y = 0;
    stage.world.add(this.points);
  }

  update(time, dist, height, amount, wind, groundY) {
    const u = this.uniforms;
    // The drift is added up frame by frame: wind × total time made the whole
    // snowfield lurch whenever the wind changed (owner, 2026-11-26).
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    u.uWindX.value = (u.uWindX.value + wind * dt * 6) % 600;
    u.uTime.value = time;
    u.uDist.value = dist;
    u.uScale.value = height * 0.9;
    u.uAmount.value = amount;
    this.points.position.y = groundY;
    this.points.visible = amount > 0.01;
  }
}

// Snow trail: the groove the board cuts. A shaded channel with bright raised
// lips, wider in a drift, that stays on the snow for about 150 m.
const TRAIL = 220;
export class Trail {
  constructor(stage) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3);
    this.alpha = new THREE.BufferAttribute(new Float32Array(TRAIL * 2), 1);
    const side = new Float32Array(TRAIL * 2);
    for (let i = 0; i < TRAIL; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    geo.setAttribute('position', this.pos);
    geo.setAttribute('alpha', this.alpha);
    geo.setAttribute('side', new THREE.BufferAttribute(side, 1));
    const idx = [];
    for (let i = 0; i < TRAIL - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geo.setIndex(idx);
    this.uniforms = { uColor: { value: new THREE.Color('#8caed9') }, uLip: { value: new THREE.Color('#ffffff') } };
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        vertexShader: 'attribute float alpha; attribute float side; varying float vA; varying float vS; void main(){ vA = alpha; vS = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform vec3 uColor; uniform vec3 uLip; varying float vA; varying float vS; void main(){ float e = abs(vS); float lip = smoothstep(0.62, 0.7, e) * (1.0 - smoothstep(0.92, 1.0, e)); float groove = 1.0 - smoothstep(0.55, 0.66, e); float centre = 1.0 - smoothstep(0.0, 0.16, e); vec3 col = mix(uColor, uColor * 0.72, centre * 0.6); col = mix(col, uLip, lip); float a = max(groove * 0.5, lip * 0.95) * vA; gl_FragColor = vec4(col, a); \n#include <colorspace_fragment>\n }',
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    stage.world.add(this.mesh);
    this.points = [];
    this.lastD = -1;
  }

  reset() {
    this.points.length = 0;
    this.lastD = -1;
  }

  update(x, dist, on, width, terrain, shade) {
    if (dist - this.lastD > 0.7 || this.points.length === 0) {
      this.points.unshift({ x, d: dist, on, w: width });
      if (this.points.length > TRAIL) this.points.pop();
      this.lastD = dist;
    } else if (this.points.length) {
      this.points[0].x = x;
      this.points[0].d = dist;
      this.points[0].w = Math.max(this.points[0].w, width);
    }
    this.uniforms.uColor.value.copy(shade);
    const pts = this.points;
    for (let i = 0; i < TRAIL; i++) {
      const p = pts[Math.min(i, pts.length - 1)];
      const z = -(p.d - dist) + 0.5;
      const y = terrain.groundAt(p.d) + 0.035;
      this.pos.setXYZ(i * 2, p.x - p.w, y, z);
      this.pos.setXYZ(i * 2 + 1, p.x + p.w, y, z);
      // Stay strong for most of its length, then melt away.
      const u = i / TRAIL;
      const a = p.on && i < pts.length ? Math.min(1, (1 - u) * 2.2) : 0;
      this.alpha.setX(i * 2, a);
      this.alpha.setX(i * 2 + 1, a);
    }
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

export function makeBlobShadow() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(18,40,84,0.9)');
  grad.addColorStop(0.55, 'rgba(18,40,84,0.5)');
  grad.addColorStop(1, 'rgba(18,40,84,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
  );
  mesh.renderOrder = 3;
  return mesh;
}

// Worn trail (Shards shop): one solid ribbon following the board, its colours
// in bands across its width (owner, 2026-11-26). It follows the rider in the
// air too. With no trail worn the board leaves nothing; the owner removed the
// twin speed streaks it used to draw at speed.
const SPEED_N = 64;
const TAIL = 0.98; // the board's tail behind the rider's centre (m), at the rider's scale
export class SpeedTrail {
  constructor(stage) {
    const geo = new THREE.BufferGeometry();
    const verts = SPEED_N * 2;
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.alpha = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.hue = new THREE.BufferAttribute(new Float32Array(verts), 1);
    // 0 on one edge, 1 on the other: where the colour bands sit.
    const across = new Float32Array(verts);
    for (let v = 1; v < verts; v += 2) across[v] = 1;
    geo.setAttribute('position', this.pos);
    geo.setAttribute('alpha', this.alpha);
    geo.setAttribute('hue', this.hue);
    geo.setAttribute('across', new THREE.BufferAttribute(across, 1));
    const idx = [];
    for (let i = 0; i < SPEED_N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    geo.setIndex(idx);
    this.uniforms = {
      uRainbow: { value: 0 },
      uPulse: { value: 0 },
      uT: { value: 0 },
      uC0: { value: new THREE.Color() },
      uC1: { value: new THREE.Color() },
      uC2: { value: new THREE.Color() },
    };
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: 'attribute float alpha; attribute float hue; attribute float across; varying float vA; varying float vH; varying float vX; void main(){ vA = alpha; vH = hue; vX = across; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        // Blended hues for rainbow, else the three colours mirrored
        // edge-middle-edge; the sides feather out so it isn't a hard strip.
        fragmentShader:
          'uniform float uRainbow; uniform float uPulse; uniform float uT; uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; varying float vA; varying float vH; varying float vX; void main(){ float m = abs(vX * 2.0 - 1.0); vec3 band = m > 0.5 ? mix(uC1, uC0, m * 2.0 - 1.0) : mix(uC2, uC1, m * 2.0); vec3 rb = 0.5 + 0.5 * cos(6.2832 * (vX * 0.83 + vec3(0.0, 0.33, 0.67))); vec3 col = mix(band, rb, uRainbow); col *= 1.0 + uPulse * (0.25 + 0.35 * sin(uT * 7.0 - vH * 5.0)); float edge = 1.0 - smoothstep(0.45, 1.0, m); gl_FragColor = vec4(col, vA * edge); \n#include <colorspace_fragment>\n }',
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    stage.world.add(this.mesh);
    this.pts = [];
    this.t = 0;
  }

  reset() {
    this.pts.length = 0;
  }

  // The worn trail (an item of TRAILS), or null for none.
  setStyle(trail) {
    const u = this.uniforms;
    this.mesh.visible = !!trail;
    u.uRainbow.value = trail && trail.rainbow ? 1 : 0;
    u.uPulse.value = trail && trail.pulse ? 1 : 0;
    if (trail) [u.uC0, u.uC1, u.uC2].forEach((c, i) => c.value.set(trail.colors[Math.min(i, trail.colors.length - 1)]));
  }

  // The shop's turntable turned the fox (and the ribbon, which rides on it) by
  // angle: swing the points already laid down back the other way, so they stay
  // put while the board turns away and the ribbon bends after it.
  turn(angle) {
    const c = Math.cos(-angle), sn = Math.sin(-angle);
    for (const p of this.pts) {
      const z = this.lastDist - p.d;
      const x = p.x * c + z * sn;
      p.d = this.lastDist - (-p.x * sn + z * c);
      p.x = x;
    }
  }

  // on: riding (the ribbon hides otherwise)
  // gap: metres from the rider to where the ribbon shows.
  // yaw: the board's turn (rider.yaw). The ribbon starts at the board's tail,
  // which swings out as the board turns, and each point stays where the tail
  // actually was, so turning and panning bend it instead of sliding it sideways
  // stiffly (owner, 2026-11-26).
  update(dt, x, y, dist, on, gap = 1.3, yaw = 0) {
    this.t += dt;
    this.lastDist = dist;
    this.pts.unshift({ x: x + Math.sin(yaw) * TAIL, y, d: dist - Math.cos(yaw) * TAIL });
    if (this.pts.length > SPEED_N) this.pts.pop();
    this.uniforms.uT.value = this.t;
    const n = this.pts.length;
    const at = (i) => this.pts[Math.min(i, n - 1)];
    const lead = Math.max(0, gap - TAIL); // clear snow between the tail and the ribbon
    let s = 0;
    for (let i = 0; i < SPEED_N; i++) {
      const p = at(i);
      if (i > 0) s += Math.hypot(p.x - at(i - 1).x, p.d - at(i - 1).d);
      const u = i / (SPEED_N - 1);
      // Grows out of nothing at the start, then tapers to a point.
      const w = 0.11 * (0.35 + 0.65 * Math.min(1, u / 0.12)) * (1 - u * 0.75);
      // Width across the ribbon's own direction, so a curve keeps its width.
      const a0 = at(Math.max(0, i - 1)), a1 = at(i + 1);
      let tx = a0.x - a1.x, tz = a1.d - a0.d;
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-4) (tx /= tl), (tz /= tl);
      else (tx = 0), (tz = 1);
      const z = -(p.d - dist);
      const v = i * 2;
      this.pos.setXYZ(v, p.x - w * tz, p.y + 0.04, z + w * tx);
      this.pos.setXYZ(v + 1, p.x + w * tz, p.y + 0.04, z - w * tx);
      // See-through (owner, 2026-11-26); fades in over the first metre after
      // the gap and out smoothly towards the end, so neither end is a hard cut.
      const fadeIn = Math.min(1, Math.max(0, (s - lead) / 1.1)), fadeOut = 1 - Math.max(0, (u - 0.35) / 0.65);
      const a = !on || i >= n ? 0 : fadeIn * fadeIn * (3 - 2 * fadeIn) * fadeOut * fadeOut * (3 - 2 * fadeOut) * 0.85;
      this.alpha.setX(v, a);
      this.alpha.setX(v + 1, a);
      const h = u * 1.5 - this.t * 1.2;
      this.hue.setX(v, h);
      this.hue.setX(v + 1, h);
    }
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.hue.needsUpdate = true;
  }
}
