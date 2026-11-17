// Plays our engine against the COM of https://www.othello.org/play/ and shows the games live
// in the browser.  Games run one after another (no parallel requests).
//   node tools/watch_server.js --level 10 --com 2 --games 10 --port 8765
//   then open http://localhost:8765
// Finished games are appended to records/vs_othello_org.jsonl; the page links each record to
// the main app's replay (served under /app/).  --games 0 only serves the records.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEngine, args, sqName } = require('./common');
const a = args();
const level = +(a.level || 10), com = +(a.com === undefined ? 2 : a.com), games = +(a.games || 10), port = +(a.port || 8765);
const E = makeEngine({ book: path.join(__dirname, '../js/book.js') });
E.initTT(20);
const X = require('../js/explain.js')(E);
// every finished game is appended to records/vs_othello_org.jsonl
const ROOT = path.join(__dirname, '..');
const RECORDS = path.join(ROOT, 'records', 'vs_othello_org.jsonl');
function loadRecords() {
  if (!fs.existsSync(RECORDS)) return [];
  return fs.readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function saveRecord(r) {
  fs.mkdirSync(path.dirname(RECORDS), { recursive: true });
  fs.appendFileSync(RECORDS, JSON.stringify(r) + '\n');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const COM_NAME = ['初級', '中級', '上級'][com] || 'level ' + com;

const state = { level, comName: COM_NAME, total: games, game: 0, weBlack: true, cells: '', blackToMove: true, last: -1, record: [], our: null, comLast: '', status: '準備中', results: [], done: false, history: loadRecords() };
const clients = new Set();
function push() {
  const msg = 'data: ' + JSON.stringify(state) + '\n\n';
  for (const res of clients) res.write(msg);
}
function setBoard(pos, black) {
  let s = '';
  for (let i = 0; i < 64; i++) { const c = E.cellAt(pos, i); s += c === 0 ? '0' : (c === 1) === black ? '1' : '2'; }
  state.cells = s; state.blackToMove = black;
}

async function comMove(black) {
  const res = await fetch('https://www.othello.org/play/ajax/nextmove.cgi?', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body: `param=COM&turn=${black ? 1 : 2}&board=${state.cells}&level=${com}`,
  });
  const lines = (await res.text()).trim().split('\n');
  if (lines[0] !== 'MOVE') throw new Error('unexpected reply: ' + lines.join('|'));
  const p = +lines[2];
  return (p % 10) * 8 + Math.floor(p / 10);
}

async function run() {
  for (let g = 0; g < games; g++) {
    const weBlack = g % 2 === 0;
    let pos = E.initialPosition(), black = true;
    Object.assign(state, { game: g + 1, weBlack, last: -1, record: [], our: null, comLast: '' });
    setBoard(pos, black); state.status = '対局開始'; push();
    await sleep(1500);
    for (;;) {
      let moves = E.legalMoves(pos);
      if (!moves.length) { pos = E.passPos(pos); black = !black; moves = E.legalMoves(pos); if (!moves.length) break; state.record.push('pass'); }
      setBoard(pos, black);
      let sq;
      if (black === weBlack) {
        state.status = 'オセロ弐 が考えています…'; push();
        const t = Date.now();
        const r = E.think(pos, E.LEVELS[level - 1]);
        sq = r.sq;
        const kind = r.type === 'book' ? '定石ブック' : r.type === 'exact' ? `終盤完全読み（残り${r.depth}手）` : r.type === 'wld' ? `勝敗読み切り（残り${r.depth}手）` : `深さ${r.depth}の読み`;
        const sc = r.type === 'wld' ? (r.score > 0 ? '勝ち' : r.score < 0 ? '負け' : '引き分け') : (r.score > 0 ? '+' : '') + (+r.score).toFixed(r.type === 'exact' ? 0 : 1) + ' 石';
        state.our = { move: sqName(sq), kind, score: sc, nodes: r.nodes, ms: r.ms, n: state.record.length + 1,
          tags: X.describe(pos, sq).tags.slice(0, 3).map(t => ({ good: t.good, text: t.text })) };
        state.status = `オセロ弐 が ${sqName(sq)} に着手`;
        await sleep(Math.max(0, 700 - (Date.now() - t)));     // keep the pace watchable
      } else {
        state.status = `othello.org ${COM_NAME} が考えています…`; push();
        await sleep(1200);
        sq = await comMove(black);
        if (!moves.includes(sq)) throw new Error('COM sent illegal move ' + sq);
        state.comLast = sqName(sq); state.status = `othello.org ${COM_NAME} が ${sqName(sq)} に着手`;
      }
      state.record.push(black ? sqName(sq).toUpperCase() : sqName(sq));
      pos = E.play(pos, sq); black = !black; state.last = sq;
      setBoard(pos, black); push();
      await sleep(900);                                       // let the viewer see each move
    }
    const s = E.finalScore(pos) * (black === weBlack ? 1 : -1);
    state.results.push({ game: g + 1, weBlack, score: s, record: state.record.filter(m => m !== 'pass').join('') });
    const rec = { date: new Date().toISOString().slice(0, 16).replace('T', ' '), level, com: COM_NAME, weBlack, score: s, kifu: state.results[g].record };
    saveRecord(rec); state.history.push(rec);
    state.status = `第${g + 1}局 終了: オセロ弐 ${s > 0 ? '勝ち' : s < 0 ? '負け' : '引き分け'} (${s > 0 ? '+' : ''}${s})`;
    console.log(`game ${g + 1}: we are ${weBlack ? 'black' : 'white'}, result ${s > 0 ? '+' : ''}${s}  ${state.results[g].record}`);
    push();
    await sleep(4000);
  }
  const w = state.results.filter(r => r.score > 0).length, l = state.results.filter(r => r.score < 0).length;
  state.done = true; state.status = `全${games}局 終了: ${w}勝 ${games - w - l}分 ${l}敗`;
  console.log(`level ${level} vs othello.org COM level ${com}: +${w} =${games - w - l} -${l}`);
  push();
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>観戦 — オセロ弐 対 othello.org</title><style>
body{margin:0;background:#0e1512;color:#e9e4d6;font-family:"Yu Gothic UI","Hiragino Sans",sans-serif;line-height:1.5}
main{max-width:980px;margin:0 auto;padding:20px 16px;display:grid;grid-template-columns:minmax(0,520px) 1fr;gap:24px}
h1{grid-column:1/-1;font-family:"Yu Mincho",serif;font-size:22px;letter-spacing:.08em;margin:0;border-bottom:1px solid #2c4036;padding-bottom:10px}
h1 b{color:#d7b25a}.players{display:flex;justify-content:space-between;margin-bottom:8px;font-size:14px}
.players span{padding:4px 10px;border-radius:8px;border:1px solid transparent}.players .on{border-color:#8c7437;background:#16211c}
.n{font-family:"Yu Mincho",serif;font-size:22px;margin:0 6px}
.frame{padding:16px;background:linear-gradient(145deg,#3a2a1a,#23180e);border-radius:12px}
.board{display:grid;grid-template-columns:repeat(8,1fr);gap:1px;background:#155438;aspect-ratio:1}
.c{background:#1c6b48;display:grid;place-items:center;aspect-ratio:1}
.d{width:82%;height:82%;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,.45);transition:background .3s}
.b{background:radial-gradient(circle at 32% 28%,#5a5f5c,#111 62%)}.w{background:radial-gradient(circle at 32% 28%,#fff,#cfcabd 70%)}
.last .d{outline:3px solid #e0664f;outline-offset:-9px}
#status{margin-top:12px;font-size:16px;color:#d7b25a;min-height:1.5em}
.chip{border:1px solid #777;display:inline-block;width:18px;height:18px;border-radius:50%;vertical-align:-3px;margin:0 6px}
.our b{font-family:"Yu Mincho",serif;font-size:26px;color:#d7b25a;margin-right:10px}.our dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0;font-size:14px}.our dt{color:#9aa79f}.our dd{margin:0}
.our ul{list-style:none;margin:6px 0 0;padding:0;font-size:13px;display:grid;gap:4px}.our li{padding-left:1.4em;position:relative}.our li::before{position:absolute;left:0}.our li.good::before{content:"○";color:#8fd19e}.our li.bad::before{content:"△";color:#e0664f}
.muted{color:#9aa79f;font-size:13px}
.box{border:1px solid #2c4036;border-radius:12px;padding:12px 14px;background:#16211c;margin-bottom:14px}
.box h2{font-family:"Yu Mincho",serif;font-size:14px;color:#d7b25a;margin:0 0 6px;letter-spacing:.1em}
#rec{font-family:Consolas,monospace;font-size:12.5px;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:3px 6px;text-align:left;border-bottom:1px solid #2c4036}
a{color:#d7b25a}.win{color:#8fd19e}.lose{color:#e0664f}
@media(max-width:760px){main{grid-template-columns:1fr}}
</style></head><body><main>
<h1>観戦 — <b>オセロ弐</b> レベル<span id="lv"></span> 対 othello.org <span id="cn"></span></h1>
<section><div class="players"><span id="pb"></span><span id="pw"></span></div>
<div class="frame"><div class="board" id="board"></div></div>
<div id="status"></div></section>
<aside><div class="box our"><h2>オセロ弐の直前の手</h2><div id="our" class="muted">まだ打っていません</div></div>
<div class="box"><h2>第<span id="gn">-</span>局の棋譜</h2><div id="rec">—</div></div>
<div class="box"><h2>結果</h2><table><thead><tr><th>局</th><th>オセロ弐</th><th>石差</th><th>棋譜</th></tr></thead><tbody id="res"></tbody></table><div id="sum" style="margin-top:8px;font-size:13px"></div></div>
<div class="box"><h2>過去の対局（records/vs_othello_org.jsonl）</h2><div id="hist" class="muted" style="max-height:220px;overflow:auto"></div></div></aside>
</main><script>
const B=document.getElementById('board'),cells=[];
for(let i=0;i<64;i++){const c=document.createElement('div');c.className='c';B.appendChild(c);cells.push(c);}
const $=id=>document.getElementById(id);
function show(s){
  $('lv').textContent=s.level;$('cn').textContent=s.comName;$('gn').textContent=s.game||'-';
  let nb=0,nw=0;
  for(let i=0;i<64;i++){const v=s.cells[i]||'0';if(v==='1')nb++;else if(v==='2')nw++;
    cells[i].className='c'+(i===s.last?' last':'');cells[i].innerHTML=v==='0'?'':'<div class="d '+(v==='1'?'b':'w')+'"></div>';}
  const us='オセロ弐',them='othello.org '+s.comName;
  $('pb').innerHTML='<i class="chip b"></i>黒 '+(s.weBlack?us:them)+'<span class="n">'+nb+'</span>';
  $('pw').innerHTML='<span class="n">'+nw+'</span>'+(s.weBlack?them:us)+' 白<i class="chip w"></i>';
  $('pb').className=s.blackToMove&&!s.done?'on':'';$('pw').className=!s.blackToMove&&!s.done?'on':'';
  $('status').textContent=s.status;
  const o=s.our;
  $('our').className=o?'':'muted';
  $('our').innerHTML=o?'<b>'+o.move+'</b><span class="muted">'+o.n+'手目</span><dl><dt>選び方</dt><dd>'+o.kind+'</dd><dt>評価（オセロ弐から見て）</dt><dd>'+o.score+'</dd><dt>読んだ局面</dt><dd>'+o.nodes.toLocaleString()+' 局面 / '+(o.ms/1000).toFixed(2)+' 秒</dd></dl>'+(o.tags.length?'<div class="muted">この手の特徴</div><ul>'+o.tags.map(t=>'<li class="'+(t.good?'good':'bad')+'">'+t.text+'</li>').join('')+'</ul>':''):'まだ打っていません';
  $('rec').textContent=s.record.length?s.record.join(' '):'—';
  $('res').innerHTML=s.results.map(r=>'<tr><td>'+r.game+'</td><td>'+(r.weBlack?'黒':'白')+'</td><td class="'+(r.score>0?'win':r.score<0?'lose':'')+'">'+(r.score>0?'+':'')+r.score+'</td><td><a target="_blank" href="/app/index.html?kifu='+r.record+'">再生</a></td></tr>').join('');
  const H=s.history||[];
  $('hist').innerHTML=H.length?'<table><tbody>'+H.slice().reverse().map(r=>'<tr><td>'+r.date+'</td><td>Lv'+r.level+' '+(r.weBlack?'黒':'白')+'</td><td class="'+(r.score>0?'win':r.score<0?'lose':'')+'">'+(r.score>0?'+':'')+r.score+'</td><td><a target="_blank" href="/app/index.html?kifu='+r.kifu+'">再生</a></td></tr>').join('')+'</tbody></table>':'まだ記録がありません';
  const w=s.results.filter(r=>r.score>0).length,l=s.results.filter(r=>r.score<0).length;
  $('sum').textContent=s.results.length?'ここまで '+w+'勝 '+(s.results.length-w-l)+'分 '+l+'敗 / 全'+s.total+'局':'';
}
const es=new EventSource('/events');es.onmessage=e=>show(JSON.parse(e.data));
es.onerror=()=>{$('status').textContent='サーバーとの接続が切れました（対局が終わったか、停止されました）';};
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(state) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else if (req.url.startsWith('/app/')) {
    const rel = decodeURIComponent(req.url.slice(5).split('?')[0]) || 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    if (!file.startsWith(ROOT) || !types[path.extname(file)] || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] });
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`watch at http://localhost:${port}`);
  if (games > 0) run().catch((e) => { state.status = 'エラー: ' + e.message; push(); console.error(e); });
});
