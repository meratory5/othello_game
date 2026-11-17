// Opening book builder.
//   node tools/build_book.js --budget 4 --plies 14 --dexp 8 --dleaf 12 --workers 10 --max 12000
// 1. Expansion: starting from the initial position, every move is scored with a depth-`dexp`
//    search.  A line stays in the book while the accumulated error of both sides (sum of
//    "best score - played score") is within `budget` discs.
// 2. Leaves are searched to depth `dleaf`, and values are backed up by negamax.
// Book entry: canonicalKey -> [[canonicalSquare, value for the mover in discs], ...]
const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { makeEngine, args } = require('./common');

if (!isMainThread) {
  const E = makeEngine();
  E.initTT(20);
  parentPort.on('message', (job) => {
    const pos = job.pos;
    if (job.mode === 'moves') {
      const out = [];
      for (const sq of E.legalMoves(pos)) {
        let c = E.play(pos, sq), sign = -1;
        if (!E.hasMoves(c)) { c = E.passPos(c); sign = 1; }
        out.push([sq, sign * E.searchValue(c, job.depth - 1)]);
      }
      parentPort.postMessage({ id: job.id, moves: out });
    } else {
      parentPort.postMessage({ id: job.id, value: E.searchValue(pos, job.depth) });
    }
  });
} else {
  const a = args();
  const budget = +(a.budget || 4), maxPly = +(a.plies || 14), dexp = +(a.dexp || 8), dleaf = +(a.dleaf || 12);
  const nWorkers = +(a.workers || 8), maxNodes = +(a.max || 12000);
  const E = makeEngine({ weights: null });

  // ---- tiny job pool
  const workers = Array.from({ length: nWorkers }, () => new Worker(__filename));
  const idle = workers.slice(), queue = [], waiting = new Map();
  let nextId = 0;
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop(), j = queue.shift();
      w.postMessage(j.job);
      waiting.set(j.job.id, { w, resolve: j.resolve });
    }
  }
  for (const w of workers) w.on('message', (m) => { const x = waiting.get(m.id); waiting.delete(m.id); idle.push(x.w); x.resolve(m); pump(); });
  const run = (job) => new Promise((resolve) => { job.id = nextId++; queue.push({ job, resolve }); pump(); });

  (async () => {
    const t0 = Date.now();
    const nodes = new Map();       // key -> { pos (canonical), loss, ply, moves: [[sq, childKey|null, shallow]] }
    const canonPos = (pos) => { const c = E.canonical(pos); return { key: c.key, pos: E.transform(pos, c.k) }; };
    let frontier = [Object.assign(canonPos(E.initialPosition()), { loss: 0 })];
    nodes.set(frontier[0].key, { pos: frontier[0].pos, loss: 0, ply: 0, moves: null });
    for (let ply = 0; ply < maxPly && frontier.length; ply++) {
      const res = await Promise.all(frontier.map(f => run({ mode: 'moves', pos: f.pos, depth: dexp })));
      const next = [];
      frontier.forEach((f, i) => {
        const node = nodes.get(f.key);
        const mv = res[i].moves;
        if (!mv.length) return;
        const best = Math.max(...mv.map(m => m[1]));
        node.moves = [];
        for (const [sq, v] of mv) {
          const loss = node.loss + (best - v);
          if (loss > budget) continue;
          let c = E.play(f.pos, sq), passed = false;
          if (!E.hasMoves(c)) { c = E.passPos(c); passed = true; if (!E.hasMoves(c)) continue; }
          const cc = canonPos(c);
          node.moves.push({ sq, key: cc.key, passed, shallow: v });
          const ex = nodes.get(cc.key);
          if (!ex) { nodes.set(cc.key, { pos: cc.pos, loss, ply: ply + 1, moves: null }); next.push({ key: cc.key, pos: cc.pos, loss }); }
          else if (loss < ex.loss) ex.loss = loss;
        }
      });
      next.sort((x, y) => x.loss - y.loss);
      const room = Math.max(0, maxNodes - nodes.size + next.length);
      frontier = next.slice(0, room);                      // the rest stay as leaves
      console.log(`ply ${ply + 1}: ${nodes.size} nodes, frontier ${frontier.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    // ---- leaf values
    const leaves = [...nodes.entries()].filter(([, n]) => !n.moves || !n.moves.length);
    console.log(`${leaves.length} leaves, searching depth ${dleaf}`);
    let doneN = 0;
    const lv = await Promise.all(leaves.map(([, n]) => run({ mode: 'value', pos: n.pos, depth: dleaf }).then(r => {
      if (++doneN % 500 === 0) console.log(`  ${doneN}/${leaves.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return r.value;
    })));
    const value = new Map();
    leaves.forEach(([k], i) => value.set(k, lv[i]));
    // ---- negamax back-up (deepest plies first; a node only points to deeper or equal-ply nodes,
    //      cycles are impossible because disc counts strictly increase)
    const order = [...nodes.entries()].filter(([, n]) => n.moves && n.moves.length)
      .sort((x, y) => E.countEmpties(x[1].pos) - E.countEmpties(y[1].pos));
    const book = {};
    for (const [k, n] of order) {
      const list = n.moves.map(m => [m.sq, (m.passed ? 1 : -1) * value.get(m.key)]);
      const best = Math.max(...list.map(m => m[1]));
      value.set(k, best);
      book[k] = list.sort((x, y) => y[1] - x[1]).map(([sq, v]) => [sq, Math.round(v * 10) / 10]);
    }
    fs.writeFileSync(path.join(__dirname, '../js/book.js'),
      '// Opening book (canonical position -> [[square, value], ...]) - generated by tools/build_book.js\n' +
      '(function (r) { var d = ' + JSON.stringify(book) + '; if (typeof module === "object" && module.exports) module.exports = d; else r.OTHELLO_BOOK = d; })(typeof self !== "undefined" ? self : this);\n');
    console.log(`book: ${Object.keys(book).length} positions, root value ${value.get(frontier.length ? [...nodes.keys()][0] : [...nodes.keys()][0]).toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const w of workers) w.terminate();
  })();
}
