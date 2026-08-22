// End-to-end load test — the only check that exercises the real extension in a
// real browser with the real Stockfish WASM engine. The unit tests cover the pure
// helpers; this covers injection, the engine worker, move handling and teardown.
//
// Requires the engine binary and a Chromium:
//   bash scripts/download-stockfish.sh
//   npm i --no-save playwright && npx playwright install chromium
//   npm run test:e2e
//
// Not in CI: it needs a headed browser and the 10 MB engine, neither of which
// belongs in the unit-test workflow.
import { chromium } from 'playwright';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '../..');
if (!existsSync(path.join(EXT, 'stockfish.js'))) {
  console.error('✗ stockfish.js missing — run: bash scripts/download-stockfish.sh');
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
<div class="game-over-modal-content"><div class="game-over-buttons-buttons">
  <button data-cy="game-over-modal-rematch-button">Rematch</button>
</div></div>
</body></html>`;

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
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
console.log('PASS 6/7: player move accepted + Stockfish replied');
console.log('         white pawn e2→e4 on the Chess.com board; black changed:',
  before.filter(x => !after.includes(x)).join(' ') || '(none)', '→',
  after.filter(x => !before.includes(x)).join(' '));

// 8. stopping restores the board (no leftover overlay)
await page.locator('#sfct-badge').click();
await page.waitForTimeout(300);
const left = await page.locator('[data-sfct]').count();
if (left !== 0) fail(`overlay pieces left after stop: ${left}`);
console.log('PASS 8: stop cleans up overlay');

console.log('\nALL CHECKS PASSED');
if (logs.length) console.log('--- page logs ---\n' + logs.join('\n'));
await ctx.close();
