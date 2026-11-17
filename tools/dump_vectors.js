// Writes reference vectors used by the Python port's test (python/othello_game_2/test_engine.py).
//   node tools/dump_vectors.js <out.json>
const fs = require('fs');
const { rng32, makeEngine } = require('./common');
const E = makeEngine({ book: require('path').join(__dirname, '../js/book.js') });
const rnd = rng32(2024);
const big = (hi, lo) => ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
const out = [];
for (let g = 0; g < 60; g++) {
  let pos = E.initialPosition();
  for (;;) {
    let moves = E.legalMoves(pos);
    if (!moves.length) { pos = E.passPos(pos); moves = E.legalMoves(pos); if (!moves.length) break; }
    const empties = E.countEmpties(pos);
    const rec = { P: big(pos.ph, pos.pl), O: big(pos.oh, pos.ol), moves, eval: E.evaluate(pos), key: E.canonical(pos).key };
    if (g < 12) { E.clearTT(); rec.d3 = E.searchValue(pos, 3); }
    if (empties <= 10) { E.clearTT(); rec.exact = E.solveExact(pos); }
    const bm = E.bookMoves(pos);
    if (bm) rec.book = bm.map(m => [m.sq, m.score]).sort((a, b) => a[0] - b[0]);
    out.push(rec);
    pos = E.play(pos, moves[Math.floor(rnd() * moves.length)]);
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(out.length, 'vectors');
