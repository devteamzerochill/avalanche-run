# In-app purchases: Shard packs and No ads

Owner decisions, 2026-11-26 (DECISIONS 93):
- The Android and iOS apps sell Shard packs and No ads through Google Play and the App Store.
- zerochill.com checks every purchase before anything is credited, next to the Shards wallet, so Bramble Bay can reuse the same check.
- The game never credits anything itself.

**Status:** the game side is built (branch `feature/in-app-purchases`). The site's purchase check and the store products don't exist yet, so nothing can be bought until they do.

## What is sold

The packs match https://zerochill.com/ledger#buy-shards at 100 Shards per $1, with **no bonus and no first-purchase double** (owner).

| Store product id | Type | Gives | US price |
|---|---|---|---|
| `shards_500` | consumable | 500 Shards | $4.99 |
| `shards_1500` | consumable | 1,500 Shards | $14.99 |
| `shards_2500` | consumable | 2,500 Shards | $24.99 |
| `shards_5000` | consumable | 5,000 Shards | $49.99 |
| `shards_10000` | consumable | 10,000 Shards | $99.99 |
| `no_ads` | non-consumable | No ads on this account | $4.99 |

No ads can also be bought for **500 Shards** inside the game, with `buy_avalanche_item('perk', 'no_ads')`.

What No ads does:
- It turns off the banner and the ads between runs on every device where the player signs in.
- Reward videos stay, because the player chooses to watch them.

The ids, Shard amounts and prices live in `CONFIG.store` (`src/config.js`). The stores show the player's local price.

## Where players see it

Shop › **Shards** tab, in the apps only (the web game has no such tab). It holds:
- the five packs;
- No ads, with two buttons: the store price, or 💎 500 (asks for confirmation first);
- Restore purchases (Apple 3.1.1).

Signed-out players are sent to sign in. The store's own payment sheet is the money confirmation.

## How a purchase flows

1. The app buys through `@capgo/native-purchases`. The player's account id goes along as `appAccountToken` (Google's `obfuscatedAccountId`).
2. The app sends the purchase to the site's check: `POST https://zerochill.com/api/public/store-purchase`. The request carries the player's session (`Authorization: Bearer <access token>`, the same Supabase session the game already uses) and this body:
   ```json
   { "platform": "android" | "ios", "product": "shards_1500", "transaction": "<id>", "token": "<Google purchase token | Apple signed transaction (JWS)>" }
   ```
3. The check verifies the purchase with Google or Apple, then:
   - for a pack, calls `shards_credit(user, shards, 'store <platform> <transaction>')`;
   - for No ads, calls `avalanche_set_no_ads(user, true)`.

   Each store transaction credits at most once.
4. Only after the check answers does the app finish the purchase in the store: it consumes a pack on Android, acknowledges No ads, and finishes the transaction on iOS. Then it reloads the profile, which shows the new Shards balance and `no_ads`.
5. If the check couldn't be reached, the purchase stays unfinished. The app sends it again on the next launch or sign-in. Google refunds anything left unacknowledged for 3 days, so a purchase can't vanish silently.

Restore purchases asks the store for a current No ads purchase and sends it through the same check. A transaction already credited still answers `ok` and sets `no_ads` again. Shards need no restore, because they are already in the wallet.

## What we ask of the site team

**1. The route** `POST /api/public/store-purchase`:
- **CORS:** the apps call it from `https://localhost` (Android) and `capacitor://localhost` (iOS).
- **Who is calling:** read the user from the Bearer token, and refuse the call without one.
- **Android:** call the Google Play Developer API, `purchases.products.get(packageName=com.zerochill.avalancherun, productId, token)`. Require all of these:
  - `purchaseState = 0` (purchased);
  - `obfuscatedExternalAccountId` = the user's id, when present;
  - the product id matches the body.
- **iOS:** verify the JWS signature against Apple's certificate chain, or look the transaction up with the App Store Server API, `GET /inApps/v1/transactions/{transactionId}`. Require all of these:
  - `bundleId = com.zerochill.avalancherun`;
  - `productId` matches the body;
  - `appAccountToken` = the user's id, when present;
  - no `revocationDate`.
- **Credit once per transaction:** keyed by `platform + transaction` (Google: the `orderId`), in a table of your own or in `shards_credit`'s ref.
- **Answers:** always HTTP 200 with JSON for a business outcome:
  - `{ "ok": true }` when credited now or earlier;
  - `{ "ok": false, "reason": "invalid", "final": true }` for a receipt that will never be valid (wrong app, wrong account, refunded). The app then finishes it, so it stops coming back.
  - `{ "ok": false, "reason": "pending" }` while Google still waits for a slow payment method.

  Use other HTTP codes only for faults, which the app retries later.
- **Sandbox:** test purchases are real transactions (Google test cards, Apple sandbox). Credit them on test accounts only, or keep a flag to refuse them in production.

**2. Refunds.** These two notifications show when a purchase is refunded:
- Google Real-time developer notifications (a Pub/Sub topic), or the Voided Purchases API on a schedule;
- App Store Server Notifications v2 (`REFUND`), sent to a URL you choose.

On a refund, take the Shards back with `shards_debit`. If the balance is too low, decide whether it goes negative or the account is flagged. For a refunded No ads, call `avalanche_set_no_ads(user, false)`.

**3. Apply** `supabase/migrations/20261203000000_no_ads.sql`. It adds:
- the `no_ads` flag on `avalanche_profiles`;
- `no_ads` in the profile;
- the 500-Shard `('perk', 'no_ads')` item;
- `avalanche_set_no_ads` (service role only).

**4. The privacy policy** currently says "Shards are bought on zerochill.com, not in the game". Change it to say Shards and No ads can be bought in the app through the App Store or Google Play, and list the purchase data (product, transaction id, time).

## What we ask of the owner

- **Play Console:**
  - create the six products above (one-time products: the five packs consumable, `no_ads` not);
  - create a Google Cloud service account with "View financial data" and "Manage orders" access;
  - give its JSON key to the site team as a secret, never in the game.
- **App Store Connect:**
  - create the five consumables and one non-consumable with the same ids;
  - create an In-App Purchase key (Users and Access › Integrations), and give the key, its id and the issuer id to the site team as secrets;
  - set the App Store Server Notifications v2 URL the site team gives you.
- **Test accounts:** Google license testers (Play Console › License testing) and an Apple sandbox account.

## Known gaps

- The iOS side is uncompiled until the Mac build, as with the ads plugin.
- If a refund arrives for No ads that was also bought with Shards, it turns the flag off. That case is rare and accepted for now.
- One more open item: a purchase made while signed in to one account and sent again after signing in to another is skipped, since its `appAccountToken` no longer matches. It is sent once the first account signs in again.
