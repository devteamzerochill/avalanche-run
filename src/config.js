// Every tuning value lives here. Systems read CONFIG, never literals.
// Values marked (P) are the prototype's and are overridable through
// window.__PARAMS for the playable-ad build (see applyParams below).

export const CONFIG = {
  // zerochill.com backend (Lovable Cloud). Public values only: the URL and the
  // anon key already ship to every visitor of the site. Used only with ?live.
  // `profile` marks a backend that has the slice 1 profile APIs
  // (supabase/migrations).
  online: {
    // ?live=local: the local Supabase from `npx supabase start`. Its standard
    // public demo key, the same on every machine; not a secret.
    local: { url: 'http://127.0.0.1:54321', anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0', profile: true },
    url: 'https://llnwrhbftwtgkzpvsbwj.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbndyaGJmdHd0Z2t6cHZzYndqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NTQwNTMsImV4cCI6MjEwMDIzMDA1M30.hORRWT3nwtRtSrmk_qu8pTg2g3pBBQAXZGbZxFkGj4Q',
    profile: true, // live since migration 0313 (2026-11-24)
  },
  // Endurance race (docs/endurance-race.md), opt-in with ?race. The race server
  // replays every rider with these same settings; it sends its own values with
  // each race, so these are the defaults both sides start from.
  race: {
    server: 'ws://localhost:2567',
    // The avalanche gains 0.3 m/s per second after 190 s; the best riders
    // (both test bots) are caught at about 3:55-4:10, inside the 5-minute cycle.
    // From denseFrom to denseTo m (about 2:00 to 3:00 into a race) the slope
    // builds up: rows come closer (spacing x denseRows at the end) and carry
    // more hazards (extra-hazard chances x denseExtra). The server sends all of
    // this with the race, so it can be tuned there.
    ramp: { from: 190, rate: 0.3, denseFrom: 7000, denseTo: 11000, denseRows: 0.7, denseExtra: 1.5 },
    sendEvery: 6, // ticks of input per message (10 a second)
    ghosts: 6, // nearest other riders drawn
  },
  version: 4, // bump when sim or generator behaviour changes (invalidates ghosts)
  tick: 1 / 60,

  lane: {
    halfWidth: 7.2, // (P) rideable half-width, m
    pisteHalf: 9.0, // (P) groomed half-width, m
    viewDist: 300, // (P) how far ahead the course exists, m
  },

  player: {
    radius: 0.36, // (P)
    depth: 0.62, // (P) half-length along the slope for collisions
    startSpeed: 26, // (P) m/s
    maxSpeed: 61, // (P) m/s
    speedRamp: 0.9, // (P) m/s per second
    accelRate: 1.1, // (P) ease rate towards cruise, 1/s
    boostAccelRate: 4,
    steerGain: 14, // wanted lateral speed per metre of error, 1/s
    latMax: 16, // m/s
    brakeShare: 0.92, // share of the stoppable speed the carve will use
    grip: 78, // lateral accel available on packed snow, m/s^2
    airControl: 16, // m/s^2
    carveDragPerVx: 0.12, // (P)
    carveDragMax: 4, // (P) m/s^2
    driftDrag: 3, // m/s^2 at full drift
    driftSpan: 40, // m/s^2 of excess demand for full drift
    keySteerSpeed: 13, // (P) m/s, target line speed for keys and tap-steer
  },

  air: {
    jumpTime: 0.72, // (P) s
    jumpHeight: 1.55, // (P) m
    rampVy: 13.5, // m/s
    cliffDrop: 3.2, // m
    jumpBuffer: 0.15, // (P) s
    grabDelay: 0.08, // s of air before a grab can start
    perfectMinHold: 0.22, // s
    perfectWindowMin: 0.05, // s before touchdown
    perfectWindowMax: 0.3,
    trickRate: 60, // trick points per second of grab (trick points do not add to the score)
    sloppySpeedMul: 0.78,
    sloppyGapLoss: 2,
  },

  boost: {
    amount: 9, // m/s over cruise
    time: 1.8, // s
    fade: 0.6, // s of linear fade at the end
    perfectGapGain: 3,
    tunnelAmount: 6,
    dashTime: 1.25, // s of boost from a dash pad
    dashGapGain: 1.5,
  },

  avalanche: {
    maxGap: 60, // (P) m
    startGap: 46, // (P)
    baseFactor: 0.94, // (P) avalanche speed as a share of cruise
    surgeFactor: 0.05, // extra share when the rider is far ahead
    surgeFrom: 35,
    surgeTo: 60,
    chase: 1, // (P) pressure multiplier
    nearMissGain: 4, // (P) m
    stumbleLoss: 3, // (P) m
    stumbleSpeedMul: 0.55, // (P)
  },

  score: {
    nearMissBonus: 25, // (P) m
    nearMissMargin: 1.1, // (P) m
    closeCallMargin: 0.45,
    cleanJumpBonus: 10,
    comboWindow: 3, // (P) s
    comboMax: 5,
    milestoneEvery: 500, // (P) m
    // Trick points (perfect landings, clean jumps, grabs, crevasse hops) count in
    // the score. The game sets `tricks` at start-up: on everywhere except runs
    // zerochill.com scores, which wait for `tricksLive` (set it true once the
    // site accepts the higher scores; LOVABLE_HANDOFF.md, DECISIONS 63).
    tricks: false,
    tricksLive: false,
  },

  surface: { glacier: 0.62, ice: 0.35, mogul: 0.6, storm: 0.85 },
  mogulDrag: 7, // m/s^2 while rattling through moguls
  wind: { accel: 9, period: 260 }, // storm crosswind in the air; period in metres

  // --- course generator -------------------------------------------------
  gen: {
    firstRowAt: 110, // (P) m
    rowTimeStart: 1.0, // s between rows at tier 0
    rowTimeEnd: 0.62, // s at tier 1
    tierDistance: 3200, // m to reach tier 1
    boostAllowance: 10, // m/s added to the cruise bound
    planLat: 8, // m/s lateral speed the safe line assumes
    planReact: 0.25, // s of reaction before the rider starts moving
    corridorStart: 1.9, // m, half-width free of deadly hazards (includes the rider)
    corridorEnd: 1.35,
    extraChanceStart: 0.3, // chance of a 2nd hazard in a row
    extraChanceEnd: 0.85,
    thirdChanceEnd: 0.55, // chance of a 3rd at tier 1
    fourthChanceEnd: 0.25,
    jumpableShare: 0.34,
    envelopeBefore: 0.5, // in jumps, deadly-free zone before a jumpable on the line
    envelopeAfterExtra: 0.25, // s, on top of one jump after it
    featureEvery: [5, 9], // rows between special features
    flakeEvery: [2, 4], // rows between flake lines
    dashEvery: [2, 4], // rows between dash pads
    density: 1, // (P) obstacle density multiplier
  },

  biomes: {
    order: ['forest', 'glacier', 'storm'],
    starts: [0, 1200, 2600], // m within a cycle
    cycle: 3900,
  },

  // --- hazard dimensions (collision) ------------------------------------
  hazards: {
    pine: { radius: [0.9, 1.3], height: 7 }, // trunk and inner branches; tips are forgiving
    boulder: { radius: [0.87, 1.5], heightPerRadius: 1.25 },
    log: { halfWidth: [1.7, 3.1], halfDepth: 0.32, height: 0.7 },
    ridge: { halfWidth: [1.5, 2.7], halfDepth: 0.7, height: 0.8 },
    crevasse: { halfWidth: [0.8, 1.4], jumpsLong: 1.25 },
    ramp: { halfWidth: 1.6, halfDepth: 2.2 },
    mogul: { halfWidth: [1.8, 2.8], halfDepth: [5, 9] },
    ice: { halfWidth: [2.2, 3.6], halfDepth: [6, 12] },
    arch: { halfWidth: 2.6, seconds: [1.3, 1.9], pillarRadius: 0.45, pillarHeight: 4 },
    flake: { radius: 0.95, height: 0.9 },
    dash: { halfWidth: 1.4, halfDepth: 2.4 },
  },

  // --- camera (P) ---------------------------------------------------------
  camera: {
    distance: 6.4,
    height: 3.1,
    pitch: 14,
    follow: 9,
    fov: 74,
    hfovLandscape: 82,
    lead: 16,
    shake: 60, // %
    introZoom: 1,
    payoffZoom: 1.15,
    yaw: 0,
    slopeDeg: 11,
  },

  // --- look (P where the prototype exposed it) ----------------------------
  look: {
    background: 'Morning', // Morning | Midday (forest lighting)
    groundColor: '#EEF4FA',
    pathColor: '#E2ECF6',
    skyTopColor: '#2F7FD8',
    fogColor: '#CFE4F2',
    playerColor: '#15161A',
    playerColor2: '#1E6FE8',
    enemyColor: '#3A4148',
    rewardColor: '#FFE14D',
    uiAccent: '#35D6FF',
  },

  audio: { sfxVolume: 0.3, musicVolume: 0.2 }, // (P) defaults
  announcer: false, // spoken call-outs (src/systems/announcer.js); off for now

  ad: {
    maxPlayTime: 300, // (P) s
    hintDelay: 3, // (P) s
    endTitle: '',
    endSub: '',
    ctaText: '',
    storeUrl: { ios: '', android: '' },
  },

  quality: {
    // pixelRatio cap, particle share, scenery share
    levels: [
      { name: 'low', pr: 0.6, particles: 0.35, scenery: 0.4, snow: 0 },
      { name: 'medium', pr: 0.8, particles: 0.6, scenery: 0.7, snow: 0.5 },
      { name: 'high', pr: 1, particles: 1, scenery: 1, snow: 1 },
    ],
    maxPixelRatio: 2,
    sampleFrames: 90,
    dropAboveMs: 21, // average frame time that triggers a step down
    capJitterMs: 2.5, // frames steadier than this are a browser cap, not overload
    dropAlwaysMs: 45, // step down regardless below ~22 fps
  },

  meta: {
    streakRewards: [
      { day: 2, flakes: 40 },
      { day: 3, board: 'ember' },
      { day: 5, flakes: 120 },
      { day: 7, rider: 'yeti' },
    ],
    streakDailyFlakes: 60, // every day after day 7
    leaderboardSize: 10,
    cpuRiders: 7,
  },
};

// Riders and boards are cosmetic only (see DECISIONS.md).
export const RIDERS = [
  // Every rider is the Zero Chill fox; 'nova' is the mascot's own outfit.
  { id: 'nova', cost: 0, fur: '#E8622A', cream: '#FFF3E6', hoodie: '#18191F', trim: '#FF6B1A', shorts: '#18191F', shortsTrim: '#E0262E', glove: '#18191F', gear: '#2F6BFF' },
  { id: 'pine', cost: 150, fur: '#D9652B', cream: '#FFF3E6', hoodie: '#2FA36B', trim: '#FFD23F', shorts: '#1C2A2E', shortsTrim: '#FFD23F', glove: '#1C2A2E', gear: '#FFD23F' },
  { id: 'blush', cost: 300, fur: '#E8642A', cream: '#FFF3E6', hoodie: '#E8457A', trim: '#3FD0F5', shorts: '#2B2140', shortsTrim: '#3FD0F5', glove: '#2B2140', gear: '#3FD0F5' },
  { id: 'frost', cost: 500, fur: '#EEF4FA', cream: '#FFFFFF', hoodie: '#3FD0F5', trim: '#16406B', shorts: '#16406B', shortsTrim: '#F07A1E', glove: '#16406B', gear: '#F07A1E' },
  { id: 'yeti', cost: -1, fur: '#5E6B7D', cream: '#F4F7FB', hoodie: '#F4F7FB', trim: '#7A5CFF', shorts: '#DDE7F0', shortsTrim: '#7A5CFF', glove: '#7A5CFF', gear: '#7A5CFF' },
];

export const BOARDS = [
  { id: 'classic', cost: 0, deck: '#15161A', stripe: '#1E6FE8', edge: '#E0262E' },
  { id: 'sunrise', cost: 100, deck: '#FFD23F', stripe: '#F07A1E', edge: '#15161A' },
  { id: 'mint', cost: 200, deck: '#F4F7FB', stripe: '#2FA36B', edge: '#16406B' },
  { id: 'ember', cost: -1, deck: '#2B0F12', stripe: '#FF5B2E', edge: '#FFD23F' },
  { id: 'aurora', cost: 400, deck: '#1B1740', stripe: '#3FD0F5', edge: '#7A5CFF' },
];

// Mission pool. `stat` is a key of the run summary (see sim.summary()).
// `total: true` missions accumulate across runs.
export const MISSIONS = [
  { id: 'dist1', stat: 'distance', goal: 800, reward: 30 },
  { id: 'near1', stat: 'nearMisses', goal: 5, reward: 30 },
  { id: 'flake1', stat: 'flakes', goal: 40, reward: 30, total: true },
  { id: 'clean1', stat: 'cleanJumps', goal: 6, reward: 40 },
  { id: 'trick1', stat: 'tricks', goal: 3, reward: 40 },
  { id: 'dist2', stat: 'distance', goal: 1500, reward: 60 },
  { id: 'combo1', stat: 'bestCombo', goal: 4, reward: 50 },
  { id: 'perfect1', stat: 'perfects', goal: 2, reward: 60 },
  { id: 'glacier', stat: 'distance', goal: 1200, reward: 50 },
  { id: 'speed1', stat: 'topKmh', goal: 170, reward: 50 },
  { id: 'near2', stat: 'nearMisses', goal: 40, reward: 80, total: true },
  { id: 'storm', stat: 'distance', goal: 2600, reward: 120 },
  { id: 'trick2', stat: 'trickScore', goal: 300, reward: 80 },
  { id: 'dist3', stat: 'distance', goal: 4000, reward: 200 },
];

// Prototype-compatible overrides: window.__PARAMS = { startSpeed: 30, ... }.
const PARAM_MAP = {
  startSpeed: ['player', 'startSpeed'],
  maxSpeed: ['player', 'maxSpeed'],
  speedRamp: ['player', 'speedRamp'],
  jumpTime: ['air', 'jumpTime'],
  obstacleDensity: ['gen', 'density', 0.01],
  avalancheChase: ['avalanche', 'chase'],
  nearMissBonus: ['score', 'nearMissBonus'],
  milestoneEvery: ['score', 'milestoneEvery'],
  sfxVolume: ['audio', 'sfxVolume', 0.01],
  musicVolume: ['audio', 'musicVolume', 0.01],
  cameraDistance: ['camera', 'distance'],
  cameraPitch: ['camera', 'pitch'],
  cameraFollow: ['camera', 'follow'],
  cameraShake: ['camera', 'shake'],
  cameraFov: ['camera', 'fov'],
  cameraHeight: ['camera', 'height'],
  cameraYaw: ['camera', 'yaw'],
  cameraLead: ['camera', 'lead'],
  cameraIntroZoom: ['camera', 'introZoom'],
  cameraPayoffZoom: ['camera', 'payoffZoom'],
  background: ['look', 'background'],
  groundColor: ['look', 'groundColor'],
  pathColor: ['look', 'pathColor'],
  skyTopColor: ['look', 'skyTopColor'],
  fogColor: ['look', 'fogColor'],
  playerColor: ['look', 'playerColor'],
  playerColor2: ['look', 'playerColor2'],
  enemyColor: ['look', 'enemyColor'],
  rewardColor: ['look', 'rewardColor'],
  uiAccent: ['look', 'uiAccent'],
  endTitle: ['ad', 'endTitle'],
  endSub: ['ad', 'endSub'],
  ctaText: ['ad', 'ctaText'],
  maxPlayTime: ['ad', 'maxPlayTime'],
  hintDelay: ['ad', 'hintDelay'],
};

export const STEER_RANGE = { value: 0.6 }; // (P) share of screen width for a full carve

export function applyParams(params) {
  if (!params) return;
  for (const key of Object.keys(params)) {
    const map = PARAM_MAP[key];
    const v = params[key];
    if (key === 'steerRange' && typeof v === 'number') STEER_RANGE.value = v / 100;
    if (!map || v === '' || v == null) continue;
    const target = CONFIG[map[0]];
    target[map[1]] = typeof v === 'number' && map[2] ? v * map[2] : v;
  }
}

// Derived air constants (kept in one place so sim, generator and tests agree).
export function airConstants() {
  const T = CONFIG.air.jumpTime;
  const g = (8 * CONFIG.air.jumpHeight) / (T * T);
  return { g, jumpVy: (g * T) / 2, rampTime: (2 * CONFIG.air.rampVy) / g };
}
