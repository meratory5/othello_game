// Plays a few games against the COM of https://www.othello.org/play/ (its moves come from the
// site's nextmove.cgi, the same request the page itself sends).  One request per COM move,
// throttled, so the load equals a person playing.  Use sparingly.
//   node tools/vs_othello_org.js --level 10 --com 2 --games 2
const path = require('path');
const { makeEngine, args, sqName } = require('./common');
const a = args();
const level = +(a.level || 10), com = +(a.com === undefined ? 2 : a.com), games = +(a.games || 2);
const E = makeEngine({ book: path.join(__dirname, '../js/book.js') });
E.initTT(20);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function comMove(pos, blackToMove) {
  let board = '';
  for (let s = 0; s < 64; s++) { const c = E.cellAt(pos, s); board += c === 0 ? '0' : (c === 1) === blackToMove ? '1' : '2'; }
  const res = await fetch('https://www.othello.org/play/ajax/nextmove.cgi?', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body: `param=COM&turn=${blackToMove ? 1 : 2}&board=${board}&level=${com}`,
  });
  const lines = (await res.text()).trim().split('\n');
  if (lines[0] !== 'MOVE') throw new Error('unexpected reply: ' + lines.join('|'));
  const p = +lines[2];
  return (p % 10) * 8 + Math.floor(p / 10);
}

(async () => {
  let w = 0, d = 0, l = 0;
  for (let g = 0; g < games; g++) {
    const weBlack = g % 2 === 0;
    let pos = E.initialPosition(), black = true, record = '';
    for (;;) {
      let moves = E.legalMoves(pos);
      if (!moves.length) { pos = E.passPos(pos); black = !black; moves = E.legalMoves(pos); if (!moves.length) break; }
      let sq;
      if (black === weBlack) sq = E.think(pos, E.LEVELS[level - 1]).sq;
      else { await sleep(1200); sq = await comMove(pos, black); if (!moves.includes(sq)) throw new Error('COM sent illegal move ' + sq); }
      record += black ? sqName(sq).toUpperCase() : sqName(sq);
      pos = E.play(pos, sq); black = !black;
    }
    const s = E.finalScore(pos) * (black === weBlack ? 1 : -1);
    if (s > 0) w++; else if (s < 0) l++; else d++;
    console.log(`game ${g + 1}: we are ${weBlack ? 'black' : 'white'}, result ${s > 0 ? '+' : ''}${s}  ${record}`);
  }
  console.log(`level ${level} vs othello.org COM level ${com}: +${w} =${d} -${l}`);
})();
