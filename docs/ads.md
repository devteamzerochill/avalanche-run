# Ads in the phone apps

Agreed with the owner on 2026-11-25 (DECISIONS 85). Anything marked **Proposal** is not agreed yet.

## Scope

- **Phone apps only** (Android and iOS, `mobile/`). The web game on zerochill.com, the claude.ai artifact and the playable ad stay ad-free.
- **Ad mediation: Unity LevelPlay.** The apps call Unity's official LevelPlay SDK through **our own thin Capacitor plugin** in `mobile/` (Kotlin on Android, Swift on iOS), not a community plugin.
- **Three formats:** rewarded video, interstitial and banner.
- **Test ads first.** The owner has no LevelPlay account yet. Everything is built and tested with LevelPlay's test setup. The owner creates the account and the two apps later and provides the app keys and ad unit IDs. These aren't secret and go in config.

## Audience and privacy

- **Every player is treated as a child.** Every ad request is child-directed and non-personalised.
- There is no age question, no consent prompt and no iOS tracking prompt.
- The store listings declare the audience to match.

## Rewarded video

Players choose to watch, and get one of two rewards:

1. **Double the run's snowflakes.** A button on the results screen after a solo run that paid snowflakes.
2. **Daily spin wheel.** Watching unlocks one spin a day. The wheel has its own button on the home screen.
   - The slices are snowflake amounts, plus a rare item slice of about **1 in 30 spins**.
   - The item slice unlocks a random snowflake-priced item the player doesn't own yet.
   - Items with a Shards price are never on the wheel.

**Proposal** (not agreed yet):
- The snowflake slices are 20, 30, 40, 50, 60, 80, 100 and 200, with smaller amounts more likely (about 55 on average).
- If the player already owns every snowflake item, the item slice gives 200 snowflakes instead.

**Granting:**
- Rewards are credited only by the zerochill.com server, after **LevelPlay's server-to-server rewarded callback** confirms the video was completed. The game never credits a reward itself.
- This needs a new edge function and migration, which we write and hand to Lovable.

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
  - initialises LevelPlay 9.8.0 with COPPA on and the device ID opted out;
  - shows the interstitial and rewarded video, and tells the game when each one closes;
  - places the banner above the navigation bar, over the bottom edge of the game.
- **The advertising ID permission is removed** in the manifest.
- **The game side is `src/systems/ads.js`.** It does nothing outside the apps. It holds the pacing rules, kept in their own localStorage key so restarting the app doesn't reset them.
- **The banner's height goes to the CSS variable `--ad`.** The title screen and the results card pad by it.
- **Keys:** `CONFIG.ads.android` holds **Unity's public demo app key and ad units**, from `ironsource-mobile/Mediation-Demo-Apps`. Replace them with the owner's own before release.

## How a rewarded video is credited (slice 2, DECISIONS 86)

1. The results card offers **"Watch a video: +N ❄"** only once the server has counted the run, with N the snowflakes the server counted for it.
2. On a tap, the app asks for a ticket: `start_avalanche_ad_reward('double', <run key>)`. Asking again for the same run returns the same ticket.
3. The video plays with the **ticket id as the LevelPlay user id** (`setDynamicUserId`).
4. LevelPlay calls the **`levelplay-reward` edge function** (`supabase/functions/levelplay-reward/`). It:
   - refuses a callback whose signature doesn't match: `md5(timestamp + eventId + userId + rewards + LEVELPLAY_PRIVATE_KEY)`;
   - calls `avalanche_ad_reward_callback` as the service role, which pays the ticket once and records the event id, so a retried event pays nothing;
   - answers `<eventId>:OK` for every final outcome (paid, retry, used ticket, unknown ticket) so LevelPlay stops retrying, and an error status only for a database failure.
5. After the video the app checks the ticket (`get_avalanche_ad_reward`) for about 10 seconds. Paid: "+N ❄ added" and the new balance. Not yet: "on the way"; the balance updates on the next profile load.

The amount is always ours. LevelPlay's `rewards` value follows ad revenue and is only used in the signature.

**Local testing:** copy `supabase/functions/.env.example` to `.env`, `npx supabase start`, then `node tests/db.mjs` signs callbacks with the local key and calls the function.

**Not confirmed yet** (needs the owner's LevelPlay account):
- that the `dynamicUserId` set before the video arrives as the callback's user id;
- the exact parameter names on the wire (the docs disagree; the function accepts `userId`, `userid`, `applicationUserId` and `appUserId`);
- that LevelPlay signs callbacks once a private key is set.

The dashboard's callback test (enter a ticket id as the User ID) checks the first two without a video.

## Before release

- **Use the owner's own keys.** Unity's demo key serves ordinary live campaigns that aren't child-directed. A test showed a game ad rated 16+ that opened the Play Store on its own.
- **In the owner's LevelPlay dashboard:**
  - mark the apps as child-directed / Families;
  - choose only certified networks for families;
  - set the ad content rating.
- **Set up the server-to-server rewarded callback:**
  - URL: `https://<project>.supabase.co/functions/v1/levelplay-reward?userId=[USER_ID]&rewards=[REWARDS]&eventId=[EVENT_ID]`;
  - set a private key, and give the same value to Lovable as the `LEVELPLAY_PRIVATE_KEY` secret;
  - run the dashboard's callback test with a real ticket id.
