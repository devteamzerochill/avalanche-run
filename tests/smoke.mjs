import { Sim } from '../src/core/sim.js';
import { Bot } from '../src/core/bot.js';
const seeds = process.argv.slice(2).map(Number); if (!seeds.length) for (let i=1;i<=30;i++) seeds.push(i*7919);
let res=[];
for (const seed of seeds) {
  const sim = new Sim(seed); const bot = new Bot();
  let n=0; while (sim.phase!=='over' && sim.dist<12000 && n++<60*400) { sim.step(bot.decide(sim)); sim.events.length=0; }
  const s=sim.summary(); res.push(s);
  console.log(seed, s.distance, s.score, s.outcome, s.cause, s.causeDetail, 'nm',s.nearMisses,'cj',s.cleanJumps,'tr',s.tricks,'pf',s.perfects,'st',s.stumbles,'fl',s.flakes,'gap',sim.gap.toFixed(0),'t',s.time.toFixed(0));
}
console.log('min',Math.min(...res.map(r=>r.distance)),'median',res.map(r=>r.distance).sort((a,b)=>a-b)[res.length>>1], 'reached2000', res.filter(r=>r.distance>=2000).length+'/'+res.length);
