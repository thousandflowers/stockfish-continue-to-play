// End-to-end load test — the only check that exercises the real extension in a
// real browser with the real Stockfish WASM engine. The unit tests cover the pure
// helpers; this covers injection, the engine worker, move handling and teardown.
//
// Requires the engine binary and a Chromium:
//   bash scripts/download-stockfish.sh
//   npm i --no-save playwright && npx playwright install chromium
//   npm run test:e2e
//
// Runs in CI too (see .github/workflows/test.yml): the engine is cached by its
// pinned checksum and the browser runs headless. Locally it stays headed.
import { chromium } from 'playwright';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '../..');
// Both halves of the engine must be there: a loader without its .wasm boots
// and then hangs, which reads as a flaky test rather than a missing file.
const missing = ['stockfish.js', 'stockfish.wasm'].filter(f => !existsSync(path.join(EXT, f)));
if (missing.length) {
  console.error(`✗ ${missing.join(' and ')} missing — run: bash scripts/download-stockfish.sh`);
  process.exit(1);
}
const userDataDir = mkdtempSync(path.join(tmpdir(), 'sfct-'));

// Minimal Chess.com-shaped page: a wc-chess-board with light-DOM pieces
// (scrape path #4) plus a game-over modal and player components.
const pieces = [
  // white
  ['wk','51'],['wq','41'],['wr','11'],['wr','81'],['wp','52'],['wp','42'],
  // black
  ['bk','58'],['bq','48'],['br','18'],['br','88'],['bp','57'],['bp','47'],
].map(([p,sq]) => `<div class="piece ${p} square-${sq}"></div>`).join('');

const HTML = `<!doctype html><html><body style="margin:0">
<div class="board-player-component"><span class="user-tagline-rating">1450</span></div>
<div class="board-player-component"><span class="user-tagline-you">You</span><span class="user-tagline-rating">1400</span></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">${pieces}</wc-chess-board>
<div class="move-list"><div class="node white-move main-line-ply">d4</div>
<div class="node black-move main-line-ply">d5</div></div>
<div class="game-over-modal-content"><div class="game-over-buttons-buttons">
  <button data-cy="game-over-modal-rematch-button">Rematch</button>
</div></div>
</body></html>`;

// Headed locally (you can watch it play), headless in CI. Extensions only load
// in Chrome's new headless mode, which Playwright selects via channel:'chromium'.
const headless = !!process.env.CI;
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless,
  ...(headless ? { channel: 'chromium' } : {}),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`[console:${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith('https://www.chess.com/game/')) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  }
  if (url.startsWith('chrome-extension://')) return route.continue();
  return route.abort();
});

const fail = (m) => { console.log('FAIL:', m); console.log(logs.join('\n')); process.exit(1); };

await page.goto('https://www.chess.com/game/live/123456', { waitUntil: 'domcontentloaded' });

// 1. button injects on the game-over screen
const btn = page.locator('#sfctplay-btn');
await btn.waitFor({ timeout: 10000 }).catch(() => fail('Continue button never injected'));
console.log('PASS 1: button injected —', (await btn.textContent()).trim());

// 2. clicking it starts the inline game
await btn.click();
await page.waitForSelector('#sfct-badge', { timeout: 10000 }).catch(async () => {
  const banner = await page.locator('#sfctplay-banner').textContent().catch(() => '(none)');
  fail('status badge missing; banner=' + banner);
});
console.log('PASS 2: badge —', await page.locator('#sfct-badge').textContent());

// 3. our overlay pieces render on the real board
const overlay = await page.locator('#board [data-sfct]').count();
if (overlay < 10) fail(`expected overlay pieces, got ${overlay}`);
console.log('PASS 3: overlay pieces rendered —', overlay);

// 4. regression: the trigger must NOT come back while playing
await page.waitForTimeout(1500);
if (await page.locator('#sfctplay-btn').count() !== 0) fail('trigger button reappeared mid-game (regression)');
console.log('PASS 4: trigger stays gone mid-game');

// 5. the engine actually loads and reaches "Your move" / legal moves
await page.waitForFunction(
  () => /Your move|thinking/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 40000 }
).catch(() => fail('engine never became ready: ' + logs.join(' | ')));
console.log('PASS 5: engine ready —', await page.locator('#sfct-badge').textContent());

// 6. play a legal move (e2-e4 style: our white pawn e2 is square-52)
const boardBox = await page.locator('#board').boundingBox();
const sq = (file, rank) => ({ // white orientation
  x: boardBox.x + (file - 0.5) * (boardBox.width / 8),
  y: boardBox.y + (8 - rank + 0.5) * (boardBox.height / 8),
});
const overlaySquares = () => page.$$eval('#board [data-sfct]', els =>
  els.map(el => (el.className.match(/\b(w|b)[kqrbnp]\b/) || [])[0] + '@' +
                (el.className.match(/square-\d\d/) || [])[0]).filter(s => !s.startsWith('undefined')).sort());

const before = await overlaySquares();
const movedAt = Date.now();
// Tag the pawn's DOM node: if the same node is still there after the move, the
// renderer moved it (so the board can animate) instead of rebuilding the board.
await page.$eval('#board [data-sfct="piece"].square-52', el => { el.dataset.tag = 'watched-pawn'; });
const from = sq(5, 2), to = sq(5, 4); // e2 → e4
await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.up();
await page.mouse.move(to.x, to.y); await page.mouse.down(); await page.mouse.up();

// 7. Stockfish replies → badge returns to "Your move" and move count grew
await page.waitForFunction(
  () => /Your move/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 45000 }
).catch(() => fail('Stockfish never replied: ' + logs.join(' | ')));
const after = await overlaySquares();
// The pawn really moved on the Chess.com board itself: e2 (square-52) is empty
// and a white pawn now sits on e4 (square-54).
if (before.includes('wp@square-54') || !before.includes('wp@square-52')) fail('bad start position: ' + before);
if (!after.includes('wp@square-54')) fail('player pawn did not land on e4: ' + after);
if (after.includes('wp@square-52')) fail('player pawn still on e2: ' + after);
// Stockfish's reply moved a black piece.
const blackBefore = before.filter(s => s.startsWith('b')).join();
const blackAfter = after.filter(s => s.startsWith('b')).join();
if (blackBefore === blackAfter) fail('Stockfish reply not rendered on the board: ' + blackAfter);
// The reply must be paced, not instant — an instant answer reads as a glitch.
const replyMs = Date.now() - movedAt;
if (replyMs < 380) fail(`Stockfish replied in ${replyMs}ms — that is not a move, that is a flicker`);
const samePawnNode = await page.$eval('#board [data-sfct="piece"].square-54',
  el => el.dataset.tag === 'watched-pawn').catch(() => false);
if (!samePawnNode) fail('the pawn node was rebuilt instead of moved — the move cannot animate');
console.log(`PASS 6/7: move accepted, Stockfish replied after ${replyMs}ms (paced, node moved not rebuilt)`);
console.log('         white pawn e2→e4 on the Chess.com board; black changed:',
  before.filter(x => !after.includes(x)).join(' ') || '(none)', '→',
  after.filter(x => !before.includes(x)).join(' '));

// 8. stopping restores the board (no leftover overlay)
await page.locator('#sfct-badge').click();
await page.waitForTimeout(300);
const left = await page.locator('[data-sfct]').count();
if (left !== 0) fail(`overlay pieces left after stop: ${left}`);
// …and Chess.com's own pieces are visible again, not stripped out: stopping must
// hand the board back, not leave it blank.
const restored = await page.$$eval('#board [class*="piece"]:not([data-sfct])',
  els => els.filter(el => getComputedStyle(el).display !== 'none').length);
if (restored < 10) fail(`Chess.com pieces not restored after stop: ${restored} visible`);
console.log('PASS 8: stop cleans up overlay and restores', restored, 'Chess.com pieces');

// 9. regression: stopping while the engine is still loading used to leave the
// abandoned init's 15 s timeout armed — it fired long after the user had stopped
// and popped an "Engine failed to load." banner over the restored board.
const restart = async () => {
  await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(async () => {
    const diag = await page.evaluate(() => {
      const b = document.getElementById('sfctplay-btn');
      const m = document.querySelector('.game-over-modal-content');
      return {
        btn: b ? b.outerHTML.slice(0, 160) : null,
        btnDisplay: b ? getComputedStyle(b).display : null,
        modalDisplay: m ? getComputedStyle(m).display : null,
        blocker: !!document.getElementById('sfct-modal-blocker'),
        badge: !!document.getElementById('sfct-badge'),
      };
    });
    fail('trigger button never came back: ' + JSON.stringify(diag));
  });
  await page.locator('#sfctplay-btn').click();
  await page.waitForSelector('#sfct-badge', { timeout: 10000 });
};
await restart();
await page.locator('#sfct-badge').click(); // stop while the engine is still loading
await page.waitForTimeout(16000);          // outlive the abandoned init's 15 s timeout
const stale = await page.locator('#sfctplay-banner').textContent().catch(() => '');
if (/Engine failed/.test(stale || '')) fail('bogus engine-failure banner after stopping mid-load');
console.log('PASS 9: no stale engine-failure banner after stopping mid-load');

// 10. and the next game still starts normally
await restart();
await page.waitForFunction(
  () => /Your move|thinking/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 40000 }
).catch(() => fail('engine never became ready after a mid-load stop'));
if (await page.locator('#board [data-sfct]').count() < 10) fail('board lost its pieces after restart');
console.log('PASS 10: restart after a mid-load stop works —', await page.locator('#sfct-badge').textContent());

// 11. losing is detected and named. Fool's mate: after 1. f3 e5 2. g4 it is
// Black (the engine) to move and Qd8-h4 is mate, so the player must be told they
// lost — not left staring at a frozen board.
const fenToDivs = (placement) => placement.split('/').flatMap((row, r) => {
  const out = [];
  let f = 0;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') { f += +ch; continue; }
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    out.push(`<div class="piece ${color}${ch.toLowerCase()} square-${f + 1}${8 - r}"></div>`);
    f++;
  }
  return out;
}).join('');
const MATE_HTML = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR')}</wc-chess-board>
<div class="move-list"><div class="node white-move main-line-ply">f3</div>
<div class="node black-move main-line-ply">e5</div>
<div class="node white-move main-line-ply">g4</div></div>
<div class="game-over-modal-shell-container"><div class="game-over-modal-shell-buttons">
<button aria-label="New Game">New Game</button></div></div>
</body></html>`;
await page.route('https://www.chess.com/game/live/mate', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: MATE_HTML }));
await page.goto('https://www.chess.com/game/live/mate', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail('no button on the mate page'));
await page.locator('#sfctplay-btn').click();
await page.locator('#sfct-result').waitFor({ timeout: 90000 }).catch(async () => fail(
  'no result modal; badge=' + (await page.locator('#sfct-badge').textContent().catch(() => '(none)'))));
const verdict = (await page.locator('#sfct-result').textContent()).trim();
if (!/Stockfish won/.test(verdict) || !/by checkmate/.test(verdict)) fail('wrong verdict: ' + verdict);
console.log('PASS 11: loss announced in a modal —', verdict.slice(0, 34));

// 12. the final position stays put, the way a finished Chess.com game does —
// the board must not snap back to Chess.com's pieces the moment you are mated.
const frozen = await page.locator('#board [data-sfct="piece"]').count();
if (frozen < 10) fail(`final position was cleared on game over (${frozen} pieces left)`);
const stillHidden = await page.$$eval('#board [class*="piece"]:not([data-sfct])',
  els => els.filter(el => getComputedStyle(el).display !== 'none').length);
if (stillHidden !== 0) fail('Chess.com pieces came back while the result was still up');
console.log('PASS 12: final position stays on the board —', frozen, 'pieces held');

// 12b. the mated king wears Chess.com's red square
const checkMark = await page.$$eval('#board [data-sfct="check"]', els => els.map(e => ({
  cls: e.className,
  bg: getComputedStyle(e).backgroundImage.slice(0, 24),
  sq: (e.className.match(/square-\d\d/) || [])[0],
})));
if (checkMark.length !== 1) fail(`expected the checked king to be marked once, got ${checkMark.length}`);
if (!/radial-gradient/.test(checkMark[0].bg)) fail('check mark is not painted: ' + checkMark[0].bg);
console.log('PASS 12b: checked king marked red on', checkMark[0].sq);

// 13. …and leaving hands the board back
await page.getByRole('button', { name: 'Back to Chess.com' }).click();
await page.waitForTimeout(500);
if (await page.locator('[data-sfct]').count() !== 0) fail('overlay left behind after closing the result');
const handedBack = await page.$$eval('#board [class*="piece"]:not([data-sfct])',
  els => els.filter(el => getComputedStyle(el).display !== 'none').length);
if (handedBack < 10) fail(`Chess.com pieces not restored after closing: ${handedBack}`);
console.log('PASS 13: closing the result restores', handedBack, 'Chess.com pieces');

// 14. castling the Chess.com way (king onto your own rook) and promotion with a
// real choice of piece — both driven through the UI, against the real engine.
const CASTLE_HTML = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs('4k3/P7/8/8/8/8/8/R3K2R')}</wc-chess-board>
<div class="move-list"><div class="node white-move main-line-ply">Kf1</div>
<div class="node black-move main-line-ply">Ke8</div></div>
<div class="game-over-modal-shell-container"><div class="game-over-modal-shell-buttons">
<button aria-label="New Game">New Game</button></div></div>
</body></html>`;
await page.route('https://www.chess.com/game/live/castle', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: CASTLE_HTML }));
await page.goto('https://www.chess.com/game/live/castle', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail('no button on the castling page'));
await page.locator('#sfctplay-btn').click();
await page.waitForFunction(() => /Your move/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 60000 }).catch(() => fail('engine never ready on the castling page'));

const box2 = await page.locator('#board').boundingBox();
const at = (file, rank) => ({
  x: box2.x + (file - 0.5) * (box2.width / 8),
  y: box2.y + (8 - rank + 0.5) * (box2.height / 8),
});
const tap = async (file, rank) => { await page.mouse.click(at(file, rank).x, at(file, rank).y); await page.waitForTimeout(350); };
const pieceAt = (sq) => page.$eval(`#board [data-sfct="piece"].square-${sq}`, el => el.className).catch(() => null);

await tap(5, 1);            // pick up the king on e1
await tap(8, 1);            // …and drop it on our own rook: castle king-side
await page.waitForTimeout(1200);
const kingCls = await pieceAt('71'), rookCls = await pieceAt('61');
if (!/\bwk\b/.test(kingCls || '')) fail('king did not castle to g1: ' + kingCls);
if (!/\bwr\b/.test(rookCls || '')) fail('rook did not jump to f1: ' + rookCls);
console.log('PASS 14: castled by dropping the king on the rook — king g1, rook f1');

await page.waitForFunction(() => /Your move/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 60000 }).catch(() => fail('engine never replied after castling'));

// 15. promotion offers the four pieces, and takes the one you pick
// the engine announces "Your move" before its legal-move list is back, so wait
// for the pawn to actually take the selection before aiming at a8
await page.waitForTimeout(600);
await tap(1, 7);            // the a7 pawn
await page.locator('#board [data-sfct="piece"].square-17.sfct-sel').waitFor({ timeout: 8000 })
  .catch(() => fail('the a7 pawn never got selected'));
await tap(1, 8);            // …to a8
await page.locator('[data-sfct="promo"]').waitFor({ timeout: 5000 }).catch(async () => fail(
  'no promotion picker; ' + JSON.stringify(await page.evaluate(() => ({
    badge: document.getElementById('sfct-badge')?.textContent,
    selected: [...document.querySelectorAll('#board .sfct-sel')].map(e => (e.className.match(/square-\d\d/) || [])[0]),
    a7: !!document.querySelector('#board [data-sfct="piece"].square-17'),
    a8: document.querySelector('#board [data-sfct="piece"].square-18')?.className || null,
    markers: [...document.querySelectorAll('[data-sfct]')].map(e => e.getAttribute('data-sfct')),
    promoHtml: document.querySelector('[data-sfct="promo"]')?.outerHTML?.slice(0, 200) || null,
    promoBox: (() => { const e = document.querySelector('[data-sfct="promo"]');
      if (!e) return null; const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
  })))));
const offered = await page.$$eval('[data-sfct="promo"] > div', els =>
  els.map(e => (e.className.match(/\bw([qnrb])\b/) || [])[1]));
if (offered.join('') !== 'qnrb') fail('promotion picker offered: ' + offered.join(','));
await page.locator('[data-sfct="promo"] > div').nth(1).click(); // the knight
await page.waitForTimeout(1200);
const promoted = await pieceAt('18');
if (!/\bwn\b/.test(promoted || '')) fail('promoted to the wrong piece: ' + promoted);
console.log('PASS 15: promotion picker offered q,n,r,b and a knight landed on a8');

// 16. continue from the position you are LOOKING at, not the one the game ended
// on. The move list marks ply 1 as selected, so it is Black to move even though
// the list runs to ply 4 and would have said White. Nothing here touches the
// board: if the engine moves a black piece on its own, the selection was read.
const SCRUB_HTML = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<div class="board-layout-sidebar"><div class="move-list">
<div class="node white-move main-line-ply selected">e4</div>
<div class="node black-move main-line-ply">e5</div>
<div class="node white-move main-line-ply">Nf3</div>
<div class="node black-move main-line-ply">Nc6</div></div></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')}</wc-chess-board>
<div class="game-over-modal-shell-container"><div class="game-over-modal-shell-buttons">
<button aria-label="New Game">New Game</button></div></div>
</body></html>`;
await page.route('https://www.chess.com/game/live/scrub', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: SCRUB_HTML }));
await page.goto('https://www.chess.com/game/live/scrub', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail('no button on the scrubbed page'));

const blackSquares = () => page.$$eval('#board [data-sfct="piece"]', els =>
  els.map(el => (el.className.match(/\bb[kqrbnp]\b/) || [])[0] + '@' +
                (el.className.match(/square-\d\d/) || [])[0]).filter(s => !s.startsWith('undefined')).sort());

await page.locator('#sfctplay-btn').click();
// "Your move" only arrives once the engine has played, and the engine only plays
// first when the selected ply says it is its turn.
await page.waitForFunction(() => /Your move/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 60000 }).catch(async () => fail(
  'engine never moved first from the selected ply; badge=' +
  (await page.locator('#sfct-badge').textContent().catch(() => '(none)'))));
// The scraped placement has every black piece on ranks 7 and 8, and every legal
// black first move lands on rank 6 or 5. So "a black piece is off its home
// ranks" means Black moved - whichever move the engine happened to pick, which
// naming two specific pieces did not survive.
const blackOffHome = (await blackSquares())
  .filter(sq => +((sq.match(/square-\d(\d)/) || [])[1]) < 7);
if (!blackOffHome.length) {
  fail('no black piece left its home ranks: the side to move came from the end ' +
       'of the list, not from the selected ply');
}
console.log('PASS 16: started from the selected ply - Black moved first, as that position says');
await page.locator('#sfct-badge').click();
await page.waitForTimeout(300);

// 17. when nothing on the page says whose turn it is, ask rather than guess.
// No move list, no last-move highlight: the old code silently assumed White.
const ASK_HTML = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs('4k3/8/8/8/8/8/4P3/4K3')}</wc-chess-board>
<div class="game-over-modal-shell-container"><div class="game-over-modal-shell-buttons">
<button aria-label="New Game">New Game</button></div></div>
</body></html>`;
await page.route('https://www.chess.com/game/live/ask', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: ASK_HTML }));
await page.goto('https://www.chess.com/game/live/ask', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail('no button on the unreadable page'));
await page.locator('#sfctplay-btn').click();
await page.locator('#sfct-ask').waitFor({ timeout: 10000 })
  .catch(() => fail('no side-to-move prompt on a page that cannot say whose turn it is'));
if (await page.locator('#sfct-badge').count() !== 0) fail('the game started before the question was answered');
await page.getByRole('button', { name: /White/ }).click();
await page.waitForSelector('#sfct-badge', { timeout: 10000 })
  .catch(() => fail('answering the prompt did not start the game'));
console.log('PASS 17: asked whose move it was, and started once answered');


// 18. how a continued game is allowed to END. Running out of legal moves covers
// mate and stalemate; every other draw leaves legal moves on the board, so
// before the draw handling a continuation that reached one simply never
// finished. Each case is picked up straight from the position, so the verdict
// arrives without a move being played.
const ENDINGS = [
  // name, placement, plies, what the result must say (null = must keep playing)
  ['sm',   'k7/2Q5/K7/8/8/8/8/8',        1, /stalemate/i],
  ['cm',   'k7/1Q6/K7/8/8/8/8/8',        1, /checkmate/i],
  ['kk',   '4k3/8/8/8/8/8/8/4K3',        2, /force mate/i],  // bare kings
  ['kbk',  '4k3/8/8/8/2B5/8/8/4K3',      2, /force mate/i],  // king and one bishop
  ['knnk', '4k3/8/8/8/1N1N4/8/8/4K3',    2, null],           // two knights: NOT automatic
  ['kpk',  '4k3/8/8/8/8/8/P7/4K3',       2, null],           // a pawn is enough
];
for (const [name, placement, plyCount, want] of ENDINGS) {
  const plies = ['<div class="node white-move main-line-ply">x</div>',
                 '<div class="node black-move main-line-ply">y</div>'].slice(0, plyCount).join('');
  const html = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<div class="board-layout-sidebar"><div class="move-list">${plies}</div></div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs(placement)}</wc-chess-board>
<div class="game-over-modal-shell-container"><div class="game-over-modal-shell-buttons">
<button aria-label="New Game">New Game</button></div></div></body></html>`;
  await page.route(`https://www.chess.com/game/live/end-${name}`, r =>
    r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`https://www.chess.com/game/live/end-${name}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 })
    .catch(() => fail(`no button on the ${name} page`));
  await page.locator('#sfctplay-btn').click();
  if (want) {
    await page.locator('#sfct-result').waitFor({ timeout: 90000 })
      .catch(async () => fail(`${name}: no verdict; badge=` +
        (await page.locator('#sfct-badge').textContent().catch(() => '(none)'))));
    const said = (await page.locator('#sfct-result').textContent()).trim();
    if (!want.test(said)) fail(`${name}: expected ${want}, got ${JSON.stringify(said.slice(0, 60))}`);
    // A position that was over before it started must not offer to replay itself.
    if (await page.getByRole('button', { name: 'Play again vs Stockfish' }).count())
      fail(`${name}: offered to replay a position that was already finished`);
    await page.getByRole('button', { name: 'Back to Chess.com' }).click();
  } else {
    await page.waitForFunction(() => /Your move|thinking/.test(
      document.getElementById('sfct-badge')?.textContent || ''), null, { timeout: 60000 })
      .catch(() => fail(`${name}: never became playable`));
    await page.waitForTimeout(1200);
    if (await page.locator('#sfct-result').count())
      fail(`${name}: called a game that is still playable finished`);
    await page.locator('#sfct-badge').click();
  }
  await page.waitForTimeout(300);
}
console.log('PASS 18: mate, stalemate and the quiet draws all land -', ENDINGS.length, 'endings');


// 19. the surface this was actually failing on: a finished game you came BACK
// to. No result modal - it was dismissed long ago - only the classes Chess.com
// leaves on such a page, and the viewed ply in the query string. The trigger has
// to appear, dock to the move-list column rather than float, and start from the
// ply the URL names.
const REVISIT = `<!doctype html><html><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<div class="board-layout-sidebar" style="box-sizing:border-box;position:absolute;right:0;top:0;width:300px;height:520px;background:#262421">
  <div class="game-tab-scrollable"><div class="move-list">
    <div class="node white-move main-line-ply">e4</div>
    <div class="node black-move main-line-ply">e5</div>
    <div class="node white-move main-line-ply">Nf3</div>
    <div class="node black-move main-line-ply">Nc6</div>
  </div></div>
  <div class="game-result"><span class="result-row">1-0</span></div>
  <div class="game-review-buttons-component"><button>Game Review</button></div>
</div>
<wc-chess-board id="board" style="position:relative;display:block;width:480px;height:480px;background:#eee">
${fenToDivs('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR')}</wc-chess-board>
</body></html>`;
await page.route('https://www.chess.com/game/live/revisit**', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: REVISIT }));
await page.goto('https://www.chess.com/game/live/revisit?username=x&move=1', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail(
  'no trigger on a finished game with no modal - the exact case a real page was failing on'));
if (await page.locator('#sfctplay-dock').count() !== 1)
  fail('the trigger floated instead of docking to the move-list column');
const dockBox = await page.locator('#sfctplay-dock').boundingBox();
const colBox = await page.locator('.board-layout-sidebar').boundingBox();
if (Math.abs(dockBox.x - colBox.x) > 2 || Math.abs(dockBox.width - colBox.width) > 2)
  fail(`dock is not flush with the column: dock=${JSON.stringify(dockBox)} col=${JSON.stringify(colBox)}`);
// The column has to have been asked to shrink, so the bar lands in free space
// rather than over the row of icons at its foot.
const reserved = await page.$eval('.board-layout-sidebar',
  el => el.hasAttribute('data-sfctcolumn') && el.style.paddingBottom);
if (!reserved) fail('the column was not asked to make room; the bar would cover its foot');
console.log('PASS 19: trigger docked to the move-list column, no modal needed, column reserved', reserved);

await page.locator('#sfctplay-btn').click();
// ?move=1 is White's first move, so Black is up: the engine plays before you do.
await page.waitForFunction(() => /Your move/.test(document.getElementById('sfct-badge')?.textContent || ''),
  null, { timeout: 60000 }).catch(() => fail('engine never moved first from the ply named in the URL'));
const movedBlack = (await page.$$eval('#board [data-sfct="piece"]', els => els
  .map(el => (el.className.match(/\bb[kqrbnp]\b/) || [])[0] + '@' + (el.className.match(/square-\d(\d)/) || [])[1])
  .filter(s => !s.startsWith('undefined'))))
  .filter(s => +s.split('@')[1] < 7);
if (!movedBlack.length) fail('no black piece left its home ranks: ?move= was not read');
console.log('PASS 19b: started from the ply in the URL - Black moved first');
await page.locator('#sfct-badge').click();
await page.waitForTimeout(500);
// Stopping brings the trigger straight back, so the column is rightly shrunk
// again. What has to hold is the pairing: shrunk exactly while the bar is there.
const paired = await page.evaluate(() => !!document.getElementById('sfctplay-dock') ===
  !!document.querySelector('[data-sfctcolumn]'));
if (!paired) fail('the column shrink and the bar disagree about whether the bar exists');

// Take the result away, which is what leaving a finished game looks like: the
// trigger must go, and the column must come back exactly as it was.
await page.evaluate(() => {
  document.querySelector('.game-result')?.remove();
  document.querySelector('.game-review-buttons-component')?.remove();
});
await page.waitForTimeout(800);
const gone = await page.evaluate(() => ({
  dock: !!document.getElementById('sfctplay-dock'),
  btn: !!document.getElementById('sfctplay-btn'),
  reserved: !!document.querySelector('[data-sfctcolumn]'),
  padding: document.querySelector('.board-layout-sidebar')?.style.paddingBottom,
}));
if (gone.dock || gone.btn) fail('the trigger outlived the finished game: ' + JSON.stringify(gone));
if (gone.reserved || gone.padding) fail('the column was left shrunk: ' + JSON.stringify(gone));
console.log('PASS 19c: column shrunk only while the bar is there, handed back intact after');

// 20. and the same page WITHOUT a result: a game still being played. The trigger
// must be impossible here, whatever else is on the page.
const IN_PLAY = REVISIT
  .replace(/<div class="game-result">[\s\S]*?<\/div>\s*/, '')
  .replace(/<div class="game-review-buttons-component">[\s\S]*?<\/div>\s*/, '')
  .replace('board-layout-sidebar', 'board-layout-sidebar sidebar-controller-component');
await page.route('https://www.chess.com/game/live/inplay**', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: IN_PLAY }));
await page.goto('https://www.chess.com/game/live/inplay?move=3', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500); // several poll ticks
if (await page.locator('#sfctplay-btn').count() !== 0)
  fail('the trigger appeared on a game that is still being played');
console.log('PASS 20: no trigger on a game in progress, even while walking its move list');


console.log('\nALL CHECKS PASSED');
if (logs.length) console.log('--- page logs ---\n' + logs.join('\n'));
await ctx.close();
