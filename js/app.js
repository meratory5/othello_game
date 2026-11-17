/* UI controller: game flow, rendering, talking to the AI worker. */
(function () {
  'use strict';
  const E = OthelloEngineFactory();          // rules only on the main thread
  const $ = (id) => document.getElementById(id);
  const SQ = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);

  const LEVEL_DESC = [
    '入門 — ほとんど気まぐれに打ちます。ルールを覚えたての方に。',
    '初級 — ときどき良い手を選びますが、大きなミスも多め。',
    '初級+ — 角は取りにきますが、読みは浅く隙だらけ。',
    '中級− — 1手先の形の良し悪しがだいたい分かります。',
    '中級 — 2手読み。うっかりミスがまだ残ります。',
    '中級+ — 2手読みが安定。終盤6手は読み切り。',
    '上級− — 4手読み＋終盤8手読み切り。まれに緩い手も。',
    '上級 — 5手読み＋定石＋終盤10手読み切り。othello.org の上級と同程度。',
    '有段 — 8手読み＋定石＋終盤14手読み切り。',
    '最強 — 2.5秒いっぱい深く読み、定石と終盤18手完全読み（20手で勝敗読み）。',
  ];
  const X = OthelloExplainFactory(E);
  const COACH_OPTS = { depth: 12, timeMs: 1000, exact: 14, wld: 14, book: false };
  const HINT_OPTS = { depth: 14, timeMs: 1500, exact: 16, wld: 18, book: true, bookSlack: 0 };
  const MIN_THINK_MS = 450;

  const ai = new OthelloAIClient({
    weights: typeof OTHELLO_WEIGHTS !== 'undefined' ? OTHELLO_WEIGHTS : null,
    book: typeof OTHELLO_BOOK !== 'undefined' ? OTHELLO_BOOK : null,
  });
  let coachAI = null, coachSeq = 0;      // second worker: reviews the player's moves while the AI thinks
  const OPENINGS = typeof OTHELLO_OPENINGS !== 'undefined' ? OTHELLO_OPENINGS : {};

  // ---- state
  let hist = [{ pos: E.initialPosition(), black: true, move: null }];
  let playerBlack = true, level = 5;
  let running = false, thinking = false, over = false;
  let hintSq = -1, evalBlack = null, evalExact = false;
  let prevCells = null, toastTimer = 0;
  let viewIdx = null;                    // null = live position, otherwise index into hist (replay)
  let playTimer = 0;
  const cur = () => hist[hist.length - 1];
  const shownIdx = () => (viewIdx === null ? hist.length - 1 : viewIdx);
  const shown = () => hist[shownIdx()];

  // ---- board DOM
  const boardEl = $('board');
  const cells = [];
  for (let s = 0; s < 64; s++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cell'; b.setAttribute('role', 'gridcell');
    b.setAttribute('aria-label', SQ(s));
    if (s === 9 || s === 13 || s === 41 || s === 45) b.classList.add('star');
    b.addEventListener('click', () => onCell(s));
    boardEl.appendChild(b); cells.push(b);
  }

  function absCells(st) {           // 0 empty, 1 black, 2 white
    const a = new Uint8Array(64);
    for (let s = 0; s < 64; s++) { const c = E.cellAt(st.pos, s); a[s] = c === 0 ? 0 : (c === 1) === st.black ? 1 : 2; }
    return a;
  }

  function render() {
    const live = viewIdx === null;
    const st = shown(), a = absCells(st);
    const legal = running && !over && live ? E.legalMoves(st.pos) : [];
    document.body.classList.toggle('reviewing', !live);
    const mine = st.black === playerBlack;
    const showMoves = $('showMoves').checked;
    let nb = 0, nw = 0;
    for (let s = 0; s < 64; s++) {
      const el = cells[s], v = a[s];
      if (v === 1) nb++; else if (v === 2) nw++;
      const was = prevCells ? prevCells[s] : v;
      let disc = el.firstChild;
      if (v === 0) { if (disc) el.removeChild(disc); }
      else {
        if (!disc) { disc = document.createElement('span'); el.appendChild(disc); }
        const cls = 'disc ' + (v === 1 ? 'black' : 'white') + (was === 0 ? ' placed' : was !== v ? ' flipped' : '');
        if (disc.className !== cls) { disc.className = cls; if (was !== v) { void disc.offsetWidth; } }
      }
      const isLegal = legal.includes(s);
      el.classList.toggle('legal', isLegal && mine && !thinking);
      el.classList.toggle('cpu-legal', isLegal && !mine && showMoves);
      if (!showMoves) el.classList.toggle('legal', false);
      el.dataset.legal = isLegal && mine && !thinking ? '1' : '';
      el.classList.toggle('last', st.move === s);
      el.classList.toggle('hint', hintSq === s);
      el.setAttribute('aria-label', SQ(s) + (v === 1 ? ' 黒' : v === 2 ? ' 白' : isLegal && mine ? ' 置けます' : ''));
    }
    // a pass entry has no move of its own: mark the move before it
    if (st.move === -1 && shownIdx() > 0) { const p = hist[shownIdx() - 1].move; if (p >= 0) cells[p].classList.add('last'); }
    prevCells = a;
    $('countBlack').textContent = nb; $('countWhite').textContent = nw;
    $('whoBlack').textContent = running || over ? (playerBlack ? '黒・あなた' : '黒・AI') : '黒';
    $('whoWhite').textContent = running || over ? (playerBlack ? '白・AI' : '白・あなた') : '白';
    $('sideBlack').classList.toggle('active', running && !over && st.black);
    $('sideWhite').classList.toggle('active', running && !over && !st.black);
    if (!live) $('turn').textContent = '棋譜を再生中（' + moveNo(shownIdx()) + '手目）';
    else if (running && !over) $('turn').textContent = thinking ? 'AIが考えています…' : mine ? 'あなたの番です' : 'AIの番です';
    else if (loaded) $('turn').textContent = '読み込んだ棋譜（' + moveNo(hist.length - 1) + '手）';
    $('undo').disabled = !(live && running && !thinking && hist.some((h, i) => i < hist.length - 1 && h.black === playerBlack));
    $('hint').disabled = !(live && running && !over && !thinking && mine);
    renderRecord(); renderMeter(); renderEval();
  }

  const moveNo = (idx) => { let n = 0; for (let i = 1; i <= idx; i++) if (hist[i].move >= 0) n++; return n; };
  function renderRecord() {
    const parts = [];
    let name = '';
    const at = shownIdx();
    for (let i = 1; i < hist.length; i++) {
      const h = hist[i];
      if (h.move >= 0) {
        const t = SQ(h.move), blk = hist[i - 1].black;
        parts.push('<' + (blk ? 'b' : 'span') + ' data-i="' + i + '"' + (i === at ? ' class="now"' : '') + '>' + (blk ? t.toUpperCase() : t) + '</' + (blk ? 'b' : 'span') + '>');
      }
      const n = OPENINGS[E.canonical(h.pos).key];
      if (n && i <= 20 && i <= at) name = n;
    }
    $('kifu').innerHTML = parts.length ? parts.join(' ') : '—';
    $('opening').textContent = name;
    $('rvPos').textContent = moveNo(at) + ' / ' + moveNo(hist.length - 1);
    const many = hist.length > 1;
    $('rvFirst').disabled = $('rvPrev').disabled = !many || at === 0;
    $('rvNext').disabled = $('rvLast').disabled = !many || at === hist.length - 1;
    $('rvPlay').disabled = !many;
    $('kifuCopy').disabled = !many;
  }
  function kifuText() {
    let t = '';
    for (let i = 1; i < hist.length; i++) if (hist[i].move >= 0) t += hist[i - 1].black ? SQ(hist[i].move).toUpperCase() : SQ(hist[i].move);
    return t;
  }
  // ---- replay
  function stopPlay() { clearInterval(playTimer); playTimer = 0; $('rvPlay').textContent = '再生'; }
  function goTo(i) {
    if (thinking && viewIdx === null && i < hist.length - 1) { /* looking back while the AI thinks is fine */ }
    i = Math.max(0, Math.min(hist.length - 1, i));
    viewIdx = i === hist.length - 1 ? null : i;
    hintSq = -1;
    render();
    // describe the move that led to the shown position
    if (coachOn() && viewIdx !== null) {
      const k = shownIdx(), h = hist[k];
      if (k > 0 && h.move >= 0) {
        const d = X.describe(hist[k - 1].pos, h.move);
        $('coachYou').innerHTML = '';
        $('coachAI').innerHTML = '<p class="coach-head"><b>' + moveNo(k) + '手目 ' + (hist[k - 1].black ? '黒' : '白') + ' ' + SQ(h.move) + '</b> の特徴</p>' + tagList(d.tags, 4);
      }
    }
  }
  function togglePlay() {
    if (playTimer) return stopPlay();
    if (shownIdx() >= hist.length - 1) goTo(0);
    $('rvPlay').textContent = '停止';
    playTimer = setInterval(() => { if (shownIdx() >= hist.length - 1) stopPlay(); else goTo(shownIdx() + 1); }, 900);
  }
  let loaded = false;
  function loadKifu(text) {
    const mv = (text || '').match(/[a-hA-H][1-8]/g);
    if (!mv || !mv.length) { toast('棋譜が読み取れません（例: F5d6C3d3C4）', 2200); return false; }
    const h = [{ pos: E.initialPosition(), black: true, move: null }];
    for (const m of mv) {
      let st = h[h.length - 1];
      if (!E.hasMoves(st.pos)) { h.push({ pos: E.passPos(st.pos), black: !st.black, move: -1 }); st = h[h.length - 1]; }
      const sq = (m.charCodeAt(1) - 49) * 8 + (m.toLowerCase().charCodeAt(0) - 97);
      if (!E.legalMoves(st.pos).includes(sq)) { toast((h.length) + '手目 ' + m + ' が打てない手です', 2500); return false; }
      h.push({ pos: E.play(st.pos, sq), black: !st.black, move: sq });
    }
    ai.cancel(); clearCoach(); stopPlay();
    hist = h; running = false; thinking = false; over = false; loaded = true; evalBlack = null; prevCells = null;
    $('result').hidden = true; setRunningUI(false);
    $('aiLine').textContent = '棋譜を読み込みました。◀ ▶ や「再生」で見返せます。';
    goTo(0);
    return true;
  }

  function renderMeter() {
    $('meter').classList.toggle('off', !$('showEval').checked);
    if (evalBlack === null) { $('meterFill').style.width = '50%'; $('meterText').textContent = '形勢 —'; return; }
    const v = Math.max(-32, Math.min(32, evalBlack));
    $('meterFill').style.width = (50 + v / 64 * 100) + '%';
    const mag = evalExact ? Math.abs(evalBlack).toFixed(0) : Math.abs(evalBlack).toFixed(1);
    const who = evalBlack > 0.05 ? '黒 +' + mag : evalBlack < -0.05 ? '白 +' + mag : '互角';
    $('meterText').textContent = (evalExact ? '読み切り ' : '形勢 ') + who;
  }

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 1300);
  }

  function describe(r) {
    if (!r) return '';
    const sec = (r.ms / 1000).toFixed(r.ms < 1000 ? 2 : 1) + '秒';
    if (r.type === 'book') return '定石から選択 · ' + sec;
    const kind = r.type === 'exact' ? '終盤完全読み（残り' + r.depth + '手）' : r.type === 'wld' ? '勝敗読み切り（残り' + r.depth + '手）' : '深さ' + r.depth;
    return kind + ' · ' + r.nodes.toLocaleString() + '局面 · ' + sec;
  }
  function setEval(r, moverBlack) {
    if (!r || r.type === 'wld') { if (r) { evalBlack = (moverBlack ? 1 : -1) * Math.sign(r.score) * 2; evalExact = false; } return; }
    evalBlack = (moverBlack ? 1 : -1) * r.score; evalExact = r.type === 'exact';
  }

  // ---- evaluation breakdown (static evaluation of the current position, shown from Black's side)
  const EVAL_GROUPS = [
    { name: '辺と隅まわり', hint: '辺8マス＋X 2マス ×4', pats: [0] },
    { name: '隅の3×3', hint: '×4', pats: [9] },
    { name: '隅の2×5', hint: '×8', pats: [10] },
    { name: '内側の縦横の列', hint: '2〜4列目 ×12', pats: [1, 2, 3] },
    { name: '斜めの列', hint: '長さ4〜8 ×18', pats: [4, 5, 6, 7, 8] },
  ];
  let evalSel = -1;
  function renderEval() {
    const box = $('evalBox');
    cells.forEach(c => c.classList.remove('pat'));
    if (!box.open || !E.hasWeights()) return;
    const st = shown(), sign = st.black ? 1 : -1;
    const bd = E.evalBreakdown(st.pos);
    const rows = EVAL_GROUPS.map(g => {
      const fs = bd.feats.filter(f => g.pats.includes(f.pat));
      const top = fs.slice().sort((x, y) => Math.abs(y.v) - Math.abs(x.v))[0];
      return { name: g.name, hint: g.hint, v: sign * fs.reduce((a, f) => a + f.v, 0), top };
    });
    const mob = bd.mobility;
    rows.push({ name: '打てる箇所の数', hint: (st.black ? '黒' : '白') + mob.own + ' 対 ' + (st.black ? '白' : '黒') + mob.opp, v: sign * mob.v, top: null });
    const max = Math.max(4, ...rows.map(r => Math.abs(r.v)));
    const fmt = (v) => (v > 0 ? '黒+' : v < 0 ? '白+' : '') + Math.abs(v).toFixed(1);
    $('evalBody').innerHTML =
      '<p class="eval-formula">評価値 ＝ 盤上の46個のパターンそれぞれの「形の点数」の合計 ＋ 打てる箇所数の点数（黒から見た石差の予想）</p>' +
      '<div class="eval-rows">' + rows.map((r, i) =>
        '<button type="button" class="eval-row' + (i === evalSel ? ' sel' : '') + '" data-i="' + i + '" title="' + r.hint + '"><span>' + r.name + '</span>' +
        '<span class="bar"><i class="' + (r.v >= 0 ? 'pos' : 'neg') + '" style="width:' + (Math.abs(r.v) / max * 50).toFixed(1) + '%"></i></span>' +
        '<span class="num">' + fmt(r.v) + '</span></button>').join('') + '</div>' +
      '<p class="eval-total"><span>合計（読みなしの静的評価・第' + (bd.stage + 1) + '段階の表）</span><b>' + fmt(sign * bd.total) + '</b></p>' +
      '<p class="eval-note">行を押すと、その種類で最も点数の動いている形を盤上に示します。実際の着手は、この評価を数手〜十数手先の局面に当てはめて読んだ結果で決まります。<a href="about.html">しくみの解説</a></p>';
    if (evalSel >= 0 && rows[evalSel] && rows[evalSel].top) for (const s of rows[evalSel].top.sq) cells[s].classList.add('pat');
    $('evalBody').querySelectorAll('.eval-row').forEach(b => b.addEventListener('click', () => { evalSel = evalSel === +b.dataset.i ? -1 : +b.dataset.i; renderEval(); }));
  }
  $('evalBox').addEventListener('toggle', () => renderEval());
  // the main thread needs its own copy of the weights for the breakdown
  if (typeof OTHELLO_WEIGHTS !== 'undefined' && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([E.b64ToBytes(OTHELLO_WEIGHTS)]).stream().pipeThrough(new DecompressionStream('gzip'));
    new Response(stream).arrayBuffer().then((b) => { E.setWeights(new Int8Array(b)); renderEval(); })
      .catch(() => { $('evalBody').innerHTML = '<p class="coach-empty">このブラウザでは内訳を表示できません。</p>'; });
  }

  // ---- explanations
  const coachOn = () => $('showCoach').checked;
  function tagList(tags, max) {
    if (!tags.length) return '<p class="coach-empty">特に目立つ特徴のない、普通の手です。</p>';
    return '<ul class="tags">' + tags.slice(0, max).map(t =>
      '<li class="' + (t.good ? 'good' : 'bad') + '">' + t.text + '<a href="lessons.html#' + t.lesson + '">講座</a></li>').join('') + '</ul>';
  }
  function explainAI(st, r) {
    if (!coachOn()) return;
    const d = X.describe(st.pos, r.sq);
    const how = r.type === 'book' ? '定石どおりの手です。'
      : r.type === 'exact' ? '終局まで読み切って選んだ手です（最善で ' + (r.score > 0 ? '+' : '') + r.score + ' 石）。'
      : r.type === 'wld' ? '勝敗を読み切って選んだ手です。' : '';
    $('coachAI').innerHTML = '<p class="coach-head"><b>AIの手 ' + SQ(r.sq) + '</b> の特徴</p>' +
      (how ? '<p class="coach-sub">' + how + '</p>' : '') + tagList(d.tags, 3);
  }
  // value (discs, for the player who just moved) of the position after the player's move
  function valueAfter(child) {
    if (!E.hasMoves(child)) {
      const p = E.passPos(child);
      if (!E.hasMoves(p)) return Promise.resolve({ v: -E.finalScore(child), exact: true });
      return coachAI.think(p, COACH_OPTS).then(r => ({ v: r.score, exact: r.type === 'exact' }));
    }
    return coachAI.think(child, COACH_OPTS).then(r => ({ v: -r.score, exact: r.type === 'exact' }));
  }
  function reviewPlayer(st, sq) {
    if (!coachOn()) return;
    if (!coachAI) coachAI = new OthelloAIClient(ai.data);
    coachAI.cancel();
    const seq = ++coachSeq;
    const mine = X.describe(st.pos, sq);
    $('coachYou').innerHTML = '<p class="coach-head"><b>あなたの手 ' + SQ(sq) + '</b> を検討中…</p>';
    coachAI.think(st.pos, COACH_OPTS).then((best) => {
      if (seq !== coachSeq) return null;
      if (best.sq === sq) return { best, played: { v: best.score, exact: best.type === 'exact' } };
      return valueAfter(E.play(st.pos, sq)).then(played => ({ best, played }));
    }).then((res) => {
      if (!res || seq !== coachSeq) return;
      const exact = res.played.exact && res.best.type === 'exact';
      const loss = Math.max(0, res.best.score - res.played.v);
      const g = X.grade(res.best.sq === sq ? 0 : loss, exact);
      let html = '<p class="coach-head"><b>あなたの手 ' + SQ(sq) + '</b>：<b class="grade-' + g.id + '">' + g.label + '</b>';
      if (res.best.sq !== sq && g.id !== 'best') html += '（AIの最善は ' + SQ(res.best.sq) + '、' + (exact ? '' : '約 ') + loss.toFixed(exact ? 0 : 1) + ' 石の損）';
      else if (res.best.sq !== sq) html += '（AIの第一候補は ' + SQ(res.best.sq) + ' でしたが、ほぼ同じ価値です）';
      html += '</p>' + tagList(mine.tags, 3);
      if (res.best.sq !== sq && g.id !== 'best' && g.id !== 'good') {
        html += '<p class="coach-sub">最善手 ' + SQ(res.best.sq) + ' の特徴</p>' + tagList(X.describe(st.pos, res.best.sq).tags, 3);
      }
      $('coachYou').innerHTML = html;
    });
  }
  function clearCoach() {
    coachSeq++;
    if (coachAI) coachAI.cancel();
    $('coachYou').innerHTML = ''; $('coachAI').innerHTML = '';
  }

  // ---- game flow
  function pushMove(sq) {
    viewIdx = null;
    const st = cur();
    hist.push({ pos: E.play(st.pos, sq), black: !st.black, move: sq });
    hintSq = -1;
    settle();
  }
  function settle() {
    let st = cur();
    if (!E.hasMoves(st.pos)) {
      const p = E.passPos(st.pos);
      if (!E.hasMoves(p)) return finish();
      toast((st.black ? '黒' : '白') + 'は置けないのでパス');
      hist.push({ pos: p, black: !st.black, move: -1 });
      st = cur();
    }
    render();
    if (st.black !== playerBlack) cpuTurn();
  }
  function cpuTurn() {
    const st = cur(), t0 = Date.now(), moverBlack = st.black;
    thinking = true; render();
    ai.think(st.pos, E.LEVELS[level - 1], (info) => {
      $('aiLine').textContent = '読み中… 深さ' + info.depth + ' · ' + info.nodes.toLocaleString() + '局面';
    }).then((r) => {
      const wait = Math.max(0, MIN_THINK_MS - (Date.now() - t0));
      setTimeout(() => {
        if (!running || cur() !== st) return;
        thinking = false;
        $('aiLine').textContent = 'AI: ' + SQ(r.sq) + ' · ' + describe(r);
        setEval(r, moverBlack);
        explainAI(st, r);
        pushMove(r.sq);
      }, wait);
    });
  }
  function onCell(s) {
    const st = cur();
    if (!running || over || thinking || viewIdx !== null || st.black !== playerBlack) return;
    if (!E.legalMoves(st.pos).includes(s)) return;
    reviewPlayer(st, s);
    pushMove(s);
  }
  function finish() {
    over = true; running = false; thinking = false;
    render();
    const a = absCells(cur());
    let nb = 0, nw = 0; for (const v of a) { if (v === 1) nb++; else if (v === 2) nw++; }
    const me = playerBlack ? nb : nw, cpu = playerBlack ? nw : nb;
    $('resultTitle').textContent = me > cpu ? 'あなたの勝ち' : me < cpu ? 'AIの勝ち' : '引き分け';
    $('resultScore').textContent = '黒 ' + nb + ' — ' + nw + ' 白（強さ ' + level + '）';
    $('turn').textContent = '終局';
    evalBlack = nb - nw; evalExact = true; renderMeter();
    setTimeout(() => { if (over) $('result').hidden = false; }, 700);
    setRunningUI(false);
  }
  function setRunningUI(on) {
    $('settings').disabled = on;
    const b = $('start');
    b.textContent = on ? '中断' : '対局開始';
    b.classList.toggle('stop', on);
  }
  function start() {
    ai.cancel(); stopPlay(); viewIdx = null; loaded = false;
    playerBlack = document.querySelector('input[name=color]:checked').value === 'black';
    level = +$('level').value;
    hist = [{ pos: E.initialPosition(), black: true, move: null }];
    running = true; over = false; thinking = false; hintSq = -1; evalBlack = null; prevCells = null;
    clearCoach();
    $('result').hidden = true; $('aiLine').innerHTML = '&nbsp;';
    setRunningUI(true);
    settle();
  }
  function stop() {
    ai.cancel();
    running = false; thinking = false; over = false; hintSq = -1;
    setRunningUI(false);
    $('turn').textContent = '中断しました — 設定を選んで「対局開始」';
    render();
  }
  function undo() {
    if (!running || thinking || viewIdx !== null) return;
    hist.pop();
    while (hist.length > 1 && cur().black !== playerBlack) hist.pop();
    hintSq = -1; evalBlack = null; prevCells = null;
    clearCoach();
    $('aiLine').innerHTML = '&nbsp;';
    render();
    if (cur().black !== playerBlack) cpuTurn();
  }
  function hint() {
    const st = cur();
    if (!running || thinking || st.black !== playerBlack) return;
    $('hint').disabled = true;
    $('aiLine').textContent = 'ヒントを計算中…';
    ai.think(st.pos, HINT_OPTS).then((r) => {
      if (cur() !== st || !running) return;
      hintSq = r.sq;
      $('aiLine').textContent = 'ヒント: ' + SQ(r.sq) + ' · ' + describe(r);
      setEval(r, st.black);
      render();
    });
  }

  // ---- wiring
  $('start').addEventListener('click', () => (running ? stop() : start()));
  $('again').addEventListener('click', start);
  $('undo').addEventListener('click', undo);
  $('hint').addEventListener('click', hint);
  $('rvFirst').addEventListener('click', () => { stopPlay(); goTo(0); });
  $('rvPrev').addEventListener('click', () => { stopPlay(); goTo(shownIdx() - 1); });
  $('rvNext').addEventListener('click', () => { stopPlay(); goTo(shownIdx() + 1); });
  $('rvLast').addEventListener('click', () => { stopPlay(); goTo(hist.length - 1); });
  $('rvPlay').addEventListener('click', togglePlay);
  $('kifu').addEventListener('click', (e) => { const i = e.target && e.target.dataset && e.target.dataset.i; if (i) { stopPlay(); goTo(+i); } });
  $('kifuCopy').addEventListener('click', () => {
    const t = kifuText();
    const done = () => toast('棋譜をコピーしました');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => window.prompt('棋譜', t));
    else window.prompt('棋譜', t);
  });
  $('kifuLoad').addEventListener('click', () => {
    if (running && !window.confirm('対局中です。中断して棋譜を読み込みますか？')) return;
    const t = window.prompt('棋譜を貼り付けてください（例: F5d6C3d3C4…）');
    if (t) loadKifu(t);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio') return;
    if (e.target && e.target.type === 'range') return;
    if (e.key === 'ArrowLeft') { stopPlay(); goTo(shownIdx() - 1); }
    else if (e.key === 'ArrowRight') { stopPlay(); goTo(shownIdx() + 1); }
  });
  $('showMoves').addEventListener('change', render);
  $('showEval').addEventListener('change', render);
  $('showCoach').addEventListener('change', () => { $('coachBox').classList.toggle('off', !coachOn()); });
  const lv = $('level');
  function showLevel() { $('levelOut').textContent = lv.value; $('levelDesc').textContent = LEVEL_DESC[lv.value - 1]; }
  lv.addEventListener('input', showLevel);
  try { const saved = localStorage.getItem('othello2.level'); if (saved) lv.value = saved; } catch (e) { /* storage unavailable */ }
  lv.addEventListener('change', () => { try { localStorage.setItem('othello2.level', lv.value); } catch (e) { /* ignore */ } });
  showLevel();
  render();

  // ?kifu=F5d6... : open a game record for replay
  const kq = /[?&]kifu=([a-hA-H1-8]+)/.exec(location.search);
  if (kq) loadKifu(kq[1]);

  // ?demo[=level] : self-running game used for automated screenshots / smoke tests
  const demo = /[?&]demo(?:=(\d+))?/.exec(location.search);
  if (demo) {
    if (demo[1]) lv.value = demo[1];
    showLevel(); start();
    setInterval(() => {
      const st = cur();
      if (!running || thinking || st.black !== playerBlack) return;
      const m = E.legalMoves(st.pos);
      if (m.length) onCell(m[Math.floor(Math.random() * m.length)]);
    }, 2600);
  }
  window.addEventListener('error', (e) => { document.title = 'ERROR: ' + e.message; });
})();
