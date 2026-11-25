// Ads in the phone apps (DECISIONS 85, docs/ads.md): Unity LevelPlay through the
// native Ads plugin in mobile/. Everywhere else (web, artifact, playable ad)
// there is no plugin and every call is a no-op.
import { CONFIG } from '../config.js';

const KEY = 'avalanche-run-ads';
const plugin = () => (typeof window !== 'undefined' && window.__APP && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Ads) || null;
const platform = () => (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || '';

// Pacing survives restarts so closing the app can't dodge or double the cap.
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch (e) {
    return {};
  }
}

export class Ads {
  constructor() {
    this.p = plugin();
    this.on = false;
    this.bannerShown = null;
    this.state = Object.assign({ day: '', runsToday: 0, sinceAd: 0, lastAd: 0 }, load());
    const keys = this.p && CONFIG.ads[platform()];
    if (!keys) return;
    this.p.addListener('banner', (e) => {
      // The banner covers the bottom edge; the menus move up by its height.
      document.documentElement.style.setProperty('--ad', (e.height || 0) + 'px');
    });
    this.p
      .init(keys)
      .then(() => (this.on = true))
      .catch((e) => console.warn('ads off:', e && e.message));
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch (e) {}
  }

  // A solo run ended (races and rematches never count).
  runEnded(day) {
    const s = this.state;
    if (s.day !== day) Object.assign(s, { day, runsToday: 0 });
    s.runsToday++;
    s.sinceAd++;
    this.save();
  }

  interstitialDue() {
    const s = this.state;
    const a = CONFIG.ads;
    return this.on && s.runsToday > a.freeRunsPerDay && s.sinceAd >= a.everyRuns && Date.now() - s.lastAd >= a.gapSeconds * 1000;
  }

  // Resolves once the ad has closed (or straight away if none was ready).
  async showInterstitial() {
    if (!this.on) return false;
    const r = await this.p.showInterstitial().catch(() => ({}));
    if (r.shown) this.markShown();
    return !!r.shown;
  }

  // Resolves { shown, rewarded }. The reward is credited by the server, never
  // here; `userId` rides along to LevelPlay's server callback.
  async showRewarded(userId) {
    if (!this.on) return { shown: false, rewarded: false };
    const r = await this.p.showRewarded(userId ? { userId } : {}).catch(() => ({}));
    if (r.shown) this.markShown();
    return { shown: !!r.shown, rewarded: !!r.rewarded };
  }

  // Any full-screen ad restarts the interstitial count and gap.
  markShown() {
    Object.assign(this.state, { sinceAd: 0, lastAd: Date.now() });
    this.save();
  }

  rewardedReady() {
    return this.on ? this.p.isReady().then((r) => !!r.rewarded).catch(() => false) : Promise.resolve(false);
  }

  // Called every frame with whether the banner may show; talks to the plugin only on change.
  banner(want) {
    want = !!(want && this.on);
    if (!this.p || want === this.bannerShown) return;
    this.bannerShown = want;
    this.p.setBanner({ visible: want }).catch(() => {});
  }
}
