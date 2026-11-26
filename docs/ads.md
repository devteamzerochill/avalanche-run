# Ads in the phone apps

Agreed with the owner on 2026-11-25 (DECISIONS 85). Anything marked **Proposal** is not agreed yet.

## Scope

- **Phone apps only** (Android and iOS, `mobile/`). The web game on zerochill.com, the claude.ai artifact and the playable ad stay ad-free.
- **Ad mediation: Unity LevelPlay.** The apps call Unity's official LevelPlay SDK through **our own thin Capacitor plugin** in `mobile/` (Kotlin on Android, Swift on iOS), not a community plugin.
- **Three formats:** rewarded video, interstitial and banner.
- **No ads** (DECISIONS 93, `docs/purchases.md`): an account that bought it gets no banner and no interstitial. Rewarded videos stay.
- **Test ads first.** The owner has no LevelPlay account yet. Everything is built and tested with LevelPlay's test setup. The owner creates the account and the two apps later and provides the app keys and ad unit IDs. These aren't secret and go in config.

## Audience and privacy

- **Not child-directed, for now (DECISIONS 87, replacing the child-directed rule in 85).** The app sends no COPPA flag and no device-ID opt-out, and keeps the advertising ID permission, so more networks fill.
- LevelPlay locks COPPA when an app is created, so two new apps were made with COPPA "Not directed" (Android `29e30bffd`, iOS `29e30f985`). The first two ("Directed") are renamed "Avalanche Run (old)" and unused.
- **Known risk, accepted by the owner:** the players include kids, so COPPA and Google Play's Families rules apply whatever the setting says. Reviewed before release on 2026-11-26: the owner chose to leave it as is (no age question, no Families setup, no ad content rating cap). iOS asks Apple's tracking prompt once (DECISIONS 89). EEA/UK consent, the US Do Not Sell switch and Settings › Privacy: DECISIONS 92 and `docs/store-readiness.md`.

## Rewarded video

Players choose to watch, and get **double the run's snowflakes**: a button on the results screen after a solo run that paid snowflakes.

**Back burner: daily spin wheel** (owner, 2026-11-26, DECISIONS 88). Taken out of the plan for now; not built. What was agreed in 85, kept for when it comes back:
- Watching unlocks one spin a day; the wheel has its own button on the home screen.
- The slices are snowflake amounts, plus a rare item slice of about 1 in 30 spins that unlocks a random snowflake-priced item the player doesn't own yet. Items with a Shards price are never on the wheel.
- Never agreed (was a proposal): slices of 20, 30, 40, 50, 60, 80, 100 and 200 with smaller amounts more likely (about 55 on average), and 200 snowflakes instead of the item slice once the player owns every snowflake item.

**Granting:**
- Rewards are credited only by the zerochill.com server, after **LevelPlay's server-to-server rewarded callback** confirms the video was completed. The game never credits a reward itself.
- This needs a migration and a callback endpoint (a website route on ZeroChill.com, DECISIONS 86), which we write and hand to Lovable.

## Interstitial

- Shown after a run ends, before the results screen.
- At most **once every 3 runs**, and never twice within **2 minutes**.
- Never in multiplayer races.
- Never in the player's first 2 runs of the day.
- Never right after the player watched a rewarded video.

## Banner

- **Bottom of the menus only:** the title screen and results. The menu layout moves up to make room.
- Never during a run, never in races.
- Hidden while the shop is open, so it can't cover the buy bar.

## How it is built (slice 1, Android)

- **Native plugin:** `mobile/android/app/src/main/java/com/zerochill/avalancherun/AdsPlugin.java`. It does three things:
  - initialises LevelPlay 9.8.0 (no COPPA flag or device-ID opt-out since DECISIONS 87);
  - shows the interstitial and rewarded video, and tells the game when each one closes;
  - places the banner above the navigation bar, over the bottom edge of the game.
- **The advertising ID permission is kept** (it was removed until DECISIONS 87).
- Load failures are logged to logcat under the tag `AvalancheAds` (for example 509, "Mediation No fill").
- **The game side is `src/systems/ads.js`.** It does nothing outside the apps. It holds the pacing rules, kept in their own localStorage key so restarting the app doesn't reset them.
- **The banner's height goes to the CSS variable `--ad`.** The title screen and the results card pad by it.
- **Keys:** `CONFIG.ads` holds the owner's own LevelPlay app keys and ad unit ids (created 2026-11-26), for Android and iOS. The apps are "Not live yet", with COPPA "Not directed" (DECISIONS 87). The ad units use the dashboard defaults with no capping or pacing, because the game paces itself. The rewarded units' reward ("Snowflakes", 1) is a placeholder, because the server decides the amount.
- **Networks:** Unity Ads is the main demand. ironSource Ads stopped serving its own ads on 2026-04-30, leaving only its exchange, so with ironSource alone every format got 509 "No fill". Unity Ads was set up on 2026-11-26 as a bidder on both LevelPlay apps. The Unity projects are `avalanche-run-android` (Game ID `800453933`) and `avalanche-run-ios` (Game ID `800453938`), both "not directed to children", with placements `BP_Rewarded_<platform>`, `BP_Interstitial_<platform>` and `BP_Banner_<platform>`. The app already ships the Unity Ads adapter.

## iOS (slice 4)

Written on 2026-11-26 without a Mac, so **not compiled or run yet**. The owner chose to write it now and test it later.

- **Native plugin:** `mobile/ios/App/App/AdsPlugin.swift`, the same five methods as Android (`start`, `isReady`, `showInterstitial`, `showRewarded`, `setBanner`) and the same events (`loaded`, `banner`), so `src/systems/ads.js` runs unchanged. The method is `start`, not `init`, on both platforms: Objective-C treats any `init…` method as a constructor.
- **Registration:** `MainViewController.swift` subclasses Capacitor's bridge view controller and registers the plugin in `capacitorDidLoad()`. `Main.storyboard` now uses it.
- **SDK:** Swift packages added to the app target in `App.xcodeproj` (by hand, so Xcode may rewrite the entries on first open):
  - `LevelPlay-Swift-Package` 9.8.0, product `UnityMediationSDK` (module `IronSource`);
  - `LevelPlay-UnityAds-Adapter-Swift-Package` 5.14.0, product `UnityAdsAdapter`;
  - `-ObjC` in Other Linker Flags, as LevelPlay's package README asks.
- **Info.plist:** SKAdNetwork ids for LevelPlay (`su67r6k2v3`) and Unity Ads (`4dzt52r2t5`), and `NSAllowsArbitraryLoads` as LevelPlay's docs ask. Apple's tracking prompt (ATT) is asked once on first launch, after the game's own explainer and before LevelPlay starts, with `NSUserTrackingUsageDescription` as its reason; players who declined the EEA/UK consent question aren't asked (DECISIONS 89, 92).
- **Needs Xcode 26 or newer** (LevelPlay 9.5.0 and later).

**Not checked against the real SDK** (the docs show the calls but not every type name). If Xcode complains, look here first:
- the delegate protocol names `LPMInterstitialAdDelegate`, `LPMRewardedAdDelegate` and `LPMBannerAdViewDelegate`, and their method signatures;
- `LPMBannerAdViewConfigBuilder().build()` giving the 320×50 banner, and `loadAd(with:)`;
- whether `LevelPlay.initWith` calls back on the main thread (the plugin hops to it anyway).

**First test on a Mac:**
1. Run `node build-apps.mjs` on the PC, open `xcode/ios/App/App.xcodeproj` from the zip, let Xcode resolve the packages, choose the team, build.
2. Run on an iPhone; the Xcode console should show no `AvalancheAds:` load failures after a minute (509 "No fill" is a fill problem, not a code one).
3. Finish a solo run that pays snowflakes and watch the rewarded video: "+N ❄ added" should show within about 10 seconds.
4. Keep playing: an interstitial should show after a run once the pacing rules allow it (see "Interstitial"; never in the first 2 runs of the day).
5. Add the iPhone as a test device in LevelPlay and Unity first, as was done for the Android phone.

**Banner fill (2026-11-26):** banner demand is thin (most tries get 509 "No fill"), but it does fill now and then; Bramble Bay, with the same LevelPlay setup, showed one. Ours never could, for two reasons in our plugin, both fixed:
- **The banner gave up after two tries per launch.** The view was hidden, and empty it had no size, until an ad arrived; LevelPlay stops retrying a banner it can't see. The view is now a fixed 320×50 box, on screen whenever the game wants a banner (empty, it's transparent and lets taps through). LevelPlay then retries about every 25 s, so we no longer call `loadAd()` again ourselves.
- **A failed refresh dropped the game's padding.** LevelPlay keeps the last ad on screen when a refresh fails, but the plugin treated the failure as "no banner", so the ad covered the bottom buttons. Failures no longer change anything; the space stays once a banner has loaded.

The app asks for `ACCESS_NETWORK_STATE`, which Unity reads for its bids, and debug builds turn on LevelPlay's adapter logging (`setAdaptersDebug`).

## How a rewarded video is credited (slice 2, DECISIONS 86)

1. The results card offers **"Watch a video: +N ❄"** only once the server has counted the run, with N the snowflakes the server counted for it.
2. On a tap, the app asks for a ticket: `start_avalanche_ad_reward('double', <run key>)`. Asking again for the same run returns the same ticket.
3. The video plays with the **ticket id as LevelPlay's dynamic user id** (`setDynamicUserId`). LevelPlay adds it to the callback as its own `dynamicUserId` parameter and leaves `userId` empty; the dashboard's callback test puts the ticket in `userId` instead. The route takes `dynamicUserId` first, then `userId`, and accepts a signature over either, since which one LevelPlay signs isn't documented.
4. LevelPlay calls the website route **`https://zerochill.com/api/public/levelplay-reward`** (`src/routes/api/public/levelplay-reward.ts` in the ZeroChill.com project; the live project allows no new edge functions). Locally the same behaviour is the edge function `supabase/functions/levelplay-reward/`. It:
   - refuses a callback whose signature doesn't match: `md5(timestamp + eventId + userId + rewards + AR_LEVELPLAY_PRIVATE_KEY)`;
   - calls `avalanche_ad_reward_callback` as the service role, which pays the ticket once and records the event id, so a retried event pays nothing;
   - answers `<eventId>:OK` for every final outcome (paid, retry, used ticket, unknown ticket) so LevelPlay stops retrying, and an error status only for a database failure.
5. After the video the app checks the ticket (`get_avalanche_ad_reward`) for about 10 seconds. Paid: "+N ❄ added" and the new balance. Not yet: "on the way"; the balance updates on the next profile load.

The amount is always ours. LevelPlay's `rewards` value follows ad revenue and is only used in the signature.

**Local testing:** copy `supabase/functions/.env.example` to `.env`, `npx supabase start`, then `node tests/db.mjs` signs callbacks with the local key and calls the function.

**Confirmed on 2026-11-26** with the dashboard's callback test on the Android app: a real ticket id entered as the User ID was paid once on the live site (+44 ❄, balance 710 → 754), with LevelPlay's own event id recorded. So the `userId` parameter arrives as set in the callback URL, LevelPlay signs with the private key, and the website's `AR_LEVELPLAY_PRIVATE_KEY` matches.

**Found on 2026-11-26 after a real video:** LevelPlay sent the ticket as `dynamicUserId` with `userId` empty. The route only read `userId`, so it refused all three callbacks with 400 "missing parameters" and paid nothing. The route was fixed and published the same day (ZeroChill.com commit 9ac0affb).

## Before release

- **Use the owner's own keys** (done). Unity's demo key serves ordinary live campaigns that aren't child-directed. A test showed a game ad rated 16+ that opened the Play Store on its own.
- **In the owner's LevelPlay dashboard:**
  - COPPA: "Not directed" (done, DECISIONS 87);
  - block gambling ads (the owner is handling it);
  - ad content rating: left at the default, no cap (owner, 2026-11-26).
- **Signed release builds:** copy the owner's `mobile/android/keystore.properties` and keystore to the build PC; without them the release APK and AAB come out unsigned.
- **Set up the server-to-server rewarded callback:**
  - URL: `https://zerochill.com/api/public/levelplay-reward?userId=[USER_ID]&rewards=[REWARDS]&eventId=[EVENT_ID]` (done on both apps, 2026-11-26; the route is published);
  - set a private key (done, one key shared by both apps), and give the same value to Lovable as the website's `AR_LEVELPLAY_PRIVATE_KEY` secret;
  - run the dashboard's callback test with a real ticket id (done on Android, 2026-11-26).
