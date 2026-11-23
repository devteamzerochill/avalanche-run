// Renderer, scene graph, sky, backdrop mountains, lights and biome moods.
import * as THREE from 'three';
import { FRAME } from '../ui/frame.js';
import { CONFIG } from '../config.js';
import { mulberry32 } from '../core/rng.js';
import { Terrain } from './terrain.js';

const C = (hex) => new THREE.Color(hex);

// One mood per biome (the forest has two: the prototype's Morning and Midday).
function moods() {
  const L = CONFIG.look;
  const custom = L.skyTopColor.toUpperCase() !== '#2F7FD8';
  return {
    forestMorning: {
      skyTop: C(custom ? L.skyTopColor : '#1E78FF'), horizon: C('#9BE4FF'), fog: C('#B9ECFF'),
      snow: C('#FFFFFF'), piste: C('#F1F9FF'), shade: C('#8CC4FF'),
      sun: C('#FFE9A8'), sunDir: new THREE.Vector3(0.55, 0.5, -0.67).normalize(), sunInt: 2.6,
      hemiSky: C('#cfeaff'), hemiGround: C('#ffffff'), hemiInt: 1.5,
      mountain: C('#a9d4ff'), accent: C('#35d6ff'), stars: 0, snowfall: 0.9, fogNear: 110, fogFar: 400, sparkle: 0.8, sunGlow: 1, clouds: 1, rainbow: 1,
    },
    forestMidday: {
      skyTop: C(custom ? L.skyTopColor : '#1466F2'), horizon: C('#A8E8FF'), fog: C('#C4EEFF'),
      snow: C('#FFFFFF'), piste: C('#F1F9FF'), shade: C('#9CCBFF'),
      sun: C('#FFF6DC'), sunDir: new THREE.Vector3(0.25, 0.85, -0.45).normalize(), sunInt: 2.5,
      hemiSky: C('#cfeaff'), hemiGround: C('#ffffff'), hemiInt: 1.6,
      mountain: C('#a9d4ff'), accent: C('#35d6ff'), stars: 0, snowfall: 0.85, fogNear: 110, fogFar: 420, sparkle: 0.8, sunGlow: 0.8, clouds: 1, rainbow: 0.6,
    },
    glacier: {
      skyTop: C('#00A6C8'), horizon: C('#B8FFF0'), fog: C('#A8F4F0'),
      snow: C('#EFFFFF'), piste: C('#D6FBFF'), shade: C('#4FD0E8'),
      sun: C('#FFFFFF'), sunDir: new THREE.Vector3(-0.45, 0.62, -0.64).normalize(), sunInt: 2.6,
      hemiSky: C('#b8f6ff'), hemiGround: C('#e6ffff'), hemiInt: 1.5,
      mountain: C('#7fe0ee'), accent: C('#ff4fd8'), stars: 0, snowfall: 0.8, fogNear: 120, fogFar: 430, sparkle: 1.3, sunGlow: 0.9, clouds: 0.7, rainbow: 0,
    },
    storm: {
      skyTop: C('#1A0B4D'), horizon: C('#FF4FB0'), fog: C('#6A3FB8'),
      snow: C('#C9B8FF'), piste: C('#B9A6FF'), shade: C('#5B3FC0'),
      sun: C('#FFB0F0'), sunDir: new THREE.Vector3(-0.3, 0.6, -0.74).normalize(), sunInt: 1.9,
      hemiSky: C('#a48cff'), hemiGround: C('#c0a8ff'), hemiInt: 1.35,
      mountain: C('#3a1f8a'), accent: C('#ffe14d'), stars: 1, snowfall: 1, fogNear: 70, fogFar: 330, sparkle: 0.6, sunGlow: 0.9, clouds: 0.25, rainbow: 0,
    },
  };
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform float uStars;
uniform float uGlow;
uniform float uTime;
uniform float uClouds;
uniform float uRainbow;
varying vec3 vDir;
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
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 1.5 + 0.1, 0.0, 1.0);
  // Banded gradient for a painted, arcade sky.
  float band = floor(pow(h, 0.7) * 7.0) / 7.0;
  vec3 col = mix(uHorizon, uTop, mix(pow(h, 0.7), band, 0.35));
  // Sun disc, halo and slow spinning rays.
  float s = max(dot(d, uSunDir), 0.0);
  vec3 side = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 upv = cross(side, uSunDir);
  float ang = atan(dot(d, upv), dot(d, side));
  float rays = (0.5 + 0.5 * sin(ang * 12.0 + uTime * 0.4)) * pow(s, 14.0);
  col += uSun * (step(0.9975, s) * 1.2 + pow(s, 40.0) * 0.5 + rays * 0.35) * uGlow;
  // Puffy clouds with a hard edge and a shaded belly.
  if (uClouds > 0.01) {
    vec2 q = d.xz / (d.y + 0.28) * 1.6 + vec2(uTime * 0.012, 0.0);
    float n = noise(q) * 0.6 + noise(q * 2.1 + 4.0) * 0.3 + noise(q * 4.3) * 0.1;
    float cover = smoothstep(0.56, 0.6, n) * smoothstep(0.02, 0.16, d.y);
    float belly = smoothstep(0.6, 0.72, n);
    vec3 cloud = mix(mix(uHorizon, vec3(1.0), 0.55), vec3(1.0), belly);
    col = mix(col, cloud, cover * uClouds * 0.95);
  }
  // Rainbow opposite the sun.
  if (uRainbow > 0.01) {
    vec3 anti = normalize(vec3(-uSunDir.x, -0.25, -uSunDir.z));
    float r = acos(clamp(dot(d, anti), -1.0, 1.0));
    float t = (r - 0.62) / 0.09;
    if (t > 0.0 && t < 1.0) {
      vec3 rb = 0.5 + 0.5 * cos(6.2832 * (t * 0.85 + vec3(0.0, 0.33, 0.67)));
      col = mix(col, rb, 0.42 * uRainbow * smoothstep(0.0, 0.15, t) * smoothstep(1.0, 0.85, t) * smoothstep(0.0, 0.2, d.y));
    }
  }
  if (uStars > 0.01) {
    vec2 g = d.xz / (abs(d.y) + 0.35) * 42.0;
    vec2 cell = floor(g);
    float r = hash(cell);
    vec2 f = fract(g) - 0.5 - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6;
    float star = step(0.93, r) * smoothstep(0.1, 0.0, length(f)) * (0.6 + 0.4 * sin(uTime * 2.0 + r * 40.0));
    col += vec3(1.0, 0.95, 0.8) * star * uStars * smoothstep(0.02, 0.3, d.y);
    // Neon aurora ribbons.
    float wave = sin(d.x * 6.0 + sin(d.z * 3.0 + uTime * 0.35) * 1.8);
    float rib = smoothstep(0.55, 1.0, wave) * smoothstep(0.1, 0.32, d.y) * smoothstep(0.75, 0.35, d.y);
    col += mix(vec3(0.1, 1.0, 0.75), vec3(1.0, 0.3, 0.9), 0.5 + 0.5 * sin(d.x * 3.0 + uTime * 0.2)) * rib * 0.5 * uStars;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Stage {
  constructor(container, opts) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!(opts && opts.preserve) });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.setAttribute('data-game-scene', '1');
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#cfe4f2', 90, 380);
    this.camera = new THREE.PerspectiveCamera(70, 0.46, 0.3, 4000);

    // Everything on the slope lives in a tilted group, so game code is "flat".
    this.world = new THREE.Group();
    this.world.rotation.x = -THREE.MathUtils.degToRad(CONFIG.camera.slopeDeg);
    this.scene.add(this.world);
    this.world.add(this.camera);
    this.rear = new THREE.PerspectiveCamera(72, 2.2, 0.3, 1200);
    this.world.add(this.rear);

    this.hemi = new THREE.HemisphereLight('#cde9ff', '#f2f6fb', 1.25);
    this.sun = new THREE.DirectionalLight('#ffe6c2', 2.5);
    this.fill = new THREE.DirectionalLight('#cfe2ff', 0.6);
    this.fill.position.set(-0.4, 0.6, 1);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fill);

    this.terrain = new Terrain();
    this.world.add(this.terrain.mesh);

    // Sky dome, drawn at the far plane.
    this.skyUniforms = {
      uTop: { value: C('#2F7FD8') },
      uHorizon: { value: C('#dff0fa') },
      uSun: { value: C('#ffd9a8') },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uStars: { value: 0 },
      uGlow: { value: 1 },
      uTime: { value: 0 },
      uClouds: { value: 1 },
      uRainbow: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 24, 12),
      new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false })
    );
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);

    this.backdrop = new THREE.Group();
    this.scene.add(this.backdrop);
    this.buildMountains();

    this.moods = moods();
    this.mood = this.cloneMood(this.moods.forestMorning);
    this.sunLocal = new THREE.Vector3();
    this.tmpV = new THREE.Vector3();
    this.tmpQ = new THREE.Quaternion();
    this.width = 1;
    this.height = 1;
    this.prScale = 1;
  }

  buildMountains() {
    // Three rings of jagged peaks, merged into one mesh with vertex colours.
    const rng = mulberry32(4242);
    const positions = [];
    const colors = [];
    const rings = [
      [2300, 430, 660, 12, 0.0],
      [1600, 300, 480, 10, 0.5],
      [1050, 200, 330, 9, 1.0],
    ];
    for (const [dist, hMin, hMax, count, near] of rings) {
      for (let i = 0; i < count; i++) {
        const ang = -1.2 + (i + rng() * 0.6) * (2.4 / count);
        const R = dist * (0.9 + rng() * 0.2);
        const h = hMin + rng() * (hMax - hMin);
        const w = h * (0.9 + rng() * 0.6);
        const cx = Math.sin(ang) * R;
        const cz = -Math.cos(ang) * R;
        const sides = 6;
        const tilt = (rng() - 0.5) * 0.3;
        const apex = [cx + w * tilt, -300 + h, cz];
        for (let s = 0; s < sides; s++) {
          const a0 = (s / sides) * Math.PI * 2 + i;
          const a1 = ((s + 1) / sides) * Math.PI * 2 + i;
          const r0 = w * (0.8 + 0.3 * Math.sin(s * 2.1 + i));
          const r1 = w * (0.8 + 0.3 * Math.sin((s + 1) * 2.1 + i));
          const p0 = [cx + Math.cos(a0) * r0, -300, cz + Math.sin(a0) * r0];
          const p1 = [cx + Math.cos(a1) * r1, -300, cz + Math.sin(a1) * r1];
          // Three bands per face: white cap with a jagged edge, mid tone, dark foot.
          const at = (p, t) => [apex[0] + (p[0] - apex[0]) * t, apex[1] + (p[1] - apex[1]) * t, apex[2] + (p[2] - apex[2]) * t];
          const shade = 0.72 + 0.28 * Math.cos(a0 + 0.8);
          const lit = shade > 0.8 ? 1 : 0.78;
          const capT = 0.3 + 0.1 * ((s + i) % 2);
          const midT = 0.68;
          const quad = (ta, tb, r, g, b2) => {
            const a = at(p0, ta), b3 = at(p1, ta), c = at(p0, tb), d2 = at(p1, tb);
            positions.push(...a, ...c, ...d2, ...a, ...d2, ...b3);
            for (let q = 0; q < 6; q++) colors.push(r, g, b2);
          };
          positions.push(...apex, ...at(p0, capT), ...at(p1, capT));
          for (let q = 0; q < 3; q++) colors.push(1.25 * lit, 1.25 * lit, 1.25 * lit);
          quad(capT, midT, 0.86 * lit, 0.9 * lit, 1.0 * lit);
          quad(midT, 1, (0.5 + near * 0.08) * lit, (0.56 + near * 0.08) * lit, 0.86 * lit);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.mountainMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, this.mountainMat);
    mesh.frustumCulled = false;
    this.backdrop.add(mesh);
    this.valleyMat = new THREE.MeshBasicMaterial({ color: '#9fb9cf', fog: false });
    const valley = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), this.valleyMat);
    valley.position.y = -300;
    this.backdrop.add(valley);
  }

  cloneMood(m) {
    const out = {};
    for (const k of Object.keys(m)) out[k] = m[k] && m[k].clone ? m[k].clone() : m[k];
    return out;
  }

  moodFor(biomeId) {
    if (biomeId === 'forest') return CONFIG.look.background === 'Midday' ? this.moods.forestMidday : this.moods.forestMorning;
    return this.moods[biomeId] || this.moods.forestMorning;
  }

  // Rebuild moods after colours changed through live parameters.
  refreshLook() {
    this.moods = moods();
  }

  // Ease the current mood towards a biome's mood (rate per second).
  blendMood(biomeId, dt, instant) {
    const target = this.moodFor(biomeId);
    const m = this.mood;
    const k = instant ? 1 : 1 - Math.exp(-dt * 0.9);
    for (const key of Object.keys(target)) {
      const tv = target[key];
      if (tv && tv.isColor) m[key].lerp(tv, k);
      else if (tv && tv.isVector3) m[key].lerp(tv, k).normalize();
      else m[key] += (tv - m[key]) * k;
    }
    this.applyMood();
  }

  applyMood() {
    const m = this.mood;
    this.scene.fog.color.copy(m.fog);
    this.scene.fog.near = m.fogNear;
    this.scene.fog.far = m.fogFar;
    this.hemi.color.copy(m.hemiSky);
    this.hemi.groundColor.copy(m.hemiGround);
    this.hemi.intensity = m.hemiInt;
    this.sun.color.copy(m.sun);
    this.sun.intensity = m.sunInt;
    this.sun.position.copy(m.sunDir).multiplyScalar(80);
    this.fill.intensity = 0.5 * m.hemiInt;
    const s = this.skyUniforms;
    s.uTop.value.copy(m.skyTop);
    s.uHorizon.value.copy(m.horizon);
    s.uSun.value.copy(m.sun);
    s.uSunDir.value.copy(m.sunDir);
    s.uStars.value = m.stars;
    s.uGlow.value = m.sunGlow;
    s.uClouds.value = m.clouds;
    s.uRainbow.value = m.rainbow;
    this.mountainMat.color.copy(m.mountain);
    this.valleyMat.color.copy(m.fog);
    // Sun direction in the tilted slope frame, for the snow shader.
    this.tmpQ.copy(this.world.quaternion).invert();
    this.sunLocal.copy(m.sunDir).applyQuaternion(this.tmpQ);
    const t = this.terrain.uniforms;
    t.uSnow.value.copy(m.snow);
    t.uPiste.value.copy(m.piste);
    t.uShade.value.copy(m.shade);
    t.uSunDir.value.copy(this.sunLocal);
    t.uSunCol.value.copy(m.sun);
    t.uFogCol.value.copy(m.fog);
    t.uFogNear.value = m.fogNear;
    t.uFogFar.value = m.fogFar;
    t.uSparkle.value = m.sparkle;
    t.uAccent.value.copy(m.accent);
  }

  resize(prScale) {
    if (prScale != null) this.prScale = prScale;
    // Layout size, not on-screen size: the portrait frame may be scaled as a whole.
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    const dpr = Math.min((window.devicePixelRatio || 1) * FRAME.scale, CONFIG.quality.maxPixelRatio * Math.max(1, FRAME.scale), 2.6); // 2.6 caps a framed canvas near 1170x2080
    this.renderer.setPixelRatio(Math.max(0.5, dpr * this.prScale));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(time) {
    this.skyUniforms.uTime.value = time;
    // Sky and backdrop ride along with the camera.
    this.camera.getWorldPosition(this.tmpV);
    this.sky.position.copy(this.tmpV);
    this.backdrop.position.set(this.tmpV.x, this.tmpV.y, this.tmpV.z);
    this.renderer.render(this.scene, this.camera);
  }

  // Rear-view mirror: a second, small pass looking back up the slope.
  // rect is in CSS pixels relative to the canvas (left, top, width, height).
  renderMirror(rect, x, ground, gap) {
    const r = this.renderer;
    const cam = this.rear;
    cam.aspect = rect.width / rect.height;
    cam.updateProjectionMatrix();
    // As the wall closes in, widen the lens and tilt up a little.
    const close = Math.min(1, Math.max(0, 1 - (gap - 7) / 18));
    cam.fov = 68 + 16 * close;
    cam.updateProjectionMatrix();
    cam.position.set(x * 0.6, ground + 2.4 + 1.5 * close, -4.5);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.tmpV.set(x * 0.8, ground + 5 + 4 * close, gap).applyMatrix4(this.world.matrixWorld));
    const y = this.height - rect.top - rect.height;
    r.setScissorTest(true);
    r.setViewport(rect.left, y, rect.width, rect.height);
    r.setScissor(rect.left, y, rect.width, rect.height);
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, cam);
    r.autoClear = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
  }
}
