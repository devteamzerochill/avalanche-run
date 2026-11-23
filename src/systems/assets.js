// Asset loading. The web build fetches files; the single-file build embeds
// them as base64 in window.__ASSETS__ (see tools/build.mjs).
export const AUDIO_FILES = ['music', 'ambience', 'rumble', 'action', 'carve', 'hit', 'land', 'nearmiss'];

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function loadAudioBytes(name) {
  const embedded = typeof window !== 'undefined' && window.__ASSETS__;
  if (embedded && embedded['snd_' + name]) return decodeBase64(embedded['snd_' + name]);
  const res = await fetch('assets/audio/snd_' + name + '.mp3');
  if (!res.ok) throw new Error('audio ' + name + ' ' + res.status);
  return res.arrayBuffer();
}
