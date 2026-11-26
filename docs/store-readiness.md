# Store readiness (App Store and Google Play)

Checked 2026-11-26 against Capacitor 8, LevelPlay 9.8.0 and Bramble Bay's own audit (`farming-island/Docs/StoreReadiness.md`, 2026-10-28), whose privacy setup this copies (DECISIONS 92).
✅ done · ⚠️ needs a decision, the Mac, or someone outside the code · ❌ blocker, still to build.

## Both stores

| | Item | Why | Where it stands |
|---|---|---|---|
| ✅ | **Privacy section in Settings** | Apple 5.1.1(i): a privacy policy link inside the app. Apple 5.1.1(v): account deletion must start inside the app. Google: a deletion web link in Data safety. | Settings › Privacy (apps only): Ad privacy choices, US Do Not Sell or Share, Privacy policy, Delete account (signed in only). Links in `CONFIG.privacy`. |
| ⚠️ | **Privacy policy page** | Reviewers open it and compare it with the build. | Live since 2026-11-26 at https://zerochill.com/avalanche-run/privacy-policy. It names Unity LevelPlay, the advertising ID, EEA rights, US "sale or sharing", the account data and deletion. Still to fix, checked 2026-11-26: it says the game offers only optional rewarded videos, but the apps also show a banner and ads between runs; its choices list only phone settings, not the in-app consent popup or the Do Not Sell switch in Settings › Privacy; it doesn't name ironSource Ads or Unity Ads; it says Shards are bought on zerochill.com, not in the game, which changes with in-app purchases (docs/purchases.md). |
| ⚠️ | **Delete account page** | As above. Google: deletion must remove the user's data, or the Data safety form must say what is kept and why. | Live since 2026-11-26 at https://zerochill.com/delete-account (sign in, type DELETE). It says some game records remain under an account ID, pending cleanup by the games team. For us: most Avalanche Run tables cascade on the account's deletion, but `avalanche_ad_rewards` keeps its rows, including `caller_ip`, under the old user id (no account link, the live project's rule). Clean these up, or declare what is kept, before the Data safety form. |
| ✅ | **EEA/UK consent** | GDPR: personalised ads need consent before the ad SDK starts. | Our own popup on first launch when the phone's time zone is in Europe; no answer counts as no. Passed to LevelPlay before init. Settings › Privacy asks again. |
| ✅ | **US Do Not Sell or Share** | US state privacy laws. | Settings switch, passed to LevelPlay (`setCCPA`). |
| ⚠️ | **Shards and No ads bought in the app** | Apple 3.1.1/3.1.3: digital goods used in the app must also be sold as in-app purchases. Both stores: a paid entry fee with a prize pot can count as real-money gambling. | Game side built (DECISIONS 93): Shop › Shards sells the five zerochill.com packs at 100 Shards per $1 and No ads ($4.99 or 500 Shards), with Restore purchases. Still needed: the site's purchase check and refunds, the store products and keys (docs/purchases.md). Check how the race pot is framed with both stores before submitting. |
| ⚠️ | **Reviewer account** | The app opens on sign-in (owner kept it, 2026-11-26). Apple wants a working demo account in App Review notes; Google in App access. | Create a dedicated review account on zerochill.com with some snowflakes and Shards. |
| ⚠️ | **Audience** | Kids play it (docs/ads.md). Picking a children's audience brings Google's Families policy and Apple's Kids rules. | Owner chose 13+ handling with no age question (DECISIONS 87, 89). Keep store art and text from aiming at young children. |

## Apple App Store

| | Item | Notes |
|---|---|---|
| ✅ | Tracking prompt (ATT) | First launch, after the consent popup: a Continue-only explainer, then Apple's prompt; skipped if consent was declined. `NSUserTrackingUsageDescription` is set. |
| ✅ | Privacy manifest for our code | `ios/App/App/PrivacyInfo.xcprivacy`: email, user ID, gameplay content, not used for tracking. Capacitor and LevelPlay ship their own. |
| ✅ | Export compliance | `ITSAppUsesNonExemptEncryption = false` in Info.plist (HTTPS only). |
| ✅ | SKAdNetwork IDs | LevelPlay and Unity Ads ids in Info.plist (docs/ads.md). |
| ⚠️ | **iOS plugin never compiled** | `AdsPlugin.swift` (ads, ATT, `LPMPrivacySettings`) was written from Unity's docs without a Mac. Build in Xcode and fix any API names first. |
| ⚠️ | Build toolchain | Uploads must be built with Xcode 26+ / iOS 26 SDK, on the Mac. Min iOS 15.0. |
| ⚠️ | Team ID and signing | Bundle id `com.zerochill.avalancherun` is set; the Apple Team must be picked in Xcode. |
| ⚠️ | `NSAllowsArbitraryLoads` | LevelPlay's docs ask for it; App Review may ask why. Answer: required by the ad SDK. |
| ⚠️ | App Store Connect | Privacy labels (match the policy and the ad SDKs: identifiers, usage data, coarse location; used for tracking when ATT is allowed), age-rating questionnaire, privacy policy URL, support URL, screenshots (6.9" iPhone; 13" iPad if iPad stays on). |

## Google Play

| | Item | Notes |
|---|---|---|
| ✅ | Target API 36 | `targetSdkVersion = 36` in `android/variables.gradle`. |
| ✅ | 16 KB page size | Checked 2026-11-26: the only native library (`libunitycoherencenative.so`) is 16 KB aligned in the zip and in its ELF segments (arm64-v8a, x86_64). |
| ✅ | Android App Bundle | `node build-apps.mjs` makes the AAB. Sign with the owner's keystore (never committed) and enrol in Play App Signing. |
| ✅ | Version code | `node build-apps.mjs X.Y.Z` raises it; every upload needs a higher one. |
| ⚠️ | Data safety form | Declare: email, user ID, app interactions (runs), device or other IDs (advertising ID, shared with ad partners), approximate location (ad partners via IP), purchase history (in-app purchases). Deletion link: https://zerochill.com/delete-account. |
| ⚠️ | Advertising ID | The `AD_ID` permission comes from the ad SDK; answer "yes, for advertising" in Play Console's Advertising ID form. |
| ⚠️ | Content rating | IARC questionnaire: ads, quick chat only (no free text), leaderboard names from zerochill.com accounts, races with a Shards entry fee. |
| ⚠️ | Closed test | Personal developer accounts made after Nov 2023 need 12 testers for 14 days before production; organisation accounts don't. |

## Sources

- Bramble Bay's audit and its sources: `farming-island/Docs/StoreReadiness.md`
- LevelPlay privacy API (`LevelPlayPrivacySettings` / `LPMPrivacySettings`, 9.5+): https://docs.unity.com/en-us/grow/levelplay/sdk/ios/regulation-advanced-settings
- Google Play account deletion: https://support.google.com/googleplay/android-developer/answer/13327111
- Google Play 16 KB page size: https://developer.android.com/guide/practices/page-sizes
