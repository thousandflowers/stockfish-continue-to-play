/**
 * Selector Audit Script
 * 
 * Opens a completed Chess.com game, runs the extension's extraction
 * selectors against the live DOM, and reports which strategies match.
 * 
 * Usage: node scripts/audit-selectors.mjs
 * 
 * Requires: npm install playwright @playwright/test
 */

import { chromium } from 'playwright';

const CHESS_COM_GAME = 'https://www.chess.com/game/live/123456789'; // placeholder
const OUTPUT_KEYS = ['fen', 'elo'];

async function runAudit() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`[audit] Navigating to Chess.com completed game...`);
  await page.goto(CHESS_COM_GAME, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for game-over modal or board
  await page.waitForSelector('wc-chess-board, .board-player-component, .game-over-modal, [class*="game-over"]', {
    timeout: 15000,
  }).catch(() => {
    console.warn('[audit] Game-over modal not found — running selectors on current DOM anyway');
  });

  // Inject extraction functions from the extension source
  const chessUtils = await readSource('lib/chess-utils.js');

  const results = await page.evaluate((src) => {
    eval(src);
    const fen = typeof getFEN === 'function' ? getFEN() : null;
    const elo = typeof getOpponentElo === 'function' ? getOpponentElo() : null;
    return { fen, elo };
  }, chessUtils);

  console.log(`[audit] FEN: ${results.fen}`);
  console.log(`[audit] Elo: ${results.elo}`);

  let allFailures = true;
  if (results.fen) {
    console.log(`[audit] ✓ FEN extracted (${results.fen.split(' ')[0]} ...)`);
    allFailures = false;
  } else {
    console.warn(`[audit] ✗ FEN returned null`);
  }
  if (results.elo) {
    console.log(`[audit] ✓ Elo detected: ${results.elo}`);
    allFailures = false;
  } else {
    console.warn(`[audit] ✗ Elo returned null`);
  }

  await browser.close();

  if (allFailures) {
    console.error(`\n[audit] ❌ ALL selectors failed — Chess.com likely updated their DOM`);
    process.exit(1);
  }

  console.log(`\n[audit] ✅ Audit passed`);
}

async function readSource(relativePath) {
  const fs = await import('fs');
  const path = await import('path');
  const full = path.resolve(new URL('.', import.meta.url).pathname, '..', relativePath);
  return fs.readFileSync(full, 'utf-8');
}

runAudit().catch((err) => {
  console.error(`[audit] Fatal: ${err.message}`);
  process.exit(1);
});
