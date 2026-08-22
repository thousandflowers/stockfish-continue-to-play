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
  it('strategy 1 beats strategy 2', () => { expect(d.getOpponentElo()).toBe(1850); });
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

  it('2: React internal state', () => {
    const b = document.createElement('wc-chess-board');
    b[Object.keys(b).find(k => k.startsWith('__')) || '__react$x'] = { setupFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' };
    document.body.appendChild(b);
    expect(d.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('2b: prefers the live position over setupFen (start position)', () => {
    const b = document.createElement('wc-chess-board');
    const advanced = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';
    b[Object.keys(b).find(k => k.startsWith('__')) || '__react$x'] = {
      setupFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // start
      game: { fen: advanced }, // live
    };
    document.body.appendChild(b);
    expect(d.getFEN()).toBe(advanced);
  });

  it('3: window state', () => {
    document.body.appendChild(document.createElement('wc-chess-board'));
    window.chessground = { state: { fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' } };
    expect(d.getFEN()).toBe('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
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

// ── getOpponentElo strategies ────────────────────────────────────────────────
describe('getOpponentElo', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  it('default 1500 with no ratings', () => { expect(d.getOpponentElo()).toBe(1500); });
  it('strategy 3: data-opponent-rating', () => {
    const el = document.createElement('div'); el.setAttribute('data-opponent-rating', '1740');
    document.body.appendChild(el);
    expect(d.getOpponentElo()).toBe(1740);
  });
  it('strategy 9: window.__PRELOADED_STATE__', () => {
    window.__PRELOADED_STATE__ = { game: { opponent: { rating: 2150 } } };
    expect(d.getOpponentElo()).toBe(2150);
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
