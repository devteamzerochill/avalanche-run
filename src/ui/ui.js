// DOM user interface: title, HUD, panels, pause, end card, toasts.
// The HUD only touches the DOM when a value changes.
import { CONFIG, RIDERS, BOARDS, QUICK_CHAT, QUICK_EMOTES, TRAILS } from '../config.js';
import { FRAME } from './frame.js';
import { t, LANGS, LANG_NAMES } from '../systems/i18n.js';
import { missionById, nextStreakReward, owns, leaderboard } from '../systems/meta.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function press(el, fn) {
  // Fire on pointerup for speed, fall back to click (keyboard, assistive tech).
  let last = 0;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    last = performance.now();
    fn(e);
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (performance.now() - last > 500) fn(e);
  });
}

// Online names and avatars come from the website; avatars only load over https.
function displayName(r) {
  return r.display_name || r.username || '?';
}

function avatar(r) {
  const initials = esc(displayName(r).trim().slice(0, 2).toUpperCase());
  const url = typeof r.avatar_url === 'string' && /^https:\/\//.test(r.avatar_url) ? r.avatar_url : '';
  return `<span class="av"><b>${initials}</b>${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : ''}</span>`;
}

function wireAvatars(root) {
  root.querySelectorAll('.av img').forEach((img) => {
    const hide = () => img.remove();
    if (img.complete && !img.naturalWidth) hide();
    else img.addEventListener('error', hide);
  });
}

export function missionText(m) {
  const def = missionById(m.id);
  if (!def) return m.id;
  return t('mission.' + def.stat + (def.total ? '.total' : ''), { n: def.goal });
}

// Short labels for why a rider's race ended. Any hazard counts as a crash.
function raceReason(r) {
  const key = { caught: 'caught', 'last alive': 'alive', 'time up': 'time', dropped: 'dropped', left: 'left', 'ahead of time': 'dq', 'out of sync': 'dq', 'bad input': 'dq' }[r] || 'crash';
  return t('race.reason.' + key);
}

function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// A quick-chat id as this player reads it: an emote, or a phrase in their language.
function chatText(id) {
  return QUICK_EMOTES[id] || t('chat.' + id);
}

export class UI {
  constructor(hooks) {
    this.hooks = hooks;
    this.el = {};
    for (const id of ['hud', 'distNum', 'hudFlakes', 'hudSpeed', 'meter', 'meterFill', 'combo', 'banner', 'bannerBig', 'bannerSmall', 'ring', 'hint', 'hand', 'hintText', 'jumpBtn', 'title', 'panel', 'panelTitle', 'panelBody', 'pause', 'end', 'toasts', 'loader', 'frost', 'flash', 'speedfx', 'titleCta', 'endCta', 'navDot']) this.el[id] = $(id);
    this.cache = {};
    this.panelName = '';
    this.shopTab = 'rider';
    this.fx = this.el.speedfx.getContext('2d');
    this.lines = [];
    for (let i = 0; i < 26; i++) this.lines.push({ a: Math.random() * 6.28, r: Math.random(), l: 0.05 + Math.random() * 0.08 });
    this.bannerUntil = 0;

    press($('playBtn'), () => hooks.play());
    press($('pauseBtn'), () => hooks.pause());
    press($('resumeBtn'), () => hooks.resume());
    press($('restartBtn'), () => hooks.restart());
    press($('quitBtn'), () => hooks.quit());
    press($('pauseSettingsBtn'), () => this.openPanel('settings'));
    press($('specPrev'), () => this.hooks.specStep(-1));
    press($('specNext'), () => this.hooks.specStep(1));
    press($('specLeave'), () => this.hooks.specLeave());
    press($('againBtn'), () => hooks.again());
    press($('backBtn'), () => hooks.back());
    press($('panelClose'), () => this.closePanel());
    press(this.el.titleCta, () => hooks.cta());
    press(this.el.endCta, () => hooks.cta());
    press($('tAccount'), () => this.openPanel('account'));
    // The card opens the race panel; its button does the one thing that matters now.
    press($('tRace'), () => this.openPanel(this.raceIn() ? 'lobby' : 'race'));
    press($('rcGo'), () => {
      const R = this.raceClient();
      if (!this.raceSignedIn()) return this.openPanel(this.live() ? 'account' : 'race');
      if (R && R.status === 'online' && R.next && !R.next.in && !(R.balance != null && R.balance < R.next.fee)) return this.hooks.raceCheckIn();
      this.openPanel(this.raceIn() ? 'lobby' : 'race');
    });
    this.el.panel.addEventListener('pointerup', (e) => {
      if (e.target === this.el.panel) this.closePanel();
    });
    document.querySelectorAll('[data-panel]').forEach((b) => press(b, () => this.openPanel(b.getAttribute('data-panel'))));
    const jb = this.el.jumpBtn;
    jb.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      hooks.jumpDown();
    });
    const up = (e) => {
      e.stopPropagation();
      hooks.jumpUp();
    };
    jb.addEventListener('pointerup', up);
    jb.addEventListener('pointercancel', up);
    jb.addEventListener('pointerleave', up);
  }

  profile() {
    return this.hooks.profile();
  }

  set(id, value) {
    if (this.cache[id] === value) return;
    this.cache[id] = value;
    this.el[id].textContent = value;
  }

  relabel() {
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      n.textContent = t(n.getAttribute('data-i18n'));
    });
    $('specChat').innerHTML = this.quickChat();
    this.wireQuickChat($('specChat'));
    const cta = CONFIG.ad.ctaText || t('cta.play');
    this.el.titleCta.textContent = cta;
    this.el.endCta.textContent = cta;
    this.refreshTitle();
    if (this.panelName) this.renderPanel();
  }

  setScale(w, h) {
    const s = h / w >= 1.4 ? Math.min(w / 390, h / 780) : Math.min(w / 700, h / 400);
    document.documentElement.style.setProperty('--s', Math.max(0.8, Math.min(1.5, s)).toFixed(3));
    const c = this.el.speedfx;
    if (c.width !== Math.round(w) || c.height !== Math.round(h)) {
      c.width = Math.round(w);
      c.height = Math.round(h);
    }
    this.w = w;
    this.h = h;
  }

  hideLoader() {
    const l = this.el.loader;
    l.style.opacity = '0';
    setTimeout(() => (l.style.display = 'none'), 320);
  }

  showCta(on) {
    this.el.titleCta.classList.toggle('hidden', !on);
    this.el.endCta.classList.toggle('hidden', !on);
  }

  // --- title ------------------------------------------------------------
  refreshTitle() {
    const p = this.profile();
    $('tBestToday').textContent = this.bestToday() + ' ' + t('unit.pts');
    $('tSoloBest').textContent = this.bestToday() + ' ' + t('unit.pts');
    $('tSoloSub').textContent = t('title.soloSub', { b: p.best, s: Math.max(1, p.streak) });
    this.dailyReward();
    this.account();
    this.raceButton();
    $('tBest').textContent = p.best + ' ' + t('unit.pts');
    $('tStreak').textContent = '🔥 ' + Math.max(1, p.streak);
    $('tStreakLabel').textContent = t('title.streak', { n: Math.max(1, p.streak) });
    $('tFlakes').textContent = p.flakes;
    this.el.navDot.classList.toggle('on', p.missions.active.some((m) => m.done));
    this.tickDaily();
  }

  host() {
    const h = this.hooks.host && this.hooks.host();
    return h && h.active ? h : null;
  }

  // Signed in for racing: the in-game sign-in (live test mode) or, on the
  // website, the page's session.
  raceSignedIn() {
    const h = this.host();
    const live = this.live();
    return live ? !!live.session : !!(h && h.origin && h.signedIn);
  }

  // Local best is a floor; the server's daily best raises it.
  bestToday() {
    const h = this.host();
    return Math.max(this.profile().bestToday, h && h.dailyBest != null ? h.dailyBest : 0);
  }

  // The website's shared Daily Reward bar for this game. Eligibility, caps and
  // thresholds belong to the server; the game only displays them. On the title
  // it is a thin bar on the Missions button; the full bar opens the Missions panel.
  dailyReward() {
    const h = this.host();
    const b = h && h.bar;
    const mini = $('navReward');
    mini.classList.toggle('hidden', !b);
    this.rewardHtml = '';
    if (!b) return;
    const max = +b.daily_max_xp || 0;
    const got = +b.xp_today || 0;
    const pct = max > 0 ? Math.min(100, Math.round((got / max) * 100)) : b.cleared ? 100 : 0;
    const full = b.exhausted || b.xp_blocked_by_cap;
    mini.firstChild.style.width = pct + '%';
    mini.classList.toggle('cleared', !!b.cleared);
    this.rewardHtml =
      `<div class="daily-reward${b.cleared ? ' cleared' : ''}${full ? ' max' : ''}"><div class="dr-top">` +
      `<span class="dr-label">${b.cleared ? '✓' : '🎁'} ${esc(b.label || t('reward.title'))}</span>` +
      `<span class="dr-xp">${esc(full ? t('reward.max') : t('reward.today', { a: got, b: max }))}</span></div>` +
      `<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }

  // Live test mode only: who is signed in to the real backend.
  live() {
    const h = this.host();
    return h && h.live ? h.live : null;
  }

  account() {
    const el = $('tAccount');
    const live = this.live();
    el.classList.toggle('hidden', !live);
    // A small chip in the top bar: just the icon when signed in (the panel says who).
    if (live) {
      el.textContent = live.session ? '👤' : '🔑 ' + t('acct.chip');
      el.title = live.session ? t('acct.as', { e: live.email }) : t('acct.signInToSave');
      el.classList.toggle('in', !!live.session);
    }
  }

  // --- endurance race ---------------------------------------------------------
  raceClient() {
    return this.hooks.race ? this.hooks.race() : null;
  }

  // Checked in to the next race: the player belongs in the lobby until it starts.
  raceIn() {
    const R = this.raceClient();
    return !!(R && R.status === 'online' && R.next && R.next.in);
  }

  // The lobby clock runs to 0 three seconds before the start; the last three
  // are a 3-2-1 on the slope (DECISIONS 66).
  lobbyEnd(R) {
    return (R.race && !R.race.started && R.race.me >= 0 && R.race.goAt > R.now() ? R.race.goAt : R.next.startAt) - CONFIG.race.slopeCount * 1000;
  }

  lobbyPanel(body) {
    const R = this.raceClient();
    const counting = R && R.race && !R.race.started && R.race.me >= 0 && R.race.goAt > R.now();
    if (!R || !(counting || (R.next && R.next.in))) return (body.innerHTML = `<p class="note">${esc(t('lobby.gone'))}</p>`);
    const names = counting ? R.race.riders.map((x) => x.name) : R.next.names || [];
    const meName = R.you && R.you.name;
    const end = this.lobbyEnd(R);
    const left = end - R.now();
    const closed = counting || R.now() >= R.next.lockAt;
    let html = `<div class="race-hero lobby-hero${left < 10000 ? ' soon' : ''}" data-hero><span class="lbl">${esc(t('lobby.startsIn'))}</span><b class="clock" data-until="${end}">${esc(clockText(left))}</b><div class="tbar"><i data-bar style="width:${this.raceBar(left)}%"></i></div></div>`;
    html += `<div class="lobby-riders"><span class="lbl">${esc(t('lobby.riders', { n: names.length }))}</span><div>${names.map((n) => `<b class="${n === meName ? 'me' : ''}">${esc(n)}</b>`).join('')}</div></div>`;
    html += `<div class="lobby-chat" id="lobbyChat">${this.chatLog(R)}</div>`;
    html += this.quickChat();
    html += closed ? `<p class="note">${esc(t('lobby.closed'))}</p>` : `<button class="btn" id="lobbyLeave">${esc(t('lobby.leave', { fee: R.next.fee }))}</button>`;
    if (R.checkinMsg) html += `<p class="note err">${esc(R.checkinMsg)}</p>`;
    body.innerHTML = html;
    this.wireQuickChat(body);
    if ($('lobbyLeave')) press($('lobbyLeave'), () => this.hooks.raceWithdraw());
  }

  // The last few quick-chat lines, newest at the bottom.
  // Only this lobby's lines: the log from an earlier race stays until a new line arrives.
  chatLog(R) {
    const counting = R.race && !R.race.started && R.race.me >= 0 && R.race.goAt > R.now();
    const id = counting ? R.race.id : R.next && R.next.id;
    const lines = (R.chat || []).filter((c) => c.race === id).slice(-5);
    if (!lines.length) return `<p class="note">${esc(t('lobby.quiet'))}</p>`;
    return lines.map((c) => `<p class="${c.me ? 'me' : ''}"><b>${esc(c.me ? t('ranks.you') : c.name)}</b> ${esc(chatText(c.id))}</p>`).join('');
  }

  quickChat() {
    return `<div class="quick-chat">${QUICK_CHAT.map((id) => `<button data-say="${id}" class="${QUICK_EMOTES[id] ? 'emote' : ''}">${esc(chatText(id))}</button>`).join('')}</div>`;
  }

  wireQuickChat(root) {
    root.querySelectorAll('[data-say]').forEach((b) =>
      press(b, () => {
        const now = performance.now();
        if (now - (this.saidAt || 0) < 1500) return; // the server drops faster ones anyway
        this.saidAt = now;
        this.hooks.raceSay(b.dataset.say);
      }),
    );
  }

  // The spectating bar: null hides it; { over } once nobody is left to watch.
  spectate(s) {
    $('spec').classList.toggle('hidden', !s);
    if (!s) return (this.cache.spec = null);
    const name = s.over ? t('spec.none') : s.name;
    const line = s.over ? '' : t('spec.place', { p: s.place, d: s.dist });
    const key = name + '|' + line + '|' + !!s.many;
    if (this.cache.spec === key) return;
    this.cache.spec = key;
    $('specName').textContent = name;
    $('specLine').textContent = line;
    $('specPrev').style.visibility = $('specNext').style.visibility = s.many ? '' : 'hidden';
  }

  // A quick-chat line arrived: refresh the lobby log in place, or show it
  // over the slope while racing or spectating.
  chatHeard(m) {
    const R = this.raceClient();
    const log = $('lobbyChat');
    if (log && R) log.innerHTML = this.chatLog(R);
    else this.toast((m.me ? t('ranks.you') : m.name) + ': ' + chatText(m.id));
  }

  // The race half of the title's play card (refreshed every second): a line
  // with the countdown, pot and riders in, and a button beside PLAY for the
  // next step (sign in, check in, or open the race panel).
  raceButton() {
    const el = $('tRace');
    const R = this.raceClient();
    el.classList.toggle('hidden', !R);
    document.body.classList.toggle('has-race', !!R);
    if (!R) return;
    const signedIn = this.raceSignedIn();
    const ready = signedIn && R.status === 'online' && R.next;
    const left = ready ? R.next.startAt - R.now() : 0;
    const set = (id, v) => {
      if ($(id).textContent !== v) $(id).textContent = v;
    };
    set('rcTitle', t('race.cardTitle'));
    set('rcLive', ready ? t('race.live') : '');
    set('rcLbl', ready ? t('race.nextIn') : signedIn ? t('race.connecting') : this.raceRule2(R));
    set('rcClock', ready ? clockText(left) : '');
    set('rcPot', ready ? '💎 ' + R.next.pot : '');
    set('rcRiders', ready ? '👥 ' + R.next.riders : '');
    // Two lines, so the button fits beside PLAY: the action, then the detail.
    let big, small, kind = '';
    if (!signedIn) (big = t('race.btn.signin')), (small = t('race.btn.signinSub'));
    else if (!ready) (big = t('race.btn.open')), (small = t('race.connecting'));
    else if (R.next.in) (big = t('race.btn.in')), (small = t('race.btn.inSub')), (kind = 'in');
    else if (R.balance != null && R.balance < R.next.fee) (big = t('race.btn.checkin')), (small = t('race.lowBtn')), (kind = 'low');
    else (big = t('race.btn.checkin')), (small = t('race.btn.fee', { fee: R.next.fee }));
    const html = `<b>${esc(big)}</b><small>${esc(small)}</small>`;
    if (this.cache.rcGo !== html) $('rcGo').innerHTML = this.cache.rcGo = html;
    $('rcGo').dataset.kind = kind;
    el.classList.toggle('ready', !!ready);
    el.classList.toggle('soon', !!ready && left < 10000);
  }

  // The race card: place, riders left, the gap, and the pack strip
  // (every rider still in, within 100 m either side of this one).
  // s: null | { left, place (0 before the start), gap (m, + = leading), pack: [{rel, lead}] }
  raceHud(s) {
    const el = $('raceHud');
    el.classList.toggle('hidden', !s);
    if (!s) {
      this.cache.rhPlace = this.cache.rhLeft = null;
      return;
    }
    const place = s.place ? '#' + s.place : '–';
    if (this.cache.rhPlace !== place) {
      if (this.cache.rhPlace != null) this.bumpEl($('rhPlace'));
      this.cache.rhPlace = place;
      $('rhPlace').textContent = place;
      el.classList.toggle('lead', s.place === 1);
    }
    if (this.cache.rhLeft !== s.left) {
      if (this.cache.rhLeft != null) this.bumpEl($('rhLeft'));
      this.cache.rhLeft = s.left;
      $('rhLeft').textContent = t('race.left', { n: s.left });
    }
    const gap = $('rhGap');
    const g = s.gap == null ? '' : (s.gap >= 0 ? '▲ ' : '▼ ') + Math.abs(s.gap) + ' m';
    if (gap.textContent !== g) gap.textContent = g;
    gap.className = s.gap == null ? '' : s.gap >= 0 ? 'up' : 'down';
    const strip = $('rhStrip');
    while (strip.children.length - 1 < s.pack.length) strip.appendChild(document.createElement('i'));
    [...strip.children].slice(1).forEach((d, k) => {
      const p = s.pack[k];
      d.style.display = p ? '' : 'none';
      if (!p) return;
      const x = Math.max(-100, Math.min(100, p.rel));
      d.style.left = (50 + x / 2).toFixed(1) + '%';
      d.className = (p.lead ? 'lead' : '') + (Math.abs(p.rel) > 100 ? ' edge' : '');
    });
    // The riders just ahead and just behind, by name: someone to chase or hold off.
    const near = (id, r, sign) => {
      const html = r ? `<em>${esc(r.name)}</em><i>${sign} ${Math.abs(r.gap)} m</i>` : '';
      if (this.cache[id] !== html) $(id).innerHTML = this.cache[id] = html;
    };
    near('rhAhead', s.ahead, '▲');
    near('rhBehind', s.behind, '▼');
  }

  bumpEl(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // Name tags over the other riders: [{name, x, y, far, d, lead}] in frame pixels.
  raceTags(list) {
    const box = $('raceTags');
    const w = box.clientWidth || 1;
    while (box.children.length < list.length) box.appendChild(document.createElement('span'));
    [...box.children].forEach((el, k) => {
      const g = list[k];
      el.style.display = g ? '' : 'none';
      if (!g) return;
      if (el.textContent !== g.name) el.textContent = g.name;
      el.className = (g.far ? 'far' : '') + (g.lead ? ' lead' : '');
      // Every drawn rider keeps its name, but a tag over the line ahead (the
      // middle third of the screen, in front of this rider) drops to half
      // strength so it never hides a hazard.
      const ahead = g.d > 0 && Math.abs(g.x / w - 0.5) < 1 / 6;
      el.style.opacity = ((g.far ? 0.6 : 0.85) * (ahead ? 0.5 : 1)).toFixed(2);
      el.style.transform = 'translate(' + g.x.toFixed(1) + 'px,' + g.y.toFixed(1) + 'px) translate(-50%,-100%)';
    });
  }

  racePanel(body) {
    const R = this.raceClient();
    if (!R) return (body.innerHTML = '');
    const rules = `<p class="note">${esc(t('race.rules'))}</p>`;
    if (!this.raceSignedIn()) {
      // On the website the page owns sign-in; only the in-game test sign-in has a button.
      body.innerHTML = `<p class="note">${esc(t('race.signin'))}</p>` + rules + (this.live() ? `<button class="btn primary" id="raceSignIn">${esc(t('acct.signIn'))}</button>` : '');
      if ($('raceSignIn')) press($('raceSignIn'), () => this.openPanel('account'));
      return;
    }
    if (R.status === 'connecting' || R.status === 'idle') return (body.innerHTML = `<p class="note">${esc(t('race.connecting'))}</p>`);
    if (R.status === 'error') {
      body.innerHTML = `<p class="note err">${esc(t('race.error', { r: R.error }))}</p><button class="btn" id="raceRetry">${esc(t('race.retry'))}</button>`;
      press($('raceRetry'), () => this.hooks.raceConnect());
      return;
    }
    const h = this.hooks;
    const game = h.raceState ? h.raceState() : null;
    const tile = (v, k) => `<div><b>${esc(String(v))}</b><span>${esc(t(k))}</span></div>`;
    // Three tabs, each short enough to need no scrolling on a phone.
    const tab = this.raceTab || 'race';
    const tabs = ['race', 'results', 'record'];
    let html = `<div class="race-tabs">${tabs.map((k) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${esc(t('race.tab.' + k))}${k === 'results' && R.results && this.raceSeen !== R.results.race && tab !== 'results' ? '<em></em>' : ''}</button>`).join('')}</div>`;
    // Results can belong to the race before the one being ridden.
    const done = R.results && R.race && R.results.race === R.race.id;
    const back = game && game.inRace && game.out ?`<button class="btn primary" id="raceBack">${esc(t('race.back'))}</button>` : '';
    if (tab === 'race') {
      // Out of the race, waiting for the others.
      if (R.race && !done && game && game.out) html += `<div class="race-hero out"><span class="lbl">${esc(t('race.outAt'))}</span><b class="clock">${game.dist} m</b><p data-left>${esc(t('race.waiting', { n: R.left }))}</p></div>`;
      if (R.next) {
        const fee = R.next.fee;
        const left = R.next.startAt - R.now();
        html += `<div class="race-hero${left < 10000 ? ' soon' : ''}" data-hero><span class="lbl">${esc(t('race.nextIn'))}</span><b class="clock" data-until="${R.next.startAt}">${esc(clockText(left))}</b><div class="tbar"><i data-bar style="width:${this.raceBar(left)}%"></i></div><div class="tiles">${tile('💎 ' + R.next.pot, 'race.pot') + tile(R.next.riders, 'race.ridersIn') + tile(Math.floor((R.next.pot * (R.next.prizePct || 0)) / 100), 'race.winnerGets')}</div></div>`;
        if (R.next.in) html += `<div class="race-in"><b>${esc(t('race.youreIn'))}</b><p>${esc(t('race.autoStart'))}</p></div>`;
        else if (R.balance != null && R.balance < fee) html += `<button class="btn primary big race-go" disabled>${esc(t('race.checkin', { fee }))}</button><p class="note err">${esc(t('race.lowShards'))}</p>`;
        else html += `<button class="btn primary big race-go" id="raceCheckIn">${esc(t('race.checkin', { fee }))}</button>`;
      }
      if (R.checkinMsg) html += `<p class="note err">${esc(R.checkinMsg)}</p>`;
      if (R.cancelled && (!R.results || R.cancelled.race > R.results.race)) html += `<p class="note">${esc(t('race.cancelled'))}</p>`;
      html += back;
    } else if (tab === 'results') {
      if (R.results) {
        this.raceSeen = R.results.race;
        html += this.raceResults(R, game && game.inRace && done ? game.me : -1);
        // Between races: ride that slope again against its podium (practice).
        if (!(game && game.inRace) && !R.results.voided && R.status === 'online') html += `<button class="btn primary" id="raceRematch">${esc(t('race.rematch'))}</button>`;
      } else html += `<p class="note">${esc(t('race.noResults'))}</p>`;
      html += back;
    } else {
      const st = R.stats || { races: 0, wins: 0, won: 0 };
      const fee = R.next ? R.next.fee : R.fee;
      html += `<div class="race-wallet"><span>💎</span><b>${esc(t('race.balance', { n: R.balance == null ? '…' : R.balance }))}</b><span class="pill">${esc(t('race.testShards'))}</span></div><div class="tiles">${tile(st.races, 'race.races') + tile(st.wins, 'race.wins') + tile(st.won, 'race.shardsWon')}</div>`;
      html += `<h4 class="race-sec">${esc(t('race.how.title'))}</h4><ul class="race-rules"><li><i>🎟️</i>${esc(t('race.rule1', { fee }))}</li><li><i>🏔️</i>${esc(this.raceRule2(R))}</li><li><i>🔥</i>${esc(this.raceRule3(R))}</li></ul>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-tab]').forEach((el) =>
      press(el, () => {
        this.raceTab = el.dataset.tab;
        this.renderPanel();
      }),
    );
    if ($('raceCheckIn')) press($('raceCheckIn'), () => h.raceCheckIn());
    if ($('raceBack')) press($('raceBack'), () => h.raceDone());
    if ($('raceRematch')) press($('raceRematch'), () => h.raceRematch());
  }

  // Once a second, and on position updates: refresh the counters in place.
  raceTick() {
    const R = this.raceClient();
    if (!R) return;
    const body = this.el.panelBody;
    body.querySelectorAll('[data-until]').forEach((el) => (el.textContent = clockText(+el.dataset.until - R.now())));
    const hero = body.querySelector('[data-hero]');
    if (hero && R.next) {
      const left = R.next.startAt - R.now();
      hero.classList.toggle('soon', left < 10000);
      hero.querySelector('[data-bar]').style.width = this.raceBar(left) + '%';
    }
    body.querySelectorAll('[data-left]').forEach((el) => (el.textContent = t('race.waiting', { n: R.left })));
  }

  // The prize share comes from the server (the race being entered, else the
  // current config); before it is known the rules leave the numbers out.
  racePct(R) {
    return R && R.next && R.next.prizePct != null ? R.next.prizePct : R && R.prizePct != null ? R.prizePct : null;
  }

  raceRule2(R) {
    const p = this.racePct(R);
    return p == null ? t('race.rule2n') : t('race.rule2', { p });
  }

  raceRule3(R) {
    const p = this.racePct(R);
    return p == null ? t('race.rule3n') : t('race.rule3', { b: 100 - p });
  }

  // Time left to check in, as a share of the race cycle.
  raceBar(left) {
    const R = this.raceClient();
    const cycle = (R && R.cycleMs) || 300000;
    return Math.max(0, Math.min(100, (left / cycle) * 100)).toFixed(1);
  }

  raceResults(R, me) {
    const m = R.results;
    const mine = m.standings.find((x) => x.i === me);
    const S = m.standings;
    let html = '';
    // This rider's own result first, then the podium, the rest, and where the pot went.
    if (m.voided) html += `<div class="race-hero res void"><b class="clock">✖</b><div><span class="lbl">${esc(t('race.voided'))}</span><p>${esc(t('race.voidedWhy'))}</p></div></div>`;
    else if (mine) {
      const won = mine.place === 1;
      // Time alive decides the race; say by how much the rider just ahead outlasted this one.
      const above = !won && S.find((x) => x.place === mine.place - 1);
      const gap = above && above.tick > mine.tick ? (above.tick - mine.tick) / 60 : 0;
      const by = gap ? `<small class="race-by">${esc(t('race.outlasted', { name: above.name, s: gap < 1 ? gap.toFixed(2) : gap.toFixed(1) }))}</small>` : '';
      html += `<div class="race-hero res${won ? ' won' : ''}"><b class="clock">#${mine.place}</b><div><span class="lbl">${esc(t(won ? 'race.winner' : 'race.placeLbl'))}</span><p>${esc(won ? t('race.youWon', { n: m.each }) : t('race.ofN', { n: S.length }))}</p>${by}</div></div>`;
    } else html += `<h4 class="race-sec">${esc(t('race.results'))}</h4>`;

    const medal = (p) => ['🥇', '🥈', '🥉'][p - 1] || p;
    const top = S.slice(0, 3);
    const order = top.length === 3 ? [top[1], top[0], top[2]] : top.length === 2 ? [top[1], top[0]] : top;
    html += `<div class="podium">${order
      .map((x) => `<div class="pod p${Math.min(3, x.place)}${x.i === me ? ' you' : ''}"><span class="medal">${medal(x.place)}</span><b>${esc(x.name)}</b><small>${x.dist} m</small><small>${esc(t('race.how', { s: x.time, r: raceReason(x.reason) }))}</small><i>${x.place}</i></div>`)
      .join('')}</div>`;
    const rest = S.slice(3, 8);
    const meRow = S.findIndex((x) => x.i === me);
    if (meRow >= 8) rest.push(S[meRow]);
    html += rest
      .map((x) => `<div class="lb rr ${x.i === me ? 'you' : ''}"><span class="n">${x.place}</span><span class="who">${esc(x.name)}</span><small>${esc(t('race.how', { s: x.time, r: raceReason(x.reason) }))}</small><span>${x.dist} m</span></div>`)
      .join('');
    // Someone placed below a rider who went less far: say what decides the order.
    if (S.some((x, i) => S.slice(0, i).some((y) => y.place < x.place && y.dist < x.dist))) html += `<p class="note">${esc(t('race.aliveRule'))}</p>`;
    html += m.voided
      ? `<div class="race-pay"><span>↩️ ${esc(t('race.refundChip'))}</span></div>`
      : `<div class="race-pay"><span>🏆 ${esc(t('race.prizeChip', { n: m.prize }))}</span>${m.house ? `<span>🏦 ${esc(t('race.feeChip', { n: m.house }))}</span>` : `<span>🔥 ${esc(t('race.burnChip', { n: m.burned }))}</span>`}</div>`;
    return html;
  }

  tickDaily() {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    const txt = t('title.daily') + ' · ' + t('title.resets', { t: pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60) });
    if (this.cache.daily !== txt) {
      this.cache.daily = txt;
      $('tDaily').textContent = txt;
    }
  }

  showTitle(on) {
    this.el.title.classList.toggle('out', !on);
    if (on) this.refreshTitle();
  }

  // --- HUD --------------------------------------------------------------
  showHud(on) {
    this.el.hud.classList.toggle('off', !on);
  }

  hud(score, flakes, kmh, danger, combo, comboLeft) {
    if (Math.floor(score / 100) !== this.cache.hundred) {
      this.cache.hundred = Math.floor(score / 100);
      this.tick('distNum');
    }
    if (this.cache.hudFlakes !== String(flakes)) this.tick('hudFlakes');
    this.set('distNum', String(score));
    this.set('hudFlakes', String(flakes));
    this.set('hudSpeed', String(kmh));
    const pct = Math.round(danger * 100);
    if (this.cache.danger !== pct) {
      this.cache.danger = pct;
      this.el.meterFill.style.height = pct + '%';
      this.el.meter.classList.toggle('hot', danger > 0.7);
    }
    if (this.cache.combo !== combo) {
      const c = this.el.combo;
      c.classList.toggle('on', combo > 1);
      if (combo > 1) {
        c.textContent = t('hud.combo', { n: combo });
        c.classList.remove('bump');
        void c.offsetWidth;
        c.classList.add('bump');
      }
      this.cache.combo = combo;
    }
    if (combo > 1) this.el.combo.style.setProperty('--left', comboLeft.toFixed(2));
  }

  // Moment-to-moment feedback goes to a small feed at the side of the screen,
  // so nothing ever covers the piste ahead. Only the countdown uses the centre.
  callout(text, kind) {
    const feed = $('feed');
    const n = document.createElement('div');
    n.className = 'call ' + (kind || '');
    n.textContent = text;
    feed.insertBefore(n, feed.firstChild);
    while (feed.children.length > 3) feed.removeChild(feed.lastChild);
    setTimeout(() => n.remove(), 1500);
  }

  banner(big, small, kind, dur) {
    if (kind !== 'count' && kind !== 'go') {
      this.callout(big || small, (kind || '') + (big ? ' major' : ''));
      return;
    }
    const b = this.el.banner;
    this.el.bannerBig.textContent = big || '';
    this.el.bannerSmall.textContent = small || '';
    b.className = kind || '';
    // "GO!" fills the screen; longer words (WINNER!, ¡GANADOR!) shrink to fit.
    const len = [...(big || '')].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 1.5 : 1), 0);
    b.style.setProperty('--fit', (kind === 'go' && len > 3 ? Math.min(120, Math.floor(380 / (len * 0.68))) : 120) + 'px');
    b.style.setProperty('--dur', (dur || (big ? 1.5 : 1.0)) + 's');
    void b.offsetWidth;
    b.classList.add('pop');
  }

  hint(text, kind) {
    const key = text + '|' + kind;
    if (this.cache.hint === key) return;
    this.cache.hint = key;
    this.el.hint.classList.toggle('on', !!text);
    if (text) this.el.hintText.textContent = text;
    this.el.hand.className = kind || 'none';
  }

  // Landing ring around the rider. k: 1 (far from landing) .. 0 (touchdown).
  ring(on, x, y, k, state) {
    const r = this.el.ring;
    const cls = on ? 'on ' + state : '';
    if (this.cache.ring !== cls) {
      this.cache.ring = cls;
      r.className = cls;
    }
    if (!on) return;
    r.style.left = x.toFixed(0) + 'px';
    r.style.top = y.toFixed(0) + 'px';
    r.style.setProperty('--k', (0.35 + k * 1.1).toFixed(3));
  }

  frost(amount) {
    const v = Math.round(amount * 50) / 50;
    if (this.cache.frost === v) return;
    this.cache.frost = v;
    this.el.frost.style.opacity = String(v);
  }

  // Diagonal-bar screen wipe; fn runs while the screen is covered.
  wipe(fn) {
    const w = $('wipe');
    if (document.body.classList.contains('reduced') || this.instant) {
      fn();
      return;
    }
    w.classList.remove('go');
    void w.offsetWidth;
    w.classList.add('go');
    clearTimeout(this.wipeTimer);
    this.wipeTimer = setTimeout(() => w.classList.remove('go'), 1100);
    setTimeout(fn, 330);
  }

  // Zone title card: bands slide in from both sides with the name, then leave.
  zone(name, sub) {
    const z = $('zone');
    $('zoneName').textContent = name;
    $('zoneSub').textContent = sub || '';
    z.classList.remove('go');
    void z.offsetWidth;
    z.classList.add('go');
    clearTimeout(this.zoneTimer);
    this.zoneTimer = setTimeout(() => z.classList.remove('go'), 2900);
  }

  tick(id) {
    const n = this.el[id];
    n.classList.remove('tick');
    void n.offsetWidth;
    n.classList.add('tick');
  }

  countUp(node, to, ms) {
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && this.endShown) requestAnimationFrame(step);
      else node.textContent = String(to);
    };
    step();
  }

  // A collected coin arcs from where it was picked up to the coin counter.
  coinFly(x, y) {
    if (document.body.classList.contains('reduced') || document.hidden) return;
    this.flying = this.flying || 0;
    if (this.flying > 14) return;
    const target = this.el.hudFlakes.parentNode.getBoundingClientRect();
    const host = this.el.hud.getBoundingClientRect();
    const tx = (target.left - host.left) / FRAME.scale + 12;
    const ty = (target.top + target.height / 2 - host.top) / FRAME.scale;
    const n = document.createElement('div');
    n.className = 'coinfly';
    this.el.hud.appendChild(n);
    this.flying++;
    const mx = (x + tx) / 2 + (Math.random() - 0.5) * 80;
    const my = Math.min(y, ty) - 60 - Math.random() * 60;
    const anim = n.animate(
      [
        { transform: `translate(${x}px,${y}px) scale(1.5)`, opacity: 1 },
        { transform: `translate(${mx}px,${my}px) scale(1.15)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${tx}px,${ty}px) scale(0.6)`, opacity: 0.9 },
      ],
      { duration: 460, easing: 'cubic-bezier(.4,0,.6,1)' }
    );
    const done = () => {
      n.remove();
      this.flying--;
      const pill = this.el.hudFlakes.parentNode;
      pill.classList.remove('got');
      void pill.offsetWidth;
      pill.classList.add('got');
    };
    anim.onfinish = done;
    anim.oncancel = done;
  }

  whiteout(amount) {
    const v = Math.round(amount * 40) / 40;
    if (this.cache.white === v) return;
    this.cache.white = v;
    const f = this.el.flash;
    f.style.transition = 'none';
    f.style.opacity = String(v);
  }

  flash(amount) {
    this.cache.white = -1;
    const f = this.el.flash;
    f.style.transition = 'none';
    f.style.opacity = String(amount);
    void f.offsetWidth;
    f.style.transition = 'opacity .5s';
    f.style.opacity = '0';
  }

  speedLines(dt, amount) {
    const g = this.fx;
    const w = this.w;
    const h = this.h;
    if (this.fxDirty) {
      g.clearRect(0, 0, w, h);
      this.fxDirty = false;
    }
    if (amount <= 0.02) return;
    this.fxDirty = true;
    const cx = w / 2;
    const cy = h * 0.56;
    const R = Math.hypot(w, h) * 0.5;
    g.lineCap = 'round';
    for (const l of this.lines) {
      l.r += dt * (1.6 + 2.5 * amount);
      if (l.r > 1) {
        l.r = 0.6 + Math.random() * 0.12;
        l.a = Math.random() * 6.28;
        l.l = 0.05 + Math.random() * 0.09;
      }
      const c = Math.cos(l.a);
      const s = Math.sin(l.a);
      g.strokeStyle = 'rgba(255,255,255,' + (0.3 * amount * (1 - Math.abs(s) * 0.3)).toFixed(3) + ')';
      g.lineWidth = 1.5 + 2 * amount;
      g.beginPath();
      g.moveTo(cx + c * R * l.r, cy + s * R * l.r * 0.9);
      g.lineTo(cx + c * R * (l.r + l.l), cy + s * R * (l.r + l.l) * 0.9);
      g.stroke();
    }
  }

  toast(text) {
    const n = document.createElement('div');
    n.className = 'toast';
    n.textContent = text;
    this.el.toasts.appendChild(n);
    setTimeout(() => n.remove(), 3300);
  }

  // --- pause / end --------------------------------------------------------
  showPause(on) {
    this.el.pause.classList.toggle('hidden', !on);
  }

  // data: {summary, result, profile}
  showEnd(data) {
    const s = data.summary;
    const title = CONFIG.ad.endTitle || t(s.outcome === 'timeout' ? 'end.title.timeout' : s.outcome === 'caught' ? 'end.title.caught' : 'end.title.crash');
    $('endTitle').textContent = title;
    let key = 'cause.' + s.cause;
    if (s.cause === 'caught') key += '.' + (s.causeDetail || 'slow');
    else if (s.causeDetail && t(key + '.' + s.causeDetail) !== key + '.' + s.causeDetail) key += '.' + s.causeDetail;
    $('endCause').textContent = CONFIG.ad.endSub || t(key);
    $('endScore').textContent = '0';
    $('endBest').classList.toggle('hidden', !data.result.newBest);
    // On the website the local CPU rank never shows; online runs show their save status instead.
    $('endRank').textContent = !this.host() && data.result.rank ? t('end.rank', { n: data.result.rank }) : '';
    this.online(data.attempt);
    $('endSpeed').textContent = String(s.topKmh);
    $('endNear').textContent = String(s.nearMisses);
    $('endCombo').textContent = 'x' + s.bestCombo;
    $('endTricks').textContent = String(s.tricks);
    $('endFlakes').textContent = '+' + (s.flakes + data.result.missionFlakes);
    $('endToday').textContent = this.bestToday() + ' ' + t('unit.pts');
    // The score is points (metres plus bonuses); the metres ridden sit beside it.
    $('endMetres').textContent = t('end.ridden', { n: s.distance });
    $('endMissions').innerHTML = data.profile.missions.active
      .map((m) => this.missionRow(m, data.result.completed.includes(m.id)))
      .join('');
    this.el.end.classList.remove('hidden');
    this.endShown = true;
    if (document.hidden) $('endScore').textContent = String(s.score);
    else setTimeout(() => this.endShown && this.countUp($('endScore'), s.score, 900), 300);
    return { title, cause: $('endCause').textContent };
  }

  // Save status and rewards for this attempt on the end card.
  online(a) {
    const el = $('endOnline');
    el.classList.toggle('hidden', !a);
    if (!a) return;
    const h = this.host();
    const r = a.result || {};
    let line = '';
    const chips = [];
    if (a.status === 'saving' || a.status === 'playing') line = t('online.saving');
    else if (a.status === 'counted' || a.status === 'duplicate') {
      const me = h && h.board && h.board.me;
      // A board fetched before this save would show an old rank; wait for the refresh.
      const rank = me && me.score >= a.score ? me.rank : 0;
      if (a.status === 'duplicate') {
        line = t('online.duplicate');
        chips.push(`<span class="note">${esc(t('online.dupReward'))}</span>`);
      } else {
        line = rank ? t('online.savedRank', { n: rank }) : t('online.saved');
        if (r.xp > 0) chips.push(`<span class="pill">${esc(t('online.xp', { n: r.xp }))}</span>`);
        if (r.coins > 0) chips.push(`<span class="pill">${esc(t('online.coins', { n: r.coins }))}</span>`);
        if (r.credits_pending > 0) chips.push(`<span class="pill">${esc(t('online.credits', { n: r.credits_pending }))}</span>`);
        const p = r.pop;
        if (p && p.label) {
          const tier = p.cleared ? (p.tier === 'half' ? t('reward.half') : t('reward.cleared')) : p.value != null ? p.value + ' / ' + p.threshold : '';
          chips.push(`<span class="pill pop ${p.cleared ? 'on' : ''}">🎁 ${esc(p.label)}${tier ? ' · ' + esc(tier) : ''}</span>`);
          if (p.xp_blocked_by_cap) chips.push(`<span class="note">${esc(t('online.cap'))}</span>`);
        }
        if (!chips.length) chips.push(`<span class="note">${esc(t('online.noReward'))}</span>`);
      }
    } else if (a.status === 'rejected') line = a.reason ? t('online.rejected', { r: a.reason }) : t('online.rejectedPlain');
    else if (a.status === 'signin') line = t('online.signin');
    else line = t('online.failed');
    const retry = a.status === 'failed' || a.status === 'signin';
    el.className = 'online ' + a.status;
    el.innerHTML =
      `<div class="ol-line"><span>${esc(line)}</span>${retry ? `<button id="saveRetry" class="btn small" data-ui>${esc(t('online.retry'))}</button>` : ''}</div>` +
      (chips.length ? `<div class="ol-chips">${chips.join('')}</div>` : '');
    if (retry) press($('saveRetry'), () => this.hooks.retrySave());
  }

  hideEnd() {
    this.el.end.classList.add('hidden');
    this.endShown = false;
  }

  missionRow(m, fresh) {
    const def = missionById(m.id);
    if (!def) return '';
    const pct = Math.min(100, Math.round((m.progress / def.goal) * 100));
    return (
      `<div class="row ${m.done ? 'done' : ''}"><div class="grow"><p>${esc(missionText(m))}</p><div class="bar"><i style="width:${pct}%"></i></div></div>` +
      `<span class="pill">${m.done ? (fresh ? '+' + def.reward + ' ❄' : t('missions.done')) : Math.min(m.progress, def.goal) + '/' + def.goal + ' · ' + def.reward + ' ❄'}</span></div>`
    );
  }

  // Sign in to the real zerochill.com backend (live test mode). The password
  // goes straight to the backend's auth endpoint; nothing here keeps it.
  accountPanel(body) {
    const live = this.live();
    if (!live) {
      body.innerHTML = '';
      return;
    }
    const warn = `<p class="note warn">${esc(t('acct.warn'))}</p>`;
    if (live.session) {
      body.innerHTML =
        `<div class="row"><div class="ico">👤</div><div class="grow"><h3>${esc(t('acct.signedIn'))}</h3><p>${esc(live.email)}</p></div></div>` +
        warn +
        `<button class="btn" id="acctOut">${esc(t('acct.signOut'))}</button>`;
      press($('acctOut'), () => this.hooks.signOut().then(() => this.renderPanel()));
      return;
    }
    body.innerHTML =
      warn +
      `<form id="acctForm" class="acct-form" autocomplete="on">` +
      `<label>${esc(t('acct.email'))}<input id="acctEmail" type="email" autocomplete="username" required></label>` +
      `<label>${esc(t('acct.password'))}<input id="acctPass" type="password" autocomplete="current-password" required></label>` +
      `<p id="acctErr" class="note err"></p>` +
      `<button class="btn primary" type="submit" id="acctGo">${esc(t('acct.signIn'))}</button></form>`;
    const form = $('acctForm');
    form.querySelectorAll('input').forEach((i) => i.addEventListener('pointerdown', (e) => e.stopPropagation()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const go = $('acctGo');
      if (go.disabled) return;
      go.disabled = true;
      $('acctErr').textContent = '';
      this.hooks
        .signIn($('acctEmail').value.trim(), $('acctPass').value)
        .then(() => {
          this.hooks.tap('select');
          this.renderPanel();
        })
        .catch((err) => {
          go.disabled = false;
          $('acctErr').textContent = t('acct.failed', { r: err.message });
        });
    });
  }

  // Today's board from the website: top rows, your row, players, all-time record.
  onlineRanks(body) {
    const b = this.host().board;
    if (!b) {
      body.innerHTML = `<p class="note">${esc(t('ranks.loading'))}</p>`;
      return;
    }
    const me = b.me;
    const top = Array.isArray(b.top) ? b.top : [];
    const row = (r, you) => `<div class="lb ${you ? 'you' : ''}"><span class="n">${r.rank}</span>${avatar(r)}<span class="who">${esc(displayName(r))}</span><span>${r.score} ${esc(t('unit.pts'))}</span></div>`;
    let html = '';
    if (b.record) html += `<div class="lb record"><span class="n">🏆</span>${avatar(b.record)}<span class="who"><small>${esc(t('ranks.record'))}</small>${esc(displayName(b.record))}</span><span>${b.record.score} ${esc(t('unit.pts'))}</span></div>`;
    html += top.length ? top.map((r) => row(r, me && r.rank === me.rank)).join('') : `<p class="note">${esc(t('ranks.empty'))}</p>`;
    if (me && !top.some((r) => r.rank === me.rank)) html += `<div class="lb-gap">⋯</div>` + row(me, true);
    html += `<p class="note">${esc(t('ranks.players', { n: b.players || 0 }))} · ${esc(t('ranks.onlineNote'))}</p>`;
    body.innerHTML = html;
    wireAvatars(body);
  }

  // The Daily / Race switch at the top of Ranks (only while races are on).
  ranksTabs(body) {
    if (!this.raceClient()) return;
    const tab = this.ranksTab || 'daily';
    body.insertAdjacentHTML('afterbegin', `<div class="race-tabs">${['daily', 'race'].map((k) => `<button data-rtab="${k}" class="${k === tab ? 'on' : ''}">${esc(t('ranks.tab.' + k))}</button>`).join('')}</div>`);
    body.querySelectorAll('[data-rtab]').forEach((el) =>
      press(el, () => {
        this.ranksTab = el.dataset.rtab;
        if (this.ranksTab === 'race') this.raceClient().requestBoard();
        this.renderPanel();
      }),
    );
  }

  // Race leaders: your record, then the top riders by wins, your row pinned below.
  raceRanks(body) {
    const R = this.raceClient();
    const st = R.stats || { races: 0, wins: 0, won: 0 };
    const tile = (v, k) => `<div><b>${esc(String(v))}</b><span>${esc(t(k))}</span></div>`;
    let html = `<div class="tiles">${tile(st.races, 'race.races') + tile(st.wins, 'race.wins') + tile('💎 ' + st.won, 'race.shardsWon')}</div>`;
    const b = R.board;
    const row = (r) => `<div class="lb rr${r.me ? ' you' : ''}"><span class="n">${r.rank === 1 ? '👑' : r.rank}</span><span class="who">${esc(r.me ? t('ranks.you') : r.name)}</span><small>${esc(t('ranks.raceLine', { r: r.races, s: r.won }))}</small><span>🏆 ${r.wins}</span></div>`;
    if (!b) html += `<p class="note">${esc(R.status === 'online' ? t('ranks.loadingRace') : t('race.connecting'))}</p>`;
    else {
      const top = Array.isArray(b.top) ? b.top : [];
      html += top.length ? top.map(row).join('') : `<p class="note">${esc(t('ranks.emptyRace'))}</p>`;
      if (b.me && !top.some((r) => r.me)) html += `<div class="lb-gap">⋯</div>` + row(b.me);
      html += `<p class="note">${esc(t('ranks.raceNote', { n: b.riders || 0 }))}</p>`;
    }
    body.innerHTML = html;
  }

  // --- panels -------------------------------------------------------------
  openPanel(name) {
    this.panelName = name;
    if (name === 'ranks' && this.host()) this.hooks.refreshOnline();
    if (name === 'ranks' && this.raceClient()) this.raceClient().requestBoard();
    this.hooks.tap('panelOpen');
    this.renderPanel();
    this.el.panel.classList.toggle('lobby', name === 'lobby');
    this.el.panel.classList.remove('hidden');
  }

  closePanel(force) {
    if (!this.panelName) return;
    // The lobby only closes by leaving (refund) or when the race starts.
    if (this.panelName === 'lobby' && !force) return;
    const was = this.panelName;
    this.panelName = '';
    this.el.panel.classList.add('hidden');
    this.hooks.tap('panelClose');
    this.hooks.panelClosed(was);
    this.refreshTitle();
  }

  renderPanel() {
    const body = this.el.panelBody;
    const name = this.panelName;
    const p = this.profile();
    const titles = { lobby: 'lobby.title', race: 'race.title', account: 'acct.title', how: 'how.title', missions: 'missions.title', shop: 'shop.title', ranks: 'ranks.title', settings: 'settings.title' };
    // With races on, Ranks has two tabs: today's mountain and the race leaders.
    const raceRanks = name === 'ranks' && !!this.raceClient();
    const ranksTab = raceRanks ? this.ranksTab || 'daily' : 'daily';
    this.el.panelTitle.textContent = t(name === 'ranks' && ranksTab === 'race' ? 'ranks.raceTitle' : titles[name]);
    if (name === 'race') {
      this.racePanel(body);
    } else if (name === 'how') {
      const rows = [['steer', '👆'], ['jump', '⤴️'], ['grab', '✊'], ['avoid', '🌲'], ['dash', '⏩'], ['wall', '🌨️'], ['daily', '🗓️']];
      body.innerHTML =
        rows.map(([k, ico]) => `<div class="row tight"><div class="ico">${ico}</div><div class="grow"><h3>${esc(t('how.' + k + '.h'))}</h3><p>${esc(t('how.' + k))}</p></div></div>`).join('') +
        `<button class="btn primary" id="howOk">${esc(t('how.ok'))}</button>`;
      press($('howOk'), () => this.closePanel());
    } else if (name === 'missions') {
      const M = CONFIG.meta;
      const next = nextStreakReward(p);
      const reward = (r) => (r.flakes ? t('reward.flakes', { n: r.flakes }) : r.rider ? t('reward.rider') : t('reward.board'));
      const days = M.streakRewards.map((r) => `<div class="${p.streak >= r.day ? 'got' : ''}"><b>${r.day}</b>${esc(r.flakes ? r.flakes + ' ❄' : r.rider ? '🏂' : '🛹')}</div>`).join('');
      this.dailyReward();
      body.innerHTML =
        (this.rewardHtml || '') +
        p.missions.active.map((m) => this.missionRow(m, false)).join('') +
        (p.missions.active.some((m) => m.done) ? `<p class="note">${esc(t('missions.new'))}</p>` : '') +
        `<div class="row"><div class="ico">🔥</div><div class="grow"><h3>${esc(t('streak.title'))} · ${Math.max(1, p.streak)}</h3><p>${esc(t('streak.next', { d: next.day, r: reward(next) }))}</p></div></div>` +
        `<div class="streak">${days}</div>`;
    } else if (name === 'shop') {
      const type = this.shopTab;
      // Trails start with "no trail", always owned.
      const list = type === 'rider' ? RIDERS : type === 'board' ? BOARDS : [{ id: 'none' }].concat(TRAILS);
      const current = type === 'rider' ? p.rider : type === 'board' ? p.board : p.trail || 'none';
      // Shards items need the server profile, which carries the wallet balance.
      const shards = typeof p.shards === 'number' ? p.shards : null;
      const galaxyDefs = `<defs><radialGradient id="galx" cx="35%" cy="40%" r="75%"><stop offset="0" stop-color="#B57CFF"/><stop offset="0.45" stop-color="#4B2AA8"/><stop offset="1" stop-color="#120C2E"/></radialGradient></defs>`;
      const galaxyStars = `<g fill="#fff"><circle cx="22" cy="42" r="0.9"/><circle cx="35" cy="48" r="1.2"/><circle cx="40" cy="39" r="0.8"/><circle cx="27" cy="51" r="0.7"/></g>`;
      const streakDay = (id) => (CONFIG.meta.streakRewards.find((r) => r[type] === id) || {}).day;
      const sw = (it) =>
        type === 'rider'
          ? `<svg viewBox="0 0 60 60" style="position:absolute;left:50%;top:2px;width:56px;height:56px;transform:translateX(-50%)">${it.fx === 'galaxy' ? galaxyDefs : ''}<path d="M14 46 Q30 60 46 46 L44 34 H16 Z" fill="${it.fx === 'galaxy' ? 'url(#galx)' : it.hoodie}"/>${it.fx === 'galaxy' ? galaxyStars : ''}<path d="M15 46 Q30 58 45 46" stroke="${it.trim}" stroke-width="2.5" fill="none"/><path d="M12 6 L22 18 L16 26 Z M48 6 L38 18 L44 26 Z" fill="${it.fur}"/><path d="M14 10 L20 18 L17 22 Z M46 10 L40 18 L43 22 Z" fill="${it.cream}"/><ellipse cx="30" cy="24" rx="16" ry="13" fill="${it.fur}"/><path d="M14 26 Q20 38 30 38 Q40 38 46 26 Q38 32 30 31 Q22 32 14 26 Z" fill="${it.cream}"/><rect x="18" y="20" width="24" height="6" rx="3" fill="#0E0F13"/><circle cx="30" cy="31" r="2.2" fill="#0E0F13"/><path d="M13 24 Q12 8 30 8 Q48 8 47 24" stroke="#0E0F13" stroke-width="2" fill="none"/><circle cx="13" cy="25" r="4" fill="#0E0F13" stroke="${it.gear}" stroke-width="1.5"/><circle cx="47" cy="25" r="4" fill="#0E0F13" stroke="${it.gear}" stroke-width="1.5"/></svg>`
          : type === 'board'
            ? `<i class="${it.fx === 'galaxy' ? 'gx' : ''}" style="left:8%;top:20px;width:84%;height:18px;border-radius:9px;background:${it.deck};box-shadow:0 3px 0 ${it.edge}"></i><i style="left:36%;top:20px;width:28%;height:18px;background:${it.stripe}"></i>`
            : it.id === 'none'
              ? `<i class="trail-sw none"></i>`
              : `<i class="trail-sw ${it.pulse ? 'pulse' : ''}" style="--a:${it.colors[0]};--b:${it.colors[1]};--c:${it.colors[2] || it.colors[1]};${it.rainbow ? 'background:linear-gradient(90deg,#ff4d6d,#ffd23f,#3ddc97,#35d6ff,#9b6bff,#ff4d6d);background-size:200% 100%' : ''}"></i>`;
      const tab = (id, key) => `<button data-tab="${id}" class="${type === id ? 'on' : ''}">${esc(t(key))}</button>`;
      body.innerHTML =
        `<div class="tabs">${tab('rider', 'shop.riders')}${tab('board', 'shop.boards')}${tab('trail', 'shop.trails')}</div>` +
        `<div class="shop-wallet"><div class="chip gold">❄ <b>${p.flakes}</b></div>${shards != null ? `<div class="chip gold shards">💎 <b>${shards}</b></div>` : ''}</div><div class="grid">` +
        list
          .map((it) => {
            const have = it.id === 'none' || owns(p, type, it.id);
            const sel = current === it.id;
            let btn;
            if (sel) btn = `<button disabled>${esc(t('shop.inUse'))}</button>`;
            else if (have) btn = `<button data-use="${it.id}">${esc(t(it.id === 'none' ? 'shop.off' : 'shop.use'))}</button>`;
            else if (it.shards) btn = shards == null ? `<button disabled>💎 ${it.shards} · ${esc(t('shop.signIn'))}</button>` : `<button class="buy gem" data-buy="${it.id}" ${shards < it.shards ? 'disabled' : ''}>💎 ${it.shards}</button>`;
            else if (it.cost < 0) btn = `<button disabled>${esc(t('shop.streak', { n: streakDay(it.id) || 7 }))}</button>`;
            else btn = `<button class="buy" data-buy="${it.id}" ${p.flakes < it.cost ? 'disabled' : ''}>❄ ${it.cost}</button>`;
            return `<div class="item ${sel ? 'sel' : ''} ${it.shards ? 'gem' : ''}"><div class="swatch">${sw(it)}</div><strong>${esc(t(type + '.' + it.id))}</strong>${btn}</div>`;
          })
          .join('') +
        `</div><p class="note">${esc(t(type === 'trail' || list.some((it) => it.shards) ? 'shop.shardsNote' : 'shop.cosmetic'))}</p>`;
      body.querySelectorAll('[data-tab]').forEach((b) =>
        press(b, () => {
          this.shopTab = b.getAttribute('data-tab');
          this.hooks.tap('toggle');
          this.renderPanel();
        })
      );
      body.querySelectorAll('[data-use]').forEach((b) =>
        press(b, () => {
          this.hooks.select(type, b.getAttribute('data-use'));
          this.renderPanel();
        })
      );
      body.querySelectorAll('[data-buy]').forEach((b) =>
        press(b, () => {
          if (b.disabled) return;
          this.hooks.buy(type, b.getAttribute('data-buy'));
          this.renderPanel();
        })
      );
    } else if (name === 'account') {
      this.accountPanel(body);
    } else if (name === 'lobby') {
      this.lobbyPanel(body);
    } else if (name === 'ranks' && ranksTab === 'race') {
      this.raceRanks(body);
    } else if (name === 'ranks' && this.host()) {
      this.onlineRanks(body);
    } else if (name === 'ranks') {
      const rows = leaderboard(p, p.day);
      body.innerHTML =
        rows
          .map(
            (r, i) =>
              `<div class="lb ${r.you ? 'you' : ''}"><span class="n">${i + 1}</span><span class="who">${r.cpu ? `<span class="tagc">${esc(t('ranks.cpu'))}</span>` : ''}${esc(r.you ? t('ranks.you') : r.name)}</span><span>${r.score} ${esc(t('unit.pts'))}</span></div>`
          )
          .join('') + `<p class="note">${esc(t('ranks.note'))}</p>`;
    } else if (name === 'settings') {
      const st = p.settings;
      const sw = (key) => `<div class="set"><span>${esc(t('settings.' + key))}</span><button class="switch ${st[key] ? 'on' : ''}" data-sw="${key}" role="switch" aria-checked="${!!st[key]}"></button></div>`;
      const range = (key, max) => `<div class="set"><span>${esc(t('settings.' + key))}</span><input type="range" min="0" max="${max}" step="0.05" value="${st[key]}" data-range="${key}"></div>`;
      const sel = (key, opts) => `<div class="set"><span>${esc(t('settings.' + key))}</span><select data-sel="${key}">${opts.map(([v, label]) => `<option value="${v}" ${st[key] === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>`;
      body.innerHTML =
        range('music', 1) +
        range('sfx', 1) +
        (CONFIG.announcer ? sw('announcer') : '') +
        sw('haptics') +
        sw('tapSteer') +
        sw('colorblind') +
        sw('reducedMotion') +
        range('shake', 1) +
        sel('lang', [['auto', LANG_NAMES.auto]].concat(LANGS.map((l) => [l, LANG_NAMES[l]]))) +
        sel('theme', [['glacier', t('theme.glacier')], ['arcade', t('theme.arcade')]]) +
        sel('quality', ['auto', 'low', 'medium', 'high'].map((q) => [q, t('quality.' + q)]));
      body.querySelectorAll('[data-sw]').forEach((b) =>
        press(b, () => {
          const key = b.getAttribute('data-sw');
          this.hooks.setting(key, !st[key]);
          b.classList.toggle('on', !!st[key]);
          b.setAttribute('aria-checked', String(!!st[key]));
        })
      );
      body.querySelectorAll('[data-range]').forEach((r) => {
        r.addEventListener('pointerdown', (e) => e.stopPropagation());
        r.addEventListener('input', () => this.hooks.setting(r.getAttribute('data-range'), +r.value));
      });
      body.querySelectorAll('[data-sel]').forEach((r) => {
        r.addEventListener('pointerdown', (e) => e.stopPropagation());
        r.addEventListener('change', () => this.hooks.setting(r.getAttribute('data-sel'), r.value));
      });
    }
    if (raceRanks) this.ranksTabs(body);
  }
}
