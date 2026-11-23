// The Zero Chill fox's head, ears and tail: sculpted from deformed spheres with
// painted fur masks (orange / cream / dark tips) and a fur-stroke texture, so the
// mascot reads as a character rather than a stack of primitives.
import * as THREE from 'three';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Tiling fur strokes, mostly running "down" the v direction of the UVs.
let furTex = null;
export function furTexture() {
  if (furTex || typeof document === 'undefined') return furTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.lineCap = 'round';
  for (let i = 0; i < 700; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const len = 4 + rnd() * 7;
    const ang = Math.PI / 2 + (rnd() - 0.5) * 0.7;
    const light = rnd() < 0.3;
    g.strokeStyle = light ? 'rgba(255,255,255,0.45)' : `rgba(70,35,10,${0.04 + rnd() * 0.08})`;
    g.lineWidth = 1 + rnd() * 1.2;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len);
        g.stroke();
      }
    }
  }
  furTex = new THREE.CanvasTexture(c);
  furTex.wrapS = furTex.wrapT = THREE.RepeatWrapping;
  furTex.repeat.set(4, 2);
  furTex.colorSpace = THREE.SRGBColorSpace;
  return furTex;
}

// Mask attributes: aCream (0..1 blend to cream), aDark (0..1 darken, for ear tips).
function setMasks(geo, fn) {
  const pos = geo.attributes.position;
  const cream = new Float32Array(pos.count);
  const dark = new Float32Array(pos.count);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const m = fn(i);
    cream[i] = m[0];
    dark[i] = m[1];
  }
  geo.userData.cream = cream;
  geo.userData.dark = dark;
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export function paintMasks(geo, fur, cream) {
  const a = new THREE.Color(fur);
  const b = new THREE.Color(cream);
  const col = geo.attributes.color;
  const c = new THREE.Color();
  for (let i = 0; i < col.count; i++) {
    c.copy(a).lerp(b, geo.userData.cream[i]).multiplyScalar(1 - 0.32 * geo.userData.dark[i]);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// Head faces +x, up is +y. Returns the geometry plus landmark points.
export function headGeometry() {
  const R = 0.13;
  const geo = new THREE.SphereGeometry(R, 40, 30);
  const pos = geo.attributes.position;
  const n = new THREE.Vector3();
  const masks = [];
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    let x = n.x * R;
    let y = n.y * R * 0.93;
    let z = n.z * R * 1.08;
    // Wider, fluffier cheeks.
    const low = smooth(0.1, -0.55, n.y);
    z *= 1 + 0.12 * low * (1 - Math.abs(n.x) * 0.5);
    // Snout: pulled forward from the lower front, narrowed.
    const f = Math.pow(Math.max(0, n.x), 4) * Math.exp(-(((n.y + 0.26) / 0.3) ** 2));
    x += 0.085 * f;
    z *= 1 - 0.38 * f;
    y += 0.008 * f;
    // Cheek tufts flick out and down at the sides.
    const tuft = Math.exp(-(((n.y + 0.32) / 0.13) ** 2)) * Math.pow(Math.abs(n.z), 5);
    z += Math.sign(n.z) * 0.032 * tuft;
    y -= 0.014 * tuft;
    // Small brow ridge so the eyes sit in sockets.
    const brow = Math.exp(-(((n.y - 0.42) / 0.12) ** 2)) * Math.pow(Math.max(0, n.x), 2);
    x += 0.006 * brow;
    pos.setXYZ(i, x, y, z);
    // Cream lower face and muzzle; orange mask around the eyes and the crown.
    const c = Math.max(smooth(-0.05, -0.11, n.y) * smooth(-0.5, -0.3, n.x), smooth(0.3, 0.5, f) * smooth(0.08, 0.0, n.y));
    masks.push([c, 0]);
  }
  geo.computeVertexNormals();
  setMasks(geo, (i) => masks[i]);
  // Landmarks found on the deformed surface.
  const v = new THREE.Vector3();
  const surf = (yy, zz) => {
    let best = -1;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.x > 0 && Math.abs(v.y - yy) < 0.012 && Math.abs(v.z - zz) < 0.012 && v.x > best) best = v.x;
    }
    return best;
  };
  let tip = new THREE.Vector3(-1, 0, 0);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (v.x > tip.x) tip.copy(v);
  }
  return { geo, surf, tip };
}

export function earGeometry() {
  const geo = new THREE.ConeGeometry(0.068, 0.2, 14, 6).translate(0, 0.095, 0);
  geo.scale(0.42, 1, 1);
  const pos = geo.attributes.position;
  const masks = [];
  for (let i = 0; i < pos.count; i++) masks.push([0, smooth(0.13, 0.19, pos.getY(i))]);
  geo.computeVertexNormals();
  return setMasks(geo, (i) => masks[i]);
}
