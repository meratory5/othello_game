/*
 * Human-readable description of a move in terms of standard Othello principles
 * (corners, X/C squares, mobility, openness / 中割り, 一石返し, stable discs, edge shapes,
 * parity).  The engine itself chooses moves with a learned pattern evaluation and search;
 * this module describes WHAT a move does on the board so that a person can connect it to
 * the principles taught in lessons.html.  It is a description, not the engine's reasoning.
 *
 *   const X = OthelloExplainFactory(E);
 *   X.describe(pos, sq) -> { tags: [{id, good, weight, text, lesson}], facts: {...} }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.OthelloExplainFactory = factory;
})(typeof self !== 'undefined' ? self : this, function OthelloExplainFactory(E) {
  'use strict';
  const CORNERS = [0, 7, 56, 63];
  const XSQ = { 9: 0, 14: 7, 49: 56, 54: 63 };
  const CSQ = { 1: 0, 8: 0, 6: 7, 15: 7, 48: 56, 57: 56, 55: 63, 62: 63 };
  const NB = [];
  for (let s = 0; s < 64; s++) {
    const l = [], r = s >> 3, c = s & 7;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) l.push(rr * 8 + cc);
    }
    NB.push(l);
  }
  const EDGES = [
    [0, 1, 2, 3, 4, 5, 6, 7], [56, 57, 58, 59, 60, 61, 62, 63],
    [0, 8, 16, 24, 32, 40, 48, 56], [7, 15, 23, 31, 39, 47, 55, 63],
  ];
  const LINES = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const name = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);

  function cellsOf(pos) { const a = new Uint8Array(64); for (let s = 0; s < 64; s++) a[s] = E.cellAt(pos, s); return a; }

  // discs of colour `who` that can never be flipped (conservative: anchored on edges/corners or full lines)
  function stableCount(a, who) {
    const st = new Uint8Array(64);
    let changed = true, n = 0;
    while (changed) {
      changed = false;
      for (let s = 0; s < 64; s++) {
        if (st[s] || a[s] !== who) continue;
        const r = s >> 3, c = s & 7;
        let ok = true;
        for (const [dr, dc] of LINES) {
          let safe = false;
          // one side is the board edge or a stable disc of the same colour
          for (const sg of [1, -1]) {
            const rr = r + dr * sg, cc = c + dc * sg;
            if (rr < 0 || rr > 7 || cc < 0 || cc > 7) { safe = true; break; }
            const t = rr * 8 + cc;
            if (a[t] === who && st[t]) { safe = true; break; }
          }
          if (!safe) {
            // or the whole line is full
            let full = true;
            for (const sg of [1, -1]) {
              let rr = r + dr * sg, cc = c + dc * sg;
              while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { if (!a[rr * 8 + cc]) { full = false; break; } rr += dr * sg; cc += dc * sg; }
              if (!full) break;
            }
            safe = full;
          }
          if (!safe) { ok = false; break; }
        }
        if (ok) { st[s] = 1; n++; changed = true; }
      }
    }
    return n;
  }

  // empty regions (8-connected); returns { id[64], sizes[] }
  function regions(a) {
    const id = new Int8Array(64).fill(-1), sizes = [];
    for (let s = 0; s < 64; s++) {
      if (a[s] || id[s] >= 0) continue;
      const k = sizes.length, stack = [s];
      id[s] = k; let n = 0;
      while (stack.length) {
        const x = stack.pop(); n++;
        for (const y of NB[x]) if (!a[y] && id[y] < 0) { id[y] = k; stack.push(y); }
      }
      sizes.push(n);
    }
    return { id, sizes };
  }

  // shape of an edge for colour `who`: 'yama' | 'wing' | 'block' | null (both corners must be empty)
  function edgeShape(a, e, who) {
    if (a[e[0]] || a[e[7]]) return null;
    const m = e.map(s => a[s] === who);
    const other = e.some(s => a[s] && a[s] !== who);
    if (other) return null;
    const run = (i, j) => { for (let k = i; k <= j; k++) if (!m[k]) return false; return true; };
    if (run(1, 6)) return 'yama';
    if ((run(1, 5) && !a[e[6]]) || (run(2, 6) && !a[e[1]])) return 'wing';
    if (run(2, 5) && !a[e[1]] && !a[e[6]]) return 'block';
    return null;
  }

  function describe(pos, sq) {
    const before = cellsOf(pos);                      // 1 = mover, 2 = opponent
    const flips = E.flipsOf(pos, sq);
    const child = E.play(pos, sq);
    const after = new Uint8Array(64);
    for (let s = 0; s < 64; s++) { const c = E.cellAt(child, s); after[s] = c ? 3 - c : 0; }
    const empties = E.countEmpties(pos);
    const oppBeforeMoves = E.legalMoves(E.passPos(pos));
    const oppMoves = E.legalMoves(child);
    const ownAfter = E.legalMoves(E.passPos(child)).length;
    const ownBefore = E.legalMoves(pos).length;
    const gameOver = !oppMoves.length && !ownAfter;

    let openness = 0;
    for (const f of flips) for (const n of NB[f]) if (!before[n] && n !== sq) openness++;
    const cornerGiven = oppMoves.filter(m => CORNERS.includes(m) && !oppBeforeMoves.includes(m));
    const cornerDenied = oppBeforeMoves.filter(m => CORNERS.includes(m) && m !== sq && !oppMoves.includes(m));
    const stableGain = stableCount(after, 1) - stableCount(before, 1);
    const reg = regions(before);
    const regSize = reg.sizes[reg.id[sq]];
    const oddRegions = reg.sizes.filter(n => n % 2).length;
    const facts = { flips: flips.length, openness, oppBefore: oppBeforeMoves.length, oppAfter: oppMoves.length, ownBefore, ownAfter,
      stableGain, regSize, oddRegions, empties, cornerGiven, cornerDenied };

    const tags = [];
    const add = (id, good, weight, text, lesson) => tags.push({ id, good, weight, text, lesson });
    const mid = empties > 14;

    if (CORNERS.includes(sq)) add('corner', true, 100, '隅を取る手。隅は二度と返されず、そこから確定石を広げられます。', 'basics-corner');
    if (cornerGiven.length) add('gives-corner', false, 100, `相手に隅（${cornerGiven.map(name).join('・')}）を取る手を与えます。`, 'basics-corner');
    if (cornerDenied.length) add('denies-corner', true, 85, `相手が狙っていた隅（${cornerDenied.map(name).join('・')}）への手を消します。`, 'basics-corner');
    if (sq in XSQ && !after[XSQ[sq]]) add('x-square', false, cornerGiven.length ? 30 : 80, `X打ち（隅 ${name(XSQ[sq])} の斜め隣）。その隅を取られるきっかけになりやすい危険なマスです。`, 'basics-cx');
    if (sq in CSQ && !after[CSQ[sq]]) add('c-square', false, 45, `C打ち（隅 ${name(CSQ[sq])} の隣）。辺の形しだいで隅を取られる原因になります。`, 'basics-cx');

    if (!gameOver) {
      if (!oppMoves.length) add('pass', true, 95, '相手は打てる所がなくなりパス。続けてもう一手打てます（手を稼ぐ）。', 'mid-tempo');
      else if (oppMoves.length <= 3 && mid) add('restrict', true, 75, `相手の打てる箇所を ${oppBeforeMoves.length} → ${oppMoves.length} に絞ります。選択肢の少ない相手は悪い手を打たされます。`, 'basics-mobility');
      else if (oppMoves.length <= oppBeforeMoves.length - 2) add('restrict', true, 60, `相手の打てる箇所を ${oppBeforeMoves.length} → ${oppMoves.length} に減らします。`, 'basics-mobility');
      else if (oppMoves.length >= oppBeforeMoves.length + 3 && mid) add('opens', false, 55, `相手の打てる箇所が ${oppBeforeMoves.length} → ${oppMoves.length} に増えます。相手に良い手を選ばせやすくなります。`, 'basics-mobility');
    }
    if (stableGain >= 2) add('stable', true, 70, `確定石（もう返されない石）が ${stableGain} 個増えます。`, 'basics-corner');

    if (mid) {
      if (openness === 0) add('nakawari', true, 65, '中割り。返した石がどれも空きマスに接していないので、相手の打てる所を増やしません。', 'mid-nakawari');
      else if (openness <= 2 && flips.length <= 3) add('low-open', true, 45, `開放度 ${openness} の静かな手。返した石がほとんど外に面していません。`, 'mid-nakawari');
      else if (openness >= 7) add('wall', false, 55, `外側の石を返す手（開放度 ${openness}）。壁ができて、相手の打てる所を増やしやすくなります。`, 'mid-nakawari');
      if (flips.length === 1 && openness <= 3) add('isseki', true, 40, '一石返し。1個だけ返して局面をあまり動かさず、相手に手を渡します。', 'mid-isseki');
      if (flips.length >= 6 && empties > 24) add('many', false, 40, `${flips.length} 個も返す手。序中盤は石の多い方が打てる所を失いやすく不利です。`, 'basics-fewer');
    }
    for (const e of EDGES) {
      if (!e.includes(sq)) continue;
      const sh = edgeShape(after, e, 1);
      if (sh === 'yama') add('yama', true, 50, 'この辺が「山」（b〜gの6個）になります。隅を取られにくい良い形です。', 'edge-yama');
      else if (sh === 'wing') add('wing', false, 50, 'この辺が「ウィング」（5個並び）になります。空いたC打ちから隅を狙われる悪形です。', 'edge-wing');
      else if (sh === 'block') add('block', true, 25, 'この辺が「ブロック」（中央4個）になります。可もなく不可もない普通の形です。', 'edge-block');
    }
    if (empties <= 14 && !gameOver) {
      if (regSize === 1) add('temadomari', true, 55, '1個空きに打つ手止まり。この空きで最後に打つのは自分になります。', 'end-temadomari');
      else if (regSize % 2 === 1) add('parity', true, 60, `奇数空き（${regSize}個空き）に先に打つ手。残りを偶数空きにして、各所の最後の手を自分が打てるようにします（偶数理論）。`, 'end-parity');
      else if (oddRegions > 0) add('even-region', false, 40, `偶数空き（${regSize}個空き）に打つ手。奇数空きが残っているので、そちらを相手に使われやすくなります。`, 'end-parity');
    }
    tags.sort((x, y) => y.weight - x.weight);
    return { tags, facts };
  }

  // classification of a move by how many discs it loses against the best move
  function grade(loss, exact) {
    if (loss <= (exact ? 0 : 0.5)) return { id: 'best', label: '最善' };
    if (loss <= 2) return { id: 'good', label: '好手' };
    if (loss <= 5) return { id: 'ok', label: '緩手' };
    if (loss <= 10) return { id: 'dubious', label: '疑問手' };
    return { id: 'bad', label: '悪手' };
  }

  return { describe, grade, stableCount, regions, edgeShape, name };
});
