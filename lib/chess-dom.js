// ── DOM scraping for Stockfish Continue to Play (Chess.com) ─────────────────
// Reads the final position, player colour, opponent rating and game-over state
// from the Chess.com page. Needs `document`; no chrome.*, Worker or fetch — so
// it runs under jsdom in the unit tests. Kept independent of chess-core.js so it
// can be imported on its own (the content-script world loads both as globals).

const PIECE_MAP = {
  wk: 'K', wq: 'Q', wr: 'R', wb: 'B', wn: 'N', wp: 'P',
  bk: 'k', bq: 'q', br: 'r', bb: 'b', bn: 'n', bp: 'p',
};

// Build a FEN placement field from Chess.com piece <div>s (class "piece wp square-52").
function buildFENFromPieces(root) {
  const pieceDivs = root.querySelectorAll('[class*="piece"][class*="square-"]');
  if (!pieceDivs.length) return null;
  const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
  let found = 0;
  pieceDivs.forEach(el => {
    let piece = null, file = -1, rank = -1;
    (el.className || '').split(/\s+/).forEach(c => {
      if (PIECE_MAP[c]) piece = PIECE_MAP[c];
      const m = c.match(/^square-(\d)(\d)$/);
      if (m) { file = parseInt(m[1], 10) - 1; rank = parseInt(m[2], 10) - 1; }
    });
    if (piece && file >= 0 && rank >= 0) { grid[7 - rank][file] = piece; found++; }
  });
  if (found < 3) return null; // noise guard
  return grid.map(row => {
    let s = '', e = 0;
    row.forEach(sq => { if (sq) { if (e) { s += e; e = 0; } s += sq; } else e++; });
    if (e) s += e;
    return s;
  }).join('/');
}

// Best-effort castling rights for a scraped placement (king + rook on home squares).
// ponytail: home-square heuristic — see castlingFromBoard in chess-core.js. Small
//   self-contained copy so this module needs no runtime dependency on chess-core.
function castlingFromPlacement(placement) {
  const board = {};
  placement.split('/').forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { c += parseInt(ch, 10); continue; }
      board['abcdefgh'[c] + (8 - r)] = ch; c++;
    }
  });
  let s = '';
  if (board.e1 === 'K' && board.h1 === 'R') s += 'K';
  if (board.e1 === 'K' && board.a1 === 'R') s += 'Q';
  if (board.e8 === 'k' && board.h8 === 'r') s += 'k';
  if (board.e8 === 'k' && board.a8 === 'r') s += 'q';
  return s || '-';
}

// Heuristic side-to-move from the move list, used only when scraping placement
// (no real FEN available). ponytail: parity of move nodes — imperfect on review
//   boards; the engine corrects course from the move list once play continues.
function getTurnFromMoveList() {
  for (const s of ['[data-whole-move-number]', '.node.selected', '[data-node-ply]']) {
    const nodes = document.querySelectorAll(s);
    if (nodes.length) return (nodes.length % 2 === 0) ? 'w' : 'b';
  }
  return 'w';
}

// Extract the current FEN. A real board attribute carries castling/EP/clocks;
// scraped placement (no history) is the fallback.
//
// There is deliberately no React-state or window.<app-state> lookup: a content
// script runs in an isolated world, where page expandos on DOM nodes and page
// globals are invisible. Probing a live chess.com page with the extension loaded
// confirmed it — those branches never fired, they only made the cascade look
// richer than it is. What actually runs on chess.com today is the piece scrape.
function getFEN() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return null;

  // 1. board attribute — a full, authoritative FEN.
  const attr = board.getAttribute('game-fen') || board.getAttribute('fen');
  if (attr && attr.split('/').length >= 7) return attr;

  // 2. Light-DOM pieces → assemble a FEN (castling estimated from home squares).
  const lightPos = buildFENFromPieces(board);
  if (lightPos) return `${lightPos} ${getTurnFromMoveList()} ${castlingFromPlacement(lightPos)} - 0 1`;

  // 3. Shadow-DOM pieces.
  try {
    const shadow = board.shadowRoot;
    if (shadow) {
      const shadowPos = buildFENFromPieces(shadow);
      if (shadowPos) return `${shadowPos} ${getTurnFromMoveList()} ${castlingFromPlacement(shadowPos)} - 0 1`;
    }
  } catch (_) {}

  return null;
}

function isFlipped(board) {
  return !!board && (
    board.hasAttribute('flipped') ||
    board.getAttribute('orientation') === 'black' ||
    board.classList.contains('flipped')
  );
}

// The player row on the far side of the board. Chess.com always renders you at
// the bottom and the opponent on top, but that row's class names keep changing
// (board-player-component → player-component player-top → player-row-top), so
// match the durable "player…top" shape instead of one generation's names.
function opponentRow() {
  return document.querySelector('[class*="player"][class*="top"], [class*="opponent"]');
}

// Which colour the user is playing. A flipped board means the user is Black.
// Otherwise the user is White — unless a "You" tag sits in the opponent's row,
// which happens when Chess.com resets the orientation in game review.
function getPlayerColor() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (isFlipped(board)) return 'black';

  const top = opponentRow();
  const youOnTop = !!top && (!!top.querySelector('[class*="you"]') || /\bYou\b/.test(top.textContent || ''));
  return youOnTop ? 'black' : 'white';
}

// A rating reads as a bare 3–4 digit number, sometimes parenthesised: chess.com
// renders bot ratings as "(250)".
const RATING_RE = /^\(?(\d{3,4})\)?$/;

function readRating(el) {
  const raw = el.getAttribute?.('data-rating') ?? el.getAttribute?.('data-opponent-rating') ??
    (el.children.length === 0 ? el.textContent : '');
  const m = RATING_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n > 100 && n < 4000) ? n : null;
}

// Opponent Elo, used only to pick the engine's strength. Read the first number
// that looks like a rating inside the opponent's row; if that row is not
// recognisable, take the strongest explicit rating node on the page. 1500 when
// the page carries no rating at all (logged-out pages don't).
// ponytail: no per-selector strategy list — the previous nine hardcoded
//   selectors all missed once chess.com renamed its classes, and every rename
//   needed another branch.
function getOpponentElo() {
  const top = opponentRow();
  if (top) {
    for (const el of top.querySelectorAll('*')) {
      const r = readRating(el);
      if (r) return r;
    }
  }
  const all = [...document.querySelectorAll('[class*="rating"], [data-rating], [data-opponent-rating]')]
    .map(readRating).filter(Boolean);
  return all.length ? Math.max(...all) : 1500;
}

function isGameOver() {
  // Only true game-over signals — NOT generic board modals or the pawn-promotion
  // menu, which also appear mid-game and would falsely trigger the Continue button.
  // `[class*="game-over"]` is the durable catch-all: Chess.com has used a
  // "game-over-*" class on the result modal across many UI revisions.
  const selectors = [
    '[class*="game-over"]',
    '[data-cy="game-over-dialog"]',
    '.game-result-component', '[class*="result-text"]',
  ];
  return selectors.some(s => {
    try { return !!document.querySelector(s); } catch (_) { return false; }
  });
}

// Board square ("e4") under a click, accounting for orientation.
function computeSquareFromClick(board, clientX, clientY) {
  const rect = board.getBoundingClientRect();
  const file = Math.floor(((clientX - rect.left) / rect.width) * 8);
  const rank = Math.floor(((clientY - rect.top) / rect.height) * 8);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  const flipped = isFlipped(board);
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return String.fromCharCode(97 + col) + (row + 1);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIECE_MAP, buildFENFromPieces, castlingFromPlacement, getTurnFromMoveList,
    getFEN, isFlipped, opponentRow, getPlayerColor, readRating, getOpponentElo,
    isGameOver, computeSquareFromClick,
  };
}
