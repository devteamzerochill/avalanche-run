// Vibration where the browser supports it (Android Chrome; iOS Safari does not).
const PATTERNS = {
  tap: 8,
  jump: 10,
  land: 14,
  perfect: [12, 30, 24],
  nearMiss: 18,
  flake: 5,
  stumble: [40, 30, 40],
  crash: [90, 40, 160],
  caught: [200, 60, 260],
  boost: [10, 20, 10, 20, 30],
};

export class Haptics {
  constructor() {
    this.enabled = true;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  fire(name) {
    if (!this.enabled || !this.supported) return;
    // Browsers block vibration until the page has had a real tap.
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return;
    try {
      navigator.vibrate(PATTERNS[name] || 10);
    } catch (err) {
      /* ignored */
    }
  }
}
