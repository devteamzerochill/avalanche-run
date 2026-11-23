// Playable-ad layer: store link, call to action, lifecycle events.
// Works stand-alone and inside MRAID containers.
import { CONFIG } from '../config.js';

export function isAdBuild() {
  return !!window.__AD_BUILD || new URLSearchParams(location.search).has('ad');
}

export function storeUrl() {
  const s = Object.assign({}, CONFIG.ad.storeUrl, window.__STORE || {});
  const ios = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  return (ios ? s.ios : s.android) || s.android || s.ios || '';
}

export function hasCta() {
  return isAdBuild() || !!storeUrl();
}

// Lifecycle events: boot, gameplay_start, endcard, replay, cta.
export function track(type, detail) {
  try {
    window.dispatchEvent(new CustomEvent('avalanche:event', { detail: Object.assign({ type }, detail || {}) }));
    if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'avalanche-run', type }, '*');
  } catch (err) {
    /* ignored */
  }
}

export function openStore() {
  const url = storeUrl();
  track('cta', { url });
  try {
    if (window.mraid && typeof window.mraid.open === 'function') window.mraid.open(url || location.href);
    else if (typeof window.ExitApi !== 'undefined' && window.ExitApi.exit) window.ExitApi.exit();
    else if (url) window.open(url, '_blank');
  } catch (err) {
    /* ignored */
  }
}
