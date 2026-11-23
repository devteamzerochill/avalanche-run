// Scripted timeline for tools/record.swift, run inside the page in record mode.
// Title screen -> PLAY -> a human-like bot rides -> it gets distracted and crashes ->
// end card -> back to the title screen. Times are seconds of video.
(function (opts) {
  const G = window.__GAME;
  const o = Object.assign({ play: 5.5, letGo: 43, hold: 6.5 }, opts || {});
  const log = (window.__RECLOG = []);
  let endAt = -1;
  let last = '';
  G.game.audio.unlock();
  G.bot(true, { human: true });
  window.__REC.script = (frame, t) => {
    const st = G.game.state;
    if (st !== last) {
      log.push([t.toFixed(2), st]);
      last = st;
    }
    if (frame === Math.round(o.play * 60)) G.begin();
    if (frame === Math.round(o.letGo * 60) && G.game.bot) G.game.bot.distracted = true;
    if (st === 'end' && endAt < 0) endAt = t;
    if (endAt > 0 && t >= endAt + o.hold && st === 'end') G.back();
  };
})(window.__SCENARIO);
