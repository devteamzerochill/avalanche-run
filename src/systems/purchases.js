// In-app purchases in the phone apps (DECISIONS 93, docs/purchases.md): Shard
// packs and No ads, through @capgo/native-purchases. Everywhere else there is no
// plugin and the Shop's Shards tab doesn't show.
//
// The game never grants anything itself. Each purchase goes to the site's check
// (CONFIG.store.verify), which verifies it with Apple or Google, credits the
// Shards or sets No ads once per transaction, and only then is the purchase
// finished in the store. One that never reached the check (app closed, no
// signal) stays unfinished and is sent again on the next launch; Google refunds
// anything left unacknowledged for 3 days, so it can't be lost silently.
import { CONFIG } from '../config.js';

const plugin = () => (typeof window !== 'undefined' && window.__APP && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativePurchases) || null;
const platform = () => (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || '';
const S = CONFIG.store;
const IDS = S.packs.map((p) => p.id).concat(S.noAds.id);
const consumable = (id) => id !== S.noAds.id;

export class Purchases {
  constructor() {
    this.p = plugin();
    this.prices = {};
  }

  get available() {
    return !!this.p;
  }

  // The store's own price text ("₱279.00"), once loaded; the dollar price until then.
  price(id) {
    const it = S.packs.find((p) => p.id === id) || S.noAds;
    return this.prices[id] || '$' + it.usd;
  }

  async loadPrices() {
    if (!this.p || this.loaded) return;
    try {
      const r = await this.p.getProducts({ productIdentifiers: IDS, productType: 'inapp' });
      (r.products || []).forEach((x) => (this.prices[x.identifier] = x.priceString));
      this.loaded = true;
    } catch (e) {
      console.warn('store prices:', e && e.message);
    }
  }

  // Resolves { ok, reason }. reason: 'cancelled', 'pending' (Google's pay-later
  // methods: credited when it clears), 'store', or the check's own reason.
  async buy(id, live) {
    let t;
    try {
      t = await this.p.purchaseProduct({
        productIdentifier: id,
        productType: 'inapp',
        // The account's id rides with the purchase, so the check can refuse
        // a receipt sent from another account.
        appAccountToken: live.session.user.id,
        isConsumable: consumable(id),
        autoAcknowledgePurchases: false,
      });
    } catch (e) {
      const m = (e && (e.code || e.message)) || '';
      return { ok: false, reason: /cancel/i.test(m) ? 'cancelled' : /pending/i.test(m) ? 'pending' : 'store' };
    }
    return this.deliver(t, live);
  }

  async deliver(t, live) {
    const android = platform() === 'android';
    const body = {
      platform: android ? 'android' : 'ios',
      product: t.productIdentifier,
      transaction: t.transactionId,
      token: android ? t.purchaseToken || t.transactionId : t.jwsRepresentation || null,
    };
    let r;
    try {
      r = await live.call('POST', S.verify, body, true);
    } catch (e) {
      // Not reached or not answered: left unfinished for the next launch.
      return { ok: false, reason: (e && e.body && e.body.reason) || 'check' };
    }
    // A receipt the check refuses for good is finished too, or it would come back every launch.
    if (r && (r.ok || r.final)) await this.finish(t).catch((e) => console.warn('finish purchase:', e && e.message));
    return r && r.ok ? r : { ok: false, reason: (r && r.reason) || 'check' };
  }

  finish(t) {
    if (platform() === 'android' && consumable(t.productIdentifier)) return this.p.consumePurchase({ purchaseToken: t.purchaseToken || t.transactionId });
    return this.p.finishTransaction({ transactionId: t.transactionId });
  }

  // On launch and after signing in: send anything bought but not yet checked.
  // Only purchases made from this account (or with no account recorded).
  async recover(live) {
    if (!this.p || !live || !live.session || this.recovering) return false;
    this.recovering = true;
    let any = false;
    try {
      const { transactions } = await this.p.getUnfinishedTransactions();
      for (const t of transactions || []) {
        if (!IDS.includes(t.productIdentifier)) continue;
        if (t.appAccountToken && t.appAccountToken !== live.session.user.id) continue;
        if ((await this.deliver(t, live)).ok) any = true;
      }
    } catch (e) {
      console.warn('purchase recovery:', e && e.message);
    } finally {
      this.recovering = false;
    }
    return any;
  }

  // Restore Purchases (Apple 3.1.1): No ads is the only thing to restore; Shards
  // are already in the wallet. Resolves true if the store had a No ads purchase.
  async restore(live) {
    await this.p.restorePurchases().catch(() => {});
    const { purchases } = await this.p.getPurchases({ productType: 'inapp', onlyCurrentEntitlements: true });
    let found = false;
    for (const t of purchases || []) {
      if (t.productIdentifier !== S.noAds.id) continue;
      found = true;
      await this.deliver(t, live);
    }
    return found;
  }
}
