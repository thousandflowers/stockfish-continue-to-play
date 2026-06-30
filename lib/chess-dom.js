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

// Extract the current FEN. Sources that carry real castling/EP/clocks are tried
// first; DOM-scraped placement (no history) is the last resort.
function getFEN() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return null;

  // 1. board attribute — a full, authoritative FEN.
  const attr = board.getAttribute('game-fen') || board.getAttribute('fen');
  if (attr && attr.split('/').length >= 7) return attr;

  // 2. React/internal state on the board element.
  try {
    const key = Object.keys(board).find(k => k.startsWith('__'));
    if (key) {
      const s = board[key];
      // Prefer the LIVE position; setupFen is the board's start/setup position and
      // never advances as moves are played — using it first would restart from move 1.
      const f = s?.game?.fen || s?.fen || s?.currentFen || s?.setupFen || s?.game?.setupFen;
      if (f && f.split('/').length >= 7) return f;
    }
  } catch (_) {}

  // 3. Global app state.
  try {
    const f = window.chessground?.state?.fen || window.board?.game?.fen || window.game?.fen;
    if (f && f.split('/').length >= 7) return f;
  } catch (_) {}

  // 4. Light-DOM pieces → assemble a FEN (castling estimated from home squares).
  const lightPos = buildFENFromPieces(board);
  if (lightPos) return `${lightPos} ${getTurnFromMoveList()} ${castlingFromPlacement(lightPos)} - 0 1`;

  // 5. Shadow-DOM pieces.
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

// Which colour the user is playing. A flipped board means the user is Black.
// When the board is not flipped (Chess.com sometimes resets orientation in game
// review), fall back to locating the "You" tag among the player components.
function getPlayerColor() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (isFlipped(board)) return 'black';

  const comps = document.querySelectorAll('.board-player-component');
  if (comps.length >= 2) {
    for (let i = 0; i < comps.length; i++) {
      const you = comps[i].querySelector('.user-tagline-you, [class*="you"]');
      if (you || /\bYou\b/.test(comps[i].textContent || '')) return i === 0 ? 'black' : 'white';
    }
    for (let i = 0; i < comps.length; i++) {
      if (comps[i].querySelector('.user-avatar-image')) return i === 0 ? 'black' : 'white';
    }
  }
  return 'white';
}

// Opponent Elo via a cascade of selectors. Returns 1500 when nothing usable found.
function getOpponentElo() {
  const parse = (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return (n > 100 && n < 4000) ? n : null;
  };
  const strategies = [
    () => { const el = document.querySelector('.board-player-component:first-child .user-tagline-rating'); return el ? parse(el.textContent) : null; },
    () => { const el = document.querySelector('.player-component.player-top .user-tagline-rating'); return el ? parse(el.textContent) : null; },
    () => { const el = document.querySelector('[data-opponent-rating]'); return el ? parse(el.getAttribute('data-opponent-rating')) : null; },
    () => { const el = document.querySelector('.board-player-component:first-child [data-rating]'); return el ? parse(el.getAttribute('data-rating')) : null; },
    () => { const el = document.querySelector('.board-player-component:first-child .rating-number'); return el ? parse(el.textContent) : null; },
    () => {
      const el = document.querySelector('[class*="rating"]:not(.user-tagline-rating):not(body):not(html)');
      if (!el) return null;
      const t = (el.textContent || '').trim();
      return /^\d{3,4}$/.test(t) ? parse(t) : null;
    },
    () => {
      const vals = [...document.querySelectorAll('.user-tagline-rating')].map(el => parse(el.textContent)).filter(Boolean);
      return vals.length ? Math.max(...vals) : null;
    },
    () => {
      const player = document.querySelector('.board-player-component:first-child');
      if (!player) return null;
      try {
        const key = Object.keys(player).find(k => k.startsWith('__'));
        if (key) { const s = player[key]; const r = s?.rating ?? s?.props?.rating ?? s?.user?.rating; return r ? parse(r) : null; }
      } catch (_) {}
      return null;
    },
    () => {
      try {
        const s = window.__PRELOADED_STATE__;
        const r = s?.game?.opponent?.rating ?? s?.data?.opponent?.rating ?? s?.rating;
        return r ? parse(r) : null;
      } catch (_) { return null; }
    },
  ];
  for (const strat of strategies) {
    const r = strat();
    if (r !== null) return r;
  }
  return 1500;
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
    getFEN, isFlipped, getPlayerColor, getOpponentElo, isGameOver, computeSquareFromClick,
  };
}
