// The avalanche: a huge wall of snow. Cel-shaded billows with a soft crest
// line; flanks that run ahead of the rider; a rolling front of snow boulders; powder.
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';
import { toonRamp, outlineMaterial, outlineGeo } from './props.js';

const VERT = /* glsl */ `
uniform float uTime;
uniform float uZ;
uniform float uGround;
uniform float uDanger;
varying vec2 vUv;
varying float vX;
void main() {
  vUv = uv;
  // A lobe of snow about two pistes wide, rounded off at both ends.
  float t = abs(uv.x - 0.5) * 2.0;
  float x = (uv.x - 0.5) * 40.0;
  float dome = sqrt(max(0.0, 1.0 - t * t * t));
  float h = (17.0 + 7.0 * uDanger + 3.0 * sin(x * 0.3 + uTime * 0.8) + 2.0 * sin(x * 0.7 - uTime * 1.1)) * (0.25 + 0.75 * dome);
  float y = uv.y * h;
  float curl = uv.y * uv.y * (5.0 + 4.0 * uDanger + 1.5 * sin(x * 0.11 + uTime * 1.3));
  float bulge = sin(uv.y * 5.0 + x * 0.2 - uTime * 2.2) * 1.0 * uv.y;
  // The ends sweep back, so it reads as a tongue pushing down the piste.
  vec3 p = vec3(x, uGround + y - 1.0, uZ + t * t * 9.0 - curl + bulge);
  vX = x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */ `
uniform float uTime;
uniform float uDanger;
uniform vec3 uLight;
uniform vec3 uShade;
uniform vec3 uInk;
varying vec2 vUv;
varying float vX;
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
  vec2 q = vec2(vX * 0.11, vUv.y * 2.6 + uTime * 1.3);
  float n = noise(q) * 0.55 + noise(q * 2.3 + 7.0) * 0.3 + noise(q * 5.1 - uTime) * 0.15;
  // Cel bands: bright billow, shaded billow, dark hollows.
  float v = n * (0.62 + 0.45 * vUv.y);
  // Three clear tones so it reads as a churning mass, not as sky.
  vec3 mid = mix(uShade, uInk, 0.22);
  vec3 dark = mix(uShade, uInk, 0.48);
  vec3 col = v > 0.5 ? uLight : v > 0.36 ? mid : dark;
  // Dark, heavy foot.
  col = mix(mix(uInk, uShade, 0.3), col, smoothstep(0.0, 0.28, vUv.y + n * 0.1));
  // Ink line along the crest.
  float crest = 0.8 + n * 0.16;
  col = mix(col, mix(uShade, uInk, 0.6), smoothstep(crest - 0.045, crest - 0.035, vUv.y));
  if (vUv.y > crest) discard;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const CHUNKS = 110;

export class Avalanche {
  constructor(stage) {
    this.stage = stage;
    this.uniforms = {
      uTime: { value: 0 },
      uZ: { value: 30 },
      uGround: { value: 0 },
      uDanger: { value: 0 },
      uLight: { value: new THREE.Color('#ffffff') },
      uShade: { value: new THREE.Color('#9db9da') },
      uInk: { value: new THREE.Color('#14182a') },
    };
    this.wall = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 48, 10),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide })
    );
    this.wall.frustumCulled = false;
    stage.world.add(this.wall);

    const geo = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
    geo.computeVertexNormals();
    this.chunkMat = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp() });
    this.chunks = new THREE.InstancedMesh(geo, this.chunkMat, CHUNKS);
    this.chunks.frustumCulled = false;
    stage.world.add(this.chunks);
    const hull = new THREE.InstancedMesh(outlineGeo(geo), outlineMaterial(0.03), CHUNKS);
    hull.instanceMatrix = this.chunks.instanceMatrix;
    hull.frustumCulled = false;
    stage.world.add(hull);
    const rng = mulberry32(7);
    this.seeds = [];
    for (let i = 0; i < CHUNKS; i++) this.seeds.push({ x: -19 + rng() * 38, back: rng() * 20, up: rng(), s: 1.0 + rng() * 2.0, ph: rng() * 6.3, sp: 0.8 + rng() * 1.8 });
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
  }

  // How far the ends of the lobe trail behind its centre.
  flank(x) {
    const t = Math.min(1, Math.abs(x) / 20);
    return -t * t * 9;
  }

  update(time, gap, danger, dist, particles, share, keepBehind) {
    const terrain = this.stage.terrain;
    const mood = this.stage.mood;
    const u = this.uniforms;
    u.uTime.value = time;
    // Never draw the wall in front of the chase camera: when it is this close,
    // the flanks, debris, shake and frost carry the threat instead.
    const near = keepBehind || 0;
    u.uZ.value = Math.max(gap + 2, near + 4);
    u.uDanger.value = danger;
    u.uGround.value = terrain.groundAt(dist - gap);
    u.uLight.value.copy(mood.snow).lerp(WHITE, 0.6);
    u.uShade.value.copy(mood.shade);
    this.chunkMat.color.copy(mood.snow).lerp(WHITE, 0.5);

    for (let i = 0; i < CHUNKS; i++) {
      const c = this.seeds[i];
      const w = time * c.sp + c.ph;
      let z = gap - this.flank(c.x) + c.back * 0.5 + Math.sin(w) * 0.8;
      // Boulders never roll over the camera (it would end up inside one).
      const clear = near + 3 + c.s * 1.9;
      if (near > 0 && z < clear) z = clear + c.back * 0.3;
      const y = terrain.groundAt(dist - z) + c.up * (1.5 + 3.5 * (1 - c.back / 20)) + Math.abs(Math.sin(w * 0.7)) * 1.8;
      const s = c.s * (0.85 + 0.25 * Math.sin(w * 1.3)) * (1 + danger * 0.6);
      this.e.set(w * 0.9, w * 0.5, 0);
      this.q.setFromEuler(this.e);
      this.p.set(c.x, y, z);
      this.s.set(s, s * 0.9, s);
      this.m.compose(this.p, this.q, this.s);
      this.chunks.setMatrixAt(i, this.m);
      // Powder thrown forward off the front.
      if (particles && Math.random() < (0.05 + danger * 0.14) * share) {
        particles.emit(c.x, y + s * 0.5, dist - z + s, (Math.random() - 0.5) * 4, 2 + Math.random() * 5, (8 + Math.random() * 16) * (0.4 + danger), 1.5, 1.8 + Math.random() * 2.6, 0.55, 1.5, 0);
      }
    }
    this.chunks.instanceMatrix.needsUpdate = true;
  }
}
const WHITE = new THREE.Color('#ffffff');
