// Meta game rules: daily roll-over, streaks, missions, unlocks, leaderboard.
// Pure functions over the profile object, so they can be tested without a DOM.
import { CONFIG, MISSIONS, RIDERS, BOARDS, TRAILS } from '../config.js';
import { mulberry32, dailySeed } from '../core/rng.js';

const DAY_MS = 864e5;

export function dayBefore(day) {
  return new Date(Date.parse(day + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);
}

// Call on boot and before every run: a new UTC day resets the daily state.
export function rollDay(p, today) {
  if (p.day === today) return false;
  p.day = today;
  p.bestToday = 0;
  p.runsToday = [];
  p.ghost = null;
  return true;
}

// First run of a day advances the streak and pays the streak reward.
export function startRun(p, today) {
  rollDay(p, today);
  refillMissions(p);
  if (p.lastDay === today) return null;
  p.streak = p.lastDay === dayBefore(today) ? p.streak + 1 : 1;
  p.lastDay = today;
  return streakReward(p);
}

function streakReward(p) {
  const M = CONFIG.meta;
  const hit = M.streakRewards.find((r) => r.day === p.streak);
  const last = M.streakRewards[M.streakRewards.length - 1].day;
  const out = { day: p.streak, flakes: 0, rider: null, board: null };
  if (hit) {
    if (hit.flakes) out.flakes = hit.flakes;
    if (hit.rider && !p.riders.includes(hit.rider)) {
      p.riders.push(hit.rider);
      out.rider = hit.rider;
    }
    if (hit.board && !p.boards.includes(hit.board)) {
      p.boards.push(hit.board);
      out.board = hit.board;
    }
  } else if (p.streak > last) out.flakes = M.streakDailyFlakes;
  p.flakes += out.flakes;
  return out.flakes || out.rider || out.board ? out : null;
}

export function nextStreakReward(p) {
  const M = CONFIG.meta;
  const next = M.streakRewards.find((r) => r.day > p.streak);
  return next || { day: p.streak + 1, flakes: M.streakDailyFlakes };
}

export function missionById(id) {
  return MISSIONS.find((m) => m.id === id);
}

function refillMissions(p) {
  const act = p.missions.active;
  for (let i = 0; i < act.length; i++) {
    if (!act[i].done) continue;
    // Skip missions that are already active.
    let guard = MISSIONS.length;
    let def = MISSIONS[p.missions.next % MISSIONS.length];
    while (guard-- > 0 && act.some((a) => a.id === def.id)) {
      p.missions.next++;
      def = MISSIONS[p.missions.next % MISSIONS.length];
    }
    act[i] = { id: def.id, progress: 0, done: false };
    p.missions.next++;
  }
}

// Apply a finished run. Returns what the end card needs to show.
export function finishRun(p, summary, replay) {
  const out = { newBest: false, newBestToday: false, rank: 0, completed: [], flakes: summary.flakes, missionFlakes: 0 };
  p.totals.runs++;
  p.totals.distance += summary.distance;
  p.totals.flakes += summary.flakes;
  p.totals.nearMisses += summary.nearMisses;
  p.flakes += summary.flakes;
  if (summary.score > p.best) {
    p.best = summary.score;
    out.newBest = true;
  }
  if (summary.score > p.bestToday) {
    p.bestToday = summary.score;
    out.newBestToday = true;
    if (replay && replay.data) p.ghost = { day: p.day, seed: summary.seed, version: CONFIG.version, score: summary.score, data: replay.data };
  }
  p.runsToday.push({ score: summary.score, time: Math.round(summary.time) });
  p.runsToday.sort((a, b) => b.score - a.score);
  p.runsToday.length = Math.min(p.runsToday.length, 5);

  for (const m of p.missions.active) {
    if (m.done) continue;
    const def = missionById(m.id);
    if (!def) continue;
    const value = summary[def.stat] || 0;
    m.progress = def.total ? m.progress + value : Math.max(m.progress, value);
    if (m.progress >= def.goal) {
      m.progress = def.goal;
      m.done = true;
      p.flakes += def.reward;
      out.missionFlakes += def.reward;
      out.completed.push(def.id);
    }
  }
  const board = leaderboard(p, p.day);
  out.rank = board.findIndex((r) => r.you && r.score === summary.score) + 1;
  return out;
}

// --- unlocks -------------------------------------------------------------
export function catalogue(type) {
  return type === 'rider' ? RIDERS : type === 'board' ? BOARDS : TRAILS;
}

function ownList(p, type) {
  return (type === 'rider' ? p.riders : type === 'board' ? p.boards : p.trails) || [];
}

export function owns(p, type, id) {
  return ownList(p, type).includes(id);
}

export function buy(p, type, id) {
  const item = catalogue(type).find((i) => i.id === id);
  // Shards items are sold by the server only (DECISIONS 68).
  if (!item || item.shards || owns(p, type, id) || item.cost < 0 || p.flakes < item.cost) return false;
  p.flakes -= item.cost;
  (type === 'rider' ? p.riders : p.boards).push(id);
  select(p, type, id);
  return true;
}

export function select(p, type, id) {
  if (type === 'trail' && id === 'none') return (p.trail = null), true;
  if (!owns(p, type, id)) return false;
  if (type === 'rider') p.rider = id;
  else if (type === 'board') p.board = id;
  else p.trail = id;
  return true;
}

// --- local leaderboard ---------------------------------------------------
const CPU_NAMES = ['Kestrel', 'Juniper', 'Bolt', 'Mossy', 'Glint', 'Tundra', 'Pika', 'Ridge', 'Sable', 'Wren'];

// CPU riders are stand-ins, labelled as such in the UI. Their scores are
// seeded from the date so the board is the same all day.
export function cpuRiders(day) {
  const rng = mulberry32(dailySeed(day) ^ 0x5eed);
  const out = [];
  for (let i = 0; i < CONFIG.meta.cpuRiders; i++) {
    const skill = rng();
    out.push({ name: CPU_NAMES[(i + Math.floor(rng() * 3)) % CPU_NAMES.length] + ' ' + (10 + Math.floor(rng() * 89)), cpu: true, score: Math.round(600 + skill * skill * 5200) });
  }
  return out;
}

export function leaderboard(p, day) {
  const rows = cpuRiders(day);
  for (const r of p.runsToday) rows.push({ name: '', you: true, score: r.score });
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, CONFIG.meta.leaderboardSize);
}
