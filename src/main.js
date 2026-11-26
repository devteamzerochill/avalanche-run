// Game loop and glue: owns the systems, feeds inputs to the simulation at a
// fixed step, turns simulation events into sound, particles, haptics and UI.
import { RECORD } from './systems/record.js'; // first: installs the virtual clock in record mode
import * as THREE from 'three';
import { CONFIG, RIDERS, BOARDS, TRAILS, applyParams } from './config.js';
import { dailySeed, utcDay, clamp } from './core/rng.js';
import { Sim, gridStart } from './core/sim.js';
import { Bot, HumanBot } from './core/bot.js';
import { Recorder, Playback, quantise } from './core/replay.js';
import { Store } from './systems/save.js';
import { rollDay, startRun, finishRun, buy, select } from './systems/meta.js';
import { initLocalServices, services } from './systems/services.js';
import { Host } from './systems/host.js';
import { RaceClient, raceRequested, runCheckUrl } from './systems/race.js';
import { setLang, getLang, t } from './systems/i18n.js';
import { AudioEngine } from './systems/audio.js';
import { Haptics } from './systems/haptics.js';
import { Announcer } from './systems/announcer.js';
import { Input } from './systems/input.js';
import { isAdBuild, hasCta, openStore, track } from './systems/playable.js';
import { Stage } from './render/stage.js';
import { Props, setInk } from './render/props.js';
import { Rider, GALAXY } from './render/rider.js';
import { Racers } from './render/racers.js';
import { Avalanche } from './render/avalanche.js';
import { Particles, Snowfall, Trail, SpeedTrail, makeBlobShadow } from './render/particles.js';
import { ChaseCamera } from './render/camera.js';
import { UI, chatText } from './ui/ui.js';
import { FRAME, applyFrame } from './ui/frame.js';
import { Perf } from './systems/perf.js';
import { Ads } from './systems/ads.js';

const query = new URLSearchParams(location.search);
const TEST = query.has('test');
const AD = isAdBuild();
const TEST_SEED = 20261115; // the prototype's fixed test seed
// Portrait lock: the web player keeps a 9:16 frame on wide screens and asks
// phones held sideways to rotate. The playable ad keeps its landscape layout.
const PORTRAIT = !!window.__PORTRAIT || query.has('portrait');

class Game {
  constructor() {
    applyParams(window.__PARAMS);
    this.store = new Store(TEST ? null : undefined);
    this.profile = this.store.profile;
    rollDay(this.profile, utcDay());
    initLocalServices(this.store);
    // zerochill.com bridge; inactive unless the page opts in with ?host=<origin>.
    this.host = new Host();
    // Trick points count in the score, except on runs the real zerochill.com
    // backend scores (the page hosting us, or ?live against it) until the site
    // has agreed to the higher scores (CONFIG.score.tricksLive).
    const live = this.host.live;
    const realSite = !!this.host.origin || (!!live && live.url !== CONFIG.online.local.url.replace(/\/$/, ''));
    CONFIG.score.tricks = CONFIG.score.tricksLive || !realSite;
    this.attempt = null;
    // Endurance race (?race): the race server replays every rider and decides
    // the result; this side streams inputs and draws the others in their own look.
    this.race = raceRequested() ? new RaceClient((type, m) => this.onRace(type, m)) : null;
    this.raceMode = null; // the race being ridden
    this.said = new Map(); // grid slot or lobby place -> { id, at }: the last quick-chat line
    setLang(window.__LANG || this.profile.settings.lang);

    if (PORTRAIT) document.body.classList.add('portrait-lock');
    applyFrame(PORTRAIT);
    this.state = 'title'; // title | play | paused | end
    this.time = 0;
    this.acc = 0;
    this.lead = 0; // part of a tick not yet simulated, carried forward for drawing
    this.timeScale = 1;
    this.slowT = 0;
    this.lesson = 0; // 0 none, 1 jump lesson running, 2 grab lesson running
    this.lessonsDone = { jump: this.profile.seenHow || RECORD, grab: this.profile.seenHow || RECORD };
    this.endT = 0;
    this.botOn = query.has('bot');
    this.bot = null;
    this.ghost = null;
    this.frameMs = 16.7;
    this.fps = 60;
    this.q = { level: 2, acc: 0, n: 0, auto: true };
    this.pulse = { boost: 0 };

    const el = document.getElementById('game');
    this.stage = new Stage(el, { preserve: TEST });
    this.stage.world.updateMatrixWorld(true);
    this.props = new Props(this.stage);
    this.avalanche = new Avalanche(this.stage);
    this.particles = new Particles(this.stage, 1400);
    this.snowfall = new Snowfall(this.stage, 1500);
    this.trail = new Trail(this.stage);
    this.speedTrail = new SpeedTrail(this.stage);
    this.racers = new Racers(this.stage);
    this.shotW = 0; // weight of a set camera shot (lobby grid, race intro)
    this.mirrorEl = document.getElementById('mirror');
    this.shadow = makeBlobShadow();
    this.stage.world.add(this.shadow);
    this.rider = new Rider();
    this.stage.world.add(this.rider.root);
    this.ghostRider = new Rider({ ghost: true });
    this.ghostRider.root.visible = false;
    this.stage.world.add(this.ghostRider.root);
    this.camera = new ChaseCamera(this.stage);

    this.audio = new AudioEngine();
    this.haptics = new Haptics();
    this.ads = new Ads();
    this.voice = new Announcer();
    this.voice.onTalk = (on) => this.audio.duck(on);
    this.input = new Input(el, {
      isAir: () => !!(this.sim && this.sim.air),
      active: () => this.state === 'play' && this.sim.phase === 'ride',
      onFirst: () => this.audio.unlock(),
    });
    this.ui = new UI({
      profile: () => this.profile,
      play: () => this.play(),
      again: () => this.endT > 0.9 && !this.raceMode && this.play(true),
      back: () => this.endT > 0.9 && this.toTitle(),
      pause: () => this.pause(),
      resume: () => this.resume(),
      restart: () => this.play(true),
      quit: () => this.toTitle(),
      cta: () => openStore(),
      host: () => this.host,
      race: () => this.race,
      // Server calls block input until they answer (ui.busy; done in onRace / onHost).
      raceCheckIn: () => this.race && this.race.room && (this.ui.busy('race', t('busy.checkin')), this.race.checkIn()),
      raceWithdraw: () => this.race && this.race.room && (this.ui.busy('race', t('busy.leave')), this.race.withdraw()),
      raceSay: (id) => this.race && this.race.say(id),
      specStep: (dir) => this.specStep(dir),
      specLeave: () => {
        this.stopSpectate();
        this.ui.closePanel(true);
        this.toTitle();
      },
      raceState: () => (this.raceMode ? { inRace: true, me: this.raceMode.me, out: this.state === 'end', dist: this.raceMode.outDist != null ? this.raceMode.outDist : Math.floor(this.sim.dist) } : null),
      raceConnect: () => this.syncRace(true),
      raceRematch: () => {
        this.ui.closePanel();
        if (this.race) this.race.requestRematch();
      },
      raceDone: () => {
        this.ui.closePanel();
        this.toTitle();
      },
      retrySave: () => {
        // Live test mode: a lost session means signing in again before retrying.
        if (this.host.live && !this.host.live.session) this.ui.openPanel('account');
        else if (this.attempt) this.ui.busy('save', t('busy.save')), this.host.retry(this.attempt.id);
      },
      signIn: (email, password) => (this.ui.busy('account', t('busy.signin')), this.host.live.signIn(email, password).finally(() => this.ui.done('account'))),
      signOut: () => (this.ui.busy('account', t('busy.signout')), this.host.live.signOut().finally(() => this.ui.done('account'))),
      refreshOnline: () => this.host.refresh(),
      tap: (name) => {
        this.audio.unlock();
        this.audio.play(name || 'tap');
      },
      jumpDown: () => this.input.buttonDown(),
      jumpUp: () => this.input.buttonUp(),
      setting: (k, v) => this.setSetting(k, v),
      ads: () => this.ads,
      buy: (type, id) => {
        if (this.host.profile) this.ui.busy('item', t('busy.buy')), this.host.buy(type, id); // the server checks the price and balance
        else if (!buy(this.profile, type, id)) this.audio.play('deny');
        else {
          this.audio.play('buy');
          this.applySkin();
          this.store.save();
        }
      },
      select: (type, id) => {
        if (this.host.profile) this.ui.busy('item', t('busy.equip')), this.host.select(type, id);
        else if (select(this.profile, type, id)) {
          this.audio.play('select');
          this.applySkin();
          this.store.save();
        }
      },
      preview: () => this.applySkin(),
      adReady: () => this.ads.rewardedReady(),
      doubleFlakes: () => this.doubleFlakes(),
      adDouble: () => this.watchDouble(),
      panelClosed: (name) => {
        if ((name === 'lobby' || name === 'shop') && this.state === 'title') this.ui.showTitle(true);
        // A race is over once its result panel is closed.
        if (name === 'race' && this.raceMode && this.state === 'end') this.toTitle();
        if (name === 'how' && !this.profile.seenHow) {
          this.profile.seenHow = true;
          this.store.profile.seenHow = true;
          this.store.save();
        }
      },
    });
    // The apps ask their first-launch privacy questions, then start the ads (DECISIONS 92).
    this.ads.start((kind) => this.ui.ask(kind));

    // Dragging across the open space above the shop panel spins the fox.
    const panel = this.ui.el.panel;
    let lastX = null;
    panel.addEventListener('pointerdown', (e) => {
      if (e.target !== panel || this.ui.panelName !== 'shop' || !this.shopCam) return;
      lastX = e.clientX;
      this.shopCam.drag = true;
      this.shopCam.vel = 0;
      panel.setPointerCapture(e.pointerId);
    });
    panel.addEventListener('pointermove', (e) => {
      if (lastX == null) return;
      const d = (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      this.shopCam.spin += d;
      this.shopCam.vel = d * 60; // keeps the flick going after release
    });
    const endDrag = () => {
      lastX = null;
      if (this.shopCam) this.shopCam.drag = false;
    };
    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);

    this.ui.instant = TEST && !query.has('anim');
    const firstGesture = () => {
      this.audio.unlock();
      if (this.audio.ctx && this.audio.ctx.state === 'running') {
        for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) window.removeEventListener(ev, firstGesture, true);
      }
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown', 'click']) window.addEventListener(ev, firstGesture, true);
    this.applySettings();
    this.applySkin();
    this.ui.relabel();
    this.ui.showCta(hasCta());
    this.host.on((type, m) => this.onHost(type, m));
    this.newSim();
    this.stage.blendMood(this.sim.biome.id, 0, true);
    this.resize();
    new ResizeObserver(() => requestAnimationFrame(() => this.resize())).observe(el);
    this.ui.requireSignIn(); // the apps open on sign-in
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    // The scaled frame keeps its layout size when the window changes, so watch the window too.
    window.addEventListener('resize', () => {
      applyFrame(PORTRAIT);
      this.resize();
    });
    document.addEventListener('visibilitychange', () => {
      if (TEST || RECORD) return;
      if (document.hidden) {
        if (this.state === 'play') this.pause();
        this.audio.suspend();
      } else if (this.state !== 'paused') this.audio.resume();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.state === 'title' && !this.ui.panelName) this.play();
      else if (e.key === 'Enter' && this.state === 'end' && this.endT > 0.9 && !this.raceMode) this.play(true);
      else if (e.key === 'Escape' || e.key === 'p') {
        if (this.ui.panelName) this.ui.closePanel();
        else if (this.state === 'play') this.pause();
        else if (this.state === 'paused') this.resume();
      }
    });
    setInterval(() => {
      if (this.state === 'title') this.ui.tickDaily();
      if (this.race) {
        if (this.state === 'title') this.ui.raceButton();
        if (this.ui.panelName === 'race' || this.ui.panelName === 'lobby') this.ui.raceTick();
      }
    }, 1000);
    window.addEventListener('error', (e) => console.error('game error', e.message));

    this.perf = new Perf(this, { show: query.has('fps'), bench: query.has('bench') });
    try {
      this.stage.renderer.compile(this.stage.scene, this.stage.camera);
    } catch (err) {
      /* warm-up is best effort */
    }
    this.last = 0;
    this.frame(0, true);
    this.ui.hideLoader();
    track('boot');
    requestAnimationFrame((ts) => this.loop(ts));
    if (query.has('bench')) this.perf.runBench(+query.get('bench') || 20);
  }

  makeBot() {
    return this.botHuman ? new HumanBot(this.sim ? this.sim.seed : 1) : new Bot();
  }

  qualityName() {
    return CONFIG.quality.levels[this.q.level].name;
  }

  seed() {
    if (query.has('seed')) return +query.get('seed') >>> 0;
    if (TEST) return TEST_SEED;
    return dailySeed(utcDay());
  }

  newSim(seed, opts) {
    this.sim = new Sim(seed != null ? seed : this.seed(), opts || { timeCap: AD ? CONFIG.ad.maxPlayTime : 0 });
    this.stage.terrain.setCliffs(this.sim.course.cliffs);
    this.recorder = new Recorder();
    this.particles.clear();
    this.trail.reset();
    this.speedTrail.reset();
    this.props.resetScenery(0);
    this.input.reset();
    this.acc = 0;
    this.timeScale = 1;
    this.lesson = 0;
    this.ghost = null;
    this.ghostRider.root.visible = false;
    this.ghostAhead = null;
    if (this.rematch) {
      this.rematch = null;
      this.racers.hide();
      this.ui.raceHud(null);
      this.ui.raceTags([]);
    }
    this.buried = false;
    this.deathT = 0;
    this.gapRide = 21;
    this.rider.root.visible = true;
    this.shadow.visible = true;
    this.ui.whiteout(0);
    this.mirrorPulse = 0;
    this.topped = false;
    this.atEdge = false;
  }

  // --- settings and skins -------------------------------------------------
  applySettings() {
    const s = this.profile.settings;
    this.audio.setVolumes(s.music, s.sfx);
    if (TEST) this.audio.setMuted(true);
    this.haptics.enabled = !!s.haptics && !TEST;
    this.voice.enabled = CONFIG.announcer && !!s.announcer && !TEST;
    this.voice.volume = s.sfx;
    this.voice.setLang(getLang());
    this.input.tapSteer = !!s.tapSteer;
    this.props.colorblind = !!s.colorblind;
    document.body.classList.toggle('tapsteer', !!s.tapSteer);
    document.body.classList.toggle('reduced', !!s.reducedMotion);
    document.body.classList.toggle('theme-glacier', s.theme !== 'arcade');
    this.q.auto = s.quality === 'auto';
    if (!this.q.auto) this.setQuality(['low', 'medium', 'high'].indexOf(s.quality));
    document.documentElement.style.setProperty('--accent', CONFIG.look.uiAccent);
    document.documentElement.style.setProperty('--reward', CONFIG.look.rewardColor);
  }

  setSetting(key, value) {
    this.profile.settings[key] = value;
    if (key === 'lang') {
      setLang(window.__LANG || value);
      this.ui.relabel();
    }
    if (key === 'sfx') this.audio.play('flake', { n: 3, minGap: 0.12 });
    else if (key !== 'music' && key !== 'shake') this.audio.play('toggle');
    this.applySettings();
    this.store.save();
  }

  setQuality(level) {
    level = clamp(level, 0, 2);
    this.q.level = level;
    const L = CONFIG.quality.levels[level];
    this.particles.share = L.particles;
    this.particles.lowFx = level === 0;
    this.mirrorRect = null;
    this.props.sceneryShare = L.scenery;
    this.snowScale = L.snow;
    this.stage.resize(L.pr);
    // Budget GPUs pay for every CSS filter over the canvas each frame (style.css).
    document.body.classList.toggle('q-low', level === 0);
    setInk(level > 0);
    this.stage.setFlatSky(level === 0);
  }

  // The worn look, with anything being tried on in the shop over it.
  applySkin() {
    const on = this.ui.panelName === 'shop' ? this.ui.tryOn : {};
    const r = RIDERS.find((x) => x.id === (on.rider || this.profile.rider)) || RIDERS[0];
    const b = BOARDS.find((x) => x.id === (on.board || this.profile.board)) || BOARDS[0];
    this.rider.setSkin(r, b);
    this.trailItem = TRAILS.find((x) => x.id === (on.trail || this.profile.trail)) || null;
    this.speedTrail.setStyle(this.trailItem);
  }

  resize() {
    this.mirrorRect = null;
    this.stage.resize();
    this.ui.setScale(this.stage.width, this.stage.height);
    // Viewport-relative sizes in the stylesheet follow the game frame, not the window.
    const root = document.documentElement.style;
    root.setProperty('--vw', (this.stage.width / 100).toFixed(2) + 'px');
    root.setProperty('--vh', (this.stage.height / 100).toFixed(2) + 'px');
    if (PORTRAIT && this.state === 'play' && this.sidewaysPhone()) this.pause();
  }

  sidewaysPhone() {
    return window.matchMedia && window.matchMedia('(orientation:landscape) and (pointer:coarse) and (max-height:540px)').matches;
  }

  // --- flow ---------------------------------------------------------------
  play(replay) {
    if (this.ui.panelName || this.wiping) return;
    // Checked in to a race: the lobby, not a solo run (DECISIONS 66).
    if (this.ui.raceIn() && !this.raceMode) return this.ui.openPanel('lobby');
    this.audio.unlock();
    this.audio.play('start');
    this.audio.play('whoosh');
    this.wiping = true;
    this.ui.wipe(() => {
      this.wiping = false;
      this.beginRun(replay);
    });
  }

  beginRun(replay) {
    // Signed in, the server runs the streak and refills missions when the run is submitted.
    const reward = this.host.profile ? (rollDay(this.profile, utcDay()), null) : startRun(this.profile, utcDay());
    this.newSim();
    if (reward) {
      const what = reward.flakes ? t('reward.flakes', { n: reward.flakes }) : reward.rider ? t('reward.rider') : t('reward.board');
      this.ui.toast(t('streak.reward', { d: reward.day, r: what }));
      this.audio.play('streak');
    }
    const g = this.profile.ghost;
    if (g && g.seed === this.sim.seed && g.version === CONFIG.version && g.day === this.profile.day) {
      this.ghost = { sim: new Sim(g.seed), play: new Playback(g.data) };
    }
    this.bot = this.botOn ? this.makeBot() : null;
    // Only runs a person plays count online: never bot, recorded or test runs.
    this.attempt = this.botOn || RECORD || TEST ? null : this.host.startAttempt();
    this.state = 'count'; // 3-2-1-GO, then 'play'
    this.countT = 2.4;
    this.countShown = 0;
    this.endT = 0;
    this.ui.hideEnd();
    this.ui.showPause(false);
    this.ui.showTitle(false);
    this.ui.showHud(true);
    this.audio.startRun();
    this.audio.resume();
    this.store.save();
    track(replay ? 'replay' : 'gameplay_start');
  }

  toTitle() {
    if (this.wiping) return;
    this.audio.play('whoosh');
    this.wiping = true;
    this.ui.wipe(() => {
      this.wiping = false;
      this.showTitle();
    });
  }

  showTitle() {
    this.endRace();
    this.audio.setRide(false);
    this.state = 'title';
    this.newSim();
    this.ui.hideEnd();
    this.ui.showPause(false);
    this.ui.showHud(false);
    this.ui.showTitle(true);
    this.ui.hint('', 'none');
    this.audio.resume();
    if (this.titleNote) {
      this.ui.toast(this.titleNote.text);
      this.audio.play(this.titleNote.won ? 'newBest' : 'tally');
      this.titleNote = null;
    }
  }

  // Signed in with a server profile, the game shows and spends that; signed
  // out it uses the device save. The device save is never overwritten by
  // server data. Settings and day-local state (best today, ghost) stay shared.
  useProfile() {
    const sp = this.host.profile;
    const local = this.store.profile;
    if (!sp) {
      if (this.profile !== local) {
        this.profile = local;
        this.applySkin();
      }
      return;
    }
    // Read the worn look before v is updated: v can be this.profile itself.
    const skin = this.profile.rider + '/' + this.profile.board + '/' + this.profile.trail;
    const v = this.profile !== local ? this.profile : Object.assign({}, local, { runsToday: local.runsToday.slice() });
    Object.assign(v, {
      settings: local.settings,
      flakes: sp.flakes,
      riders: sp.riders.slice(),
      boards: sp.boards.slice(),
      trails: (sp.trails || []).slice(),
      rider: sp.rider,
      board: sp.board,
      trail: sp.trail || null,
      shards: typeof sp.shards === 'number' ? sp.shards : null,
      streak: sp.streak,
      missions: { active: sp.missions.map((m) => Object.assign({}, m)), next: 0 },
      totals: Object.assign({ runs: 0, distance: 0, flakes: 0, nearMisses: 0 }, sp.totals),
      best: sp.best || 0,
    });
    this.profile = v;
    if (skin !== v.rider + '/' + v.board + '/' + v.trail) this.applySkin();
  }

  // --- endurance race ----------------------------------------------------------
  // Connect to the race server with the player's session: the in-game sign-in
  // in live test mode, or on the website a token the page hands over.
  syncRace(retry) {
    if (!this.race) return;
    const live = this.host.live;
    const signedIn = live ? !!live.session : !!(this.host.origin && this.host.signedIn);
    if (!signedIn) {
      if (this.race.status !== 'idle') this.race.disconnect();
      return;
    }
    if (retry && this.race.status === 'error') this.race.status = 'idle';
    if (this.race.status !== 'idle') return;
    this.race.connect(() => (live ? live.fresh().then((ok) => (ok && live.session ? live.session.access_token : null)) : this.host.raceToken()));
  }

  onRace(type, m) {
    if (type === 'checkin' || type === 'withdraw' || (type === 'status' && this.race.status !== 'online')) this.ui.done('race');
    if (type === 'countdown' && m.me >= 0) {
      this.ui.raceTab = 'race';
      this.beginRace(m);
    }
    if (type === 'go' && this.raceMode && m.race === this.raceMode.id) this.raceMode.go = true;
    if (type === 'rematch' && !this.raceMode) m.race ? this.beginRematch(m) : this.ui.toast(t('race.noRematch'));
    if (type === 'riders' && this.raceMode) this.raceStanding(m);
    if (type === 'checkin') {
      this.audio.play(m.ok ? 'buy' : 'deny');
      if (m.ok && this.state === 'title') this.ui.closePanel(), this.ui.openPanel('lobby');
    }
    if (type === 'withdraw' && m.ok && this.ui.panelName === 'lobby') {
      this.ui.closePanel(true);
      this.ui.openPanel('race');
    }
    // Checked in from before a reload, or another tab: back to the lobby.
    if ((type === 'hello' || type === 'next') && this.state === 'title' && !this.raceMode && this.ui.raceIn() && this.ui.panelName !== 'lobby') this.ui.closePanel(true), this.ui.openPanel('lobby');
    // No longer in (left from another tab, or the race was cancelled): out of the lobby.
    if ((type === 'next' || type === 'cancelled') && this.ui.panelName === 'lobby' && !this.raceMode && !this.ui.raceIn()) {
      this.ui.closePanel(true);
      this.ui.openPanel('race');
    }
    if (type === 'chat') {
      this.ui.chatHeard(m);
      if (m.i >= 0) this.said.set(m.i, { id: m.id, at: this.time });
    }
    if (type === 'results' && this.raceMode && m.race === this.raceMode.id) {
      const mine = m.standings.find((x) => x.i === this.raceMode.me);
      this.ui.raceTab = 'results';
      // The last rider standing has won: the run ends here, no riding on alone.
      const riding = this.state === 'play';
      if (riding) this.finishRace();
      this.stopSpectate();
      const won = mine && mine.place === 1 && !m.voided;
      if (won) this.celebrate(m.each);
      else this.audio.play('tally');
      // Just stopped: the end state opens the panel after the celebration.
      if (this.state === 'end' && !this.raceMode.shown && !riding) {
        this.raceMode.shown = true;
        this.ui.openPanel('race');
      }
    }
    if (this.state === 'title') this.ui.raceButton();
    // Positions arrive 10 times a second: only the counters change, so the
    // panel's buttons stay put under the player's finger.
    if (this.ui.panelName === 'race') type === 'riders' ? this.ui.raceTick() : this.ui.renderPanel();
    // The lobby keeps its buttons still: the chat log updates itself (chatHeard).
    if (this.ui.panelName === 'lobby' && ['next', 'checkin', 'withdraw', 'countdown', 'status', 'balance'].includes(type)) this.ui.renderPanel();
    if (this.ui.panelName === 'ranks' && type === 'board') this.ui.renderPanel();
  }

  // The countdown for a race this player checked in to: whatever they were
  // doing, the race takes over (a daily run in progress is abandoned).
  beginRace(info) {
    if (this.raceMode && this.raceMode.id === info.id) return;
    if (info.started) return; // too late to ride this one
    // The lobby stays up over the slope until its clock reaches 0.
    if (this.ui.panelName !== 'lobby') {
      this.ui.closePanel(true);
      this.ui.openPanel('lobby');
    }
    // No pausing a race (see pause()), so no pause button either.
    this.ui.el.hud.classList.add('racing');
    this.wiping = false;
    this.attempt = null;
    this.raceMode = { id: info.id, seed: info.seed, ramp: info.ramp, me: info.me, goAt: info.goAt, go: false, batch: [], ticks: 0, from: 0, shown: false, ghosts: new Map(), snapAt: 0, alive: new Map(), looks: new Map(info.riders.map((r) => [r.i, r.look])), riders: info.riders, pot: info.pot };
    const mine = info.riders.find((r) => r.i === info.me);
    // Each rider starts from their own grid slot (DECISIONS 70).
    this.newSim(info.seed, { ramp: info.ramp, start: mine && mine.start });
    // Until the server's first positions arrive, the others stand on their slots.
    for (const r of info.riders) if (r.i !== info.me && r.start) this.raceMode.ghosts.set(r.i, { i: r.i, d: r.start.d, x: r.start.x, y: 0, flags: 1, tick: 0, v: this.sim.v, hist: [[0, r.start.d, r.start.x, 0]] });
    this.said.clear(); // lobby places are not grid slots
    // Races are ridden by hand: the server voids a win that follows the bot.
    this.bot = null;
    this.state = 'count';
    this.countT = 9;
    this.countShown = 0;
    this.endT = 0;
    this.ui.hideEnd();
    this.ui.showPause(false);
    this.ui.showTitle(false);
    this.ui.showHud(false); // shown for the 3-2-1, after the lobby and the intro
    this.ui.raceHud({ left: info.riders.length, place: 0, gap: null, pack: [] });
    this.audio.unlock();
    this.audio.play('start');
    this.audio.startRun();
    this.audio.resume();
  }

  // A practice ride on the last race's slope against its top 3 riders' ghosts,
  // replayed here from their inputs. Nothing is paid or counted.
  beginRematch(m) {
    if (this.wiping) return;
    this.audio.unlock();
    this.audio.play('start');
    this.audio.play('whoosh');
    this.wiping = true;
    this.ui.wipe(() => {
      this.wiping = false;
      if (this.raceMode) return; // a race countdown took over meanwhile
      this.newSim(m.seed, { ramp: m.ramp });
      this.rematch = { race: m.race, riders: m.riders.map((r) => ({ name: r.name, place: r.place, look: r.look, sim: new Sim(m.seed, { ramp: m.ramp, start: r.start }), play: new Playback(r.data), end: r.end, out: false })), hudAt: -99 };
      this.bot = this.botOn ? this.makeBot() : null;
      this.attempt = null;
      this.state = 'count';
      this.countT = 2.4;
      this.countShown = 0;
      this.endT = 0;
      this.ui.hideEnd();
      this.ui.showPause(false);
      this.ui.showTitle(false);
      this.ui.showHud(true);
      this.audio.startRun();
      this.audio.resume();
    });
  }

  // Rematch ghosts: exact replays, drawn like race riders (nearest first, name tags).
  drawRematch(visDt, speed01) {
    const q = this.rematch;
    const sim = this.sim;
    const live = q.riders.filter((g) => !g.out);
    const near = this.state === 'play' || this.state === 'count' ? live.filter((g) => Math.abs(g.sim.dist - sim.dist) < 140) : [];
    const terrain = this.stage.terrain;
    const tags = [];
    const medal = (p) => ['🥇', '🥈', '🥉'][p - 1] || '';
    this.racers.begin();
    near.forEach((g, k) => {
      const s = g.sim;
      // Carried forward by the render lead like the rider (see lead).
      const dz = s.dist + s.v * this.lead - sim.dist;
      const r = this.drawRacer(k, g.look, { x: s.x, y: terrain.groundStep(s.dist) + s.y, z: -dz, v: s.v, vx: s.vx, air: s.air, grab: s.grab, speed01, riding: this.state === 'play', fade: true }, visDt);
      if (dz > -6) this.tagFor(tags, r.rider, medal(g.place) + ' ' + g.name, dz, false);
    });
    this.racers.end();
    this.ui.raceTags(tags);
    // Place and gap among the podium, a few times a second.
    if (this.state === 'play' && sim.tick - q.hudAt >= 6) {
      q.hudAt = sim.tick;
      const others = live.map((g) => g.sim.dist);
      const best = others.length ? Math.max(...others) : null;
      const list = live.map((g) => ({ id: q.riders.indexOf(g), name: g.name, d: g.sim.dist }));
      this.ui.raceHud({ left: live.length + (sim.phase === 'ride' ? 1 : 0), place: 1 + others.filter((d) => d > sim.dist).length, gap: best == null ? null : Math.round(sim.dist - best), pack: others.map((d) => ({ rel: d - sim.dist, lead: d === best && d > sim.dist })), ...this.rivals(q, list, sim.dist) });
    }
  }

  // Each position update: who fell (to the side feed), and this rider's place
  // and gap to the leader (or lead over the next) in the HUD.
  raceStanding(m) {
    const q = this.raceMode;
    for (const [i, , , , flags] of m.r) {
      const alive = !!(flags & 1);
      if (q.alive.get(i) && !alive && i !== q.me && (this.state === 'play' || this.state === 'spectate')) this.ui.callout(t('race.isOut', { name: this.race.nameOf(i) }), 'bad race-out');
      q.alive.set(i, alive);
    }
    if (this.state !== 'play') return;
    // The server ruled this rider out (dropped, out of sync) while this phone
    // still rides: the server's call stands, so stop here too.
    const own = m.r.find((r) => r[0] === q.me);
    if (own && !(own[4] & 1) && this.sim.phase === 'ride') {
      q.outDist = Math.floor(own[1]);
      return this.finishRace();
    }
    const mine = this.sim.dist;
    this.raceProject();
    const list = m.r.filter((r) => r[0] !== q.me && r[4] & 1).map((r) => ({ id: r[0], name: this.race.nameOf(r[0]), d: q.ghosts.has(r[0]) ? q.ghosts.get(r[0]).show : r[1] }));
    const others = list.map((r) => r.d);
    const place = 1 + others.filter((d) => d > mine).length;
    const best = others.length ? Math.max(...others) : null;
    // Leading: the lead over the next rider. Behind: the distance to the leader.
    const gap = best == null ? null : Math.round(mine - best);
    q.leader = best != null && best > mine ? list.find((r) => r.d === best).id : q.me;
    this.ui.raceHud({ left: m.left, place, gap, pack: others.map((d) => ({ rel: d - mine, lead: d === best && d > mine })), ...this.rivals(q, list, mine) });
  }

  // The riders either side of this one, by name, for the race card; and now and
  // then a line in the side feed about them (a pass either way, or, after a
  // quiet spell, where the nearest one is), so a race feels like riding with
  // people. list: [{ id, name, d }] of the other riders still in.
  rivals(q, list, mine) {
    let ahead = null, behind = null;
    for (const r of list) {
      if (r.d > mine && (!ahead || r.d < ahead.d)) ahead = r;
      if (r.d <= mine && (!behind || r.d > behind.d)) behind = r;
    }
    const v = q.riv || (q.riv = { side: new Map(), at: this.sim.tick, said: -1e9 });
    const tick = this.sim.tick;
    v.passes = v.passes || [];
    for (const r of list) {
      // 2 m either side before a pass counts, so riders level don't flicker.
      const rel = r.d - mine;
      const was = v.side.get(r.id);
      const now = rel > 2 ? 1 : rel < -2 ? -1 : was;
      v.side.set(r.id, now);
      if (!was || now === was || this.sim.t <= 3) continue;
      // Passed and passed back before it was said: nothing happened.
      const undo = v.passes.some((p) => p.id === r.id);
      v.passes = v.passes.filter((p) => p.id !== r.id);
      if (!undo) v.passes.push({ id: r.id, now, name: r.name });
    }
    // At most one line every 2.5 s, so the feed never fills up with rivals;
    // a pass waits its turn (and is dropped if that rider is out by then).
    if (this.state !== 'play' || tick - v.said <= 150) return this.rivalGaps(ahead, behind, mine);
    v.passes = v.passes.filter((p) => list.some((r) => r.id === p.id));
    const p = v.passes.shift();
    let line = p && (p.now < 0 ? [t('race.passed', { name: p.name }), 'good'] : [t('race.passedBy', { name: p.name }), 'bad']);
    const near = ahead && behind ? (ahead.d - mine < mine - behind.d ? ahead : behind) : ahead || behind;
    // A rider level with you is plain to see; "0 m behind" would say nothing.
    const n = near && Math.round(Math.abs(near.d - mine));
    if (!line && n >= 3 && tick - Math.max(v.said, v.at) > 12 * 60) line = [t(near.d > mine ? 'race.isAhead' : 'race.isBehind', { name: near.name, n }), 'dash'];
    if (line) {
      this.ui.callout(line[0], line[1]);
      v.said = tick;
    }
    return this.rivalGaps(ahead, behind, mine);
  }

  rivalGaps(ahead, behind, mine) {
    const gapOf = (r) => r && { name: r.name, gap: Math.round(r.d - mine) };
    return { ahead: gapOf(ahead), behind: gapOf(behind) };
  }

  // Each other rider's position carried forward to this rider's current tick:
  // their updates arrive a few ticks late, and comparing unequal ticks would
  // draw (and rank) them behind when they are level.
  raceProject() {
    const q = this.raceMode;
    for (const g of q.ghosts.values()) g.show = g.d + (g.flags & 1 ? g.v * Math.min(1, Math.max(0, (this.sim.tick - g.tick) * CONFIG.tick)) : 0);
  }

  celebrate(prize) {
    this.ui.banner(t('race.winner'), '', 'go', 2.2);
    this.ui.toast(t('race.won', { n: prize }));
    this.audio.play('newBest');
    this.hype('newBest', 3, 'hype', 'horn');
    this.haptics.fire('perfect');
    const sim = this.sim;
    const gy = this.stage.terrain.groundStep(sim.dist);
    for (let i = 0; i < 80; i++) this.particles.emit(sim.x, gy + 1, sim.dist, (Math.random() - 0.5) * 12, 3 + Math.random() * 8, sim.v * (0.6 + Math.random() * 0.4), 1.2, 0.34, 1, 6, 1 + (i % 5));
  }

  // Inputs go to the server in the same run-length form as the replay recorder.
  raceInput(input) {
    const q = this.raceMode;
    const tx = Math.round(input.tx * 100);
    const flags = (input.jump ? 1 : 0) | (input.grab ? 2 : 0);
    const last = q.batch[q.batch.length - 1];
    if (last && last[1] === tx && last[2] === flags) last[0]++;
    else q.batch.push([1, tx, flags]);
    q.ticks++;
  }

  raceFlush(force) {
    const q = this.raceMode;
    if (!q.batch.length || (!force && q.ticks < CONFIG.race.sendEvery)) return;
    this.race.sendInputs(q.id, q.from, q.batch);
    q.from += q.ticks;
    q.batch = [];
    q.ticks = 0;
  }

  // --- spectating (DECISIONS 67) ---------------------------------------------
  // Out of the race while others still ride: follow one of them. The world is
  // drawn around a stand-in Sim on the same slope, placed on the followed
  // rider every frame from the server's positions (as their ghost would be);
  // the player's own finished Sim is kept and comes back when it ends.
  specRiders() {
    const q = this.raceMode;
    return [...q.ghosts.values()].filter((g) => g.flags & 1 && g.i !== q.me).sort((a, b) => b.d - a.d);
  }

  startSpectate() {
    const q = this.raceMode;
    const lead = q ? this.specRiders()[0] : null;
    if (!lead || (this.race.results && this.race.results.race === q.id)) return false;
    q.spec = { own: this.sim, target: -1, sim: null };
    this.specFollow(lead.i);
    this.state = 'spectate';
    this.buried = false;
    this.rider.root.visible = true;
    this.shadow.visible = true;
    this.ui.whiteout(0);
    this.ui.showHud(false);
    this.audio.setRide(true);
    return true;
  }

  specFollow(i) {
    const q = this.raceMode;
    const s = q.spec;
    const g = q.ghosts.get(i);
    s.target = i;
    // The course is only kept ahead of the furthest point reached, so going
    // back to a rider further up the slope needs a fresh stand-in.
    if (!s.sim || (g && g.d < s.sim.dist - 10)) s.sim = new Sim(q.seed, { ramp: q.ramp });
    s.disp = s.x = s.y = null;
    this.sim = s.sim;
    s.snap = true;
  }

  specStep(dir) {
    const q = this.raceMode;
    if (!q || !q.spec) return;
    const list = this.specRiders();
    if (!list.length) return;
    const k = list.findIndex((g) => g.i === q.spec.target);
    this.specFollow(list[(k + dir + list.length) % list.length].i);
    this.audio.play('tap');
  }

  stepSpectate(dt) {
    const q = this.raceMode;
    const s = q && q.spec;
    if (!s) return;
    let g = q.ghosts.get(s.target);
    if (!g || !(g.flags & 1)) {
      // The followed rider went out: on to the leader.
      const next = this.specRiders()[0];
      if (next) this.specFollow(next.i);
      g = next;
    }
    if (!g) return this.ui.spectate({ over: true });
    const sim = s.sim;
    // Eight ticks behind the server's clock, like the ghosts, so updates are in hand.
    const tick = Math.floor((this.race.now() - q.goAt) / 1000 / CONFIG.tick) - 8;
    const target = g.d + g.v * clamp((tick - g.tick) * CONFIG.tick, 0, 1);
    if (s.disp == null || Math.abs(target - s.disp) > 15) s.disp = target;
    else s.disp += g.v * dt + (target - s.disp) * Math.min(1, dt * 2);
    const px = s.x;
    s.x = s.x == null ? g.x : s.x + (g.x - s.x) * Math.min(1, dt * 8);
    s.y = s.y == null ? g.y : s.y + (g.y - s.y) * Math.min(1, dt * 10);
    sim.course.ensure(s.disp + CONFIG.lane.viewDist + 80);
    Object.assign(sim, { dist: s.disp, x: s.x, y: s.y, v: g.v, vx: px == null ? 0 : (s.x - px) / Math.max(dt, 1e-3), air: !!(g.flags & 2), grab: !!(g.flags & 4), tick, gap: 40 });
    sim.danger = clamp(1 - sim.gap / CONFIG.avalanche.maxGap, 0, 1);
    sim.biome = sim.updateBiome();
    sim.events.length = 0;
    if (s.snap) {
      s.snap = false;
      this.camera.snap({ mode: 'ride', x: s.x, ground: this.stage.terrain.groundStep(s.disp) });
    }
    const list = this.specRiders();
    this.ui.spectate({ name: this.race.nameOf(g.i), place: 1 + list.filter((x) => x.d > g.d).length, dist: Math.floor(g.d), left: list.length, many: list.length > 1 });
  }

  stopSpectate() {
    const q = this.raceMode;
    if (!q || !q.spec) return;
    this.sim = q.spec.own;
    q.spec = null;
    if (this.state === 'spectate') {
      this.state = 'end';
      this.rider.root.visible = false;
      this.shadow.visible = false;
    }
    this.ui.spectate(null);
  }

  finishRace() {
    this.state = 'end';
    this.endT = 0;
    this.audio.setRide(false);
    this.raceFlush(true);
    this.summary = this.sim.summary();
    this.ui.showHud(false);
    this.ui.raceHud(null);
    this.ui.raceTags([]);
    this.ui.hint('', 'none');
    this.ui.ring(false);
  }

  endRace() {
    if (!this.raceMode) return;
    this.stopSpectate();
    this.raceMode = null;
    this.ui.el.hud.classList.remove('racing');
    this.racers.hide();
    this.ui.raceHud(null);
    this.ui.raceTags([]);
  }

  // The other riders, from the server's replay of their inputs (10 updates a
  // second, carried forward at their own speed in between). Only the nearest
  // few are drawn.
  drawRaceGhosts(visDt, speed01) {
    const q = this.raceMode;
    const snap = this.race.snap;
    const sim = this.sim;
    if (snap && this.race.snapAt !== q.snapAt) {
      q.snapAt = this.race.snapAt;
      for (const [i, d, x, y, flags, tick] of snap.r) {
        if (i === q.me) continue;
        let g = q.ghosts.get(i);
        if (!g) q.ghosts.set(i, (g = { i, d, x, y, flags, tick, v: sim.v, hist: [] }));
        // Speed over the last half second of the rider's own ticks: steady even
        // when updates arrive in bursts.
        if (tick > g.tick || !g.hist.length) g.hist.push([tick, d, x, y]);
        if (g.hist.length > 30) g.hist.shift();
        const [t0, d0] = g.hist[Math.max(0, g.hist.length - 6)];
        if (tick > t0) g.v = Math.max(0, (d - d0) / ((tick - t0) * CONFIG.tick));
        Object.assign(g, { d, x, y, flags, tick });
      }
    }
    this.raceProject();
    const near = [];
    for (const g of q.ghosts.values()) {
      if (!(g.flags & 1) || (q.spec && g.i === q.spec.target)) continue;
      if (Math.abs(g.show - sim.dist) < 140) near.push(g);
    }
    near.sort((a, b) => Math.abs(a.show - sim.dist) - Math.abs(b.show - sim.dist));
    const n = this.state === 'title' ? 0 : Math.min(near.length, this.racerCap());
    near.length = n;
    const terrain = this.stage.terrain;
    // Along the slope: the drawn position moves every tick at a smoothed speed
    // and eases towards each new estimate, so updates never show as snaps.
    // Across and up: drawn 8 ticks behind the newest update, blended between
    // updates (the delay can't be seen sideways; the steps could).
    const step = (sim.tick - (q.drawTick == null ? sim.tick : q.drawTick)) * CONFIG.tick;
    q.drawTick = sim.tick;
    for (const g of near) {
      g.vs = g.vs == null ? g.v : g.vs + (g.v - g.vs) * Math.min(1, visDt * 3);
      const target = g.d + g.vs * Math.min(1, Math.max(0, (sim.tick - g.tick) * CONFIG.tick));
      if (g.disp == null || Math.abs(target - g.disp) > 15) g.disp = target;
      else g.disp += g.vs * step + (target - g.disp) * Math.min(1, visDt * 2);
      const want = sim.tick - g.tick + 8;
      g.lag = g.lag == null ? want : g.lag + (want - g.lag) * Math.min(1, visDt * 1.5);
      const rt = sim.tick - g.lag;
      const H = g.hist;
      let k = H.length - 1;
      if (rt >= H[k][0]) [g.dx, g.dy] = [H[k][2], H[k][3]];
      else if (rt <= H[0][0]) [g.dx, g.dy] = [H[0][2], H[0][3]];
      else {
        while (k > 0 && H[k - 1][0] > rt) k--;
        const a = H[k - 1], b = H[k], u = (rt - a[0]) / (b[0] - a[0]);
        g.dx = a[2] + (b[2] - a[2]) * u;
        g.dy = a[3] + (b[3] - a[3]) * u;
      }
    }
    const tags = [];
    const moving = this.state === 'play' || this.state === 'spectate';
    this.racers.begin();
    near.forEach((g, k) => {
      // sim.dist is carried forward by the part of a tick not yet simulated
      // (see lead); carry the rider the same, or it shudders against the fox.
      const dz = g.disp + g.vs * this.lead - sim.dist;
      const r = this.drawRacer(k, q.looks.get(g.i), { x: g.dx, y: terrain.groundStep(g.disp) + g.dy, z: -dz, v: g.vs, vx: 0, air: !!(g.flags & 2), grab: !!(g.flags & 4), speed01, riding: moving, fade: moving, hop: this.hop(g.i) }, visDt);
      // Name tags on the grid (count) and while riding.
      if ((this.state === 'play' || this.state === 'count') && dz > -6) this.tagFor(tags, r.rider, this.sayTag(g.i, this.race.nameOf(g.i)), g.show - sim.dist, g.i === q.leader);
    });
    this.racers.end();
    this.ui.raceTags(tags);
  }

  // One other rider from the pool (DECISIONS 71): posed and placed in the slope
  // frame (o.z), with its worn trail, and faded to see-through while
  // it would hide the fox or the slope just ahead of it.
  drawRacer(k, look, o, visDt) {
    const r = this.racers.get(k, look);
    const R = r.rider;
    R.update(visDt, { mode: o.mode || 'ride', x: o.x, y: o.y, vx: o.vx || 0, air: o.air, grab: o.grab, speed01: o.speed01, wipe: false, wipeT: 0, drift: 0 });
    R.root.position.z = o.z;
    if (o.hop) R.root.position.y += Math.sin(o.hop * Math.PI) * 0.7;
    const sim = this.sim;
    const inView = o.dim || (o.fade && Math.abs(o.x - sim.x) < 1.7 && o.z > -4 && o.z < CONFIG.camera.distance + 1);
    r.alpha += ((inView ? 0.3 : 1) - r.alpha) * Math.min(1, visDt * 8);
    R.setOpacity(r.alpha > 0.97 ? 1 : r.alpha);
    const tr = r.items.trail;
    r.trail.mesh.visible = !!tr && o.riding;
    if (r.trail.mesh.visible) {
      const d = sim.dist - o.z;
      r.trail.mesh.position.z = o.z;
      r.trail.update(visDt, o.x, o.y, d, true);
    } else r.trail.reset();
    return r;
  }

  // How many other riders are drawn: each is a full rider (about 125 meshes).
  racerCap() {
    return Math.min(CONFIG.race.ghosts, CONFIG.quality.levels[this.q.level].racers || CONFIG.race.ghosts);
  }

  // A name tag over a drawn rider's head, in frame pixels (d: metres ahead of the fox).
  tagFor(tags, rider, name, d, lead) {
    const v = this.tagV || (this.tagV = new THREE.Vector3());
    rider.root.getWorldPosition(v);
    v.y += 2.3;
    v.project(this.stage.camera);
    if (v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) tags.push({ name, x: ((v.x + 1) / 2) * this.stage.width, y: ((1 - v.y) / 2) * this.stage.height, far: Math.abs(d) > 60, d, lead });
  }

  // A rider's name, with their quick-chat line for a few seconds after they say it.
  sayTag(i, name) {
    const s = this.said.get(i);
    return s && this.time - s.at < 3 ? name + ' ' + chatText(s.id) : name;
  }

  // 0..1 through a little hop after an emote, else 0.
  hop(i) {
    const s = this.said.get(i);
    const u = s && /^e_/.test(s.id) ? (this.time - s.at) / 0.45 : 1;
    return u >= 0 && u < 1 ? u : 0;
  }

  // The lobby (DECISIONS 69): everyone checked in stands on the start grid in
  // their own look, in check-in order until the server shuffles them at the
  // close. The fox stays where it is; the grid is laid out around it.
  drawLobby(visDt) {
    const n = this.race && this.race.next;
    const sim = this.sim;
    const terrain = this.stage.terrain;
    const tags = [];
    this.racers.begin();
    if (n && n.in && n.names && n.me >= 0) {
      const N = n.names.length;
      const mine = gridStart(n.me, N);
      // During a close-up, riders between the camera and the one shown fade out.
      const sp = this.spotW > 0 && this.spot ? gridStart(this.spot.i, N) : null;
      for (let i = 0, k = 0; i < N && k < this.racerCap(); i++) {
        if (i === n.me) continue;
        const s = gridStart(i, N);
        const dz = s.d - mine.d;
        const dim = !!sp && i !== this.spot.i && s.d > sp.d && Math.abs(s.x - sp.x) < 2.2;
        const r = this.drawRacer(k++, n.looks && n.looks[i], { mode: 'idle', x: s.x - mine.x, y: terrain.groundStep(sim.dist + dz), z: -dz, v: 0, air: false, grab: false, speed01: 0, riding: false, fade: false, dim, hop: this.hop(i) }, visDt);
        this.tagFor(tags, r.rider, this.sayTag(i, n.names[i]), dz, false);
      }
    }
    this.racers.end();
    this.ui.raceTags(tags);
  }

  // Every grid slot in the slope frame around the fox (slot me, drawn at foxX).
  gridPoints(N, me, foxX) {
    const mine = gridStart(me, N);
    const T = this.stage.terrain;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const s = gridStart(i, N);
      const dz = s.d - mine.d;
      pts.push({ x: s.x - mine.x + foxX, z: -dz, y: T.groundStep(this.sim.dist + dz) });
    }
    return pts;
  }

  // Set camera shots: the lobby looks back up at the grid from in front of it;
  // the race intro flies from there over the grid and settles behind the fox
  // for the 3-2-1. Null when the chase camera has the shot to itself.
  raceShot(dt) {
    const n = this.race && this.race.next;
    const q = this.raceMode;
    let pts = null;
    let u = 0;
    if (this.state === 'title' && this.ui.panelName === 'lobby' && n && n.in && n.names && n.me >= 0) pts = this.gridPoints(n.names.length, n.me, 0);
    else if (this.state === 'count' && q && q.riders.every((r) => r.start)) {
      pts = this.gridPoints(q.riders.length, q.me, this.sim.x);
      u = clamp(1 - (this.countT - CONFIG.race.slopeCount) / CONFIG.race.introSeconds, 0, 1);
    }
    this.shotW += ((pts ? 1 : 0) - this.shotW) * Math.min(1, dt * 2.5);
    if (!pts) {
      // Left the lobby: ease back from the last shot (the intro ends at weight 0).
      if (!this.shot || this.shot.w < 0.001) return null;
      this.shot.w *= 1 - Math.min(1, dt * 2.5);
      return this.shot;
    }
    const T = this.stage.terrain;
    const g = (z) => T.groundStep(this.sim.dist - z);
    let x0 = Infinity, x1 = -Infinity, zF = Infinity, zB = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      zF = Math.min(zF, p.z);
      zB = Math.max(zB, p.z);
    }
    const cx = (x0 + x1) / 2;
    const zc = (zF + zB) / 2;
    const fx = pts.length ? this.sim.x : 0;
    const S = this.shot || (this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), w: 0, path: new THREE.CatmullRomCurve3([0, 1, 2, 3].map(() => new THREE.Vector3())), aim: new THREE.CatmullRomCurve3([0, 1, 2, 3].map(() => new THREE.Vector3())) });
    const back = 7.5 + (x1 - x0) * 0.35; // wider grids need the camera further out
    const P = S.path.points;
    const L = S.aim.points;
    // Aimed well below the riders, so they stand in the top third, clear of the lobby panel.
    P[0].set(cx + 1.4, g(zF - back) + 3.6, zF - back);
    L[0].set(cx, g(zc) - 3.4, zc);
    P[1].set(cx - 6.5, g(zc) + 4.6, zc - 1);
    L[1].set(cx, g(zc) + 0.8, zc);
    P[2].set(fx + 3, g(zB + 6) + 4.4, zB + 6);
    L[2].set(fx, g(0) + 1, 0);
    P[3].set(fx, g(5.5) + 2.6, 5.5);
    L[3].set(fx, g(-12), -12);
    // The lobby is a place to show off (DECISIONS 84): the shot drifts along
    // the line, and each rider who arrives (the player first) gets a close-up.
    if (this.state === 'title') {
      const span = Math.max(1.5, (x1 - x0) * 0.35);
      P[0].x += Math.sin(this.time * 0.18) * span;
      L[0].x += Math.sin(this.time * 0.18) * span * 0.8;
    }
    const e = u * u * (3 - 2 * u);
    S.path.getPoint(e, S.pos);
    S.aim.getPoint(e, S.look);
    if (this.state === 'title') {
      const N = pts.length;
      if (!this.spot || this.spot.race !== n.id) this.spot = { race: n.id, seen: N, i: n.me, at: this.time };
      else if (N > this.spot.seen) Object.assign(this.spot, { seen: N, i: N - 1, at: this.time }); // newest check-in is last
      else this.spot.seen = N;
      const age = this.time - this.spot.at;
      const p = pts[this.spot.i];
      const sw = (this.spotW = p && age < CONFIG.race.spotSeconds ? clamp(age / 0.5, 0, 1) * clamp((CONFIG.race.spotSeconds - age) / 0.6, 0, 1) : 0);
      if (sw > 0) {
        const k = sw * sw * (3 - 2 * sw);
        const v = S.v || (S.v = new THREE.Vector3());
        S.pos.lerp(v.set(p.x + 0.8, p.y + 3.2, p.z - 4.4), k); // high enough to look over the rows in front
        S.look.lerp(v.set(p.x, p.y + 0.1, p.z), k); // aimed low: the rider stands above the lobby panel
      }
    }
    // The last stretch hands over to the chase camera itself.
    const k = clamp((u - 0.72) / 0.28, 0, 1);
    S.w = this.shotW * (1 - k * k * (3 - 2 * k));
    return S;
  }

  // The shop's try-on shot (DECISIONS 82): the fox close up in the top part of
  // the screen, above the panel, turning slowly; a drag spins it.
  shopShot(dt) {
    const on = this.state === 'title' && this.ui.panelName === 'shop';
    const S = this.shopCam || (this.shopCam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), w: 0, spin: 0, vel: 0.5, drag: false });
    S.w += ((on ? 1 : 0) - S.w) * Math.min(1, dt * 4);
    if (!S.drag) S.vel += ((on ? 0.5 : 0) - S.vel) * Math.min(1, dt * 1.5); // eases back to a slow turn after a flick
    // The turn adds up while the shop is open; on closing, take the nearest
    // equivalent angle so the fox turns back the short way instead of
    // unwinding every turn it made (faster the longer the shop was open).
    if (on) S.spin += S.vel * dt;
    else if (S.open) S.spin = Math.atan2(Math.sin(S.spin), Math.cos(S.spin));
    S.open = on;
    if (!on && S.w < 0.01) S.spin = 0;
    // Back to facing the camera as the shop closes.
    this.rider.root.rotation.y = on ? S.spin : S.spin * S.w;
    if (S.w < 0.001) return null;
    const x = this.sim.x;
    const g = this.stage.terrain.groundStep(this.sim.dist);
    const K = CONFIG.shop.camera;
    S.pos.set(x + K.x, g + K.y, K.z);
    S.look.set(x, g + K.lookY, 0);
    return S;
  }

  // The page answered: redraw whatever shows online data.
  onHost(type, m) {
    if (type === 'session') this.syncRace();
    if (type === 'profile' || type === 'session') this.useProfile();
    if (type === 'item_result') this.ui.done('item');
    if (type === 'submit_result') this.ui.done('save');
    if (type === 'item_result') this.audio.play(m.ok ? (m.action === 'buy' ? 'buy' : 'select') : 'deny');
    if (type === 'submit_result' && this.attempt && m.attempt === this.attempt.id && this.attempt.result && this.attempt.result.avalanche) {
      const r = this.attempt.result.avalanche.streak_reward;
      if (r && (r.flakes || r.rider || r.board) && !this.attempt.result.avalanche.duplicate) {
        const what = r.flakes ? t('reward.flakes', { n: r.flakes }) : r.rider ? t('reward.rider') : t('reward.board');
        this.ui.toast(t('streak.reward', { d: r.day, r: what }));
        this.audio.play('streak');
      }
    }
    if (this.state === 'title') this.ui.refreshTitle();
    if (this.ui.panelName === 'ranks' || ((type === 'profile' || type === 'item_result') && ['shop', 'missions'].includes(this.ui.panelName))) this.ui.renderPanel();
    if (this.ui.endShown) this.ui.online(this.attempt);
    if (type === 'submit_result' && this.ui.endShown) this.ui.offerDouble();
    if (type === 'submit_result' && this.attempt && this.attempt.status === 'counted' && this.attempt.result) {
      const r = this.attempt.result;
      if (r.pop && r.pop.cleared) this.audio.play('mission');
    }
  }

  pause() {
    // A race can't be paused: the server keeps time, and a rider whose inputs
    // stop arriving is out.
    if (this.state !== 'play' || this.raceMode) return;
    this.state = 'paused';
    this.voice.stop();
    this.audio.setRide(false);
    this.ui.showPause(true);
    this.audio.play('pause');
    setTimeout(() => this.state === 'paused' && this.audio.suspend(), 180);
    this.input.clear();
  }

  // The Android back button (the app shell calls window.__appBack): one step
  // back. On the title a second press within 2 s leaves the app. Returns false
  // only then, so the shell exits; true means the game handled it.
  back() {
    if (this.ui.busyKey) return true; // a server call is under way
    // The sign-in gate can't be closed, so Back there works like on the title: press twice to leave.
    if (this.ui.panelName && !(this.ui.panelName === 'account' && this.ui.signInGate())) return this.ui.closePanel(), true;
    if (this.state === 'play') return this.pause(), true;
    if (this.state === 'paused') return this.resume(), true;
    if (this.state === 'end' && !this.raceMode && this.endT > 0.9) return this.toTitle(), true;
    if (this.state !== 'title') return true;
    if (performance.now() - (this.backAt || -1e9) < 2000) return false;
    this.backAt = performance.now();
    this.ui.toast(t('app.backExit'));
    return true;
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'play';
    this.ui.showPause(false);
    this.audio.resume();
    this.audio.play('resume');
    this.audio.setRide(true);
    this.last = 0;
  }

  finish() {
    if (this.raceMode) return this.finishRace();
    if (this.rematch) return this.finishRematch();
    this.state = 'end';
    this.audio.setRide(false);
    this.endT = 0;
    const summary = this.sim.summary();
    const data = this.recorder.encode();
    this.result = finishRun(this.profile, summary, { data });
    this.summary = summary;
    this.ads.runEnded(this.profile.day);
    this.endAd = null;
    this.store.save();
    services.leaderboard.submit(this.profile.day, { score: summary.score, seed: summary.seed });
    if (this.attempt && this.host.current === this.attempt) {
      const s = summary;
      const stats = { distance: s.distance, flakes: s.flakes, nearMisses: s.nearMisses, bestCombo: s.bestCombo, cleanJumps: s.cleanJumps, tricks: s.tricks, perfects: s.perfects, trickScore: s.trickScore, topKmh: s.topKmh };
      this.host.endAttempt(s.score, stats, (key) => this.checkRun(key, s, data));
    }
    else this.attempt = null;
    this.ui.showHud(false);
    this.ui.hint('', 'none');
    this.ui.ring(false);
  }

  // Send the run's inputs to the race server, which replays them and records
  // whether they really make this score (DECISIONS 72). Signed out: no check.
  // On the website the token comes from race_token, which only a page that
  // embeds with ?race answers (otherwise every save would wait 10 s for it).
  checkRun(key, s, data) {
    const live = this.host.live;
    if (!live && !raceRequested()) return null;
    const token = live ? live.fresh().then((ok) => (ok && live.session ? live.session.access_token : null)) : this.host.raceToken();
    return token.then((t) => {
      if (!t) return null;
      const body = JSON.stringify({ token: t, key, seed: s.seed, version: CONFIG.version, data, score: s.score, metres: s.distance });
      return fetch(runCheckUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
    });
  }

  // How this ride would have placed against the podium, then back to the title.
  finishRematch() {
    const q = this.rematch;
    this.state = 'end';
    this.endT = 0;
    this.audio.setRide(false);
    this.summary = this.sim.summary();
    this.ui.showHud(false);
    this.ui.raceHud(null);
    this.ui.raceTags([]);
    this.ui.hint('', 'none');
    this.ui.ring(false);
    // Ghosts still riding would have outlasted this ride; the rest by distance.
    const mine = this.sim.dist;
    const place = 1 + q.riders.filter((g) => !g.out || g.sim.dist > mine).length;
    q.place = place;
    q.dist = Math.floor(mine);
  }

  // --- simulation events -> feedback ---------------------------------------
  handle(ev) {
    const sim = this.sim;
    const ui = this.ui;
    const P = this.particles;
    const gy = this.stage.terrain.groundStep(sim.dist);
    const reduced = this.profile.settings.reducedMotion;
    switch (ev.type) {
      case 'dash':
        this.audio.play('dash');
        this.haptics.fire('boost');
        this.pulse.boost = 1;
        this.camera.kick(0.35);
        ui.banner('', t('hud.dash'), 'dash', 0.8);
        for (let i = 0; i < 26; i++) P.emit(sim.x + (Math.random() - 0.5) * 2, gy + 0.2 + Math.random() * 0.8, sim.dist, (Math.random() - 0.5) * 5, 1 + Math.random() * 3, sim.v * 0.7, 0.6, 0.35 * 0.6, 0.7, 3, 0); // snow, not rainbow (owner, 2026-11-26)
        break;
      case 'jump':
        this.audio.play('jump');
        this.audio.play('action');
        this.haptics.fire('jump');
        P.burst(12, sim.x, gy + 0.1, sim.dist - 1.0, 2.2, 1.2, sim.v * 0.4, 0.5, 0.3, 0.9);
        break;
      case 'ramp':
        this.audio.play('ramp');
        this.audio.play('bigjump');
        this.audio.play('action', { rate: 0.8 });
        this.haptics.fire('jump');
        this.camera.kick(0.3);
        P.burst(26, sim.x, gy + 0.3, sim.dist - 1.0, 3, 2.4, sim.v * 0.5, 0.7, 0.4, 0.9);
        break;
      case 'cliff':
        this.audio.play('cliff');
        this.audio.play('wind');
        break;
      case 'grab':
        this.audio.play('grab');
        break;
      case 'release':
        this.audio.play('release');
        break;
      case 'comboEnd':
        this.audio.play('comboEnd');
        break;
      case 'archExit':
        this.audio.play('archExit');
        break;
      case 'land': {
        this.audio.play('land', { vol: ev.airKind === 'jump' ? 0.8 : 1.2 });
        this.haptics.fire(ev.quality === 'perfect' ? 'perfect' : 'land');
        this.rider.land(ev.airKind === 'jump' ? 0.6 : 1);
        this.camera.land(ev.airKind === 'jump' ? 0.4 : 1);
        this.camera.kick(ev.airKind === 'jump' ? 0.2 : 0.45);
        P.burst(ev.airKind === 'jump' ? 22 : 44, sim.x, gy + 0.05, sim.dist - 1.0, 3.4, 1.3, sim.v * 0.35, 0.7, 0.42, 0.9);
        if (ev.quality === 'perfect') {
          this.audio.play('perfect');
          this.hype('perfect', 2, 'hype', 'crowd');
          ui.banner('', t('hud.perfect', { n: ev.pts }), 'good', 1.2);
          for (let i = 0; i < 34; i++) P.emit(sim.x, gy + 0.6, sim.dist, (Math.random() - 0.5) * 9, 1 + Math.random() * 6, sim.v * (0.6 + Math.random() * 0.4), 0.9, 0.26, 0.8, 6, 0); // a puff of snow, not confetti (owner, 2026-11-26)
        } else if (ev.quality === 'sloppy') {
          this.audio.play('sloppy');
          this.hype('sloppy', 2, 'down');
          this.haptics.fire('stumble');
          this.rider.flail(0.6);
          this.camera.kick(0.6);
          ui.banner('', t('hud.sloppy'), 'bad', 1.0);
        } else if (ev.tricked && ev.pts > 0) {
          this.audio.play('trick');
          ui.banner('', t('hud.trick', { n: ev.pts }), 'gold', 1.0);
        }
        break;
      }
      case 'boost':
        this.audio.play('boost');
        this.hype('boost', 1, 'hype');
        this.haptics.fire('boost');
        this.pulse.boost = 1;
        break;
      case 'nearMiss':
        this.audio.play('nearmiss');
        this.audio.play('whoosh');
        this.haptics.fire('nearMiss');
        if (ev.combo > 1) this.audio.play('combo', { n: ev.combo });
        if (ev.combo >= 3) this.hype('combo', 2, 'hype', ev.combo >= 4 ? 'horn' : 'crowd', { n: ev.combo });
        else this.hype(ev.close ? 'closeCall' : 'nearMiss', ev.close ? 2 : 1, 'hype', ev.close ? 'crowd' : '');
        ui.banner('', t(ev.close ? 'hud.closeCall' : 'hud.nearMiss', { n: ev.pts }), 'gold', 0.9);
        if (ev.close && !reduced) this.slowT = 0.16;
        for (let i = 0; i < 8; i++) P.emit(sim.x - ev.side * 0.5, gy + 0.4 + Math.random(), sim.dist, ev.side * 2, 1.5, sim.v * 0.6, 0.4, 0.3, 0.9, 2, 0);
        break;
      case 'clean':
        this.audio.play('clean');
        ui.banner('', t('hud.clean', { n: ev.pts }), 'good', 0.8);
        break;
      case 'hop':
        this.audio.play('perfect');
        this.hype('hop', 2, 'hype', 'crowd');
        ui.banner('', t('hud.hop', { n: ev.pts }), 'gold', 1.0);
        break;
      case 'flake':
        this.audio.play('flake', { n: this.flakeChain(), minGap: 0 });
        this.haptics.fire('flake');
        // A ring of gold shards, and the coin flies to the counter.
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * 6.283;
          P.emit(ev.x, gy + ev.y, ev.d, Math.cos(a) * 3.2, Math.sin(a) * 3.2 + 1, sim.v * 0.96, 0.32, 0.2, 1, 3, i % 3 === 0 ? 4 : 1);
        }
        {
          const v = (this.tmp2 || (this.tmp2 = new THREE.Vector3())).set(ev.x, gy + ev.y, -(ev.d - sim.dist)).applyMatrix4(this.stage.world.matrixWorld).project(this.stage.camera);
          ui.coinFly((v.x * 0.5 + 0.5) * this.stage.width, (-v.y * 0.5 + 0.5) * this.stage.height);
        }
        break;
      case 'stumble':
        this.audio.play('hit', { vol: 0.8 });
        this.audio.play('stumble');
        this.hype('stumble', 2, 'down');
        this.haptics.fire('stumble');
        this.rider.flail(0.7);
        this.mirrorPulse = 2.4;
        this.camera.kick(0.7);
        P.burst(34, sim.x, gy + 0.2, sim.dist + 0.4, 3.5, 1.4, sim.v * 0.5, 0.7, 0.4, 0.9);
        ui.banner('', t('hud.stumble'), 'bad', 0.9);
        break;
      case 'crash':
        this.audio.play('hit');
        this.audio.play('crash');
        this.hype('crash', 3, 'down', 'crowdDown');
        this.haptics.fire('crash');
        this.camera.kick(1.2);
        if (!reduced) {
          this.slowT = 0.5;
          ui.flash(0.55);
        }
        P.burst(80, sim.x, gy + 0.4, sim.dist + 0.6, 5.5, 2.2, sim.v * 0.4, 1.1, 0.5, 0.95);
        ui.hint('', 'none');
        break;
      case 'caught':
        this.audio.play('caught');
        this.hype('caught', 3, 'down', 'crowdDown');
        this.haptics.fire('caught');
        this.camera.kick(1.4);
        ui.hint('', 'none');
        break;
      case 'milestone':
        this.audio.play('milestone');
        this.hype('milestone', 2, 'hype', 'crowd', { n: ev.at });
        ui.banner(t('hud.milestone', { n: ev.at }), '', '', 1.4);
        break;
      case 'biome':
        this.audio.play('biome');
        ui.zone(t('biome.' + ev.id), t('biome.sub'));
        this.hype(ev.id, 2, 'hype', 'horn');
        break;
      case 'archEnter':
        this.audio.play('boost');
        break;
      case 'surface':
        if (ev.surface === 'mogul') this.camera.kick(0.35);
        if (ev.surface === 'ice') this.audio.play('ice');
        break;
      default:
        break;
    }
  }

  // Announcer call with its stinger. stinger: '' | 'hype' | 'crowd' | 'crowdDown' | 'horn'.
  hype(key, priority, mood, stinger, vars) {
    const said = this.voice.say(t('say.' + key, vars), priority, mood);
    if (!said && priority < 2) return;
    if (stinger === 'horn') {
      this.audio.play('horn', { minGap: 0.4 });
      this.audio.play('crowd', { big: true, minGap: 0.4 });
    } else if (stinger === 'crowd') this.audio.play('crowd', { minGap: 0.6 });
    else if (stinger === 'crowdDown') this.audio.play('crowd', { minGap: 0.6 });
    else if (stinger === 'hype') this.audio.play('hype', { minGap: 0.4 });
  }

  flakeChain() {
    const now = this.time;
    this.chain = now - (this.chainT || 0) < 0.6 ? (this.chain || 0) + 1 : 0;
    this.chainT = now;
    return this.chain;
  }

  // --- tutorial hints and slow motion --------------------------------------
  coach(dt) {
    const sim = this.sim;
    const inp = this.input;
    const ui = this.ui;
    const P = CONFIG.player;
    if (sim.phase !== 'ride' || this.bot) {
      ui.hint('', 'none');
      this.lesson = 0;
      return;
    }
    const steerHint = this.profile.settings.tapSteer ? t('hint.tapSteer') : t('hint.drag');
    // The next jumpable in the rider's lane.
    let bar = null;
    const list = sim.course.entities;
    for (let i = sim.first; i < list.length; i++) {
      const e = list[i];
      if (e.d0 > sim.dist + sim.v * 1.6) break;
      if (e.jump && !e.done && !e.hit && e.d0 > sim.dist && Math.abs(sim.x - e.x) < e.hw + P.radius) {
        bar = e;
        break;
      }
    }
    const left = sim.timeToLand();
    const bigAir = sim.air && (sim.airKind === 'ramp' || sim.airKind === 'cliff');
    if (!inp.usedDrag) ui.hint(sim.t > 0.4 ? steerHint : '', 'drag');
    else if (bar && !inp.usedJump) ui.hint(t('hint.jump'), 'tap');
    else if (bigAir && sim.grab && left < 0.34 && !this.lessonsDone.release) ui.hint(t('hint.release'), 'none');
    else if (bigAir && !sim.grab && !this.lessonsDone.grab && left > 0.4) ui.hint(t('hint.grab'), 'hold');
    else if (sim.danger > 0.72) ui.hint(t('hint.hurry'), 'none');
    else if (inp.idleSeconds() > CONFIG.ad.hintDelay && !sim.air) ui.hint(steerHint, 'drag');
    else ui.hint('', 'none');

    // First-time lessons freeze the moment until the player acts.
    if (!this.lessonsDone.jump && bar && !sim.air && (bar.d0 - sim.dist) / Math.max(1, sim.v) < 0.9) this.lesson = 1;
    if (this.lesson === 1 && (sim.air || !bar)) {
      this.lesson = 0;
      this.lessonsDone.jump = true;
    }
    if (!this.lessonsDone.grab && bigAir && sim.airT > 0.12 && this.lesson === 0 && !sim.grab) {
      this.lesson = 2;
      this.lessonT = 0;
    }
    if (this.lesson === 2) {
      this.lessonT += dt;
      if (sim.grab || !sim.air || this.lessonT > 2.2) {
        this.lesson = 0;
        if (sim.grab) this.lessonsDone.grab = true;
      }
    }
    if (sim.stats.perfects > 0) this.lessonsDone.release = true;
  }

  // --- main loop ------------------------------------------------------------
  loop(ts) {
    requestAnimationFrame((n) => this.loop(n));
    const raw = this.last ? (ts - this.last) / 1000 : 1 / 60;
    this.last = ts;
    if (raw > 0) {
      this.frameMs = this.frameMs * 0.92 + raw * 1000 * 0.08;
      this.fps = 1000 / this.frameMs;
    }
    if (TEST && this.manual) return;
    const c0 = performance.now();
    this.frame(clamp(raw, 0, 0.05));
    this.perf.frame(raw * 1000, performance.now() - c0);
    this.autoQuality(raw * 1000);
  }

  autoQuality(ms) {
    const q = this.q;
    if (!q.auto || TEST || this.state !== 'play') return;
    (q.win || (q.win = [])).push(ms);
    if (q.win.length < CONFIG.quality.sampleFrames) return;
    const w = q.win.sort((x, y) => x - y);
    q.win = [];
    const median = w[w.length >> 1];
    const avg = w.reduce((t, v) => t + v, 0) / w.length;
    // A browser frame cap (Safari in Low Power Mode runs pages at a steady 30 fps)
    // shows up as slow but even frames. Lowering quality cannot help there and
    // only makes the game blurrier, so only step down when most frames are
    // uneven, or the game is genuinely very slow. One-off hitches are ignored.
    const uneven = w.filter((v) => Math.abs(v - median) > CONFIG.quality.capJitterMs).length / w.length;
    const capped = uneven < 0.2;
    if (q.level > 0 && ((median > CONFIG.quality.dropAboveMs && !capped) || median > CONFIG.quality.dropAlwaysMs)) this.setQuality(q.level - 1);
    void avg;
  }

  // Advance the simulation by whole ticks.
  advance(dt) {
    const sim = this.sim;
    // A race runs on the server's clock: every tick that is due gets simulated,
    // so a slow frame never leaves this rider behind (and dropped as gone).
    const cap = this.raceMode ? 30 : 6;
    if (this.raceMode) {
      const f = Math.max(0, (this.race.now() - this.raceMode.goAt) / 1000 / CONFIG.tick);
      const due = Math.min(cap, Math.floor(f) - sim.tick);
      this.acc = Math.max(0, due) * CONFIG.tick + (f - Math.floor(f)) * CONFIG.tick;
    } else this.acc += dt * this.timeScale;
    let steps = 0;
    while (this.acc >= CONFIG.tick && steps < cap) {
      this.acc -= CONFIG.tick;
      steps++;
      if (sim.phase === 'over') break;
      if (this.bot && this.attempt) this.attempt = null; // bot switched on mid-run: this run won't be submitted
      const input = quantise(this.bot && sim.phase === 'ride' ? this.bot.decide(sim) : this.input.consume());
      if (sim.phase === 'ride') {
        this.recorder.push(input);
        if (this.raceMode) this.raceInput(input);
      }
      sim.step(input);
      if (this.raceMode) {
        // The server records the distance at the moment of death, before the crash slide.
        if (sim.phase !== 'ride' && this.raceMode.outDist == null) this.raceMode.outDist = Math.floor(sim.dist);
        this.raceFlush(sim.phase !== 'ride');
      }
      if (sim.events.length) {
        for (const ev of sim.events) this.handle(ev);
        sim.events.length = 0;
      }
      if (this.ghost && this.ghost.sim.phase !== 'over') {
        this.ghost.sim.step(this.ghost.play.next());
        this.ghost.sim.events.length = 0;
      }
      if (this.rematch) {
        for (const g of this.rematch.riders) {
          // Out where the rider went out: a dropped rider's inputs simply stop.
          if (g.sim.phase === 'ride' && g.sim.tick < g.end) g.sim.step(g.play.next());
          else g.out = true;
          g.sim.events.length = 0;
        }
      }
    }
    if (steps === cap) this.acc = 0;
  }

  // What a rewarded video would add: the snowflakes the server counted for this
  // run, since it pays from its own record. 0 hides the offer.
  doubleFlakes() {
    const live = this.host.live;
    const a = this.attempt;
    const av = a && a.result && a.result.avalanche;
    if (!live || !live.session || this.raceMode || !a || a.status !== 'counted' || a.doubled || !av || av.duplicate) return 0;
    return av.flakes_earned > 0 ? av.flakes_earned : 0;
  }

  // A rewarded video for the run's snowflakes again (DECISIONS 86). Only the
  // server credits it, from LevelPlay's callback: the ticket for this run rides
  // along as the LevelPlay user id, and afterwards the game waits a little for
  // the server to say it has paid.
  async watchDouble() {
    if (!this.doubleFlakes()) return;
    const live = this.host.live;
    this.attempt.doubled = true;
    const ticket = await live.adTicket(this.attempt.key).catch(() => null);
    if (!ticket || !ticket.ok) return this.ui.toast(t('ads.doubleFailed'));
    const r = await this.ads.showRewarded(ticket.ticket);
    if (!r.rewarded) return;
    this.ui.busy('ad', t('ads.checking'));
    const paid = await live.adCredited(ticket.ticket, 10000).finally(() => this.ui.done('ad'));
    this.ui.toast(t(paid && paid.status === 'credited' ? 'ads.doubled' : 'ads.doubleLater', { n: ticket.flakes }));
  }

  // The interstitial plays after the burial and before the results (DECISIONS 85).
  endAdDone() {
    if (this.endAd === 'done') return true;
    if (!this.endAd) {
      if (!this.ads.interstitialDue()) return (this.endAd = 'done'), true;
      this.endAd = 'showing';
      this.ads.showInterstitial().finally(() => (this.endAd = 'done'));
    }
    return false;
  }

  frame(dt, first) {
    let sim = this.sim;
    const st = this.stage;
    const terrain = st.terrain;
    const set = this.profile.settings;
    this.time += dt;
    this.fxTime = (this.fxTime || 0) + dt * (this.state === 'play' ? this.timeScale : 1);
    this.particles.time = this.fxTime;
    // The banner shows on the title and the results only: never in a run, a race or an open panel.
    this.ads.banner(!this.ui.panelName && ((this.state === 'title' && !this.race?.next?.in) || (this.state === 'end' && this.ui.endShown && !this.raceMode)));

    if (this.state === 'count') {
      this.countT -= dt;
      // A race starts on the server's word, not when the local count runs out.
      if (this.raceMode) this.countT = this.raceMode.go ? 0 : Math.max(0.01, (this.raceMode.goAt - this.race.now()) / 1000);
      const n = Math.ceil(this.countT / (this.raceMode ? 1 : 0.8));
      // A race: the lobby counts to 0, the camera flies down the grid (DECISIONS 70),
      // then a short 3-2-1 on the slope.
      const q = this.raceMode;
      const introAt = CONFIG.race.slopeCount + CONFIG.race.introSeconds;
      if (q && this.ui.panelName === 'lobby' && this.countT <= introAt) this.ui.closePanel(true);
      if (q && !q.intro && this.countT <= introAt && this.countT > CONFIG.race.slopeCount + 0.5) {
        q.intro = true;
        this.ui.banner(t('race.title'), t('race.introSub', { n: q.riders.length, pot: q.pot || 0 }), 'go', CONFIG.race.introSeconds * 0.75);
        this.audio.play('whoosh');
      }
      if (q && !q.hud && this.countT <= CONFIG.race.slopeCount) (q.hud = true), this.ui.showHud(true);
      if (n !== this.countShown && n > 0 && !(q && this.countT > CONFIG.race.slopeCount)) {
        this.countShown = n;
        this.ui.banner(String(n), '', 'count', 0.8);
        this.audio.play('count');
        this.hype('' + n, 3, 'count');
      }
      if (this.countT <= 0) {
        this.state = 'play';
        this.ui.banner(t('hud.go'), '', 'go', 0.9);
        setTimeout(() => this.state === 'play' && this.ui.zone(t('biome.' + this.sim.biome.id), t(this.raceMode || this.rematch ? 'race.title' : 'title.daily')), 700);
        this.audio.play('go');
        this.hype('go', 3, 'hype', 'horn');
        this.audio.setRide(true);
        this.camera.kick(0.4);
      }
    }
    if (this.state === 'play') {
      this.input.frame(dt, sim.x);
      // Slow motion: lessons, close calls, the first beat of a crash.
      this.slowT = Math.max(0, this.slowT - dt);
      // No slow motion in a race: every rider runs on the server's clock.
      const target = this.raceMode ? 1 : this.lesson === 1 ? 0.2 : this.lesson === 2 ? 0.3 : this.slowT > 0 ? 0.3 : 1;
      this.timeScale += (target - this.timeScale) * (1 - Math.exp(-dt * (target < this.timeScale ? 9 : 5)));
      this.perf.mark('sim');
      this.advance(dt);
      this.perf.span('sim', 'sim');
      if (!this.raceMode && !this.rematch) this.coach(dt);
      if (sim.phase === 'over') this.finish();
    } else if (this.state === 'spectate') {
      this.stepSpectate(dt);
    } else if (this.state === 'end') {
      this.endT += dt;
      if (this.rematch) {
        // After the burial, back to the title, where a toast says how it would
        // have placed (the burial's white-out hides anything shown before).
        const q = this.rematch;
        if (this.endT > 1.6 && !this.wiping) {
          this.titleNote = { text: t('race.rematchPlace', { n: q.place, of: q.riders.length + 1 }) + ' · ' + q.dist + ' m', won: q.place === 1 };
          this.toTitle();
        }
      } else if (this.raceMode) {
        // After the burial, the race panel: riders left, then the result.
        if (!this.raceMode.shown && this.endT > 1.6 && !this.startSpectate()) {
          this.raceMode.shown = true;
          this.ui.openPanel('race');
        }
      } else if (!this.ui.endShown && this.endT > 0.7 && this.endAdDone()) {
        this.ui.showEnd({ summary: this.summary, result: this.result, profile: this.profile, attempt: this.attempt });
        this.audio.play(this.result.newBest ? 'newBest' : this.summary.outcome === 'timeout' ? 'win' : 'lose');
        if (this.result.newBest) this.hype('newBest', 3, 'hype', 'horn');
        for (let i = 0; i < 6; i++) setTimeout(() => this.state === 'end' && this.audio.play('tally', { minGap: 0 }), 250 + i * 60);
        if (this.result.missionFlakes) {
          this.ui.toast(t('toast.mission', { n: this.result.missionFlakes }));
          setTimeout(() => this.audio.play('mission'), 900);
        }
        track('endcard');
      }
    }
    if (this.state === 'paused' && !first) return;
    // Spectating starts or stops above and swaps the Sim: draw the one now in place.
    sim = this.sim;

    // The simulation only moves in whole 60 Hz ticks. In slow motion that is one
    // tick every few frames, which stutters, so for drawing we carry the rider
    // forward by the time not yet simulated. Restored at the end of the frame.
    const lead = this.state === 'play' && sim.phase !== 'over' ? this.acc : 0;
    this.lead = lead;
    const simDist = sim.dist;
    const simX = sim.x;
    const simY = sim.y;
    if (lead > 0) {
      const W = CONFIG.lane.halfWidth;
      sim.dist += sim.v * lead;
      sim.x = clamp(sim.x + sim.vx * lead, -W, W);
      if (sim.air) sim.y = Math.max(0, sim.y + sim.vy * lead);
    }

    const riding = (this.state === 'play' || this.state === 'spectate') && sim.phase === 'ride';
    const wipe = sim.phase !== 'ride';
    const title = this.state === 'title';
    const speed01 = clamp((sim.v - 30) / 30, 0, 1);
    const groundStep = terrain.groundStep(sim.dist);
    const visDt = dt * (this.state === 'play' ? Math.max(0.25, this.timeScale) : 1);

    // World.
    this.perf.mark('world');
    terrain.update(sim.dist);
    st.blendMood(sim.biome.id, dt, first);
    this.props.update(sim, this.time);
    // The wall is drawn closer than the simulated gap (60 m of lead reads as
    // about 33 m), so it stays a presence instead of a far-off ridge.
    let gap;
    if (title) gap = 15;
    else if (!wipe) {
      gap = 7 + sim.gap * 0.3;
      this.gapRide = gap;
      this.deathT = 0;
    } else {
      // Any death: the wall keeps coming and buries the rider.
      this.deathT += dt;
      const k = clamp((this.deathT - 0.5) / 1.3, 0, 1);
      gap = this.gapRide + (-7 - this.gapRide) * k * k * (3 - 2 * k);
      if (gap < 1.2 && !this.buried) {
        this.buried = true;
        this.rider.root.visible = false;
        this.shadow.visible = false;
        this.audio.play('buried');
        this.haptics.fire('caught');
        this.camera.kick(1.5);
        const gs = terrain.groundStep(sim.dist);
        for (let i = 0; i < 90; i++) this.particles.emit(sim.x + (Math.random() - 0.5) * 9, gs + Math.random() * 3, sim.dist + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 14, 2 + Math.random() * 9, sim.v + 4 + Math.random() * 14, 1.3, 1.6 + Math.random() * 2.6, 0.9, 7, 0);
      }
      this.ui.whiteout(clamp((this.deathT - 1.6) / 0.5, 0, 1) * (this.state === 'end' && this.ui.endShown ? 0.35 : 0.9));
    }
    const danger = title ? 0.3 : sim.danger;
    this.avalanche.update(this.time, gap, danger, sim.dist, this.particles, CONFIG.quality.levels[this.q.level].particles, title || wipe ? 0 : CONFIG.camera.distance);
    terrain.uniforms.uShadowZ.value = gap - 6 - terrain.mesh.position.z;
    terrain.uniforms.uShadowAmt.value = title ? 0.3 : 0.8;

    // Rider.
    const riderY = groundStep + sim.y;
    this.rider.update(visDt, {
      mode: title ? 'idle' : 'ride',
      boost: clamp(sim.boostNow / CONFIG.boost.amount, 0, 1),
      x: sim.x,
      y: riderY,
      vx: sim.vx,
      air: sim.air,
      grab: sim.grab,
      speed01,
      wipe,
      wipeT: sim.wipeT,
      caught: sim.cause === 'caught',
      drift: sim.drift,
      vyNorm: clamp(sim.vy / 10, -1, 1),
    });
    const meAt = this.raceMode ? this.raceMode.me : this.race && this.race.next && this.race.next.in ? this.race.next.me : -1;
    const hop = meAt >= 0 && (title || this.state === 'count') ? this.hop(meAt) : 0;
    if (hop) this.rider.root.position.y += Math.sin(hop * Math.PI) * 0.7;
    const groundSmooth = terrain.groundAt(sim.dist);
    const hAbove = Math.max(0, riderY - groundSmooth);
    const sh = 1.5 / (1 + hAbove * 0.3);
    this.shadow.position.set(sim.x, groundSmooth + 0.04, 0.05);
    this.shadow.scale.set(sh * 0.9, 1, sh * 1.9);
    this.shadow.material.opacity = 0.62 / (1 + hAbove * 0.35);
    this.trail.update(sim.x, sim.dist, !sim.air && !wipe && !title, 0.34 + sim.drift * 0.3 + Math.min(0.2, Math.abs(sim.vx) * 0.02), terrain, st.mood.shade);

    // In the shop the fox stands on a turntable, so a trail being tried on rides
    // on the fox itself: run out straight back off the tail of the board, as if
    // already going fast, and turning with it.
    const tryOn = title && this.ui.panelName === 'shop';
    if (tryOn !== this.trailTryOn) {
      this.speedTrail.reset();
      (tryOn ? this.rider.root : this.stage.world).add(this.speedTrail.mesh);
      this.trailTryOn = tryOn;
    }
    if (tryOn) {
      // As the turntable (or a drag) turns the fox, the ribbon bends after the board.
      const rot = this.rider.root.rotation.y;
      if (this.trailRot != null && Math.abs(rot - this.trailRot) < 1) this.speedTrail.turn(rot - this.trailRot);
      this.trailRot = rot;
      this.speedTrail.update(dt, 0, 0, this.time * 14, true, 0.7); // closer: the shop sees it side-on
    } else {
      this.trailRot = null;
      this.speedTrail.update(dt, sim.x, riderY, sim.dist, riding, 1.3, this.rider.yaw);
    }
    GALAXY.uGTime.value = this.time;
    GALAXY.uGPx.value = 1 / Math.max(1, st.renderer.domElement.height);

    // Wind-blown spindrift streaming across the piste, and snow shaken off the banks.
    if (!this.particles.lowFx) {
      const P = this.particles;
      const dir = Math.sin(this.time * 0.13) > 0 ? 1 : -1;
      for (let i = 0; i < 2; i++) {
        P.emit(-dir * (6 + Math.random() * 16), groundSmooth + 0.15 + Math.random() * 0.5, sim.dist + 8 + Math.random() * 130, dir * (5 + Math.random() * 7), 0.2 + Math.random() * 0.5, 0, 1.6, 1.3 + Math.random() * 1.4, 0.22, 0, 0);
      }
      // The avalanche spits debris past the rider when it is close.
      if (riding && danger > 0.42 && Math.random() < (danger - 0.3) * 1.6) {
        const side = Math.random() < 0.5 ? -1 : 1;
        P.emit(sim.x + side * (2.5 + Math.random() * 7), groundSmooth + 0.5 + Math.random() * 2.5, sim.dist - 9, side * Math.random() * 2, 1 + Math.random() * 4, sim.v * (1.25 + Math.random() * 0.4), 1.1, 1.2 + Math.random() * 2.4, 0.75, 6, 0);
      }
    }

    // Ghost.
    if (this.ghost && this.state === 'play') {
      const g = this.ghost.sim;
      // Carried forward like the rider, or it slides back a little every tick.
      const dz = g.dist + (g.phase === 'ride' ? g.v * this.lead : 0) - sim.dist;
      const show = g.phase === 'ride' && Math.abs(dz) < 140;
      this.ghostRider.root.visible = show;
      if (show) {
        this.ghostRider.update(visDt, { mode: 'ride', x: g.x, y: terrain.groundStep(g.dist) + g.y, vx: g.vx, air: g.air, grab: g.grab, speed01, wipe: false, wipeT: 0, drift: 0 });
        this.ghostRider.root.position.z = -dz;
      }
      const ahead = dz > 2 ? 1 : dz < -2 ? -1 : 0;
      if (ahead && this.ghostAhead && ahead !== this.ghostAhead && sim.t > 4 && g.phase === 'ride') {
        this.ui.banner('', t(ahead > 0 ? 'hud.ghostAhead' : 'hud.ghostBehind'), '', 1.2);
        this.audio.play('ghost');
      }
      if (ahead) this.ghostAhead = ahead;
    }

    if (this.raceMode) this.drawRaceGhosts(visDt, speed01);
    else if (this.rematch) this.drawRematch(visDt, speed01);
    else if (title && this.ui.panelName === 'lobby') this.drawLobby(visDt);
    else if (this.racers.list.some((r) => r.used)) this.racers.hide(), this.ui.raceTags([]);

    // Spray. Everything comes off the tail of the board (TAIL metres behind centre).
    const TAIL = 1.0;
    if (riding && !sim.air) {
      const P = this.particles;
      // The snow is kept small, faint, short-lived and low so it doesn't drown a
      // worn trail; toned down for everyone (owner, 2026-11-26).
      const ws = 0.5; // size
      const wa = 0.55; // opacity
      const wl = 0.6; // life
      const n = 1 + (sim.drift > 0.3 ? 1 : 0);
      for (let i = 0; i < n; i++) P.emit(sim.x + (Math.random() - 0.5) * 0.35, groundSmooth + 0.08, sim.dist - TAIL, (Math.random() - 0.5) * 1.6, 0.8 + Math.random() * 2.2, sim.v * (0.75 + Math.random() * 0.1), (0.8 + Math.random() * 0.6) * wl, 0.35 * ws, 0.85 * wa, 1.8, 0);
      // A V-shaped plume of snow peeling off both edges of the board; taller with speed.
      const lift = (1.6 + speed01 * 3.2) * 0.45;
      for (const side of [-1, 1]) {
        P.emit(sim.x + side * 0.22, groundSmooth + 0.1, sim.dist - TAIL, side * (1.6 + Math.random() * 2.6), lift * (0.6 + Math.random() * 0.7), sim.v * (0.82 + Math.random() * 0.08), (0.55 + Math.random() * 0.35) * wl, (0.5 + Math.random() * 0.45) * ws, 0.9 * wa, 9, 0);
      }
      const avx = Math.abs(sim.vx);
      if (avx > 5) {
        const side = sim.vx > 0 ? -1 : 1;
        for (let i = 0; i < 2; i++) P.emit(sim.x + side * 0.25, groundSmooth + 0.1, sim.dist - TAIL - Math.random() * 0.4, side * (3 + Math.random() * 4) * (1 + sim.drift), 1.5 + Math.random() * 2.2, sim.v * 0.8, 0.5 * wl, (0.36 + sim.drift * 0.2) * ws, 0.85 * wa, 5, 0);
        if (avx > 9) this.audio.play('carve', { vol: clamp(avx / 20, 0.4, 1), minGap: 0.35 });
      }
      if (sim.surface === 'mogul') this.audio.play('mogul', { minGap: 0.11 });
      if (sim.surface === 'mogul' && Math.random() < 0.5) P.burst(4, sim.x, groundSmooth + 0.1, sim.dist - TAIL, 2, 1.6, sim.v * 0.7, 0.4, 0.3, 0.8);
    }
    // No coloured boost exhaust or drift sparks: only snow comes off the board
    // (owner, 2026-11-26). The drift still sounds.
    if (riding && !sim.air && sim.drift > 0.3) this.audio.play('spark', { minGap: 0.12 });
    if (wipe && sim.wipeT < 1.2 && Math.random() < 0.6) this.particles.burst(3, sim.x, groundSmooth + 0.2, sim.dist, 2.5, 1.2, sim.v * 0.5, 0.8, 0.4, 0.9);
    this.particles.update(this.fxTime, sim.dist, st.height, st.mood.snow);
    this.snowfall.update(this.fxTime, sim.dist, st.height, st.mood.snowfall * (this.snowScale == null ? 1 : Math.max(0.25, this.snowScale)), sim.wind, groundSmooth);

    // Camera.
    this.pulse.boost = Math.max(0, this.pulse.boost - dt * 0.9);
    this.camera.update(dt, {
      mode: title ? 'title' : 'ride',
      x: sim.x,
      ground: groundStep,
      air: sim.y,
      v: sim.v,
      vx: sim.vx,
      speed01,
      danger,
      boost: clamp(sim.boostNow / CONFIG.boost.amount, 0, 1),
      inArch: !!sim.inArch,
      caught: wipe,
      wipe,
      reduced: !!set.reducedMotion,
      shakeScale: set.shake,
      shot: this.raceShot(dt) || this.shopShot(dt),
    });
    if (first) this.camera.snap({ mode: 'title', x: 0, ground: 0 });

    // HUD.
    if (this.state === 'play' || this.state === 'count') {
      const comboLeft = sim.combo > 0 ? clamp(1 - (sim.t - sim.comboT) / CONFIG.score.comboWindow, 0, 1) : 0;
      this.ui.hud(sim.score, sim.stats.flakes, Math.round(sim.v * 3.6), sim.danger, sim.combo, comboLeft);
      const bigAir = sim.air && sim.phase === 'ride' && (sim.grab || sim.airKind !== 'jump');
      if (bigAir) {
        const left = sim.timeToLand();
        const A = CONFIG.air;
        const p = this.rider.root.getWorldPosition(this.tmp || (this.tmp = new THREE.Vector3())).project(st.camera);
        const state = sim.grab ? (left <= A.perfectWindowMax && left >= A.perfectWindowMin && sim.grabT >= A.perfectMinHold ? 'perfect' : left < A.perfectWindowMin ? 'late' : '') : '';
        this.ui.ring(true, (p.x * 0.5 + 0.5) * st.width, (-p.y * 0.5 + 0.5) * st.height - 20, clamp(left / 1.1, 0, 1), state);
        if (state === 'perfect' && this.ringState !== 'perfect') this.audio.play('window');
        this.ringState = state;
      } else {
        this.ui.ring(false);
        this.ringState = '';
      }
      // Behaviour cues: piste edge, top speed, the wall closing in.
      if (riding) {
        const atEdge = Math.abs(sim.x) > CONFIG.lane.halfWidth - 0.02;
        if (atEdge && !this.atEdge) this.audio.play('wall');
        this.atEdge = atEdge;
        const top = sim.v > CONFIG.player.maxSpeed - 0.5;
        if (top && !this.topped) {
          this.audio.play('topSpeed');
          this.hype('topSpeed', 1, 'hype', 'hype');
        }
        this.topped = this.topped || top;
        if (sim.danger < 0.4) this.warned = false;
        if (sim.danger > 0.58) {
          this.beepT = (this.beepT || 0) - dt;
          if (!this.warned) {
            this.warned = true;
            this.hype('hurry', 3, 'urgent');
          }
          if (this.beepT <= 0) {
            this.audio.play('hurry');
            this.beepT = 0.75 - sim.danger * 0.55;
          }
        }
      }
    }
    this.ui.frost(this.state === 'play' || this.state === 'end' ? clamp((danger - 0.3) * 1.5 * (sim.cause === 'caught' ? 0.5 : 1), 0, 0.95) : 0);
    // Boost blows a rush of wind across the screen instead of colouring the piste (owner, 2026-11-26).
    const gust = riding && !set.reducedMotion ? clamp(sim.boostNow / CONFIG.boost.amount, 0, 1) : 0;
    this.ui.speedLines(dt, riding && !set.reducedMotion ? clamp(0.25 + speed01 * 0.75, 0, 1) : 0, gust);
    this.audio.mix(speed01, danger, this.timeScale < 0.6, riding, clamp(sim.boostNow / CONFIG.boost.amount, 0, 1));

    this.perf.span('world', 'world');
    this.perf.mark('render');
    st.render(this.time);
    this.perf.span('render', 'render');
    this.perf.mark('mirror');

    // Rear-view mirror while riding (skipped on the lowest quality level).
    // The mirror pops in from time to time, after a mistake, and whenever the wall is close.
    this.mirrorPulse = Math.max(0, (this.mirrorPulse || 0) - dt);
    const glance = sim.t > 5 && sim.t % 12 < 2.6;
    const mirrorOn = this.state === 'play' && riding && this.q.level > 0 && (glance || danger > 0.5 || this.mirrorPulse > 0);
    if (mirrorOn !== this.mirrorOn) {
      this.mirrorOn = mirrorOn;
      this.mirrorEl.classList.toggle('off', !mirrorOn);
      this.mirrorRect = null;
      this.mirrorSince = this.time;
      if (mirrorOn) this.audio.play(danger > 0.5 ? 'alert' : 'mirror');
    }
    if (mirrorOn) {
      if (!this.mirrorRect) {
        const m = this.mirrorEl.getBoundingClientRect();
        const c = st.renderer.domElement.getBoundingClientRect();
        const w = this.mirrorEl.offsetWidth;
        const h = this.mirrorEl.offsetHeight;
        const cx = (m.left + m.width / 2 - c.left) / FRAME.scale;
        const cy = (m.top + m.height / 2 - c.top) / FRAME.scale;
        this.mirrorRect = { left: cx - w / 2 + 2, top: cy - h / 2 + 2, width: w - 4, height: h - 4 };
      }
      if (this.mirrorRect.width > 20 && this.time - this.mirrorSince > 0.22) st.renderMirror(this.mirrorRect, sim.x, groundStep, gap);
      const hot = danger > 0.6;
      if (hot !== this.mirrorHot) {
        this.mirrorHot = hot;
        this.mirrorEl.classList.toggle('hot', hot);
      }
    }
    this.perf.span('mirror', 'mirror');
    sim.dist = simDist;
    sim.x = simX;
    sim.y = simY;
  }

  // --- debug / automation hook ----------------------------------------------
  info() {
    const s = this.sim;
    return {
      state: this.state,
      phase: s.phase,
      t: +s.t.toFixed(2),
      dist: +s.dist.toFixed(1),
      score: s.score,
      speed: +s.v.toFixed(1),
      gap: +s.gap.toFixed(1),
      danger: +s.danger.toFixed(3),
      combo: s.combo,
      x: +s.x.toFixed(2),
      y: +s.y.toFixed(2),
      biome: s.biome.id,
      cause: s.cause,
      outcome: s.outcome,
      stats: Object.assign({}, s.stats),
      seed: s.seed,
      quality: CONFIG.quality.levels[this.q.level].name,
      fps: +this.fps.toFixed(1),
      endShown: !!this.ui.endShown,
      ghost: !!this.ghost,
      online: this.host.active ? { signedIn: this.host.signedIn, attempt: this.attempt && { id: this.attempt.id, status: this.attempt.status, score: this.attempt.score, key: this.attempt.key } } : null,
    };
  }
}

function boot() {
  const game = new Game();
  // Hook for automated tests and ad-network QA.
  window.__appBack = () => game.back();
  window.__GAME = {
    game,
    info: () => game.info(),
    begin: () => game.play(),
    again: () => game.play(true),
    back: () => game.toTitle(),
    // bot(true) plays perfectly; bot(true, { human: true }) plays like a person.
    bot: (on, o) => {
      game.botOn = on !== false;
      game.botHuman = !!(o && o.human);
      game.bot = game.botOn && !game.raceMode ? game.makeBot() : null;
    },
    // Step the game by n frames of dt seconds without waiting for the display.
    step: (n, dt) => {
      game.manual = true;
      for (let i = 0; i < (n || 1); i++) game.frame(dt || 1 / 60);
      game.manual = false;
      return game.info();
    },
    bench: (s) => game.perf.runBench(s || 20),
    stats: () => {
      const r = game.stage.renderer.info;
      return { fps: +game.fps.toFixed(1), frameMs: +game.frameMs.toFixed(2), calls: r.render.calls, triangles: r.render.triangles, geometries: r.memory.geometries, textures: r.memory.textures, quality: CONFIG.quality.levels[game.q.level].name, pixelRatio: game.stage.renderer.getPixelRatio() };
    },
    audioLog: () => game.audio.log.slice(),
    voiceLog: () => game.voice.log.slice(),
    setting: (k, v) => game.setSetting(k, v),
    panel: (name) => (name ? game.ui.openPanel(name) : game.ui.closePanel()),
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
