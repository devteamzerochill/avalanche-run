// Chase camera in the slope frame. Prototype framing, plus: speed and boost
// FOV kicks, landing dip, carve roll, an intro shot that looks back up at the
// avalanche, and a swing back to the wall when it catches the rider.
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const ease = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const rad = THREE.MathUtils.degToRad;

export class ChaseCamera {
  constructor(stage) {
    this.stage = stage;
    this.cam = stage.camera;
    this.x = 0;
    this.ground = 0;
    this.intro = 1;
    this.shake = 0;
    this.dip = 0;
    this.roll = 0;
    this.arch = 0;
    this.fov = 70;
    this.time = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
    this.c = new THREE.Vector3();
    this.d = new THREE.Vector3();
  }

  kick(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  land(amount) {
    this.dip = Math.max(this.dip, amount);
  }

  snap(s) {
    this.x = s.x * 0.88;
    this.ground = s.ground;
    this.intro = s.mode === 'title' ? 1 : 0;
  }

  // s: {mode, x, ground, air, v, speed01, danger, boost, inArch, vx, caught, wipe, reduced, shakeScale}
  update(dt, s) {
    const K = CONFIG.camera;
    const st = this.stage;
    this.time += dt;
    const portrait = st.height >= st.width;
    const aspect = st.width / st.height;
    const baseFov = portrait ? K.fov : THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(rad(K.hfovLandscape / 2)) / aspect)), 40, 70);
    const motion = s.reduced ? 0 : 1;
    const fovT = baseFov + (s.speed01 * 6 + s.boost * 9) * motion - (s.wipe ? 8 * (K.payoffZoom - 1) * 4 : 0);
    this.fov = ease(this.fov, fovT, 4, dt);
    this.cam.fov = this.fov;

    this.arch = ease(this.arch, s.inArch ? 1 : 0, 5, dt);
    const dist = K.distance * (portrait ? 1 : 0.85) * (1 - 0.2 * this.arch) * (1 - 0.08 * s.boost * motion);
    const h = K.height * (portrait ? 1 : 0.85) * (1 - 0.3 * this.arch);
    this.x = ease(this.x, s.x * 0.88, K.follow, dt);
    this.ground = ease(this.ground, s.ground, 7, dt);
    this.dip = Math.max(0, this.dip - dt * 3.5);
    const yaw = rad(K.yaw);
    const lift = s.air * 0.32 - this.dip * 0.35 * motion;

    // Chase pose.
    this.a.set(this.x + Math.sin(yaw) * dist, this.ground + h + lift, Math.cos(yaw) * dist);
    const lookY = h - Math.tan(rad(K.pitch)) * (dist + K.lead);
    this.b.set(this.x * 0.95, this.ground + lookY + s.air * 0.15, -K.lead);
    // Intro / caught pose: in front of the rider, looking back up at the wall.
    const z = 1 / K.introZoom;
    this.c.set(s.x + 1.3 * z, this.ground + 0.95, -5.6 * z);
    this.d.set(s.x - 0.15, this.ground + 2.3, 12);
    const introT = s.mode === 'title' || s.wipe ? 1 : 0;
    this.intro = ease(this.intro, introT, s.caught ? 2.4 : 3.6, dt);
    const k = this.intro * this.intro * (3 - 2 * this.intro);
    this.pos.lerpVectors(this.a, this.c, k);
    this.look.lerpVectors(this.b, this.d, k);
    // Swing wide while blending so the move reads as an orbit, not a slide.
    this.pos.x += Math.sin(k * Math.PI) * 2.2;

    this.shake = Math.max(0, this.shake - dt * 1.7);
    const rumble = s.mode === 'ride' ? Math.max(0, s.danger - 0.22) * 0.26 : 0;
    const amp = (K.shake / 100) * s.shakeScale * (rumble + this.shake * 0.24);
    const t = this.time;
    this.pos.x += (Math.sin(t * 41) + Math.sin(t * 23)) * amp * 0.5;
    this.pos.y += (Math.sin(t * 37) + Math.cos(t * 19)) * amp * 0.5;

    this.cam.position.copy(this.pos);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(this.look.applyMatrix4(st.world.matrixWorld));
    this.roll = ease(this.roll, motion * THREE.MathUtils.clamp(-s.vx * 0.0045, -0.07, 0.07) * (1 - k), 6, dt);
    this.cam.rotateZ(this.roll);
    this.cam.updateProjectionMatrix();
  }
}
