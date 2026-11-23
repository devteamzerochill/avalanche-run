// Input: turns pointers and keys into the three things the simulation
// understands: a target line (x), a jump edge, a grab level.
import { CONFIG, STEER_RANGE } from '../config.js';
import { clamp } from '../core/rng.js';

const TAP_MS = 260;
const TAP_PX = 12;

export class Input {
  constructor(el, opts) {
    this.el = el;
    this.isAir = opts.isAir; // () => bool
    this.active = opts.active; // () => bool, true while a run accepts input
    this.onFirst = opts.onFirst || (() => {}); // called on any gesture (audio unlock)
    this.tapSteer = false;
    this.targetX = 0;
    this.jumpEdge = false;
    this.pointers = new Map(); // id -> {x0, y0, tx0, t0, moved, air, steer, dir, jumpBtn}
    this.steerId = null;
    this.keys = {};
    this.keyGrab = false;
    this.digital = false;
    this.lastInputT = 0;
    this.usedDrag = false;
    this.usedJump = false;
    this.usedGrab = false;
    this.width = 1;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.cancel(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    window.addEventListener('blur', () => this.clear());
  }

  clear() {
    this.pointers.clear();
    this.steerId = null;
    this.keys = {};
    this.keyGrab = false;
  }

  reset() {
    this.clear();
    this.targetX = 0;
    this.jumpEdge = false;
  }

  now() {
    return performance.now();
  }

  down(e) {
    this.onFirst();
    if (!this.active()) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic events have no capture */
    }
    const rect = this.el.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    const p = { x0: e.clientX, y0: e.clientY, tx0: this.targetX, t0: this.now(), moved: 0, air: this.isAir(), steer: false, dir: 0 };
    if (this.tapSteer) {
      p.dir = e.clientX - rect.left < rect.width / 2 ? -1 : 1;
    } else if (this.steerId == null) {
      p.steer = true;
      this.digital = false;
      this.steerId = e.pointerId;
    }
    if (p.air) this.usedGrab = true;
    this.pointers.set(e.pointerId, p);
    this.lastInputT = this.now();
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.active()) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    p.moved = Math.max(p.moved, Math.sqrt(dx * dx + dy * dy));
    if (p.steer) {
      const W = CONFIG.lane.halfWidth;
      const full = STEER_RANGE.value * this.width;
      this.targetX = clamp(p.tx0 + (dx * 2 * W) / full, -W, W);
      if (p.moved > TAP_PX) this.usedDrag = true;
    }
    this.lastInputT = this.now();
  }

  up(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.steerId === e.pointerId) this.steerId = null;
    if (!p || !this.active()) return;
    // A short, still press is a tap: jump. (In tap-steer mode the JUMP button does it.)
    if (!this.tapSteer && p.moved < TAP_PX && this.now() - p.t0 < TAP_MS) this.pressJump();
  }

  cancel(e) {
    this.pointers.delete(e.pointerId);
    if (this.steerId === e.pointerId) this.steerId = null;
  }

  pressJump() {
    this.jumpEdge = true;
    this.usedJump = true;
    this.lastInputT = this.now();
  }

  // The on-screen JUMP button (tap-steer mode) calls these.
  buttonDown() {
    this.onFirst();
    if (!this.active()) return;
    this.pressJump();
    this.pointers.set('btn', { x0: 0, y0: 0, tx0: 0, t0: this.now(), moved: 99, air: this.isAir(), steer: false, dir: 0 });
  }

  buttonUp() {
    this.pointers.delete('btn');
  }

  keyDown(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.repeat) return;
    this.keys[k] = true;
    if (!this.active()) return;
    this.onFirst();
    if (k === ' ' || k === 'ArrowUp' || k === 'w') {
      e.preventDefault();
      if (this.isAir()) {
        this.keyGrab = true;
        this.usedGrab = true;
      }
      this.pressJump();
    }
    if (k === 'ArrowDown' || k === 's' || k === 'Shift') {
      this.keyGrab = true;
      this.usedGrab = true;
    }
  }

  keyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys[k] = false;
    if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'ArrowDown' || k === 's' || k === 'Shift') this.keyGrab = false;
  }

  // Called once per rendered frame: keys and tap-steer move the target line.
  frame(dt, x) {
    if (!this.active()) return;
    const W = CONFIG.lane.halfWidth;
    let dir = 0;
    if (this.keys.ArrowLeft || this.keys.a) dir -= 1;
    if (this.keys.ArrowRight || this.keys.d) dir += 1;
    for (const p of this.pointers.values()) dir += p.dir;
    dir = clamp(dir, -1, 1);
    if (dir !== 0) {
      // Keep the target a fixed lead ahead of the board: a steady carve that
      // stops soon after the key or thumb lets go.
      this.targetX = clamp(x + dir * 1.25, -W, W);
      this.digital = true;
      this.usedDrag = true;
      this.lastInputT = this.now();
    } else if (this.digital && this.steerId == null) {
      this.targetX += (x - this.targetX) * Math.min(1, dt * 10);
    }
  }

  get grab() {
    if (this.keyGrab) return true;
    for (const p of this.pointers.values()) if (p.air) return true;
    return false;
  }

  // One simulation tick's worth of input.
  consume() {
    const out = { tx: this.targetX, jump: this.jumpEdge, grab: this.grab };
    this.jumpEdge = false;
    return out;
  }

  idleSeconds() {
    return (this.now() - this.lastInputT) / 1000;
  }
}
