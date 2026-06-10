// ── Chess utility functions for Stockfish Continue to Play ──────────────────
// Shared between content_chesscom.js and automated tests.
// No chrome.*, Worker, or fetch — pure DOM-only functions.

const PIECE_MAP = {
  'wk':'K','wq':'Q','wr':'R','wb':'B','wn':'N','wp':'P',
  'bk':'k','bq':'q','br':'r','bb':'b','bn':'n','bp':'p'
};

function eloToLichessLevel(elo) {
  if (elo < 1000) return 1;
  if (elo < 1200) return 2;
  if (elo < 1400) return 3;
  if (elo < 1600) return 4;
  if (elo < 1800) return 5;
  if (elo < 2000) return 6;
  if (elo < 2300) return 7;
  return 8;
}

function eloToSkill(elo) {
  const levels = [800, 1000, 1200, 1400, 1600, 1800, 2000];
  const skills = [0, 3, 6, 9, 12, 15, 18, 20];
  for (let i = 0; i < levels.length; i++) if (elo < levels[i]) return skills[i];
  return 20;
}

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
      if (m) { file = parseInt(m[1]) - 1; rank = parseInt(m[2]) - 1; }
    });
    if (piece && file >= 0 && rank >= 0) {
      grid[7 - rank][file] = piece;
      found++;
    }
  });
  if (found < 3) return null;
  return grid.map(row => {
    let s = '', e = 0;
    row.forEach(sq => { if (sq) { if (e) { s += e; e = 0; } s += sq; } else e++; });
    if (e) s += e;
    return s;
  }).join('/');
}

function getTurnFromMoveList() {
  const selectors = [
    '[data-whole-move-number]',
    '.node.selected',
    '[data-node-ply]',
  ];
  for (const s of selectors) {
    const nodes = document.querySelectorAll(s);
    if (nodes.length) return (nodes.length % 2 === 0) ? 'w' : 'b';
  }
  return 'w';
}

function getFEN() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return null;

  const attr = board.getAttribute('game-fen') || board.getAttribute('fen');
  if (attr && attr.split('/').length >= 7) {
    console.log('[Stockfish+][fen:1] attribute');
    return attr;
  }

  try {
    const key = Object.keys(board).find(k => k.startsWith('__'));
    if (key) {
      const s = board[key];
      const f = s?.setupFen || s?.game?.fen || s?.fen || s?.currentFen || s?.game?.setupFen;
      if (f && f.split('/').length >= 7) {
        console.log('[Stockfish+][fen:2] internal state');
        return f;
      }
    }
  } catch (_) {}

  const lightPos = buildFENFromPieces(board);
  if (lightPos) {
    const fen = `${lightPos} ${getTurnFromMoveList()} - - 0 1`;
    console.log('[Stockfish+][fen:3] light DOM pieces');
    return fen;
  }

  try {
    const shadow = board.shadowRoot;
    if (shadow) {
      const shadowPos = buildFENFromPieces(shadow);
      if (shadowPos) {
        const fen = `${shadowPos} ${getTurnFromMoveList()} - - 0 1`;
        console.log('[Stockfish+][fen:4] shadow DOM');
        return fen;
      }
    }
  } catch (_) {}

  try {
    const state = window.chessground?.state?.fen
                || window.board?.game?.fen
                || window.game?.fen;
    if (state && state.split('/').length >= 7) {
      console.log('[Stockfish+][fen:5] window state');
      return state;
    }
  } catch (_) {}

  console.warn('[Stockfish+][fen:0] ALL METHODS FAILED');
  return null;
}

function getPlayerColor() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (!board) return 'white';
  const flipped = board.hasAttribute('flipped') ||
                  board.getAttribute('orientation') === 'black' ||
                  board.classList.contains('flipped');
  return flipped ? 'black' : 'white';
}

function getOpponentElo() {
  const parseRating = (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''));
    return (n > 100 && n < 4000) ? n : null;
  };

  const strategies = [

    // 1: direct opponent section (first-child)
    () => {
      const el = document.querySelector('.board-player-component:first-child .user-tagline-rating');
      return el ? parseRating(el.textContent) : null;
    },

    // 2: .player-component.player-top
    () => {
      const el = document.querySelector('.player-component.player-top .user-tagline-rating');
      return el ? parseRating(el.textContent) : null;
    },

    // 3: [data-opponent-rating] attribute
    () => {
      const el = document.querySelector('[data-opponent-rating]');
      return el ? parseRating(el.getAttribute('data-opponent-rating')) : null;
    },

    // 4: [data-rating] on opponent element
    () => {
      const el = document.querySelector('.board-player-component:first-child [data-rating]');
      return el ? parseRating(el.getAttribute('data-rating')) : null;
    },

    // 5: .rating-number inside opponent section
    () => {
      const el = document.querySelector('.board-player-component:first-child .rating-number');
      return el ? parseRating(el.textContent) : null;
    },

    // 6: generic rating-like class (exclude known .user-tagline-rating)
    () => {
      const el = document.querySelector(
        '[class*="rating"]:not(.user-tagline-rating):not(body):not(html)'
      );
      if (!el) return null;
      const text = el.textContent.trim();
      // only grab short numeric strings (ratings, not "rating" text)
      if (/^\d{3,4}$/.test(text)) return parseRating(text);
      return null;
    },

    // 7: any .user-tagline-rating (take max)
    () => {
      const all = [...document.querySelectorAll('.user-tagline-rating')];
      const vals = all.map(el => parseRating(el.textContent)).filter(Boolean);
      return vals.length ? Math.max(...vals) : null;
    },

    // 8: React internal state on opponent section
    () => {
      const player = document.querySelector('.board-player-component:first-child');
      if (!player) return null;
      try {
        const key = Object.keys(player).find(k => k.startsWith('__'));
        if (key) {
          const s = player[key];
          const r = s?.rating ?? s?.props?.rating ?? s?.user?.rating;
          return r ? parseRating(r) : null;
        }
      } catch (_) {}
      return null;
    },

    // 9: window.__PRELOADED_STATE__
    () => {
      try {
        const s = window.__PRELOADED_STATE__;
        if (!s) return null;
        const r = s?.game?.opponent?.rating
               ?? s?.data?.opponent?.rating
               ?? s?.rating;
        return r ? parseRating(r) : null;
      } catch (_) {}
      return null;
    },

  ];

  for (let i = 0; i < strategies.length; i++) {
    const result = strategies[i]();
    if (result !== null) {
      console.log(`[Stockfish+][elo:${i + 1}] ${result}`);
      return result;
    }
  }

  console.log('[Stockfish+][elo:0] ALL METHODS FAILED — default 1500');
  return 1500;
}

function isGameOver() {
  return !!(
    document.querySelector('.game-over-modal-content') ||
    document.querySelector('.game-over-modal-component') ||
    document.querySelector('.game-over-buttons-component')
  );
}

// Node.js test support — unused in Chrome extension context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIECE_MAP,
    eloToLichessLevel,
    eloToSkill,
    buildFENFromPieces,
    getTurnFromMoveList,
    getFEN,
    getPlayerColor,
    getOpponentElo,
    isGameOver,
  };
}
