// The portrait frame. On screens wider than 9:16 the web player lays the game
// out once at a fixed phone size and scales that whole frame to fit, so the UI
// is identical on every screen. `scale` converts screen pixels (from
// getBoundingClientRect / pointer events) back to frame pixels.
export const FRAME = { w: 450, h: 800, scale: 1, framed: false };

export function applyFrame(enabled) {
  const body = document.body;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const framed = !!enabled && vw / vh > FRAME.w / FRAME.h + 0.01;
  FRAME.framed = framed;
  FRAME.scale = framed ? Math.min(vw / FRAME.w, vh / FRAME.h) : 1;
  body.classList.toggle('framed', framed);
  document.documentElement.style.setProperty('--frame-scale', FRAME.scale.toFixed(4));
  return FRAME;
}
