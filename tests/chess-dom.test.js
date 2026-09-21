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
  it('null when a king is missing - that is what noise looks like', () => {
    const root = document.createElement('div');
    root.append(piece('piece wp square-11'), piece('piece bp square-88'), piece('piece wr square-44'));
    expect(d.buildFENFromPieces(root)).toBeNull();
  });
  it('two bare kings ARE a position, and a drawn one', () => {
    // The old count-based guard rejected this, so continuing from a bare-kings
    // ending said "Position not found" instead of "Already a draw".
    const root = document.createElement('div');
    root.append(piece('piece wk square-51'), piece('piece bk square-58'));
    expect(d.buildFENFromPieces(root)).toBe('4k3/8/8/8/8/8/8/4K3');
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

// ── averageMoveSeconds ───────────────────────────────────────────────────────
describe('averageMoveSeconds', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const list = (plies) => {
    document.body.innerHTML = '<div class="move-list">' + plies.map(([san, clock], i) =>
      `<div class="node ${i % 2 ? 'black' : 'white'}-move main-line-ply">${san}` +
      (clock ? `<span class="node-clock">${clock}</span>` : '') + '</div>').join('') + '</div>';
  };
  it('null when the move list has no clocks', () => {
    list([['e4'], ['e5'], ['Nf3'], ['Nc6']]);
    expect(d.averageMoveSeconds()).toBeNull();
  });
  it('null on a move list too short to measure', () => {
    list([['e4', '9:58'], ['e5', '9:57']]);
    expect(d.averageMoveSeconds()).toBeNull();
  });
  it('averages each side\'s own clock drops', () => {
    // White's clock: 9:58 → 9:54 → 9:50, so 4s per move.
    // Black's:       9:54 → 9:46 → 9:38, so 8s per move. Mean 6.
    list([['e4', '9:58'], ['e5', '9:54'], ['Nf3', '9:54'], ['Nc6', '9:46'],
          ['Bb5', '9:50'], ['a6', '9:38']]);
    expect(d.averageMoveSeconds()).toBeCloseTo(6, 1);
  });
  it('ignores a clock that went up (increment) and keeps the rest', () => {
    list([['e4', '9:50'], ['e5', '9:40'], ['Nf3', '9:55'], ['Nc6', '9:36'],
          ['Bc4', '9:51'], ['Nf6', '9:32']]);
    expect(d.averageMoveSeconds()).toBeCloseTo(4, 1);
  });
  it('reads tenths', () => { expect(d.parseClock('0:59.4')).toBeCloseTo(59.4, 1); });
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

// ── readSideToMove ───────────────────────────────────────────────────────────
// Navigating the move list after a game is the whole point of "continue from
// the position on the board", so the side to move has to follow the SELECTED
// ply, not the last one played.
describe('readSideToMove', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  // `sel` is the index of the ply Chess.com is showing, -1 for none marked.
  const movelist = (plies, sel = -1) => {
    document.body.innerHTML = '<div class="analysis-view-movelist move-list">' +
      plies.map((san, i) => `<div class="node ${i % 2 ? 'black' : 'white'}-move main-line-ply` +
        `${i === sel ? ' selected' : ''}">${san}</div>`).join('') +
      '</div>';
  };
  const highlight = (from, to, pieceClass) => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = `<div class="highlight square-${from}"></div><div class="highlight square-${to}"></div>` +
                  `<div class="piece ${pieceClass} square-${to}"></div>`;
    document.body.appendChild(b);
  };

  it('black is up when the selected ply is White’s', () => {
    movelist(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 2); // 3rd ply, White played Nf3
    expect(d.readSideToMove()).toBe('b');
  });
  it('white is up when the selected ply is Black’s', () => {
    movelist(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 3); // 4th ply, Black played Nc6
    expect(d.readSideToMove()).toBe('w');
  });
  it('the selected ply wins over the last one played', () => {
    movelist(['e4', 'e5', 'Nf3', 'Nc6'], 0); // scrubbed back to right after 1. e4
    expect(d.readSideToMove()).toBe('b');
  });
  it('reads a selection marked with aria-selected', () => {
    movelist(['e4', 'e5', 'Nf3']);
    document.querySelectorAll('.node')[1].setAttribute('aria-selected', 'true');
    expect(d.readSideToMove()).toBe('w');
  });
  it('index parity decides when the colour classes are gone', () => {
    document.body.innerHTML = '<div class="move-list">' +
      ['e4', 'e5', 'Nf3'].map((s, i) => `<div class="main-line-ply${i === 1 ? ' selected' : ''}">${s}</div>`).join('') +
      '</div>';
    expect(d.readSideToMove()).toBe('w'); // ply 2 was Black's
  });
  it('the board breaks a tie between index and colour class', () => {
    document.body.innerHTML = '<div class="move-list">' +
      '<div class="node white-move main-line-ply">e4</div>' +
      '<div class="node white-move main-line-ply selected">e5</div>' + // mislabelled
      '</div>';
    highlight('57', '55', 'bp'); // a black pawn landed on e5, so White is up
    expect(d.readSideToMove()).toBe('w');
  });
  it('null when index and colour class disagree and the board is silent', () => {
    document.body.innerHTML = '<div class="move-list">' +
      '<div class="node white-move main-line-ply">e4</div>' +
      '<div class="node white-move main-line-ply selected">e5</div>' +
      '</div>';
    expect(d.readSideToMove()).toBeNull();
  });
  it('with nothing marked the board wins over the end of the list', () => {
    movelist(['e4', 'e5', 'Nf3', 'Nc6']); // list says White is up
    highlight('52', '54', 'wp');          // board shows a white pawn just landed
    expect(d.readSideToMove()).toBe('b');
  });
  it('falls back to the end of the list when nothing else is readable', () => {
    movelist(['e4', 'e5', 'Nf3']);
    expect(d.readSideToMove()).toBe('b');
  });
  it('null on a page with no move list and no board', () => {
    expect(d.readSideToMove()).toBeNull();
  });
  it('getTurnFromMoveList still defaults to white on an empty page', () => {
    expect(d.getTurnFromMoveList()).toBe('w');
  });
  it('ignores our own overlay pieces when reading the highlight', () => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = '<div class="highlight square-52"></div><div class="highlight square-54"></div>' +
                  '<div class="piece wp square-54" data-sfct="piece"></div>';
    document.body.appendChild(b);
    expect(d.readSideToMove()).toBeNull();
  });
});

// ── enPassantTarget ──────────────────────────────────────────────────────────
// The only legal move a scraped position can lose. Castling can only ever be
// over-granted by the home-square heuristic, promotion does not depend on the
// start FEN at all, and the two counters cannot make anything illegal — but a
// capture en passant is simply absent from the engine's move list when the FEN
// says "-", and the refusal reads as a bug.
describe('enPassantTarget', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const withHighlights = (...squares) => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = squares.map(s => `<div class="highlight square-${s}"></div>`).join('');
    document.body.appendChild(b);
    return b;
  };

  it('d7-d5 leaves d6 capturable', () => {
    withHighlights('47', '45');
    expect(d.enPassantTarget('8/8/8/3p4/8/8/8/8')).toBe('d6');
  });
  it('e2-e4 leaves e3 capturable', () => {
    withHighlights('52', '54');
    expect(d.enPassantTarget('8/8/8/8/4P3/8/8/8')).toBe('e3');
  });
  it('a single push is not a double push', () => {
    withHighlights('46', '45');
    expect(d.enPassantTarget('8/8/8/3p4/8/8/8/8')).toBe('-');
  });
  it('a knight hop is not a double push', () => {
    withHighlights('71', '63');
    expect(d.enPassantTarget('8/8/8/8/8/5N2/8/8')).toBe('-');
  });
  it('two squares apart but no pawn landed there', () => {
    withHighlights('41', '43');
    expect(d.enPassantTarget('8/8/8/8/8/3R4/8/8')).toBe('-');
  });
  it('a pawn on the wrong rank is not a double push', () => {
    withHighlights('44', '46');
    expect(d.enPassantTarget('8/8/3p4/8/8/8/8/8')).toBe('-');
  });
  it('dash when the board is not highlighting at all', () => {
    withHighlights();
    expect(d.enPassantTarget('8/8/8/3p4/8/8/8/8')).toBe('-');
  });
  it('dash when there is no board', () => {
    expect(d.enPassantTarget('8/8/8/3p4/8/8/8/8')).toBe('-');
  });
  it('getFEN puts the target in the fourth field', () => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = '<div class="highlight square-47"></div><div class="highlight square-45"></div>' +
                  '<div class="piece bp square-45"></div><div class="piece wp square-54"></div>' +
                  '<div class="piece wk square-51"></div><div class="piece bk square-58"></div>';
    document.body.appendChild(b);
    expect(d.getFEN().split(' ')[3]).toBe('d6');
  });
});

// ── isGameOver: only a VISIBLE game-over surface counts ──────────────────────
// Fair play depends entirely on this one predicate: it is what keeps the
// trigger off a live board. A game-over node left mounted but hidden - after a
// rematch, or rendered ahead of time - must not read as a finished game.
describe('isGameOver visibility', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const modal = (style) => {
    const e = document.createElement('div');
    e.className = 'game-over-modal-content';
    if (style) e.setAttribute('style', style);
    document.body.appendChild(e);
    return e;
  };

  it('a visible modal still counts', () => { modal(); expect(d.isGameOver()).toBe(true); });
  it('display:none does not count', () => { modal('display:none'); expect(d.isGameOver()).toBe(false); });
  it('visibility:hidden does not count', () => { modal('visibility:hidden'); expect(d.isGameOver()).toBe(false); });
  it('an ancestor-hidden modal does not count', () => {
    const e = modal();
    e.checkVisibility = () => false; // what a browser answers inside a hidden parent
    expect(d.isGameOver()).toBe(false);
  });
  it('one hidden and one visible still counts', () => {
    modal('display:none'); modal();
    expect(d.isGameOver()).toBe(true);
  });
});

// ── Which board gets read ────────────────────────────────────────────────────
// getFEN() took the FIRST board in the document while the content script played
// on the LARGEST visible one. On a page carrying more than one they disagree,
// and navigating the move list is exactly where a second board shows up.
describe('board selection and our own pieces', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const boardWith = (...classes) => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = classes.map(c => `<div class="piece ${c}"></div>`).join('');
    document.body.appendChild(b);
    return b;
  };

  it('reads the board it is handed, not the first one on the page', () => {
    boardWith('wk square-11', 'bk square-18', 'wp square-21');           // decoy
    const real = boardWith('wk square-51', 'bk square-58', 'wp square-54');
    expect(d.getFEN(real).split(' ')[0]).toContain('4K3');
  });
  it('falls back to the first board when handed nothing', () => {
    boardWith('wk square-11', 'bk square-18', 'wp square-21');
    expect(d.getFEN().split(' ')[0]).toContain('KP6');
  });
  it('our own overlay pieces are not part of the position', () => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = '<div class="piece wk square-51"></div><div class="piece bk square-58"></div>' +
                  '<div class="piece wp square-54"></div>' +
                  '<div class="piece wq square-41" data-sfct="piece"></div>';
    document.body.appendChild(b);
    expect(d.buildFENFromPieces(b)).not.toContain('Q');
  });
});

// ── sidebarPanel ─────────────────────────────────────────────────────────────
// With no game-over modal to dock under - a finished game you came back to,
// which is when you actually sit and walk the move list - the trigger anchors
// to the column the move list lives in.
describe('sidebarPanel', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('walks out of the move list to the column around it', () => {
    document.body.innerHTML =
      '<div class="board-layout-sidebar"><div class="inner">' +
      '<div class="move-list-wrapper"><div class="node white-move">e4</div></div>' +
      '</div></div>';
    expect(d.sidebarPanel()?.className).toBe('board-layout-sidebar');
  });
  it('matches a renamed column on the durable side/rail shape', () => {
    document.body.innerHTML =
      '<div class="game-sidebar-component"><div class="movelist">x</div></div>';
    expect(d.sidebarPanel()?.className).toBe('game-sidebar-component');
  });
  it('falls back to the move list when no column is recognisable', () => {
    document.body.innerHTML = '<div class="wrap"><div class="move-list">x</div></div>';
    expect(d.sidebarPanel()?.className).toBe('move-list');
  });
  it('null when the page has no move list at all', () => {
    document.body.innerHTML = '<div class="board-layout-sidebar"></div>';
    expect(d.sidebarPanel()).toBeNull();
  });
});

// ── isSelectedPly: a marker that is not a marker ─────────────────────────────
// The dangerous direction is a FALSE positive. Anchoring on the wrong ply makes
// both list readings agree with each other on that wrong node, so the answer
// comes back confident instead of falling through to the board.
describe('isSelectedPly strictness', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const list = (...classes) => {
    document.body.innerHTML = '<div class="move-list">' +
      classes.map((c, i) => `<div class="node ${i % 2 ? 'black' : 'white'}-move main-line-ply ${c}">x</div>`).join('') +
      '</div>';
  };
  const highlight = (from, to, pieceClass) => {
    const b = document.createElement('wc-chess-board');
    b.innerHTML = `<div class="highlight square-${from}"></div><div class="highlight square-${to}"></div>` +
                  `<div class="piece ${pieceClass} square-${to}"></div>`;
    document.body.appendChild(b);
  };

  it('“de-selected” is not selected', () => {
    list('', 'de-selected', '', '');
    expect(d.plyNodes().some(d.isSelectedPly)).toBe(false);
  });
  it('“not-selected” is not selected', () => {
    list('not-selected', '', '', '');
    expect(d.plyNodes().some(d.isSelectedPly)).toBe(false);
  });
  it('a negated marker does not anchor the answer on the wrong ply', () => {
    list('', 'de-selected', '', ''); // 4 plies, last is Black's, so White is up
    expect(d.readSideToMove()).toBe('w');
  });
  it('“selected” as a whole token still counts', () => {
    list('', 'selected', '', '');
    expect(d.readSideToMove()).toBe('w'); // ply 2 was Black's
  });
  it('two plies claiming the selection defer to the board', () => {
    list('selected', '', 'selected', '');
    highlight('52', '54', 'wp'); // a white pawn just landed: Black is up
    expect(d.readSideToMove()).toBe('b');
  });
});
