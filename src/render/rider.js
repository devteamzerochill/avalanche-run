// The rider: a procedural jointed figure on a board. Poses are sets of numbers
// blended by the game state; legs and arms are solved with two-bone IK so the
// feet stay on the board whatever the body does.
import * as THREE from 'three';
import { toonRamp, outlineMaterial, ink } from './props.js';
import { furTexture, headGeometry, earGeometry, paintMasks } from './fox.js';

// Galaxy cloth (Shards shop, DECISIONS 68): a drifting nebula with twinkling
// stars, laid out in screen space so it reads as a window onto space rather
// than a print on the fabric. Shared clock and pixel scale for every galaxy part.
export const GALAXY = { uGTime: { value: 0 }, uGPx: { value: 1 / 800 } };
const GALAXY_HEAD = `
uniform float uGalaxy;
uniform float uGTime;
uniform float uGPx;
vec3 galaxyNebula(vec2 p) {
  float t = uGTime;
  float n = sin(p.x * 1.3 + t * 0.21) + sin(p.y * 1.7 - t * 0.17) + sin((p.x + p.y) * 0.9 + t * 0.13) + 0.6 * sin(length(p - vec2(2.0, 3.0)) * 2.1 - t * 0.3);
  n = n * 0.2 + 0.5;
  vec3 deep = vec3(0.05, 0.03, 0.2);
  vec3 violet = vec3(0.45, 0.12, 0.75);
  vec3 cyan = vec3(0.1, 0.65, 0.95);
  return mix(mix(deep, violet, smoothstep(0.45, 0.8, n)), cyan, smoothstep(0.82, 0.98, n));
}
float galaxyStars(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float h = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  vec2 c = vec2(fract(h * 13.7), fract(h * 71.3)) * 0.7 + 0.15;
  float tw = 0.45 + 0.55 * sin(uGTime * 3.0 + h * 40.0);
  return step(0.8, h) * smoothstep(0.16, 0.0, length(f - c)) * tw;
}
`;
function galaxyMaterial(m) {
  m.userData.galaxy = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGalaxy = m.userData.galaxy;
    sh.uniforms.uGTime = GALAXY.uGTime;
    sh.uniforms.uGPx = GALAXY.uGPx;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', GALAXY_HEAD + 'void main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  vec2 gp = gl_FragCoord.xy * uGPx * 9.0;
  vec3 gNeb = galaxyNebula(gp * 0.9);
  if (uGalaxy > 0.5) diffuseColor.rgb = gNeb;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  if (uGalaxy > 0.5) totalEmissiveRadiance += gNeb * 0.12 + vec3(galaxyStars(gp * 7.0) + 0.7 * galaxyStars(gp * 11.0 + 11.0)) * 1.8;`
      );
  };
  return m;
}

const Y = new THREE.Vector3(0, 1, 0);

// Parts that never move against their joint are drawn as one mesh per
// material (DECISIONS 77): the fox was 126 draw calls, most of a budget
// phone's frame. parts: [{ geo, m }] with m the part's matrix in joint space.
const HIDDEN = 31; // the camera never renders this layer: the source parts stay for re-baking
const _v = new THREE.Vector3();
const _n = new THREE.Matrix3();
function mergeParts(parts, withColor) {
  let nv = 0;
  let ni = 0;
  for (const { geo } of parts) {
    nv += geo.attributes.position.count;
    ni += geo.index ? geo.index.count : geo.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = withColor ? new Float32Array(nv * 3) : null;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const { geo, m } of parts) {
    const P = geo.attributes.position;
    const N = geo.attributes.normal;
    const U = geo.attributes.uv;
    const C = geo.attributes.color;
    _n.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      const o = (vo + i) * 3;
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      pos[o] = _v.x;
      pos[o + 1] = _v.y;
      pos[o + 2] = _v.z;
      if (N) {
        _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize();
        nor[o] = _v.x;
        nor[o + 1] = _v.y;
        nor[o + 2] = _v.z;
      }
      if (U) {
        uv[(vo + i) * 2] = U.getX(i);
        uv[(vo + i) * 2 + 1] = U.getY(i);
      }
      if (col && C) {
        col[o] = C.getX(i);
        col[o + 1] = C.getY(i);
        col[o + 2] = C.getZ(i);
      }
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) idx[io + i] = geo.index.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io + i] = vo + i;
    io += geo.index ? geo.index.count : P.count;
    vo += P.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
const THIGH = 0.37;
const SHIN = 0.37;
const UPPER = 0.27;
const FORE = 0.26;
const TORSO = 0.44;

// hip [x,y,z], leanF (towards toes, +x), leanS (towards travel, -z), hands, board tweak,
// head yaw (negative turns the face to the chase camera, positive looks downhill).
const POSES = {
  idle: { hx: 0.0, hy: 0.8, hz: 0.0, lf: 0.1, ls: 0.0, fx: 0.16, fy: 0.62, fz: -0.3, rx: 0.14, ry: 0.6, rz: 0.3, br: 0, by: 0, bp: 0, head: -0.5 },
  ride: { hx: 0.03, hy: 0.63, hz: 0.0, lf: 0.36, ls: -0.06, fx: 0.3, fy: 0.78, fz: -0.48, rx: 0.2, ry: 0.72, rz: 0.46, br: 0, by: 0, bp: 0, head: 1.05 },
  tuck: { hx: 0.05, hy: 0.5, hz: -0.02, lf: 0.62, ls: -0.12, fx: 0.34, fy: 0.55, fz: -0.34, rx: 0.3, ry: 0.5, rz: 0.3, br: 0, by: 0, bp: 0, head: 1.15 },
  air: { hx: 0.0, hy: 0.58, hz: 0.0, lf: 0.3, ls: 0.0, fx: 0.1, fy: 1.16, fz: -0.5, rx: 0.34, ry: 0.98, rz: 0.52, br: 0.0, by: 0.0, bp: -0.14, head: 0.95 },
  grab: { hx: -0.04, hy: 0.45, hz: 0.02, lf: 0.8, ls: 0.05, fx: -0.05, fy: 1.2, fz: -0.44, rx: 0.2, ry: 0.14, rz: 0.06, br: 0.38, by: 0.42, bp: -0.1, head: 0.75 },
  land: { hx: 0.04, hy: 0.4, hz: 0.0, lf: 0.72, ls: 0.0, fx: 0.4, fy: 0.5, fz: -0.52, rx: 0.36, ry: 0.5, rz: 0.52, br: 0, by: 0, bp: 0, head: 1.05 },
  flail: { hx: 0.1, hy: 0.58, hz: 0.0, lf: 0.9, ls: 0.1, fx: 0.4, fy: 1.1, fz: -0.6, rx: 0.5, ry: 0.3, rz: 0.6, br: 0.1, by: 0.2, bp: 0.1, head: 0.5 },
  cheer: { hx: 0.0, hy: 0.78, hz: 0.0, lf: 0.05, ls: 0.0, fx: 0.1, fy: 1.35, fz: -0.4, rx: 0.1, ry: 1.35, rz: 0.4, br: 0, by: 0, bp: 0, head: -0.4 },
};
const KEYS = Object.keys(POSES.ride);
const GOGGLES_DOWN = true;

// Black goggle lens with a faint glint so it still reads as glass.
let lensTex = null;
function lensTexture() {
  if (lensTex || typeof document === 'undefined') return lensTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 32);
  gr.addColorStop(0, '#2A2C33');
  gr.addColorStop(0.5, '#0B0C10');
  gr.addColorStop(1, '#16171C');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.beginPath();
  g.moveTo(70, 0);
  g.lineTo(82, 0);
  g.lineTo(66, 32);
  g.lineTo(54, 32);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.fillRect(88, 0, 4, 32);
  lensTex = new THREE.CanvasTexture(c);
  lensTex.colorSpace = THREE.SRGBColorSpace;
  return lensTex;
}

// "ZERO CHILL" print on the hoodie chest, drawn once to a canvas.
let logoTex = null;
function chestLogo() {
  if (!logoTex && typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'italic 900 50px "Arial Black", Impact, sans-serif';
    g.lineWidth = 8;
    g.strokeStyle = '#7a2a08';
    g.strokeText('ZERO CHILL', 128, 40, 236);
    g.fillStyle = '#FF8A1F';
    g.fillText('ZERO CHILL', 128, 40, 236);
    g.font = 'bold 20px Arial, sans-serif';
    g.fillStyle = '#FFB566';
    g.fillText('PROOF OF PLAY', 128, 80);
    logoTex = new THREE.CanvasTexture(c);
    logoTex.colorSpace = THREE.SRGBColorSpace;
    logoTex.anisotropy = 4;
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.15, 0.056).rotateY(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, depthWrite: false })
  );
  m.position.set(0.158, 0.06, 0);
  return m;
}

export class Rider {
  constructor(opts) {
    this.ghost = !!(opts && opts.ghost);
    this.root = new THREE.Group(); // position in the slope frame
    this.body = new THREE.Group(); // lean / yaw / tumble
    this.root.add(this.body);
    this.pose = Object.assign({}, POSES.idle);
    this.target = Object.assign({}, POSES.idle);
    this.landPulse = 0;
    this.flailT = 0;
    this.lean = 0;
    this.yaw = 0;
    this.time = 0;

    const mk = (hex, o) => (this.ghost ? null : new THREE.MeshToonMaterial(Object.assign({ color: hex, gradientMap: toonRamp() }, o)));
    const fur = this.ghost ? null : furTexture();
    this.ghostMat = this.ghost ? new THREE.MeshBasicMaterial({ color: '#7fe3ff', transparent: true, opacity: 0.32, depthWrite: false, fog: false }) : null;
    // The rider is the Zero Chill fox: fur, cream ruff, hoodie, shorts, goggles, headphones.
    this.mats = {
      fur: mk('#E8622A', { map: fur }), cream: mk('#FFF3E6', { map: fur }), furVC: mk('#ffffff', { map: fur, vertexColors: true }),
      hoodie: this.ghost ? null : galaxyMaterial(mk('#18191F')), trim: mk('#FF6B1A'), shorts: mk('#18191F'),
      shortsTrim: mk('#E0262E'), gear: mk('#2F6BFF'), dark: mk('#0E0F13'), boot: mk('#24262E'),
      nose: mk('#2A1410'), iris: mk('#C2410C'), innerEar: mk('#B9A497', { map: fur }),
      sclera: this.ghost ? null : new THREE.MeshBasicMaterial({ color: '#FBF8F2' }), shine: this.ghost ? null : new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      deck: this.ghost ? null : galaxyMaterial(mk('#15161A')), stripe: mk('#1E6FE8'), edge: mk('#E0262E'),
    };
    const mat = (name) => this.ghostMat || this.mats[name];
    const ink = this.ghost ? null : outlineMaterial(0.013);
    const add = (geo, name, parent, bare) => {
      const m = new THREE.Mesh(geo, mat(name));
      (parent || this.body).add(m);
      if (ink && !bare) m.add(new THREE.Mesh(geo, ink));
      return m;
    };

    // Board: rounded plank along z.
    this.board = new THREE.Group();
    this.body.add(this.board);
    const shape = new THREE.Shape();
    const w = 0.17;
    const l = 0.8;
    const r = 0.16;
    shape.moveTo(-w, -l + r);
    shape.lineTo(-w, l - r);
    shape.quadraticCurveTo(-w, l, 0, l + 0.03);
    shape.quadraticCurveTo(w, l, w, l - r);
    shape.lineTo(w, -l + r);
    shape.quadraticCurveTo(w, -l, 0, -l - 0.03);
    shape.quadraticCurveTo(-w, -l, -w, -l + r);
    const deckGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false, curveSegments: 5 }).rotateX(Math.PI / 2).translate(0, 0.075, 0);
    add(deckGeo, 'deck', this.board);
    add(new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, curveSegments: 5 }).rotateX(Math.PI / 2).translate(0, 0.032, 0).scale(1.05, 1, 1.02), 'edge', this.board);
    add(new THREE.BoxGeometry(0.3, 0.012, 0.5).translate(0, 0.082, 0), 'stripe', this.board);
    add(new THREE.BoxGeometry(0.24, 0.012, 0.12).translate(0, 0.082, -0.62), 'stripe', this.board);
    this.bootF = add(new THREE.BoxGeometry(0.3, 0.12, 0.15), 'boot', this.board);
    this.bootR = add(new THREE.BoxGeometry(0.3, 0.12, 0.15), 'boot', this.board);
    this.bootF.position.set(0.02, 0.14, -0.26);
    this.bootR.position.set(0.02, 0.14, 0.26);
    // Furry paws poking out over the bindings.
    for (const b of [this.bootF, this.bootR]) {
      add(new THREE.SphereGeometry(0.085, 14, 10).scale(1.25, 0.6, 1).translate(0.07, 0.07, 0), 'cream', b);
      for (const tz of [-0.042, 0, 0.042]) add(new THREE.SphereGeometry(0.03, 8, 6).scale(1.2, 0.8, 1).translate(0.165, 0.055, tz), 'cream', b);
    }

    const limb = (rad, name) => add(new THREE.CapsuleGeometry(rad, 1, 3, 12), name);
    this.thighF = limb(0.095, 'shorts');
    this.shinF = limb(0.07, 'fur');
    this.thighR = limb(0.095, 'shorts');
    this.shinR = limb(0.07, 'fur');
    this.upperF = limb(0.07, 'hoodie');
    this.foreF = limb(0.062, 'hoodie');
    this.upperR = limb(0.07, 'hoodie');
    this.foreR = limb(0.062, 'hoodie');
    // White paws with orange cuffs where they meet the sleeves.
    this.handF = add(new THREE.SphereGeometry(0.075, 14, 10).scale(1, 1, 1.1), 'cream');
    this.handR = add(new THREE.SphereGeometry(0.075, 14, 10).scale(1, 1, 1.1), 'cream');
    for (const h of [this.handF, this.handR]) add(new THREE.TorusGeometry(0.06, 0.018, 6, 16).rotateX(Math.PI / 2).translate(0, 0.045, 0), 'trim', h);
    this.hips = add(new THREE.SphereGeometry(0.16, 18, 12).scale(0.95, 0.72, 1.1), 'shorts');
    add(new THREE.BoxGeometry(0.16, 0.1, 0.02).translate(0, -0.01, 0.168), 'shortsTrim', this.hips);
    add(new THREE.BoxGeometry(0.16, 0.1, 0.02).translate(0, -0.01, -0.168), 'shortsTrim', this.hips);
    this.torso = add(new THREE.CapsuleGeometry(0.15, 0.24, 4, 16), 'hoodie');
    this.torso.scale.set(0.95, 1, 1.25);
    // Hoodie hem band and the hood bunched at the back of the neck.
    add(new THREE.CylinderGeometry(0.152, 0.152, 0.05, 12, 1, true).translate(0, -0.15, 0), 'trim', this.torso);
    add(new THREE.SphereGeometry(0.11, 8, 6).scale(0.8, 0.7, 1.1).translate(-0.1, 0.2, 0), 'hoodie', this.torso);
    // Fox neck and chest fluff spilling out of the collar.
    add(new THREE.CylinderGeometry(0.075, 0.09, 0.1, 14).translate(0, 0.25, 0), 'fur', this.torso);
    add(new THREE.SphereGeometry(0.075, 12, 9).scale(0.7, 0.9, 0.9).translate(0.085, 0.2, 0), 'cream', this.torso);
    if (!this.ghost) this.torso.add(chestLogo());

    this.head = new THREE.Group();
    this.body.add(this.head);
    const H = this.head;
    // One sculpted head: orange crown and eye mask, cream cheeks and muzzle.
    const hd = headGeometry();
    this.vc = [hd.geo];
    add(hd.geo, 'furVC', H);
    // Nose and a little ":3" smirk.
    add(new THREE.SphereGeometry(0.018, 12, 8).scale(0.9, 0.72, 1.25).translate(hd.tip.x - 0.003, hd.tip.y + 0.006, 0), 'nose', H, true);
    for (const s of [-1, 1]) {
      const mz = s * 0.012;
      const mx = Math.max(hd.surf(-0.064, mz), 0.12);
      add(new THREE.TorusGeometry(0.012, 0.0026, 4, 12, Math.PI).rotateY(Math.PI / 2).rotateX(Math.PI).translate(mx + 0.001, -0.058, mz), 'nose', H, true);
    }
    // Big confident eyes: sclera, iris, pupil, shine, half lid, thick brow.
    // Hidden while the goggles are down over them (set GOGGLES_DOWN false to show).
    for (const s of GOGGLES_DOWN ? [] : [-1, 1]) {
      const ez = s * 0.05;
      const eye = new THREE.Group();
      eye.position.set(hd.surf(0.022, ez) - 0.013, 0.022, ez);
      eye.rotation.set(0, -s * 0.42, 0);
      H.add(eye);
      add(new THREE.SphereGeometry(0.031, 16, 12).scale(0.55, 1.12, 0.95), 'sclera', eye, true);
      add(new THREE.SphereGeometry(0.021, 14, 10).scale(0.45, 1.05, 1).translate(0.011, -0.002, -s * 0.004), 'iris', eye, true);
      add(new THREE.SphereGeometry(0.0115, 10, 8).scale(0.45, 1.1, 1).translate(0.0165, -0.002, -s * 0.005), 'nose', eye, true);
      if (!this.ghost) {
        const sh = new THREE.Mesh(new THREE.SphereGeometry(0.0048, 8, 6).translate(0.02, 0.008, -s * 0.001), this.mats.shine);
        eye.add(sh);
      }
      const lid = add(new THREE.SphereGeometry(0.034, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.36).scale(0.6, 1.12, 1.0), 'fur', eye, true);
      lid.rotation.z = -0.35;
      const brow = add(new THREE.CapsuleGeometry(0.0085, 0.04, 3, 8).rotateX(Math.PI / 2), 'nose', eye, true);
      brow.position.set(0.012, 0.043, s * 0.004);
      brow.rotation.x = -s * 0.32;
    }
    // Ears: leaf-shaped with darker tips, grey-brown insides and white tufts.
    const earGeo = earGeometry();
    this.vc.push(earGeo);
    for (const s of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(-0.012, 0.098, s * 0.078);
      ear.rotation.set(s * 0.36, 0, 0.1);
      H.add(ear);
      add(earGeo, 'furVC', ear);
      add(new THREE.ConeGeometry(0.045, 0.14, 10).scale(0.25, 1, 1).translate(0.016, 0.075, 0), 'innerEar', ear, true);
      for (const k of [-1, 0, 1]) add(new THREE.ConeGeometry(0.012, 0.07, 5).rotateX(k * 0.3).translate(0.024, 0.045, k * 0.012), 'cream', ear, true);
    }
    // Crown tuft.
    for (const k of [-1, 1]) add(new THREE.ConeGeometry(0.016, 0.05, 6).rotateZ(-0.5).rotateX(k * 0.25).translate(0.035, 0.122, k * 0.01), 'fur', H);
    // Big all-black snowboard goggles over the eyes: a wraparound frame, a dark
    // glossy lens covering the top half of the face, and a strap round the head.
    const gog = new THREE.Group();
    gog.position.set(-0.01, 0.035, 0);
    gog.rotation.z = 0.08;
    gog.scale.set(1, 1, 1.1);
    H.add(gog);
    const wrap = 2.0;
    const arc = (r, h) => new THREE.CylinderGeometry(r, r * 0.97, h, 24, 1, true, Math.PI / 2 - wrap / 2, wrap);
    add(arc(0.153, 0.13), 'dark', gog);
    add(arc(0.156, 0.116), 'dark', gog, true);
    if (!this.ghost) {
      const lens = new THREE.Mesh(arc(0.16, 0.1), new THREE.MeshBasicMaterial({ map: lensTexture(), side: THREE.DoubleSide }));
      gog.add(lens);
    }
    add(new THREE.TorusGeometry(0.148, 0.013, 5, 32).rotateX(Math.PI / 2).translate(0, 0.03, 0), 'dark', gog);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.035, 0.05, 0.02).translate(0.03, 0.02, s * 0.15), 'dark', gog);
    // Headphones: band over the top, cups with blue rings.
    add(new THREE.TorusGeometry(0.15, 0.013, 6, 24, Math.PI).rotateY(Math.PI / 2).translate(-0.025, 0.0, 0), 'dark', H);
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 18).rotateX(Math.PI / 2).translate(-0.025, -0.015, s * 0.148), 'dark', H);
      add(new THREE.TorusGeometry(0.042, 0.01, 6, 18).translate(-0.025, -0.015, s * 0.17), 'gear', H);
    }

    // Big bushy tail with a white tip: overlapping puffs that stream out with speed.
    this.tail = [];
    let parent = this.hips;
    const radii = [0.06, 0.09, 0.112, 0.128, 0.134, 0.128, 0.108, 0.075];
    for (let i = 0; i < radii.length; i++) {
      const seg = new THREE.Group();
      seg.position.set(i === 0 ? -0.15 : -0.085, i === 0 ? -0.03 : 0, 0);
      parent.add(seg);
      add(new THREE.SphereGeometry(radii[i], 14, 10).scale(1.45, 1, 1).translate(-0.05, 0, 0), i >= 6 ? 'cream' : 'fur', seg);
      this.tail.push(seg);
      parent = seg;
    }
    this.v = { hip: new THREE.Vector3(), chest: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), j: new THREE.Vector3(), t: new THREE.Vector3(), up: new THREE.Vector3(), hint: new THREE.Vector3() };
    this.root.scale.setScalar(1.22);
    this.head.scale.setScalar(1.65);
    this.handF.scale.setScalar(1.35);
    this.handR.scale.setScalar(1.35);
    this.spin = 0;
    for (const g of this.vc) paintMasks(g, '#E8622A', '#FFF3E6');
    // Joints whose fixed parts are baked (the tail swings, so it stays apart).
    this.bakeSets = [[this.board], [this.head], [this.torso], [this.hips, this.tail[0]], [this.handF], [this.handR]];
    this.bake();
    this.solve();
  }

  // (Re)build each joint's merged meshes from its fixed parts, which stay in
  // the scene graph on a layer the camera skips (setSkin repaints their colours).
  bake() {
    for (const [joint, skip] of this.bakeSets) {
      for (const m of joint.userData.baked || []) {
        joint.remove(m);
        m.geometry.dispose();
      }
      const byMat = new Map();
      const walk = (node, mat) => {
        for (const c of node.children) {
          if (c.userData.bake || c === skip) continue;
          c.updateMatrix();
          const m = mat.clone().multiply(c.matrix);
          if (c.isMesh) {
            if (!byMat.has(c.material)) byMat.set(c.material, []);
            byMat.get(c.material).push({ geo: c.geometry, m });
            c.layers.set(HIDDEN);
          }
          walk(c, m);
        }
      };
      if (joint.isMesh) {
        byMat.set(joint.material, [{ geo: joint.geometry, m: new THREE.Matrix4() }]);
        joint.layers.set(HIDDEN);
      }
      walk(joint, new THREE.Matrix4());
      joint.userData.baked = [];
      for (const [material, parts] of byMat) {
        const mesh = new THREE.Mesh(mergeParts(parts, !!material.vertexColors), material);
        mesh.userData.bake = true;
        joint.add(mesh);
        joint.userData.baked.push(mesh);
      }
    }
  }

  setSkin(rider, board) {
    if (this.ghost) return;
    const m = this.mats;
    if (rider) {
      for (const k of ['fur', 'cream', 'hoodie', 'trim', 'shorts', 'shortsTrim', 'gear']) if (rider[k]) m[k].color.set(rider[k]);
      for (const g of this.vc) paintMasks(g, rider.fur, rider.cream);
      this.bake(); // the baked head and ears carry copies of those colours
      m.hoodie.userData.galaxy.value = rider.fx === 'galaxy' ? 1 : 0;
    }
    if (board) {
      m.deck.userData.galaxy.value = board.fx === 'galaxy' ? 1 : 0;
      m.deck.color.set(board.deck);
      m.stripe.color.set(board.stripe);
      m.edge.color.set(board.edge);
    }
  }

  // See-through (a < 1) or solid (1): another racer fades when it would hide
  // the player's fox or the slope ahead (DECISIONS 71).
  setOpacity(a) {
    if (this.alpha === a) return;
    if (!this.allMats) {
      const set = new Set();
      this.root.traverse((o) => o.material && set.add(o.material));
      this.allMats = [...set].map((m) => ({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite }));
    }
    const solid = a >= 1;
    for (const b of this.allMats) {
      // The ink hull draws solid whatever the opacity: off while see-through.
      if (b.m.isShaderMaterial) {
        b.m.visible = solid && ink.on;
        continue;
      }
      const tr = solid ? b.transparent : true;
      // Opaque materials compile without alpha, so switching needs a rebuild (cached after once).
      if (b.m.transparent !== tr) b.m.needsUpdate = true;
      b.m.transparent = tr;
      b.m.opacity = b.opacity * a;
      b.m.depthWrite = solid ? b.depthWrite : false;
    }
    this.alpha = a;
  }

  place(mesh, a, b) {
    const t = this.v.t.subVectors(b, a);
    const len = Math.max(0.001, t.length());
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(Y, t.multiplyScalar(1 / len));
    mesh.scale.set(1, len, 1);
  }

  // Two-bone IK: joint position between a and b, bending towards hint.
  joint(a, b, l1, l2, hint) {
    const d = this.v.t.subVectors(b, a);
    let L = d.length();
    const max = l1 + l2 - 0.002;
    if (L > max) {
      b.copy(a).addScaledVector(d, max / L);
      d.subVectors(b, a);
      L = max;
    }
    d.multiplyScalar(1 / Math.max(L, 1e-4));
    const a1 = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a1 * a1));
    const perp = this.v.up.copy(hint).addScaledVector(d, -hint.dot(d));
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
    perp.normalize();
    return this.v.j.copy(a).addScaledVector(d, a1).addScaledVector(perp, h);
  }

  solve() {
    const p = this.pose;
    const v = this.v;
    // Board tweak (grabs tilt and turn the board under the body).
    this.board.rotation.set(p.bp, p.by, p.br);
    this.board.updateMatrix();
    v.hip.set(p.hx, p.hy, p.hz);
    // Torso direction from the two lean angles.
    const sx = Math.sin(p.lf);
    const sz = -Math.sin(p.ls);
    const up = v.up.set(sx, Math.sqrt(Math.max(0.05, 1 - sx * sx - sz * sz)), sz).normalize().clone();
    v.chest.copy(v.hip).addScaledVector(up, TORSO);
    this.hips.position.copy(v.hip);
    this.torso.position.copy(v.hip).addScaledVector(up, TORSO * 0.52);
    this.torso.quaternion.setFromUnitVectors(Y, up);
    this.head.position.copy(v.chest).addScaledVector(up, 0.29);
    this.head.rotation.set(0, p.head, 0);

    // Legs: hip sockets -> boots (which follow the board).
    const legs = [
      [this.thighF, this.shinF, -0.11, this.bootF],
      [this.thighR, this.shinR, 0.11, this.bootR],
    ];
    for (const [thigh, shin, oz, boot] of legs) {
      v.a.set(v.hip.x, v.hip.y - 0.04, v.hip.z + oz);
      v.b.copy(boot.position).applyMatrix4(this.board.matrix);
      v.b.y += 0.05;
      v.hint.set(1, 0.15, oz * 2.2);
      const j = this.joint(v.a, v.b, THIGH, SHIN, v.hint).clone();
      this.place(thigh, v.a, j);
      this.place(shin, j, v.b);
    }
    // Arms: shoulders -> hand targets.
    const arms = [
      [this.upperF, this.foreF, -0.2, this.handF, p.fx, p.fy, p.fz],
      [this.upperR, this.foreR, 0.2, this.handR, p.rx, p.ry, p.rz],
    ];
    for (const [upper, fore, oz, hand, tx, ty, tz] of arms) {
      v.a.copy(v.chest).addScaledVector(up, -0.05);
      v.a.z += oz;
      v.b.set(tx, ty, tz);
      v.hint.set(-0.4, -0.6, oz * 3);
      const j = this.joint(v.a, v.b, UPPER, FORE, v.hint).clone();
      this.place(upper, v.a, j);
      this.place(fore, j, v.b);
      hand.position.copy(v.b);
    }
  }

  // s: {mode, x, y, vx, air, grab, speed01, wipe, wipeT, caught, drift}
  update(dt, s) {
    this.time += dt;
    this.landPulse = Math.max(0, this.landPulse - dt * 3.2);
    this.flailT = Math.max(0, this.flailT - dt);
    let name = 'ride';
    if (s.mode === 'idle') name = 'idle';
    else if (s.mode === 'cheer') name = 'cheer';
    else if (s.wipe) name = 'flail';
    else if (s.air) name = s.grab ? 'grab' : 'air';
    else if (this.flailT > 0) name = 'flail';
    else if (s.speed01 > 0.75) name = 'tuck';
    const base = POSES[name];
    const k = 1 - Math.exp(-dt * (name === 'grab' || name === 'air' ? 16 : 11));
    for (const key of KEYS) {
      let tv = base[key];
      if (this.landPulse > 0 && !s.air) tv += (POSES.land[key] - tv) * Math.min(1, this.landPulse * 1.3);
      this.pose[key] += (tv - this.pose[key]) * k;
    }
    const p = this.pose;
    // Life: breathing, flailing arms.
    const wob = Math.sin(this.time * 2.2) * 0.012;
    p.hy += wob;
    if (name === 'flail') {
      p.fy += Math.sin(this.time * 19) * 0.25;
      p.ry += Math.cos(this.time * 17) * 0.25;
    }
    if (name === 'ride' || name === 'tuck') {
      // Inside hand drops towards the snow in a carve.
      const lean = this.lean;
      p.fy -= Math.max(0, lean) * 0.5;
      p.ry -= Math.max(0, -lean) * 0.5;
    }
    this.solve();
    p.hy -= wob;
    // Tail: curls up behind, streams uphill with speed, wags at rest, whips in the air.
    const sp = s.mode === 'idle' || s.mode === 'cheer' ? 0 : s.speed01 || 0;
    const wag = s.mode === 'idle' || s.mode === 'cheer' ? 0.35 : s.air ? 0.25 : 0.1;
    const rate = s.mode === 'cheer' ? 9 : s.air ? 11 : 4 + sp * 4;
    for (let i = 0; i < this.tail.length; i++) {
      const seg = this.tail[i];
      const ph = this.time * rate - i * 0.45;
      seg.rotation.z = i === 0 ? -0.2 + sp * 0.15 : -0.24 + sp * 0.14 + Math.cos(ph) * wag * 0.25;
      seg.rotation.y = (i === 0 ? 0.1 + sp * 0.85 : sp * 0.06) + Math.sin(ph) * wag * 0.62 - this.lean * (i === 0 ? 0.6 : 0);
    }

    this.root.position.set(s.x, s.y, 0);
    if (s.wipe) {
      const t = s.wipeT;
      const u = Math.min(1, t / 0.9);
      if (s.caught) this.body.rotation.set(u * 1.2, 0, Math.sin(t * 6) * 0.2 * (1 - u));
      else this.body.rotation.set(-t * 5 * (1 - u * 0.6), t * 2.2 * (1 - u * 0.6), Math.sin(t * 5) * 0.5 * (1 - u));
      this.body.position.y = Math.max(0, 0.7 * Math.sin(Math.min(Math.PI, t * 3.4))) + (s.caught ? 0 : u * 0.2);
      return;
    }
    this.body.position.y = 0;
    const leanT = THREE.MathUtils.clamp(-s.vx * 0.045, -0.55, 0.55) * (s.air ? 0.4 : 1);
    this.lean += (leanT - this.lean) * (1 - Math.exp(-dt * 12));
    const yawT = THREE.MathUtils.clamp(-s.vx * 0.032, -0.45, 0.45) + (s.drift || 0) * (s.vx > 0 ? -0.25 : 0.25);
    this.yaw += (yawT - this.yaw) * (1 - Math.exp(-dt * 10));
    const idleSway = s.mode === 'idle' ? Math.sin(this.time * 1.3) * 0.04 : 0;
    // Grabs spin the rider; letting go snaps back to forward.
    if (s.air && s.grab) this.spin += dt * 13;
    else if (this.spin !== 0) {
      const turn = Math.PI * 2;
      const goal = Math.ceil(this.spin / turn - 0.15) * turn;
      this.spin += (goal - this.spin) * (1 - Math.exp(-dt * 22));
      if (!s.air || Math.abs(goal - this.spin) < 0.02) this.spin = 0;
    }
    this.body.rotation.set(s.air ? -0.14 + (s.vyNorm || 0) * -0.12 : (s.boost || 0) * -0.16, this.yaw + idleSway + this.spin, this.lean);
  }

  land(strength) {
    this.landPulse = Math.max(this.landPulse, strength);
  }

  flail(seconds) {
    this.flailT = seconds;
  }
}
