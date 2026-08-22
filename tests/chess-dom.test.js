// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

let d;
beforeAll(async () => { d = await import(path.resolve('lib/chess-dom.js')); });

const loadFixture = (name) => fs.readFileSync(path.resolve('tests/fixtures', name), 'utf-8');
const piece = (className) => { const el = document.createElement('div'); el.className = className; return el; };

// ── Realistic HTML fixtures ──────────────────────────────────────────────────
describe('fixture: chesscom-gameover-attr', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-gameover-attr.html'); });
  it('FEN from game-fen attribute', () => {
    expect(d.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });
  it('opponent Elo from user-tagline-rating', () => { expect(d.getOpponentElo()).toBe(1850); });
  it('white player colour (default)', () => { expect(d.getPlayerColor()).toBe('white'); });
  it('game over detected', () => { expect(d.isGameOver()).toBe(true); });
});

describe('fixture: chesscom-gameover-react', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-gameover-react.html'); });
  it('rejects invalid rating 42 → default 1500', () => { expect(d.getOpponentElo()).toBe(1500); });
  it('no FEN on an empty board', () => { expect(d.getFEN()).toBeNull(); });
});

describe('fixture: chesscom-gameover-pieces', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-gameover-pieces.html'); });
  it('FEN from light-DOM pieces', () => {
    const fen = d.getFEN();
    expect(fen).toMatch(/^rnbqkbnr\/pppppppp\//);
    expect(fen).toContain(' b ');
  });
  it('Elo from data-opponent-rating', () => { expect(d.getOpponentElo()).toBe(1740); });
  it('game over detected', () => { expect(d.isGameOver()).toBe(true); });
});

describe('fixture: chesscom-elo-strategies', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-elo-strategies.html'); });
  it('reads the opponent row (player-top), not the first rating on the page', () => {
    expect(d.getOpponentElo()).toBe(1920);
  });
  it('no FEN without a board element', () => { expect(d.getFEN()).toBeNull(); });
  it('no game over', () => { expect(d.isGameOver()).toBe(false); });
});

describe('fixture: chesscom-flipped-board', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-flipped-board.html'); });
  it('FEN from attribute', () => {
    expect(d.getFEN()).toBe('r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  });
  it('black player colour (flipped)', () => { expect(d.getPlayerColor()).toBe('black'); });
  it('opponent Elo', () => { expect(d.getOpponentElo()).toBe(2030); });
});

// ── buildFENFromPieces ───────────────────────────────────────────────────────
describe('buildFENFromPieces', () => {
  it('null with no pieces', () => {
    expect(d.buildFENFromPieces(document.createElement('div'))).toBeNull();
  });
  it('null below the 3-piece noise guard', () => {
    const root = document.createElement('div');
    root.append(piece('piece wk square-11'), piece('piece bk square-88'));
    expect(d.buildFENFromPieces(root)).toBeNull();
  });
  it('parses the start position', () => {
    const root = document.createElement('div');
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece bp square-${f + 1}7`));
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece wp square-${f + 1}2`));
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}1`)));
    expect(d.buildFENFromPieces(root)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  });
});

// ── castlingFromPlacement ────────────────────────────────────────────────────
describe('castlingFromPlacement', () => {
  it('full rights from the start placement', () => {
    expect(d.castlingFromPlacement('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toBe('KQkq');
  });
  it('"-" when kings have left home', () => {
    expect(d.castlingFromPlacement('8/8/8/8/8/8/8/8')).toBe('-');
  });
});

// ── getFEN fallback chain ────────────────────────────────────────────────────
describe('getFEN', () => {
  beforeAll(() => { document.body.innerHTML = ''; }); // clear a prior fixture's DOM
  afterEach(() => { document.body.innerHTML = ''; });

  it('null without a board', () => { expect(d.getFEN()).toBeNull(); });

  it('1: game-fen attribute', () => {
    const b = document.createElement('wc-chess-board');
    b.setAttribute('game-fen', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    document.body.appendChild(b);
    expect(d.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  // A content script runs in an isolated world: page expandos on DOM nodes and
  // page globals are invisible to it. Probing a live chess.com page confirmed
  // those lookups never fire, so getFEN() must not grow them back.
  it('ignores page-world state that a content script cannot actually see', () => {
    const b = document.createElement('wc-chess-board');
    b.__reactFiber$x = { game: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' } };
    document.body.appendChild(b);
    window.chessground = { state: { fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' } };
    expect(d.getFEN()).toBeNull(); // no attribute, no pieces → nothing to read
    delete window.chessground;
  });

  it('4: light-DOM pieces, castling derived from home squares', () => {
    const b = document.createElement('wc-chess-board');
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => b.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    for (let f = 0; f < 8; f++) b.appendChild(piece(`piece bp square-${f + 1}7`));
    for (let f = 0; f < 8; f++) b.appendChild(piece(`piece wp square-${f + 1}2`));
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => b.appendChild(piece(`piece ${p} square-${f + 1}1`)));
    document.body.appendChild(b);
    expect(d.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('null when board has no usable position', () => {
    document.body.appendChild(document.createElement('wc-chess-board'));
    expect(d.getFEN()).toBeNull();
  });
});

// ── getPlayerColor ───────────────────────────────────────────────────────────
describe('getPlayerColor', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('white by default', () => {
    document.body.appendChild(document.createElement('wc-chess-board'));
    expect(d.getPlayerColor()).toBe('white');
  });
  it('black when flipped', () => {
    const b = document.createElement('wc-chess-board');
    b.setAttribute('flipped', '');
    document.body.appendChild(b);
    expect(d.getPlayerColor()).toBe('black');
  });
  it('black when orientation="black"', () => {
    const b = document.createElement('chess-board');
    b.setAttribute('orientation', 'black');
    document.body.appendChild(b);
    expect(d.getPlayerColor()).toBe('black');
  });
  it('reads "You" tag when board is not flipped (game review)', () => {
    document.body.appendChild(document.createElement('wc-chess-board'));
    const top = document.createElement('div'); top.className = 'board-player-component';
    const bottom = document.createElement('div'); bottom.className = 'board-player-component';
    bottom.innerHTML = '<span class="user-tagline-you">You</span>';
    document.body.append(top, bottom);
    expect(d.getPlayerColor()).toBe('white'); // "You" at bottom (index 1) → white
  });
});

// ── the real game-over modal ─────────────────────────────────────────────────
describe('fixture: chesscom-gameover-real-modal (captured from live chess.com)', () => {
  beforeAll(() => { document.body.innerHTML = loadFixture('chesscom-gameover-real-modal.html'); });
  it('game over detected', () => { expect(d.isGameOver()).toBe(true); });
  it('finds the modal', () => {
    expect(d.findGameOverModal()?.className).toContain('game-over-modal-shell-container');
  });
  it('anchors next to Chess.com\'s own button, not the close X', () => {
    const a = d.modalButtonAnchor(d.findGameOverModal());
    expect(a.getAttribute('aria-label')).toBe('New Game');
  });
  it('anchor is inside the modal button row, so our trigger lands there too', () => {
    const a = d.modalButtonAnchor(d.findGameOverModal());
    expect(a.parentElement.className).toContain('game-over-modal-shell-buttons');
  });
});

// ── getTurnFromMoveList ──────────────────────────────────────────────────────
// Shapes taken from a live chess.com analysis board, not invented.
describe('getTurnFromMoveList', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const movelist = (...plies) => {
    document.body.innerHTML = '<div class="analysis-view-movelist move-list">' +
      plies.map((san, i) => `<div class="node ${i % 2 ? 'black' : 'white'}-move main-line-ply">${san}</div>`).join('') +
      '</div>';
  };
  it('white by default with no move list', () => { expect(d.getTurnFromMoveList()).toBe('w'); });
  it('black to move after White played', () => { movelist('e4'); expect(d.getTurnFromMoveList()).toBe('b'); });
  it('white to move after Black replied', () => { movelist('e4', 'e5'); expect(d.getTurnFromMoveList()).toBe('w'); });
  it('black to move again on the next White move', () => {
    movelist('e4', 'e5', 'Nf3'); expect(d.getTurnFromMoveList()).toBe('b');
  });
  it('falls back to the last-move highlight when there is no move list', () => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = '<div class="highlight square-52"></div><div class="highlight square-54"></div>' +
                  '<div class="piece wp square-54"></div>';
    document.body.appendChild(b);
    expect(d.getTurnFromMoveList()).toBe('b'); // a white pawn just landed there
  });
});

// ── getOpponentElo strategies ────────────────────────────────────────────────
describe('getOpponentElo', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('default 1500 with no ratings', () => { expect(d.getOpponentElo()).toBe(1500); });
  it('strategy 3: data-opponent-rating', () => {
    const el = document.createElement('div'); el.setAttribute('data-opponent-rating', '1740');
    document.body.appendChild(el);
    expect(d.getOpponentElo()).toBe(1740);
  });
  it('parenthesised bot rating, as chess.com renders it today', () => {
    document.body.innerHTML =
      '<div class="player-row-component player-row-top">' +
      '<span class="cc-user-username-white">Cyclops</span>' +
      '<span class="cc-text-medium cc-user-rating-white">(250)</span></div>';
    expect(d.getOpponentElo()).toBe(250);
  });
  it('prefers the opponent row over the player\'s own rating', () => {
    document.body.innerHTML =
      '<div class="player-row-component player-row-top"><span class="cc-user-rating-white">1180</span></div>' +
      '<div class="player-row-component player-row-bottom"><span class="cc-user-rating-white">2400</span></div>';
    expect(d.getOpponentElo()).toBe(1180);
  });
  it('ignores page-world state a content script cannot see', () => {
    window.__PRELOADED_STATE__ = { game: { opponent: { rating: 2150 } } };
    expect(d.getOpponentElo()).toBe(1500);
    delete window.__PRELOADED_STATE__;
  });
  it('rejects out-of-range ratings', () => {
    const mk = (v) => { const s = document.createElement('div'); s.className = 'board-player-component'; const r = document.createElement('span'); r.className = 'user-tagline-rating'; r.textContent = v; s.appendChild(r); return s; };
    document.body.appendChild(mk('42'));
    expect(d.getOpponentElo()).toBe(1500);
    document.body.innerHTML = '';
    document.body.appendChild(mk('9999'));
    expect(d.getOpponentElo()).toBe(1500);
  });
});

// ── isGameOver ───────────────────────────────────────────────────────────────
describe('isGameOver', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('false by default', () => { expect(d.isGameOver()).toBe(false); });
  it('true with a game-over modal', () => {
    const e = document.createElement('div'); e.className = 'game-over-modal-content';
    document.body.appendChild(e);
    expect(d.isGameOver()).toBe(true);
  });
  it('false for the mid-game pawn-promotion menu', () => {
    const e = document.createElement('div'); e.className = 'pawn-promotion-menu';
    document.body.appendChild(e);
    expect(d.isGameOver()).toBe(false);
  });
});

// ── computeSquareFromClick ───────────────────────────────────────────────────
describe('computeSquareFromClick', () => {
  const board = (flipped) => {
    const b = document.createElement('wc-chess-board');
    if (flipped) b.setAttribute('flipped', '');
    b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800, right: 800, bottom: 800 });
    return b;
  };
  it('top-left is a8 (not flipped)', () => { expect(d.computeSquareFromClick(board(false), 50, 50)).toBe('a8'); });
  it('bottom-left is a1 (not flipped)', () => { expect(d.computeSquareFromClick(board(false), 50, 750)).toBe('a1'); });
  it('top-left is h1 (flipped)', () => { expect(d.computeSquareFromClick(board(true), 50, 50)).toBe('h1'); });
  it('null outside the board', () => { expect(d.computeSquareFromClick(board(false), 900, 50)).toBeNull(); });
});
