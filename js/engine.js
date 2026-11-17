/*
 * Othello engine (bitboard + pattern evaluation + PVS + exact endgame solver)
 *
 * The whole engine lives in one self-contained factory function so that it can be
 *   - required from Node (tools/, tests),
 *   - loaded with a <script> tag on the page,
 *   - turned into a Web Worker through factory.toString() (works on file:// too).
 *
 * Board: 64 squares, sq = row*8+col (a1 = 0, h8 = 63).  A bitboard is kept as two
 * 32-bit halves (lo = squares 0..31, hi = squares 32..63).  A position is always
 * (player-to-move, opponent) = (pl, ph, ol, oh).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.OthelloEngineFactory = factory;
})(typeof self !== 'undefined' ? self : this, function OthelloEngineFactory() {
  'use strict';

  // ------------------------------------------------------------------ bits
  function popcnt(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }
  const SHIFTS = [1, 8, 7, 9];
  const NOT_AH = 0x7e7e7e7e;

  // legal moves of P -> ML / MH
  let ML = 0, MH = 0;
  function getMoves(pl, ph, ol, oh) {
    let rl = 0, rh = 0;
    for (let d = 0; d < 4; d++) {
      const s = SHIFTS[d], r = 32 - s;
      const ml = d === 1 ? ol : ol & NOT_AH, mh = d === 1 ? oh : oh & NOT_AH;
      let tl = ml & (pl << s), th = mh & ((ph << s) | (pl >>> r));
      if (tl | th) {
        for (let i = 0; i < 5; i++) {
          const nl = tl << s, nh = (th << s) | (tl >>> r);
          tl |= ml & nl; th |= mh & nh;
        }
        rl |= tl << s; rh |= (th << s) | (tl >>> r);
      }
      tl = ml & ((pl >>> s) | (ph << r)); th = mh & (ph >>> s);
      if (tl | th) {
        for (let i = 0; i < 5; i++) {
          const nl = (tl >>> s) | (th << r), nh = th >>> s;
          tl |= ml & nl; th |= mh & nh;
        }
        rl |= (tl >>> s) | (th << r); rh |= th >>> s;
      }
    }
    ML = rl & ~(pl | ol); MH = rh & ~(ph | oh);
  }
  function mobility(pl, ph, ol, oh) {
    getMoves(pl, ph, ol, oh);
    return popcnt(ML) + popcnt(MH);
  }

  // discs flipped when P plays sq -> FL / FH (0 when illegal)
  let FL = 0, FH = 0;
  function getFlips(sq, pl, ph, ol, oh) {
    let bl = 0, bh = 0;
    if (sq < 32) bl = 1 << sq; else bh = 1 << (sq - 32);
    let fl = 0, fh = 0;
    for (let d = 0; d < 4; d++) {
      const s = SHIFTS[d], r = 32 - s;
      const ml = d === 1 ? ol : ol & NOT_AH, mh = d === 1 ? oh : oh & NOT_AH;
      let tl = ml & (bl << s), th = mh & ((bh << s) | (bl >>> r));
      if (tl | th) {
        for (;;) {
          const nl = tl << s, nh = (th << s) | (tl >>> r);
          const al = ml & nl & ~tl, ah = mh & nh & ~th;
          if (!(al | ah)) { if ((nl & pl) | (nh & ph)) { fl |= tl; fh |= th; } break; }
          tl |= al; th |= ah;
        }
      }
      tl = ml & ((bl >>> s) | (bh << r)); th = mh & (bh >>> s);
      if (tl | th) {
        for (;;) {
          const nl = (tl >>> s) | (th << r), nh = th >>> s;
          const al = ml & nl & ~tl, ah = mh & nh & ~th;
          if (!(al | ah)) { if ((nl & pl) | (nh & ph)) { fl |= tl; fh |= th; } break; }
          tl |= al; th |= ah;
        }
      }
    }
    FL = fl; FH = fh;
  }

  // ------------------------------------------------------------ symmetries
  const SYM = [], SYMINV = [];
  (function () {
    const T = [
      (r, c) => [r, c], (r, c) => [c, r], (r, c) => [7 - r, c], (r, c) => [r, 7 - c],
      (r, c) => [7 - r, 7 - c], (r, c) => [7 - c, 7 - r], (r, c) => [c, 7 - r], (r, c) => [7 - c, r],
    ];
    for (const t of T) {
      const a = new Uint8Array(64), inv = new Uint8Array(64);
      for (let s = 0; s < 64; s++) {
        const [r, c] = t(s >> 3, s & 7);
        a[s] = r * 8 + c; inv[r * 8 + c] = s;
      }
      SYM.push(a); SYMINV.push(inv);
    }
  })();

  // ------------------------------------------------------ pattern features
  const PATTERNS = [
    { name: 'edge2x', sq: [0, 1, 2, 3, 4, 5, 6, 7, 9, 14] },
    { name: 'hv2', sq: [8, 9, 10, 11, 12, 13, 14, 15] },
    { name: 'hv3', sq: [16, 17, 18, 19, 20, 21, 22, 23] },
    { name: 'hv4', sq: [24, 25, 26, 27, 28, 29, 30, 31] },
    { name: 'd8', sq: [0, 9, 18, 27, 36, 45, 54, 63] },
    { name: 'd7', sq: [1, 10, 19, 28, 37, 46, 55] },
    { name: 'd6', sq: [2, 11, 20, 29, 38, 47] },
    { name: 'd5', sq: [3, 12, 21, 30, 39] },
    { name: 'd4', sq: [4, 13, 22, 31] },
    { name: 'c33', sq: [0, 1, 2, 8, 9, 10, 16, 17, 18] },
    { name: 'c25', sq: [0, 1, 2, 3, 4, 8, 9, 10, 11, 12] },
  ];
  const NSTAGE = 10;
  const MOB_SIZE = 256;
  const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683, 59049];
  const features = [];           // {pat, sq[]}  (index = sum b[sq[k]] * 3^k)
  let STAGE_SIZE = 0, MOB_OFF = 0;
  (function () {
    let off = 0;
    PATTERNS.forEach((p, pi) => {
      p.size = POW3[p.sq.length]; p.off = off; off += p.size;
      p.selfSyms = [];
      const seen = new Set();
      const baseKey = p.sq.slice().sort((a, b) => a - b).join(',');
      for (let k = 0; k < 8; k++) {
        const img = p.sq.map(s => SYM[k][s]);
        const key = img.slice().sort((a, b) => a - b).join(',');
        if (key === baseKey) p.selfSyms.push(img.map(s => p.sq.indexOf(s)));
        if (seen.has(key)) continue;
        seen.add(key);
        features.push({ pat: pi, sq: img });
      }
    });
    MOB_OFF = off; STAGE_SIZE = off + MOB_SIZE;
  })();
  const NF = features.length;
  const FSQ = new Uint8Array(features.reduce((n, f) => n + f.sq.length, 0));
  const FEND = new Int32Array(NF), FOFF = new Int32Array(NF);
  (function () {
    let p = 0;
    features.forEach((f, i) => {
      for (let j = f.sq.length - 1; j >= 0; j--) FSQ[p++] = f.sq[j];
      FEND[i] = p; FOFF[i] = PATTERNS[f.pat].off;
    });
  })();

  // canonical index tables (weight sharing under each pattern's own symmetry)
  function canonTable(pi) {
    const p = PATTERNS[pi], n = p.sq.length, t = new Int32Array(p.size);
    const dig = new Uint8Array(n);
    for (let idx = 0; idx < p.size; idx++) {
      let x = idx, best = idx;
      for (let k = 0; k < n; k++) { dig[k] = x % 3; x = (x / 3) | 0; }
      for (const perm of p.selfSyms) {
        let v = 0;
        for (let k = 0; k < n; k++) v += dig[k] * POW3[perm[k]];
        if (v < best) best = v;
      }
      t[idx] = best;
    }
    return t;
  }

  const cells = new Uint8Array(64);
  function fillCells(pl, ph, ol, oh) {
    for (let i = 0; i < 32; i++) {
      cells[i] = ((pl >>> i) & 1) | (((ol >>> i) & 1) << 1);
      cells[i + 32] = ((ph >>> i) & 1) | (((oh >>> i) & 1) << 1);
    }
  }
  // absolute feature indices (within one stage) of a position -> out[NF+1]
  function featureIndices(pl, ph, ol, oh, out) {
    fillCells(pl, ph, ol, oh);
    let p = 0;
    for (let f = 0; f < NF; f++) {
      let idx = 0;
      for (const e = FEND[f]; p < e; p++) idx = idx * 3 + cells[FSQ[p]];
      out[f] = FOFF[f] + idx;
    }
    let a = mobility(pl, ph, ol, oh), b = mobility(ol, oh, pl, ph);
    if (a > 15) a = 15; if (b > 15) b = 15;
    out[NF] = MOB_OFF + a * 16 + b;
  }
  function stageOf(discs) {
    const s = ((discs - 4) / 6) | 0;
    return s < 0 ? 0 : s >= NSTAGE ? NSTAGE - 1 : s;
  }

  // ------------------------------------------------------------ evaluation
  // All midgame scores are in EVAL_UNIT-ths of a disc.
  const EVAL_UNIT = 8;
  const SCORE_MAX = 64 * EVAL_UNIT;
  let W = null;                  // Int8Array(NSTAGE * STAGE_SIZE) or null

  function setWeights(w) { W = w; }

  const CORNER_L = 0x00000081, CORNER_H = 0x81000000 | 0;
  const XSQ_L = 0x00004200, XSQ_H = 0x00420000;
  const CSQ_L = 0x00008142, CSQ_H = 0x42810000;
  function heuristicEval(pl, ph, ol, oh) {
    const el = ~(pl | ol), eh = ~(ph | oh);
    // squares next to an empty square
    let nl = 0, nh = 0;
    {
      const al = el & 0xfefefefe, ah = eh & 0xfefefefe, bl = el & 0x7f7f7f7f, bh = eh & 0x7f7f7f7f;
      nl = (al >>> 1) | (bl << 1) | (el << 8) | ((el >>> 8) | (eh << 24)) |
        (al << 7) | (bl << 9) | ((al >>> 9) | (ah << 23)) | ((bl >>> 7) | (bh << 25));
      nh = (ah >>> 1) | (bh << 1) | ((eh << 8) | (el >>> 24)) | (eh >>> 8) |
        ((ah << 7) | (al >>> 25)) | ((bh << 9) | (bl >>> 23)) | (ah >>> 9) | (bh >>> 7);
    }
    const mp = mobility(pl, ph, ol, oh), mo = mobility(ol, oh, pl, ph);
    const cp = popcnt(pl & CORNER_L) + popcnt(ph & CORNER_H), co = popcnt(ol & CORNER_L) + popcnt(oh & CORNER_H);
    // X / C squares only matter while the neighbouring corner is empty
    let xp = 0, xo = 0, ccp = 0, cco = 0;
    if (el & 1) { xp += (pl >>> 9) & 1; xo += (ol >>> 9) & 1; ccp += ((pl >>> 1) & 1) + ((pl >>> 8) & 1); cco += ((ol >>> 1) & 1) + ((ol >>> 8) & 1); }
    if (el & 0x80) { xp += (pl >>> 14) & 1; xo += (ol >>> 14) & 1; ccp += ((pl >>> 6) & 1) + ((pl >>> 15) & 1); cco += ((ol >>> 6) & 1) + ((ol >>> 15) & 1); }
    if (eh & 0x01000000) { xp += (ph >>> 17) & 1; xo += (oh >>> 17) & 1; ccp += ((ph >>> 16) & 1) + ((ph >>> 25) & 1); cco += ((oh >>> 16) & 1) + ((oh >>> 25) & 1); }
    if (eh & 0x80000000) { xp += (ph >>> 22) & 1; xo += (oh >>> 22) & 1; ccp += ((ph >>> 23) & 1) + ((ph >>> 30) & 1); cco += ((oh >>> 23) & 1) + ((oh >>> 30) & 1); }
    const fp = popcnt(pl & nl) + popcnt(ph & nh), fo = popcnt(ol & nl) + popcnt(oh & nh);
    const np = popcnt(pl) + popcnt(ph), no = popcnt(ol) + popcnt(oh);
    const empties = 64 - np - no;
    let v = (cp - co) * 80 - (xp - xo) * 44 - (ccp - cco) * 14 + (mp - mo) * 12 - (fp - fo) * 5;
    if (empties < 16) v += (np - no) * (16 - empties) / 2;
    return v | 0;
  }

  function evaluate(pl, ph, ol, oh) {
    if (W === null) return heuristicEval(pl, ph, ol, oh);
    fillCells(pl, ph, ol, oh);
    const base = stageOf(popcnt(pl) + popcnt(ph) + popcnt(ol) + popcnt(oh)) * STAGE_SIZE;
    let p = 0, sum = 0;
    for (let f = 0; f < NF; f++) {
      let idx = 0;
      for (const e = FEND[f]; p < e; p++) idx = idx * 3 + cells[FSQ[p]];
      sum += W[base + FOFF[f] + idx];
    }
    let a = mobility(pl, ph, ol, oh), b = mobility(ol, oh, pl, ph);
    if (a > 15) a = 15; if (b > 15) b = 15;
    sum += W[base + MOB_OFF + a * 16 + b];
    return sum > SCORE_MAX - 1 ? SCORE_MAX - 1 : sum < 1 - SCORE_MAX ? 1 - SCORE_MAX : sum;
  }

  // The static evaluation split into its table look-ups (values in discs, mover's view).
  function evalBreakdown(pl, ph, ol, oh) {
    if (W === null) return null;
    fillCells(pl, ph, ol, oh);
    const stage = stageOf(popcnt(pl) + popcnt(ph) + popcnt(ol) + popcnt(oh));
    const base = stage * STAGE_SIZE;
    const feats = [];
    let p = 0;
    for (let f = 0; f < NF; f++) {
      let idx = 0;
      for (const e = FEND[f]; p < e; p++) idx = idx * 3 + cells[FSQ[p]];
      feats.push({ pat: features[f].pat, sq: features[f].sq, index: idx, v: W[base + FOFF[f] + idx] / EVAL_UNIT });
    }
    let a = mobility(pl, ph, ol, oh), b = mobility(ol, oh, pl, ph);
    const own = a, opp = b;
    if (a > 15) a = 15; if (b > 15) b = 15;
    return { stage, feats, mobility: { own, opp, v: W[base + MOB_OFF + a * 16 + b] / EVAL_UNIT }, total: evaluate(pl, ph, ol, oh) / EVAL_UNIT };
  }

  function finalScore(pl, ph, ol, oh) {     // discs, empties go to the winner
    const a = popcnt(pl) + popcnt(ph), b = popcnt(ol) + popcnt(oh);
    const d = a - b;
    return d > 0 ? 64 - 2 * b : d < 0 ? 2 * a - 64 : 0;
  }

  // --------------------------------------------------- transposition table
  let TT_BITS = 20, TT_MASK = 0;
  let ttPl, ttPh, ttOl, ttOh, ttLo, ttHi, ttDepth, ttMove;
  const EXACT_DEPTH = 100;       // entries written by the endgame solver (values in discs)
  function initTT(bits) {
    TT_BITS = bits || TT_BITS;
    const n = 1 << TT_BITS;
    TT_MASK = n - 1;
    ttPl = new Int32Array(n); ttPh = new Int32Array(n); ttOl = new Int32Array(n); ttOh = new Int32Array(n);
    ttLo = new Int16Array(n); ttHi = new Int16Array(n); ttDepth = new Int8Array(n); ttMove = new Int8Array(n);
    ttDepth.fill(-1);
  }
  function clearTT() { if (ttDepth) ttDepth.fill(-1); }
  function hashPos(pl, ph, ol, oh) {
    let h = Math.imul(pl, 0x9e3779b1) ^ Math.imul(ph, 0x85ebca77);
    h ^= h >>> 15;
    h = Math.imul(h ^ ol, 0xc2b2ae3d) ^ Math.imul(oh, 0x27d4eb2f);
    h ^= h >>> 13;
    h = Math.imul(h, 0x165667b1);
    return (h ^ (h >>> 16)) & TT_MASK;
  }
  function ttStore(h, pl, ph, ol, oh, depth, lo, hi, move) {
    if (ttDepth[h] > depth && ttPl[h] === pl && ttPh[h] === ph && ttOl[h] === ol && ttOh[h] === oh) return;
    ttPl[h] = pl; ttPh[h] = ph; ttOl[h] = ol; ttOh[h] = oh;
    ttDepth[h] = depth; ttLo[h] = lo; ttHi[h] = hi; ttMove[h] = move;
  }

  // ----------------------------------------------------------- search core
  const MAXPLY = 64, MAXMOVES = 34;
  const mvSq = new Int8Array(MAXPLY * MAXMOVES), mvVal = new Int32Array(MAXPLY * MAXMOVES);
  const mvFl = new Int32Array(MAXPLY * MAXMOVES), mvFh = new Int32Array(MAXPLY * MAXMOVES);
  // static square preference used only to break ordering ties
  const SQV = new Int32Array(64);
  (function () {
    const q = [9, 1, 6, 5, 1, 0, 3, 3, 6, 3, 5, 4, 5, 3, 4, 4];
    for (let s = 0; s < 64; s++) {
      const r = Math.min(s >> 3, 7 - (s >> 3)), c = Math.min(s & 7, 7 - (s & 7));
      SQV[s] = q[r * 4 + c];
    }
  })();

  let nodes = 0, deadline = Infinity, aborted = false;
  const ABORT = { abort: true };
  function checkTime() {
    if (Date.now() > deadline) { aborted = true; throw ABORT; }
  }

  // collect + score the moves of the node at `ply`; returns the move count
  function genMoves(pl, ph, ol, oh, ply, ttm, mode) {
    let ml = ML, mh = MH;         // caller has just run getMoves
    const base = ply * MAXMOVES;
    let n = 0;
    while (ml | mh) {
      let sq;
      if (ml) { const b = ml & -ml; sq = 31 - Math.clz32(b); ml ^= b; }
      else { const b = mh & -mh; sq = 63 - Math.clz32(b); mh ^= b; }
      getFlips(sq, pl, ph, ol, oh);
      const fl = FL, fh = FH;
      let v;
      if (sq === ttm) v = 1 << 28;
      else if (mode === 0) v = SQV[sq];
      else {
        // child position: mover = old opponent
        let cpl = ol & ~fl, cph = oh & ~fh, col = pl | fl, coh = ph | fh;
        if (sq < 32) col |= 1 << sq; else coh |= 1 << (sq - 32);
        const mob = mobility(cpl, cph, col, coh);
        v = SQV[sq] - mob * ORD_MOB;
        if (mode === 2) v -= evaluate(cpl, cph, col, coh) * 2;
      }
      const i = base + n++;
      mvSq[i] = sq; mvVal[i] = v; mvFl[i] = fl; mvFh[i] = fh;
    }
    return n;
  }
  // move the best remaining move to slot i
  function pickMove(base, i, n) {
    let b = i, bv = mvVal[base + i];
    for (let j = i + 1; j < n; j++) if (mvVal[base + j] > bv) { bv = mvVal[base + j]; b = j; }
    if (b !== i) {
      const x = base + i, y = base + b;
      let t = mvSq[x]; mvSq[x] = mvSq[y]; mvSq[y] = t;
      t = mvVal[x]; mvVal[x] = mvVal[y]; mvVal[y] = t;
      t = mvFl[x]; mvFl[x] = mvFl[y]; mvFl[y] = t;
      t = mvFh[x]; mvFh[x] = mvFh[y]; mvFh[y] = t;
    }
  }

  // Principal variation search, scores in 1/EVAL_UNIT discs, fail-soft.
  function pvs(pl, ph, ol, oh, depth, alpha, beta, ply, passed) {
    if (depth <= 0) { nodes++; return evaluate(pl, ph, ol, oh); }
    if ((++nodes & 8191) === 0) checkTime();
    getMoves(pl, ph, ol, oh);
    if (!(ML | MH)) {
      if (passed) return finalScore(pl, ph, ol, oh) * EVAL_UNIT;
      return -pvs(ol, oh, pl, ph, depth, -beta, -alpha, ply, true);
    }
    let h = 0, ttm = -1;
    const useTT = depth >= 2;
    if (useTT) {
      const sml = ML, smh = MH;
      h = hashPos(pl, ph, ol, oh);
      if (ttDepth[h] >= 0 && ttPl[h] === pl && ttPh[h] === ph && ttOl[h] === ol && ttOh[h] === oh) {
        ttm = ttMove[h];
        const d = ttDepth[h];
        if (d === EXACT_DEPTH) {
          const lo = ttLo[h] * EVAL_UNIT, hi = ttHi[h] * EVAL_UNIT;
          if (lo >= beta) return lo;
          if (hi <= alpha) return hi;
          if (lo === hi) return lo;
        } else if (d >= depth) {
          const lo = ttLo[h], hi = ttHi[h];
          if (lo >= beta) return lo;
          if (hi <= alpha) return hi;
          if (lo === hi) return lo;
          if (lo > alpha) alpha = lo;
          if (hi < beta) beta = hi;
        }
      }
      ML = sml; MH = smh;
    }
    const n = genMoves(pl, ph, ol, oh, ply, ttm, depth >= 5 ? 2 : depth >= 2 ? 1 : 0);
    const base = ply * MAXMOVES;
    const alpha0 = alpha;
    let best = -32000, bestMove = -1;
    for (let i = 0; i < n; i++) {
      if (depth >= 2) pickMove(base, i, n);
      const sq = mvSq[base + i], fl = mvFl[base + i], fh = mvFh[base + i];
      const cpl = ol & ~fl, cph = oh & ~fh;
      let col = pl | fl, coh = ph | fh;
      if (sq < 32) col |= 1 << sq; else coh |= 1 << (sq - 32);
      let v;
      if (i === 0) v = -pvs(cpl, cph, col, coh, depth - 1, -beta, -alpha, ply + 1, false);
      else {
        v = -pvs(cpl, cph, col, coh, depth - 1, -alpha - 1, -alpha, ply + 1, false);
        if (v > alpha && v < beta) v = -pvs(cpl, cph, col, coh, depth - 1, -beta, -alpha, ply + 1, false);
      }
      if (v > best) {
        best = v; bestMove = sq;
        if (v > alpha) { alpha = v; if (v >= beta) break; }
      }
    }
    if (useTT) {
      ttStore(h, pl, ph, ol, oh, depth, best > alpha0 ? best : -32000, best < beta ? best : 32000, bestMove);
    }
    return best;
  }

  // ------------------------------------------------------- endgame solver
  // Exact disc-difference search (scores in discs).
  function solve1(pl, ph, ol, oh) {
    const el = ~(pl | ol), eh = ~(ph | oh);
    const sq = el ? 31 - Math.clz32(el & -el) : 63 - Math.clz32(eh & -eh);
    const d = 2 * (popcnt(pl) + popcnt(ph)) - 63;
    getFlips(sq, pl, ph, ol, oh);
    let n = popcnt(FL) + popcnt(FH);
    if (n) return d + 2 * n + 1;
    getFlips(sq, ol, oh, pl, ph);
    n = popcnt(FL) + popcnt(FH);
    if (n) return d - 2 * n - 1;
    return d > 0 ? d + 1 : d - 1;
  }

  function solve(pl, ph, ol, oh, alpha, beta, empties, ply, passed) {
    if (empties === 1) { nodes++; return solve1(pl, ph, ol, oh); }
    if ((++nodes & 16383) === 0) checkTime();
    getMoves(pl, ph, ol, oh);
    let ml = ML, mh = MH;
    if (!(ml | mh)) {
      if (passed) return finalScore(pl, ph, ol, oh);
      return -solve(ol, oh, pl, ph, -beta, -alpha, empties, ply, true);
    }
    let best = -99;
    if (empties <= 4) {
      while (ml | mh) {
        let sq;
        if (ml) { const b = ml & -ml; sq = 31 - Math.clz32(b); ml ^= b; }
        else { const b = mh & -mh; sq = 63 - Math.clz32(b); mh ^= b; }
        getFlips(sq, pl, ph, ol, oh);
        const fl = FL, fh = FH;
        let col = pl | fl, coh = ph | fh;
        if (sq < 32) col |= 1 << sq; else coh |= 1 << (sq - 32);
        const v = -solve(ol & ~fl, oh & ~fh, col, coh, -beta, -alpha, empties - 1, ply + 1, false);
        if (v > best) { best = v; if (v > alpha) { alpha = v; if (v >= beta) return v; } }
      }
      return best;
    }
    let h = 0, ttm = -1;
    const useTT = empties >= 8;
    if (useTT) {
      h = hashPos(pl, ph, ol, oh);
      if (ttDepth[h] >= 0 && ttPl[h] === pl && ttPh[h] === ph && ttOl[h] === ol && ttOh[h] === oh) {
        ttm = ttMove[h];
        if (ttDepth[h] === EXACT_DEPTH) {
          const lo = ttLo[h], hi = ttHi[h];
          if (lo >= beta) return lo;
          if (hi <= alpha) return hi;
          if (lo === hi) return lo;
          if (lo > alpha) alpha = lo;
          if (hi < beta) beta = hi;
        }
      }
    }
    ML = ml; MH = mh;
    const n = genMoves(pl, ph, ol, oh, ply, ttm, empties >= SOLVE_EVAL_ORDER ? 2 : 1);
    const base = ply * MAXMOVES;
    const alpha0 = alpha;
    let bestMove = -1;
    for (let i = 0; i < n; i++) {
      pickMove(base, i, n);
      const sq = mvSq[base + i], fl = mvFl[base + i], fh = mvFh[base + i];
      const cpl = ol & ~fl, cph = oh & ~fh;
      let col = pl | fl, coh = ph | fh;
      if (sq < 32) col |= 1 << sq; else coh |= 1 << (sq - 32);
      let v;
      if (i === 0) v = -solve(cpl, cph, col, coh, -beta, -alpha, empties - 1, ply + 1, false);
      else {
        v = -solve(cpl, cph, col, coh, -alpha - 1, -alpha, empties - 1, ply + 1, false);
        if (v > alpha && v < beta) v = -solve(cpl, cph, col, coh, -beta, -alpha, empties - 1, ply + 1, false);
      }
      if (v > best) {
        best = v; bestMove = sq;
        if (v > alpha) { alpha = v; if (v >= beta) break; }
      }
    }
    if (useTT) ttStore(h, pl, ph, ol, oh, EXACT_DEPTH, best > alpha0 ? best : -64, best < beta ? best : 64, bestMove);
    return best;
  }
  let SOLVE_EVAL_ORDER = 11, ORD_MOB = 32;

  // ------------------------------------------------------------ positions
  function initialPosition() {
    // black to move: black on d5 (sq 35), e4 (sq 28); white on d4 (27), e5 (36)
    return { pl: 1 << 28, ph: 1 << 3, ol: 1 << 27, oh: 1 << 4 };
  }
  function legalMoves(pos) {
    getMoves(pos.pl, pos.ph, pos.ol, pos.oh);
    const out = [];
    for (let s = 0; s < 32; s++) if ((ML >>> s) & 1) out.push(s);
    for (let s = 0; s < 32; s++) if ((MH >>> s) & 1) out.push(s + 32);
    return out;
  }
  function flipsOf(pos, sq) {
    getFlips(sq, pos.pl, pos.ph, pos.ol, pos.oh);
    const out = [];
    for (let s = 0; s < 32; s++) { if ((FL >>> s) & 1) out.push(s); }
    for (let s = 0; s < 32; s++) { if ((FH >>> s) & 1) out.push(s + 32); }
    return out;
  }
  // returns the position after the move, seen from the next mover (no pass handling)
  function play(pos, sq) {
    getFlips(sq, pos.pl, pos.ph, pos.ol, pos.oh);
    const fl = FL, fh = FH;
    let col = pos.pl | fl, coh = pos.ph | fh;
    if (sq < 32) col |= 1 << sq; else coh |= 1 << (sq - 32);
    return { pl: pos.ol & ~fl, ph: pos.oh & ~fh, ol: col, oh: coh };
  }
  function passPos(pos) { return { pl: pos.ol, ph: pos.oh, ol: pos.pl, oh: pos.ph }; }
  function countEmpties(pos) { return 64 - popcnt(pos.pl) - popcnt(pos.ph) - popcnt(pos.ol) - popcnt(pos.oh); }
  function discCounts(pos) { return [popcnt(pos.pl) + popcnt(pos.ph), popcnt(pos.ol) + popcnt(pos.oh)]; }
  function hasMoves(pos) { getMoves(pos.pl, pos.ph, pos.ol, pos.oh); return (ML | MH) !== 0; }
  function isGameOver(pos) { return !hasMoves(pos) && !hasMoves(passPos(pos)); }
  function cellAt(pos, sq) {   // 0 empty, 1 mover, 2 opponent
    return sq < 32 ? ((pos.pl >>> sq) & 1) | (((pos.ol >>> sq) & 1) << 1)
      : ((pos.ph >>> (sq - 32)) & 1) | (((pos.oh >>> (sq - 32)) & 1) << 1);
  }
  function fromCells(arr) {      // arr[64] of 0/1/2 (1 = mover)
    const p = { pl: 0, ph: 0, ol: 0, oh: 0 };
    for (let s = 0; s < 64; s++) {
      if (arr[s] === 1) { if (s < 32) p.pl |= 1 << s; else p.ph |= 1 << (s - 32); }
      else if (arr[s] === 2) { if (s < 32) p.ol |= 1 << s; else p.oh |= 1 << (s - 32); }
    }
    return p;
  }
  function transform(pos, k) {
    const a = new Uint8Array(64);
    for (let s = 0; s < 64; s++) a[SYM[k][s]] = cellAt(pos, s);
    return fromCells(a);
  }
  const hex = x => (x >>> 0).toString(16).padStart(8, '0');
  function posKey(pos) { return hex(pos.ph) + hex(pos.pl) + hex(pos.oh) + hex(pos.ol); }
  function canonical(pos) {
    let bestKey = null, bestK = 0;
    for (let k = 0; k < 8; k++) {
      const key = posKey(transform(pos, k));
      if (bestKey === null || key < bestKey) { bestKey = key; bestK = k; }
    }
    return { key: bestKey, k: bestK };
  }
  function perft(pos, depth, passed) {
    if (depth === 0) return 1;
    const moves = legalMoves(pos);
    if (!moves.length) return passed ? 1 : perft(passPos(pos), depth - 1, true);
    let n = 0;
    for (const m of moves) n += perft(play(pos, m), depth - 1, false);
    return n;
  }

  // ------------------------------------------------------------------ book
  // book: { canonicalKey: [[canonicalSquare, valueInDiscs], ...] }
  let BOOK = null;
  function setBook(b) { BOOK = b; }
  function bookMoves(pos) {
    if (!BOOK) return null;
    const c = canonical(pos);
    const e = BOOK[c.key];
    if (!e) return null;
    return e.map(([sq, v]) => ({ sq: SYMINV[c.k][sq], score: v }));
  }

  // ------------------------------------------------------------ root search
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // PVS over the root moves. `order` (array of squares) is re-sorted best first.
  // fn(child, alpha, beta) must return the child's value from the child's mover's view.
  function rootPVS(pos, order, lo, hi, fn, onBest) {
    let alpha = lo, best = -32000, bestSq = order[0];
    for (let i = 0; i < order.length; i++) {
      const c = play(pos, order[i]);
      let v;
      if (i === 0) v = -fn(c, -hi, -alpha);
      else {
        v = -fn(c, -alpha - 1, -alpha);
        if (v > alpha && v < hi) v = -fn(c, -hi, -alpha);
      }
      if (v > best) {
        best = v; bestSq = order[i];
        if (onBest) onBest(bestSq, best);
        if (v > alpha) alpha = v;
        if (alpha >= hi) break;
      }
    }
    const k = order.indexOf(bestSq);
    order.splice(k, 1); order.unshift(bestSq);
    return { sq: bestSq, score: best };
  }
  // value of a position for its mover (handles a pass / game end at the root of the child)
  function midValue(c, depth, alpha, beta) { return pvs(c.pl, c.ph, c.ol, c.oh, depth, alpha, beta, 1, false); }
  function endValue(c, alpha, beta, empties) { return solve(c.pl, c.ph, c.ol, c.oh, alpha, beta, empties, 1, false); }

  /*
   * think(pos, opts) -> { sq, score (discs, mover's view), depth, type, nodes, ms, scores? }
   *   depth    : midgame search depth (iterative deepening up to it)
   *   timeMs   : soft time budget for the whole move (default: none)
   *   exact    : solve exactly when empties <= exact
   *   wld      : solve win/loss/draw when empties <= wld (and > exact)
   *   noise    : std-dev (discs) of gaussian noise added to every root move score
   *   book     : use the opening book
   *   bookSlack: play randomly among book moves within this many discs of the best
   *   rng      : () => [0,1)
   *   onInfo   : progress callback
   */
  function think(pos, opts) {
    const o = Object.assign({ depth: 6, exact: 0, wld: 0, noise: 0, book: false, bookSlack: 0, rng: Math.random }, opts);
    const t0 = Date.now();
    nodes = 0; aborted = false;
    deadline = Infinity;
    if (!ttDepth) initTT();
    const moves = legalMoves(pos);
    if (!moves.length) return null;
    const empties = countEmpties(pos);
    const done = (r) => { r.score += 0; r.nodes = nodes; r.ms = Date.now() - t0; return r; };

    if (o.book) {
      const bm = bookMoves(pos);
      if (bm && bm.length) {
        const top = Math.max.apply(null, bm.map(m => m.score));
        const cand = bm.filter(m => m.score >= top - o.bookSlack);
        const pick = cand[Math.floor(o.rng() * cand.length)];
        return done({ sq: pick.sq, score: pick.score, depth: 0, type: 'book' });
      }
    }

    // ---- weakened play: score every move independently, add noise, take the max
    if (o.noise > 0) {
      const useExact = empties <= o.exact;
      const scores = moves.map((sq) => {
        const c = play(pos, sq);
        const v = useExact ? -endValue(c, -64, 64, empties - 1)
          : -midValue(c, Math.min(o.depth, empties) - 1, -32000, 32000) / EVAL_UNIT;
        return { sq, score: v, noisy: v + gauss(o.rng) * o.noise };
      });
      let b = scores[0];
      for (const s of scores) if (s.noisy > b.noisy) b = s;
      return done({ sq: b.sq, score: b.score, depth: useExact ? empties : o.depth, type: useExact ? 'exact' : 'mid', scores });
    }

    const order = moves.slice();
    let result = null;
    const hardEnd = o.timeMs ? t0 + o.timeMs : Infinity;

    // ---- midgame iterative deepening (also orders the root moves for the solver)
    const wantSolve = empties <= o.exact ? 'exact' : empties <= o.wld ? 'wld' : null;
    let maxDepth = Math.min(o.depth, empties);
    if (wantSolve && !o.timeMs) maxDepth = Math.min(maxDepth, 6);
    // with a time budget the midgame search may use ~60% of it (all of it when no solve follows)
    deadline = o.timeMs ? (wantSolve ? t0 + o.timeMs * 0.25 : hardEnd) : Infinity;
    try {
      for (let d = 1; d <= maxDepth; d++) {
        let partial = null;
        try {
          const r = rootPVS(pos, order, -32000, 32000, (c, a, b) => midValue(c, d - 1, a, b),
            (sq, v) => { partial = { sq, score: v }; });
          result = { sq: r.sq, score: r.score / EVAL_UNIT, depth: d, type: 'mid' };
        } catch (e) {
          if (e !== ABORT) throw e;
          // a deeper iteration that at least finished its first move is still trustworthy
          if (partial) result = { sq: partial.sq, score: partial.score / EVAL_UNIT, depth: d, type: 'mid' };
          throw e;
        }
        if (o.onInfo) o.onInfo(Object.assign({ nodes, ms: Date.now() - t0 }, result));
        if (moves.length === 1 && !wantSolve) break;
        // not enough time left for another iteration
        if (o.timeMs && !wantSolve && Date.now() - t0 > o.timeMs * 0.45) break;
      }
    } catch (e) { if (e !== ABORT) throw e; }

    // ---- endgame
    if (wantSolve) {
      aborted = false;
      deadline = hardEnd;
      try {
        let partial = null;
        const lo = wantSolve === 'exact' ? -64 : -1, hi = wantSolve === 'exact' ? 64 : 1;
        const r = rootPVS(pos, order, lo, hi, (c, a, b) => endValue(c, a, b, empties - 1),
          (sq, v) => { partial = { sq, score: v }; });
        result = { sq: r.sq, score: r.score, depth: empties, type: wantSolve };
      } catch (e) {
        if (e !== ABORT) throw e;
      }
    }
    if (!result) result = { sq: order[0], score: 0, depth: 0, type: 'mid' };
    return done(result);
  }

  // exact value of a position (discs, mover's view) – used by tools and tests
  function solveExact(pos, alpha, beta) {
    if (!ttDepth) initTT();
    deadline = Infinity;
    return solve(pos.pl, pos.ph, pos.ol, pos.oh, alpha === undefined ? -64 : alpha, beta === undefined ? 64 : beta, countEmpties(pos), 0, false);
  }
  function searchValue(pos, depth) {
    if (!ttDepth) initTT();
    deadline = Infinity;
    return pvs(pos.pl, pos.ph, pos.ol, pos.oh, depth, -32000, 32000, 0, false) / EVAL_UNIT;
  }

  // ---------------------------------------------------------------- levels
  // Calibrated with tools/calibrate.js so that the Elo gap between neighbours is
  // roughly constant (see README).  noise = std-dev in discs of the evaluation blur.
  const LEVELS = [
    { name: '1', depth: 1, noise: 30, exact: 0 },
    { name: '2', depth: 1, noise: 12, exact: 0 },
    { name: '3', depth: 1, noise: 6.5, exact: 0 },
    { name: '4', depth: 1, noise: 3.5, exact: 2 },
    { name: '5', depth: 2, noise: 3.5, exact: 4 },
    { name: '6', depth: 2, noise: 1, exact: 6 },
    { name: '7', depth: 4, noise: 1.3, exact: 8 },
    { name: '8', depth: 5, noise: 0, exact: 10, wld: 12, book: true, bookSlack: 2 },
    { name: '9', depth: 8, noise: 0, exact: 14, wld: 16, book: true, bookSlack: 1 },
    { name: '10', depth: 30, noise: 0, exact: 18, wld: 20, book: true, bookSlack: 0.5, timeMs: 2500 },
  ];

  // weights: Int8Array stored gzip + base64
  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = atob(b64), a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }

  return {
    NSTAGE, STAGE_SIZE, NF, MOB_OFF, PATTERNS, features, EVAL_UNIT, LEVELS, SYM, SYMINV,
    popcnt, getMovesRaw: (pl, ph, ol, oh) => { getMoves(pl, ph, ol, oh); return [ML, MH]; },
    initialPosition, legalMoves, flipsOf, play, passPos, countEmpties, discCounts, hasMoves, isGameOver,
    cellAt, fromCells, transform, canonical, posKey, perft,
    featureIndices, canonTable, stageOf, evaluate: (p) => evaluate(p.pl, p.ph, p.ol, p.oh),
    evalBreakdown: (p) => evalBreakdown(p.pl, p.ph, p.ol, p.oh),
    heuristicEval: (p) => heuristicEval(p.pl, p.ph, p.ol, p.oh),
    finalScore: (p) => finalScore(p.pl, p.ph, p.ol, p.oh),
    setWeights, hasWeights: () => W !== null, setBook, bookMoves, initTT, clearTT,
    think, solveExact, searchValue, b64ToBytes,
    setSolveEvalOrder: (n) => { SOLVE_EVAL_ORDER = n; }, setOrdMob: (n) => { ORD_MOB = n; },
    getNodes: () => nodes,
  };
});
