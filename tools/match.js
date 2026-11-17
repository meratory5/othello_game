// Plays matches between two player configurations from random openings (each opening is
// played twice with colours swapped).
//   node tools/match.js --a '{"level":10}' --b '{"legacy":8}' --pairs 20 --plies 6 --seed 1
// Player spec (JSON):
//   {"level": n}                      level n of the shipped engine (1..10), weights + book
//   {"opts": {...}, "weights": false} raw think() options, optionally without weights / with "book": true
//   {"legacy": n}                     the AI of the previous version (tools/legacy/index_v1.html) at strength n
const fs = require('fs');
const path = require('path');
const { rng32, makeEngine, args } = require('./common');

function legacyPlayer(level) {
  const html = fs.readFileSync(path.join(__dirname, 'legacy/index_v1.html'), 'utf8');
  const src = html.slice(html.indexOf('class OthelloGame {'), html.indexOf('// ゲーム開始'));
  const el = new Proxy({}, { get: (t, k) => (k === 'addEventListener' || k === 'appendChild' ? () => { } : k === 'classList' ? { add() { }, remove() { } } : k === 'style' || k === 'dataset' ? {} : '') , set: () => true });
  const document = { getElementById: () => el, createElement: () => el, querySelector: () => el, querySelectorAll: () => [] };
  const Game = new Function('document', 'alert', 'setTimeout', src + '; return OthelloGame;')(document, () => { }, () => { });
  const g = new Game();
  const E = makeEngine({ weights: null });
  return {
    name: 'legacy' + level,
    async move(pos, blackToMove) {
      const me = blackToMove ? 1 : 2;
      for (let s = 0; s < 64; s++) { const c = E.cellAt(pos, s); g.board[s >> 3][s & 7] = c === 0 ? 0 : c === 1 ? me : 3 - me; }
      g.cpuColor = me; g.playerColor = 3 - me; g.searchDepth = level;
      const empties = E.countEmpties(pos);
      const th = { 1: 3, 2: 3, 3: 5, 4: 7, 5: 9, 6: 11, 7: 11, 8: 13 }[level] || 14;
      g.searchStartTime = Date.now(); g.nodesSearched = 0;
      const [mv] = await g.alphaBetaSearch(empties <= th ? empties : level, me);
      return mv[0] * 8 + mv[1];
    },
  };
}
function enginePlayer(spec, rnd) {
  const dir = path.join(__dirname, '../js');
  const useBook = spec.level ? true : !!spec.book;
  const E = makeEngine({ weights: spec.weights === false ? null : (spec.weights || path.join(dir, 'weights.js')), book: useBook ? path.join(dir, 'book.js') : null });
  E.initTT(spec.tt || 20);
  const opts = Object.assign({}, spec.level ? E.LEVELS[spec.level - 1] : spec.opts, { rng: rnd });
  if (spec.override) Object.assign(opts, spec.override);
  return { name: JSON.stringify(spec), async move(pos) { return E.think(pos, opts).sq; }, E };
}
function makePlayer(spec, rnd) { return spec.legacy ? legacyPlayer(spec.legacy) : enginePlayer(spec, rnd); }

async function playGame(E, black, white, start) {
  let pos = start.pos, blackToMove = start.black;
  for (;;) {
    let moves = E.legalMoves(pos);
    if (!moves.length) { pos = E.passPos(pos); blackToMove = !blackToMove; moves = E.legalMoves(pos); if (!moves.length) break; }
    const sq = await (blackToMove ? black : white).move(pos, blackToMove);
    if (!moves.includes(sq)) throw new Error('illegal move ' + sq + ' by ' + (blackToMove ? black : white).name);
    pos = E.play(pos, sq); blackToMove = !blackToMove;
  }
  return E.finalScore(pos) * (blackToMove ? 1 : -1);   // black's score
}

async function match(specA, specB, pairs, plies, seed, quiet) {
  const rnd = rng32(seed);
  const E = makeEngine({ weights: null });
  const A = makePlayer(specA, rng32(seed + 1)), B = makePlayer(specB, rng32(seed + 2));
  let w = 0, d = 0, l = 0, diff = 0;
  for (let p = 0; p < pairs; p++) {
    let pos = E.initialPosition(), black = true, ok = true;
    for (let i = 0; i < plies; i++) {
      const m = E.legalMoves(pos);
      if (!m.length) { ok = false; break; }
      pos = E.play(pos, m[Math.floor(rnd() * m.length)]); black = !black;
    }
    if (!ok) { p--; continue; }
    const start = { pos, black };
    for (const aBlack of [true, false]) {
      const s = await playGame(E, aBlack ? A : B, aBlack ? B : A, start) * (aBlack ? 1 : -1);
      diff += s; if (s > 0) w++; else if (s < 0) l++; else d++;
    }
    if (!quiet) process.stdout.write(`\r${p + 1}/${pairs}  A: +${w} =${d} -${l}  avg ${(diff / (w + d + l)).toFixed(1)}   `);
  }
  const n = w + d + l, sc = (w + d / 2) / n;
  const elo = sc <= 0 ? -Infinity : sc >= 1 ? Infinity : -400 * Math.log10(1 / sc - 1);
  return { w, d, l, score: sc, elo, avg: diff / n };
}

module.exports = { match };
if (require.main === module) {
  const a = args();
  match(JSON.parse(a.a), JSON.parse(a.b), +(a.pairs || 10), +(a.plies || 6), +(a.seed || 1)).then(r =>
    console.log(`\nA=${a.a} vs B=${a.b}: +${r.w} =${r.d} -${r.l}  score ${(r.score * 100).toFixed(1)}%  Elo ${r.elo.toFixed(0)}  avg discs ${r.avg.toFixed(1)}`));
}
