// The player's ad privacy answers in the phone apps (DECISIONS 92), copied from
// Bramble Bay: consent to personalised ads, asked in the EEA/UK, and the US
// "Do Not Sell or Share" opt-out. Kept on the device; src/systems/ads.js hands
// them to LevelPlay before it starts.

const KEY = 'avalanche-run-privacy';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch (e) {
    return {};
  }
}

export const privacy = Object.assign({ consent: null, doNotSell: false }, load());

export function savePrivacy(changes) {
  Object.assign(privacy, changes);
  try {
    localStorage.setItem(KEY, JSON.stringify({ consent: privacy.consent, doNotSell: privacy.doNotSell }));
  } catch (e) {
    /* private storage off: the answers last for this session */
  }
}

// Whether a time zone id (IANA) is in or near the EEA/UK, where ads need consent.
// Every Europe/ zone counts, which asks a few more players than the law needs;
// an unknown zone counts too, so nobody there is missed.
export function consentRegion(zone) {
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      zone = '';
    }
  }
  if (!zone) return true;
  return zone.startsWith('Europe/') || ['Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores', 'Atlantic/Reykjavik', 'Atlantic/Faroe', 'Arctic/Longyearbyen', 'Asia/Nicosia', 'Asia/Famagusta', 'WET', 'CET', 'MET', 'EET', 'GB', 'Eire'].includes(zone);
}

// What LevelPlay is told: the answer if there is one; in the consent region an
// unanswered question counts as no, so ads never start personalised without one.
export function adPrivacy() {
  const out = { doNotSell: !!privacy.doNotSell };
  if (privacy.consent !== null) out.consent = !!privacy.consent;
  else if (consentRegion()) out.consent = false;
  return out;
}
