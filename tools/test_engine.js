// Correctness tests for the engine: node tools/test_engine.js
const E = require('../js/engine.js')();
const assert = require('assert');

function rng32(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// --- reference implementation on a plain array (independent of the bitboards)
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
function refFlips(b, sq, me) {
  if (b[sq]) return [];
  const out = [], r0 = sq >> 3, c0 = sq & 7;
  for (const [dr, dc] of DIRS) {
    const t = []; let r = r0 + dr, c = c0 + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === 3 - me) { t.push(r * 8 + c); r += dr; c += dc; }
    if (t.length && r >= 0 && r < 8 && c >= 0 && c < 8 && b[r * 8 + c] === me) out.push(...t);
  }
  return out;
}
function toArr(pos) { const a = []; for (let s = 0; s < 64; s++) a.push(E.cellAt(pos, s)); return a; }
function refNegamax(b, me, passed) {
  let best = null;
  for (let s = 0; s < 64; s++) {
    const f = refFlips(b, s, me);
    if (!f.length) continue;
    const nb = b.slice(); nb[s] = me; for (const x of f) nb[x] = me;
    const v = -refNegamax(nb, 3 - me, false);
    if (best === null || v > best) best = v;
  }
  if (best !== null) return best;
  if (passed) {
    let a = 0, o = 0; for (const x of b) { if (x === me) a++; else if (x) o++; }
    return a > o ? 64 - 2 * o : a < o ? 2 * a - 64 : 0;
  }
  return -refNegamax(b, 3 - me, true);
}

// 1. perft
const PERFT = [1, 4, 12, 56, 244, 1396, 8200, 55092, 390216, 3005288];
for (let d = 1; d <= 9; d++) assert.equal(E.perft(E.initialPosition(), d, false), PERFT[d], 'perft ' + d);
console.log('perft 1..9 ok');

// 2. move generation / flips against the reference on random positions
const rnd = rng32(12345);
let checked = 0;
for (let g = 0; g < 300; g++) {
  let pos = E.initialPosition();
  for (;;) {
    let moves = E.legalMoves(pos);
    if (!moves.length) { pos = E.passPos(pos); moves = E.legalMoves(pos); if (!moves.length) break; }
    const b = toArr(pos);
    const ref = []; for (let s = 0; s < 64; s++) if (refFlips(b, s, 1).length) ref.push(s);
    assert.deepStrictEqual(moves, ref);
    const m = moves[Math.floor(rnd() * moves.length)];
    assert.deepStrictEqual(E.flipsOf(pos, m), refFlips(b, m, 1).sort((x, y) => x - y));
    pos = E.play(pos, m); checked++;
  }
}
console.log('movegen ok on', checked, 'positions');

// 3. exact solver against brute force at 7..9 empties, and windowed searches agree
function randomPos(empties) {
  for (;;) {
    let pos = E.initialPosition();
    for (;;) {
      if (E.countEmpties(pos) === empties) { if (E.hasMoves(pos)) return pos; break; }
      let moves = E.legalMoves(pos);
      if (!moves.length) { pos = E.passPos(pos); moves = E.legalMoves(pos); if (!moves.length) break; }
      pos = E.play(pos, moves[Math.floor(rnd() * moves.length)]);
    }
  }
}
for (let i = 0; i < 150; i++) {
  const pos = randomPos(6 + (i % 4));
  const ref = refNegamax(toArr(pos), 1, false);
  E.clearTT();
  assert.equal(E.solveExact(pos), ref, 'exact');
  E.clearTT();
  const w = E.solveExact(pos, -1, 1);
  assert.equal(Math.sign(w), Math.sign(ref), 'wld');
  // think() must pick a move that preserves the exact value
  const r = E.think(pos, { depth: 4, exact: 20 });
  assert.equal(r.score, ref, 'think score');
  const c = E.play(pos, r.sq);
  assert.equal(0 - refNegamax(toArr(c), 1, false), ref, 'think move');
}
console.log('exact solver ok');

// 4. larger solves: PVS/TT result must equal a TT-less full-window run through a different path (wld vs exact sign)
for (let i = 0; i < 30; i++) {
  const pos = randomPos(14);
  E.clearTT(); const v = E.solveExact(pos);
  E.clearTT(); const w = E.solveExact(pos, -1, 1);
  E.clearTT(); const u = E.solveExact(pos, v - 1, v + 1);
  assert.equal(Math.sign(v), Math.sign(w)); assert.equal(u, v);
}
console.log('14-empties consistency ok');

// 5. symmetry: evaluation and canonical keys are invariant
for (let i = 0; i < 200; i++) {
  const pos = randomPos(20 + (i % 30));
  const key = E.canonical(pos).key, ev = E.evaluate(pos), hv = E.heuristicEval(pos);
  for (let k = 1; k < 8; k++) {
    const t = E.transform(pos, k);
    assert.equal(E.canonical(t).key, key);
    assert.equal(E.heuristicEval(t), hv, 'heuristic symmetric');
    if (E.hasWeights()) assert.equal(E.evaluate(t), ev, 'eval symmetric');
  }
}
console.log('symmetry ok');

// 6. FFO endgame test #40 (20 empties, black to move, +38)
if (process.argv.includes('--ffo')) {
  const s = 'O--OOOOX-OOOOOOXOOXXOOOXOOXOOOXXOOOOOOXX---OOOOX----O--X--------';
  const pos = E.fromCells([...s].map(ch => ch === 'X' ? 1 : ch === 'O' ? 2 : 0));
  E.clearTT();
  const t = Date.now();
  const r = E.think(pos, { depth: 10, exact: 30 });
  console.log('FFO40:', r.score, 'move', r.sq, 'nodes', r.nodes, 'ms', Date.now() - t, 'nps', Math.round(r.nodes / (Date.now() - t) * 1000));
}
