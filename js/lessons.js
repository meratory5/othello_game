/* lessons.html: static figures and the "next move" problems. */
(function () {
  'use strict';
  const E = OthelloEngineFactory();
  const X = OthelloExplainFactory(E);
  const DATA = typeof OTHELLO_LESSON_DATA !== 'undefined' ? OTHELLO_LESSON_DATA : {};
  const SQ = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
  const sqOf = (n) => (n.charCodeAt(1) - 49) * 8 + (n.charCodeAt(0) - 97);

  // ---- static figures
  const row = (r, str) => { const o = {}; [...str].forEach((ch, c) => { if (ch !== '.') o[r * 8 + c] = ch; }); return o; };
  const FIGS = {
    names: { labels: (() => {
      const l = {};
      ['a1', 'h1', 'a8', 'h8'].forEach(n => { l[sqOf(n)] = '隅'; });
      ['b1', 'g1', 'a2', 'h2', 'a7', 'h7', 'b8', 'g8'].forEach(n => { l[sqOf(n)] = 'C'; });
      ['b2', 'g2', 'b7', 'g7'].forEach(n => { l[sqOf(n)] = 'X'; });
      ['c1', 'f1', 'a3', 'h3', 'a6', 'h6', 'c8', 'f8'].forEach(n => { l[sqOf(n)] = 'A'; });
      ['d1', 'e1', 'a4', 'a5', 'h4', 'h5', 'd8', 'e8'].forEach(n => { l[sqOf(n)] = 'B'; });
      return l;
    })(), hl: ['c3', 'd3', 'e3', 'f3', 'c4', 'f4', 'c5', 'f5', 'c6', 'd6', 'e6', 'f6', 'd4', 'e4', 'd5', 'e5'].map(sqOf) },
    wing: { discs: row(0, '.bbbbb..'), hl: [6] },
    yama: { discs: row(0, '.bbbbbb.') },
    block: { discs: row(0, '..bbbb..') },
  };
  document.querySelectorAll('.mini[data-fig]').forEach((el) => {
    const f = FIGS[el.dataset.fig];
    for (let s = 0; s < 64; s++) {
      const c = document.createElement('div');
      c.className = 'c' + (f.hl && f.hl.includes(s) ? ' hl' : '');
      if (f.discs && f.discs[s]) c.innerHTML = '<span class="d ' + f.discs[s] + '"></span>';
      else if (f.labels && f.labels[s]) c.textContent = f.labels[s];
      el.appendChild(c);
    }
  });

  // ---- problems
  function posOf(q) {
    const arr = [...q.cells].map(ch => ch === '0' ? 0 : (ch === '1') === q.black ? 1 : 2);
    return E.fromCells(arr);
  }
  const tagHtml = (tags, n) => tags.length ? '<ul>' + tags.slice(0, n).map(t => '<li class="' + (t.good ? 'good' : 'bad') + '">' + t.text + '</li>').join('') + '</ul>'
    : '<ul><li class="good">目立つ特徴はありませんが、読むと最も得になる手です。</li></ul>';

  document.querySelectorAll('.quiz[data-quiz]').forEach((box) => {
    const list = DATA[box.dataset.quiz] || [];
    if (!list.length) { box.innerHTML = '<p class="sub">この項目の問題はまだありません。</p>'; return; }
    let k = 0;
    const board = document.createElement('div'); board.className = 'mini';
    const side = document.createElement('div');
    box.append(board, side);
    const cells = [];
    for (let s = 0; s < 64; s++) {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'c';
      c.setAttribute('aria-label', SQ(s));
      c.addEventListener('click', () => answer(s));
      board.appendChild(c); cells.push(c);
    }
    let q, pos, done;
    function show() {
      q = list[k]; pos = posOf(q); done = false;
      const legal = q.moves.map(m => m[0]);
      for (let s = 0; s < 64; s++) {
        const ch = q.cells[s];
        cells[s].className = 'c' + (legal.includes(s) ? ' legal' : '');
        cells[s].innerHTML = ch === '0' ? '' : '<span class="d ' + (ch === '1' ? 'b' : 'w') + '"></span>';
        cells[s].disabled = !legal.includes(s);
      }
      const empties = [...q.cells].filter(c => c === '0').length;
      side.innerHTML = '<h4>問題 ' + (k + 1) + ' / ' + list.length + '</h4><p class="q"><b>' + (q.black ? '黒' : '白') + '番</b>です（残り ' + empties +
        ' マス）。最善の一手はどこでしょう。金色の点が打てる所です。</p><div class="fb"></div>';
    }
    function answer(s) {
      if (done) return;
      const m = q.moves.find(x => x[0] === s);
      if (!m) return;
      done = true;
      const best = q.moves[0], loss = best[1] - m[1];
      const g = X.grade(loss, q.exact);
      const ok = g.id === 'best' || (g.id === 'good' && !q.exact);
      cells[best[0]].classList.add('best');
      if (!ok) cells[s].classList.add('wrong');
      for (const [sq, v] of q.moves) {
        cells[sq].classList.add('scored');
        cells[sq].innerHTML = '<span class="sc">' + (v > 0 ? '+' : '') + (q.exact ? v.toFixed(0) : v.toFixed(1)) + '</span>';
        cells[sq].disabled = true;
      }
      let html = ok ? '<b class="good">正解！</b> ' + SQ(s) + ' は' + (s === best[0] ? '最善手です。' : '最善手 ' + SQ(best[0]) + ' とほぼ同じ価値の手です。')
        : '<b class="' + (g.id === 'ok' ? 'mid' : 'bad') + '">' + g.label + '</b> ' + SQ(s) + ' は最善手 <b class="good">' + SQ(best[0]) + '</b> より' + (q.exact ? '' : '約 ') + loss.toFixed(q.exact ? 0 : 1) + ' 石損です。';
      html += '<p class="sub">最善手 ' + SQ(best[0]) + ' の特徴</p>' + tagHtml(X.describe(pos, best[0]).tags, 3);
      if (s !== best[0]) html += '<p class="sub">あなたの手 ' + SQ(s) + ' の特徴</p>' + tagHtml(X.describe(pos, s).tags, 3);
      html += '<p class="sub">盤上の数字は、その手を打った場合の' + (q.exact ? '最終石差（双方最善）' : '形勢（AIの6手読み、石差の予想）') + 'です。</p>';
      html += '<button type="button" class="btn" data-a="next">次の問題</button><button type="button" class="btn" data-a="retry">もう一度</button>';
      const fb = side.querySelector('.fb');
      fb.innerHTML = html;
      fb.querySelector('[data-a=next]').addEventListener('click', () => { k = (k + 1) % list.length; show(); });
      fb.querySelector('[data-a=retry]').addEventListener('click', show);
    }
    show();
  });
})();
