// Online features behind interfaces, with local stand-ins. A backend plugs in
// by calling services.use('leaderboard', new MyRemoteLeaderboard()) at boot.
//
// interface LeaderboardService {
//   submit(day: string, entry: {score, seed, proof}): Promise<{rank: number}>
//   top(day: string, limit: number): Promise<Array<{name, score, you?, cpu?}>>
// }
// interface TournamentService {
//   current(): Promise<null | {id, name, endsAt, seed}>
//   join(id: string): Promise<boolean>
// }
// interface ProofOfPlayService {
//   prove(run: {seed, version, data, score}): Promise<{proof: string}>
//   verify(run: {seed, version, data, score}): Promise<{valid: boolean, score: number}>
// }
import { CONFIG } from '../config.js';
import { leaderboard } from './meta.js';
import { resimulate } from '../core/replay.js';
import { hashString } from '../core/rng.js';

export class LocalLeaderboard {
  constructor(store) {
    this.store = store;
  }

  async submit(day, entry) {
    const rows = leaderboard(this.store.profile, day);
    return { rank: rows.findIndex((r) => r.you && r.score === entry.score) + 1 };
  }

  async top(day, limit) {
    return leaderboard(this.store.profile, day).slice(0, limit || CONFIG.meta.leaderboardSize);
  }
}

export class LocalTournament {
  async current() {
    return null; // no tournament without a backend
  }

  async join() {
    return false;
  }
}

// Proof of Play, local version: the proof is a hash over the run, and
// verification re-simulates the recorded inputs and compares the score.
// A server would run exactly the same resimulate() on its side.
export class LocalProofOfPlay {
  async prove(run) {
    return { proof: hashString([run.seed, run.version, run.score, run.data].join(':')).toString(16) };
  }

  async verify(run) {
    const re = resimulate(run);
    if (!re) return { valid: false, score: 0 };
    return { valid: re.summary.score === run.score, score: re.summary.score };
  }
}

export const services = {
  leaderboard: null,
  tournament: null,
  proof: null,
  use(name, impl) {
    this[name] = impl;
  },
};

export function initLocalServices(store) {
  services.use('leaderboard', new LocalLeaderboard(store));
  services.use('tournament', new LocalTournament());
  services.use('proof', new LocalProofOfPlay());
}
