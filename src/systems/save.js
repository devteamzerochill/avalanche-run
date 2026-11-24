// Persistence. One JSON blob in localStorage; survives private mode and
// blocked storage by falling back to memory.
import { MISSIONS } from '../config.js';

const KEY = 'avalanche-run-2';

export function defaultProfile() {
  return {
    v: 1,
    best: 0,
    day: '',
    bestToday: 0,
    streak: 0,
    lastDay: '',
    flakes: 0,
    riders: ['nova'],
    boards: ['classic'],
    rider: 'nova',
    board: 'classic',
    trails: [], // Shards shop trails: bought on the server only
    trail: null,
    missions: { active: [], next: 0 },
    totals: { runs: 0, distance: 0, flakes: 0, nearMisses: 0 },
    runsToday: [], // [{score, time}]
    ghost: null, // {day, seed, version, score, data}
    seenHow: false,
    settings: {
      music: 0.6, // 0..1 of the configured music volume
      sfx: 0.8,
      haptics: true,
      reducedMotion: false,
      shake: 1,
      colorblind: false,
      tapSteer: false,
      lang: 'auto',
      quality: 'auto',
      announcer: true,
      theme: 'glacier', // 'glacier' | 'arcade' (the original yellow and red look)
    },
  };
}

export class Store {
  constructor(storage, key) {
    this.key = key || KEY;
    this.storage = null;
    try {
      const s = storage === undefined ? globalThis.localStorage : storage;
      if (s) {
        s.getItem(this.key);
        this.storage = s;
      }
    } catch (err) {
      this.storage = null;
    }
    this.profile = this.load();
  }

  load() {
    const base = defaultProfile();
    let raw = null;
    try {
      raw = this.storage ? JSON.parse(this.storage.getItem(this.key) || 'null') : null;
    } catch (err) {
      raw = null;
    }
    if (raw && typeof raw === 'object') {
      Object.assign(base, raw);
      base.settings = Object.assign(defaultProfile().settings, raw.settings || {});
      base.totals = Object.assign(defaultProfile().totals, raw.totals || {});
      if (!base.missions || !Array.isArray(base.missions.active)) base.missions = { active: [], next: 0 };
    }
    while (base.missions.active.length < 3) {
      base.missions.active.push({ id: MISSIONS[base.missions.next % MISSIONS.length].id, progress: 0, done: false });
      base.missions.next++;
    }
    return base;
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.profile));
    } catch (err) {
      /* storage full or blocked: keep playing from memory */
    }
  }

  reset() {
    const storage = this.storage;
    this.storage = null;
    this.profile = this.load();
    this.storage = storage;
    this.save();
  }
}
