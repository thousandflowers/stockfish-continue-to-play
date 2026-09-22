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
<div class="board-player-component"><span class="user-username">opponent</span><span class="user-tagline-rating">1450</span></div>
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

// The status pill and the banner are gone: a continuation announces itself by
// renaming Chess.com's own opponent row, and its phase lives on <html>, where a
// test can wait for it and a person never sees it. Waiting on a state-machine
// value also beats regex-matching display English, which is what this used to do.
const phaseIs = (...names) => page.waitForFunction(
  (ns) => ns.includes(document.documentElement.dataset.sfctPhase || ''), names, { timeout: 60000 });
const stop = () => page.keyboard.press('Escape');
const rowText = () => page.evaluate(() => {
  // The opponent's row is the player row that does NOT carry a "You" tag - the
  // same rule opponentRow() uses, rather than a narrower class guess.
  const rows = [...document.querySelectorAll('[class*="player"]')]
    .filter(el => !el.querySelector('[class*="player"]'));
  const them = rows.find(el => !/\byou\b/i.test(el.textContent || '')) || rows[0];
  return them?.textContent?.trim().replace(/\s+/g, ' ') ?? '(no row)';
});

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
await page.waitForSelector('html[data-sfct-phase]', { timeout: 10000 }).catch(async () => {
  const row = await rowText();
  fail('no continuation started; opponent row=' + row);
});
const renamed = await rowText();
if (!/Stockfish/.test(renamed)) fail('the opponent row was not renamed: ' + renamed);
console.log('PASS 2: the opponent became the engine —', renamed);

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
  () => ['your-move','thinking'].includes(document.documentElement.dataset.sfctPhase),
  null, { timeout: 40000 }
).catch(() => fail('engine never became ready: ' + logs.join(' | ')));
console.log('PASS 5: engine ready —', await rowText());

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
  () => document.documentElement.dataset.sfctPhase === 'your-move',
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

// 7b. The arrow keys walk the continuation: ← one ply back, ↑ the start, ↓ the
// live position again. Two plies were played (e4 and the reply).
await page.keyboard.press('ArrowLeft');
const oneBack = await overlaySquares();
// One ply back = the start with e4 played: the reply, capture included, is undone.
if (oneBack.join() !== before.map(s => s === 'wp@square-52' ? 'wp@square-54' : s).sort().join())
  fail('← did not take back only the reply: ' + oneBack);
await page.keyboard.press('ArrowUp');
if ((await overlaySquares()).join() !== before.join()) fail('↑ did not show the start: ' + await overlaySquares());
await page.keyboard.press('ArrowRight');
if ((await overlaySquares()).join() !== oneBack.join()) fail('→ did not step forward one ply');
await page.keyboard.press('ArrowDown');
if ((await overlaySquares()).join() !== after.join()) fail('↓ did not return to the live position');
// A press on the board while looking back only returns to the present.
await page.keyboard.press('ArrowUp');
await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.up();
if ((await overlaySquares()).join() !== after.join()) fail('a click while looking back did not return to the present');
if (await page.locator('#board [data-sfct="sel"]').count()) fail('that click also selected a piece');
console.log('PASS 7b: ←/→/↑/↓ walk the continuation, a click returns to the present');

// 7c. A clicked piece stays above its own selected square. The release used to
// strip the piece's z-index, leaving it at auto under the highlight's 2.
const e1 = sq(5, 1); // the king: e4's pawn may be blocked, and a piece with no moves is refused
await page.mouse.move(e1.x, e1.y); await page.mouse.down(); await page.mouse.up();
const stacking = await page.evaluate(() => {
  const sel = document.querySelector('#board [data-sfct="sel"]');
  const pc = sel && [...document.querySelectorAll('#board [data-sfct="piece"]')].find(e => e.dataset.sq === sel.dataset.sq);
  return pc ? [getComputedStyle(pc).zIndex, getComputedStyle(sel).zIndex] : null;
});
if (!stacking) fail('clicking the e1 king did not select it');
if (!(Number(stacking[0]) > Number(stacking[1]))) fail(`the selected square paints over its piece: piece z=${stacking[0]}, square z=${stacking[1]}`);
await page.mouse.move(e1.x, e1.y); await page.mouse.down(); await page.mouse.up(); // deselect
console.log(`PASS 7c: selected piece stays above its square (z ${stacking[0]} over ${stacking[1]})`);

// 8. stopping restores the board (no leftover overlay)
await stop();
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
        phase: document.documentElement.dataset.sfctPhase ?? null,
      };
    });
    fail('trigger button never came back: ' + JSON.stringify(diag));
  });
  await page.locator('#sfctplay-btn').click();
  await page.waitForSelector('html[data-sfct-phase]', { timeout: 10000 });
};
await restart();
await stop(); // stop while the engine is still loading
await page.waitForTimeout(16000);          // outlive the abandoned init's 15 s timeout
// The failure now lands in Chess.com's own opponent row, and an abandoned init
// must not write there either.
const stale = await rowText();
if (/Engine failed/.test(stale)) fail('bogus engine-failure notice after stopping mid-load: ' + stale);
console.log('PASS 9: no stale engine-failure notice after stopping mid-load');

// 10. and the next game still starts normally
await restart();
await page.waitForFunction(
  () => ['your-move','thinking'].includes(document.documentElement.dataset.sfctPhase),
  null, { timeout: 40000 }
).catch(() => fail('engine never became ready after a mid-load stop'));
if (await page.locator('#board [data-sfct]').count() < 10) fail('board lost its pieces after restart');
console.log('PASS 10: restart after a mid-load stop works —', await rowText());

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
  'no result modal; badge=' + (await rowText())));
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

// 12b. the mated king wears Chess.com's red square. The glow lives on an inner
// element so their grow/wiggle/shrink animation cannot fight the transform that
// puts the marker on its square, so that is where the paint is.
const checkMark = await page.$$eval('#board [data-sfct="check"]', els => els.map(e => ({
  sq: (e.className.match(/square-\d\d/) || [])[0],
  inner: e.children.length,
  bg: e.firstElementChild ? getComputedStyle(e.firstElementChild).backgroundImage.slice(0, 24) : '(no child)',
  anim: e.firstElementChild ? getComputedStyle(e.firstElementChild).animationName : '(none)',
})));
if (checkMark.length !== 1) fail(`expected the checked king to be marked once, got ${checkMark.length}`);
if (!/radial-gradient/.test(checkMark[0].bg)) fail('check mark is not painted: ' + checkMark[0].bg);
if (!/_sfctgrow/.test(checkMark[0].anim)) fail('check mark is not animated: ' + checkMark[0].anim);
console.log('PASS 12b: checked king marked red on', checkMark[0].sq, '- animation', checkMark[0].anim);

// 12c. The card is their v6 modal, copied: their glyphs on our buttons, their
// close cross, and nothing of ours added to it - no note, no stray box.
const shape = await page.$eval('#sfct-result', c => ({
  v6: !!c.querySelector('.game-over-modal-shell-v6 .game-over-modal-header-is-v6-modal-enabled'),
  glyphs: [...c.querySelectorAll('svg[data-glyph]')].map(s => s.dataset.glyph).join(),
  note: !!c.querySelector('[data-sfct="card-note"]'),
  ad: !!c.querySelector('[class*="ad-"]'),
}));
if (!shape.v6 || shape.glyphs !== 'mark-cross,arrow-spin-redo,arrow-chevron-left' || shape.note || shape.ad)
  fail('the result card is not their v6 modal: ' + JSON.stringify(shape));
console.log('PASS 12c: the result card is their v6 modal -', shape.glyphs);

// 13. …and leaving hands the board back - by their close cross, as on their modal
await page.getByRole('button', { name: 'Close' }).click();
await page.waitForTimeout(500);
if (await page.locator('[data-sfct]').count() !== 0) fail('overlay left behind after closing the result');
const handedBack = await page.$$eval('#board [class*="piece"]:not([data-sfct])',
  els => els.filter(el => getComputedStyle(el).display !== 'none').length);
if (handedBack < 10) fail(`Chess.com pieces not restored after closing: ${handedBack}`);
console.log('PASS 13: closing the result restores', handedBack, 'Chess.com pieces');

// 14. castling the Chess.com way (king onto your own rook) and promotion with a
// real choice of piece — both driven through the UI, against the real engine.
// Their promotion-window rules, copied verbatim off a live chess.com stylesheet
// (2026-09-22): the picker is built to wear them, so the fixture carries them.
const PROMO_CSS = `<style>
.promotion-window { background-color: rgb(255, 255, 255); border-radius: 3px; bottom: 0px; display: flex; flex-direction: column-reverse; height: 56.25%; left: 0px; position: absolute; top: auto; width: 12.5%; z-index: 2; }
.promotion-window.top { bottom: auto; top: 0px; }
.promotion-window .promotion-piece { background-position-y: bottom; background-repeat: no-repeat; background-size: 100%; cursor: pointer; padding-top: 100%; position: relative; }
.promotion-window .promotion-piece.wq, .promotion-window .promotion-piece.bq { order: 0; }
.promotion-window .promotion-piece.wn, .promotion-window .promotion-piece.bn { order: 1; }
.promotion-window .promotion-piece.wr, .promotion-window .promotion-piece.br { order: 2; }
.promotion-window .promotion-piece.wb, .promotion-window .promotion-piece.bb { order: 3; }
.promotion-window.top .promotion-piece.wq, .promotion-window.top .promotion-piece.bq { order: 4; }
.promotion-window.top .promotion-piece.wn, .promotion-window.top .promotion-piece.bn { order: 3; }
.promotion-window.top .promotion-piece.wr, .promotion-window.top .promotion-piece.br { order: 2; }
.promotion-window.top .promotion-piece.wb, .promotion-window.top .promotion-piece.bb { order: 1; }
.promotion-window .close-button { align-items: center; border-radius: 4px 4px 0px 0px; cursor: pointer; display: flex; flex-grow: 1; font-size: 150%; justify-content: center; max-height: 12.5%; order: 4; }
.promotion-window.top .close-button { border-radius: 0px 0px 3px 3px; order: 0; }
</style>`;
const CASTLE_HTML = `<!doctype html><html><head>${PROMO_CSS}</head><body style="margin:0">
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
await page.waitForFunction(() => document.documentElement.dataset.sfctPhase === 'your-move',
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

await page.waitForFunction(() => document.documentElement.dataset.sfctPhase === 'your-move',
  null, { timeout: 60000 }).catch(() => fail('engine never replied after castling'));

// 15. promotion offers the four pieces, and takes the one you pick
// the engine announces "Your move" before its legal-move list is back, so wait
// for the pawn to actually take the selection before aiming at a8
await page.waitForTimeout(600);
await tap(1, 7);            // the a7 pawn
// The square you picked up from is marked with Chess.com's own `highlight`
// class on a node of its own, not with a ring drawn onto the piece.
await page.locator('#board [data-sfct="sel"].square-17.highlight').waitFor({ timeout: 8000 })
  .catch(() => fail('the a7 pawn never got selected'));
await tap(1, 8);            // …to a8
await page.locator('[data-sfct="promo"]').waitFor({ timeout: 5000 }).catch(async () => fail(
  'no promotion picker; ' + JSON.stringify(await page.evaluate(() => ({
    phase: document.documentElement.dataset.sfctPhase ?? null,
    selected: [...document.querySelectorAll('#board [data-sfct="sel"]')].map(e => (e.className.match(/square-\d\d/) || [])[0]),
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

// 15b. The picker is their promotion window: their classes, opened the way
// theirs opens, on the a-file, hanging from the top edge White promotes on, one
// file wide and 56.25% of the board tall - the geometry their rules give it.
const win = await page.$eval('[data-sfct="promo"]', (w) => {
  const r = w.getBoundingClientRect(), b = w.parentElement.getBoundingClientRect();
  return { cls: w.className, close: !!w.querySelector(':scope > i.close-button.icon-font-chess.x'),
    x: r.left - b.left, y: r.top - b.top, w: r.width / b.width, h: r.height / b.height };
});
if (win.cls !== 'promotion-window dynamic top promotion-window--visible' || !win.close)
  fail('the picker is not their promotion window: ' + JSON.stringify(win));
if (Math.abs(win.x) > 1 || Math.abs(win.y) > 1 || Math.abs(win.w - 0.125) > 0.002 || Math.abs(win.h - 0.5625) > 0.002)
  fail('the promotion window is not where theirs would be: ' + JSON.stringify(win));
console.log('PASS 15b: the picker is their promotion window, on the a-file at the top edge');

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
await page.waitForFunction(() => document.documentElement.dataset.sfctPhase === 'your-move',
  null, { timeout: 60000 }).catch(async () => fail(
  'engine never moved first from the selected ply; badge=' +
  (await rowText())));
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
await stop();
await page.waitForTimeout(300);

// 17. when nothing on the page says whose turn it is, the trigger is not offered
// at all. There used to be a card of ours asking the question; nothing of ours
// interrupts the page any more, so the honest answer is to decline a game that
// could only start on a guess. No move list, no last-move highlight.
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
await page.waitForTimeout(1500);
if (await page.locator('#sfctplay-btn').count() !== 0)
  fail('offered a continuation on a page that cannot say whose turn it is');
if (await page.locator('html[data-sfct-phase]').count() !== 0) fail('a game started on a guess');
console.log('PASS 17: no trigger where the side to move cannot be settled');


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
        (await rowText())));
    const said = (await page.locator('#sfct-result').textContent()).trim();
    if (!want.test(said)) fail(`${name}: expected ${want}, got ${JSON.stringify(said.slice(0, 60))}`);
    // A position that was over before it started must not offer to replay itself.
    if (await page.getByRole('button', { name: 'Play again vs Stockfish' }).count())
      fail(`${name}: offered to replay a position that was already finished`);
    await page.getByRole('button', { name: 'Back to Chess.com' }).click();
  } else {
    await phaseIs('your-move', 'thinking').catch(() => fail(`${name}: never became playable`));
    await page.waitForTimeout(1200);
    if (await page.locator('#sfct-result').count())
      fail(`${name}: called a game that is still playable finished`);
    await stop();
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
await page.waitForFunction(() => document.documentElement.dataset.sfctPhase === 'your-move',
  null, { timeout: 60000 }).catch(() => fail('engine never moved first from the ply named in the URL'));
const movedBlack = (await page.$$eval('#board [data-sfct="piece"]', els => els
  .map(el => (el.className.match(/\bb[kqrbnp]\b/) || [])[0] + '@' + (el.className.match(/square-\d(\d)/) || [])[1])
  .filter(s => !s.startsWith('undefined'))))
  .filter(s => +s.split('@')[1] < 7);
if (!movedBlack.length) fail('no black piece left its home ranks: ?move= was not read');
console.log('PASS 19b: started from the ply in the URL - Black moved first');
await stop();
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


// 21. the capture ring is as heavy as Chess.com's. Their base rule declares 5px,
// but a live board computes 7.5px on an 86px square - they scale it with the
// board - so wearing the class alone left ours a third too thin, which is
// exactly what "too thin" was. The fixture carries their three real rules, so
// what this asserts is the contract we depend on, not our own invention.
const CC_MARKER_CSS = `<style>
.highlight,.hint,.capture-hint{height:12.5%;left:0;position:absolute;top:0;width:12.5%}
.hint,.capture-hint{background-clip:content-box;border-radius:50%;box-sizing:border-box;pointer-events:none}
.hint{background-color:rgba(0,0,0,.14);padding:4.2%}
.capture-hint{border:5px solid rgba(0,0,0,.14)}
</style>`;
const RING = `<!doctype html><html><head>${CC_MARKER_CSS}</head><body style="margin:0">
<div class="player-row-component player-row-top"><span class="cc-user-rating-white">(1450)</span></div>
<div class="board-layout-sidebar"><div class="move-list">
<div class="node white-move main-line-ply">x</div>
<div class="node black-move main-line-ply">y</div></div></div>
<wc-chess-board id="board" style="position:relative;display:block;width:640px;height:640px;background:#eee">
${fenToDivs('4k3/8/8/8/8/5K2/8/R2r4')}</wc-chess-board>
<div class="game-result">1-0</div></body></html>`;
await page.route('https://www.chess.com/game/live/ring**', route =>
  route.fulfill({ status: 200, contentType: 'text/html', body: RING }));
await page.goto('https://www.chess.com/game/live/ring', { waitUntil: 'domcontentloaded' });
await page.locator('#sfctplay-btn').waitFor({ timeout: 10000 }).catch(() => fail('no trigger on the ring page'));
await page.locator('#sfctplay-btn').click();
await page.waitForFunction(() => document.documentElement.dataset.sfctPhase === 'your-move',
  null, { timeout: 60000 }).catch(() => fail('engine never ready on the ring page'));
const rbox = await page.locator('#board').boundingBox();
await page.mouse.click(rbox.x + 0.5 * rbox.width / 8, rbox.y + 7.5 * rbox.height / 8); // the a1 rook
await page.waitForTimeout(900);
const marks = await page.$$eval('#board [data-sfct="dot"]', els => els.map(e => ({
  cls: e.className, border: getComputedStyle(e).borderWidth, pad: getComputedStyle(e).padding })));
const ring = marks.find(m => /capture-hint/.test(m.cls));
if (!ring) fail('no capture ring on the rook it can take: ' + JSON.stringify(marks));
const want = (rbox.width / 8) * (7.5 / 86);
if (Math.abs(parseFloat(ring.border) - want) > 0.6)
  fail(`ring is ${ring.border}, Chess.com's weight for this board is ${want.toFixed(1)}px`);
// …and it really is scaled, not the 5px the base rule declares.
if (Math.abs(parseFloat(ring.border) - 5) < 1)
  fail(`ring is still the declared 5px (${ring.border}) - the scaling did not apply`);
if (!marks.some(m => /(^| )hint/.test(m.cls) && parseFloat(m.pad) > 0))
  fail('the plain dots lost their padding: ' + JSON.stringify(marks));
console.log(`PASS 21: capture ring ${ring.border} on a ${Math.round(rbox.width / 8)}px square (Chess.com's weight), dots padded`);
await stop();
await page.waitForTimeout(300);


console.log('\nALL CHECKS PASSED');
if (logs.length) console.log('--- page logs ---\n' + logs.join('\n'));
await ctx.close();
