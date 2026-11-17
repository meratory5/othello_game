// Self-play data generator.
//   node tools/selfplay.js --games 5000 --depth 4 --exact 12 --seed 1 --out data/g0_1.bin [--noweights]
// Record = 5 x int32: pl, ph, ol, oh, final disc difference for the side to move.
const fs = require('fs');
const path = require('path');
const { rng32, makeEngine, args } = require('./common');

const a = args();
const games = +(a.games || 1000), depth = +(a.depth || 4), exact = +(a.exact || 12), seed = +(a.seed || 1);
const E = makeEngine(a.noweights ? { weights: null } : {});
const rnd = rng32(seed * 7919 + 13);
E.initTT(18);
const out = [];
const t0 = Date.now();
for (let g = 0; g < games; g++) {
  let pos = E.initialPosition(), black = true;
  const rec = [];
  const randomPlies = 2 + Math.floor(rnd() * 15);       // 2..16 random plies give opening variety
  let ply = 0;
  for (;;) {
    let moves = E.legalMoves(pos);
    if (!moves.length) {
      pos = E.passPos(pos); black = !black;
      moves = E.legalMoves(pos);
      if (!moves.length) break;
    }
    let sq;
    if (ply < randomPlies) sq = moves[Math.floor(rnd() * moves.length)];
    else {
      rec.push(pos.pl, pos.ph, pos.ol, pos.oh, black ? 1 : -1);
      const empties = E.countEmpties(pos);
      // a little noise keeps the games from collapsing onto a few lines
      const noisy = empties > exact && rnd() < 0.12;
      sq = E.think(pos, { depth, exact, noise: noisy ? 3 : 0, rng: rnd }).sq;
    }
    pos = E.play(pos, sq); black = !black; ply++;
  }
  const fs_ = E.finalScore(pos) * (black ? 1 : -1);      // black's final score
  for (let i = 0; i < rec.length; i += 5) out.push(rec[i], rec[i + 1], rec[i + 2], rec[i + 3], rec[i + 4] * fs_);
  if (g % 16 === 0) E.clearTT();
}
fs.mkdirSync(path.dirname(a.out), { recursive: true });
fs.writeFileSync(a.out, Buffer.from(new Int32Array(out).buffer));
console.log(`${a.out}: ${games} games, ${out.length / 5} positions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
