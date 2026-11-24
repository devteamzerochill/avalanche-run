// Other riders in their own look (DECISIONS 71): race riders, rematch ghosts
// and the lobby grid share one pool of full riders, each with its own trail.
import { Rider } from './rider.js';
import { SpeedTrail } from './particles.js';
import { RIDERS, BOARDS, TRAILS } from '../config.js';

// { rider, board, trail } ids from the server -> the config items (defaults
// for a player with no profile, or an item this game version doesn't know).
export function lookItems(look) {
  const L = look || {};
  return {
    rider: RIDERS.find((x) => x.id === L.rider) || RIDERS[0],
    board: BOARDS.find((x) => x.id === L.board) || BOARDS[0],
    trail: TRAILS.find((x) => x.id === L.trail) || null,
  };
}

export class Racers {
  constructor(stage) {
    this.stage = stage;
    this.list = [];
  }

  // Call once a frame before get(): anything not asked for is hidden by end().
  begin() {
    for (const r of this.list) r.used = false;
  }

  // The k-th drawn rider this frame, wearing look.
  get(k, look) {
    while (this.list.length <= k) {
      const rider = new Rider();
      rider.root.visible = false;
      this.stage.world.add(rider.root);
      const trail = new SpeedTrail(this.stage);
      trail.mesh.visible = false;
      this.list.push({ rider, trail, key: null, items: null, alpha: 1, used: false, spark: 0, hop: 0 });
    }
    const r = this.list[k];
    const key = look ? [look.rider, look.board, look.trail].join('/') : '';
    if (r.key !== key) {
      r.key = key;
      r.items = lookItems(look);
      r.rider.setSkin(r.items.rider, r.items.board);
      r.trail.setStyle(r.items.trail);
      r.trail.reset();
    }
    r.used = true;
    r.rider.root.visible = true;
    return r;
  }

  end() {
    for (const r of this.list) {
      if (r.used) continue;
      r.rider.root.visible = false;
      r.trail.mesh.visible = false;
      r.trail.reset();
      r.alpha = 1;
      r.rider.setOpacity(1);
    }
  }

  hide() {
    this.begin();
    this.end();
  }
}
