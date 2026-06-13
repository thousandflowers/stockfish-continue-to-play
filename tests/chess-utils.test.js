import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'path';

let utils;

beforeAll(async () => {
  const mod = await import(path.resolve('lib/chess-utils.js'));
  utils = mod;
});

// ── eloToLichessLevel ────────────────────────────────────────────────────

describe('eloToLichessLevel', () => {
  it('1 for elo < 1000', () => {
    expect(utils.eloToLichessLevel(0)).toBe(1);
    expect(utils.eloToLichessLevel(500)).toBe(1);
    expect(utils.eloToLichessLevel(999)).toBe(1);
  });

  it('2 for 1000–1199', () => {
    expect(utils.eloToLichessLevel(1000)).toBe(2);
    expect(utils.eloToLichessLevel(1100)).toBe(2);
    expect(utils.eloToLichessLevel(1199)).toBe(2);
  });

  it('3 for 1200–1399', () => {
    expect(utils.eloToLichessLevel(1200)).toBe(3);
    expect(utils.eloToLichessLevel(1300)).toBe(3);
    expect(utils.eloToLichessLevel(1399)).toBe(3);
  });

  it('4 for 1400–1599', () => {
    expect(utils.eloToLichessLevel(1400)).toBe(4);
    expect(utils.eloToLichessLevel(1500)).toBe(4);
    expect(utils.eloToLichessLevel(1599)).toBe(4);
  });

  it('5 for 1600–1799', () => {
    expect(utils.eloToLichessLevel(1600)).toBe(5);
    expect(utils.eloToLichessLevel(1700)).toBe(5);
    expect(utils.eloToLichessLevel(1799)).toBe(5);
  });

  it('6 for 1800–1999', () => {
    expect(utils.eloToLichessLevel(1800)).toBe(6);
    expect(utils.eloToLichessLevel(1900)).toBe(6);
    expect(utils.eloToLichessLevel(1999)).toBe(6);
  });

  it('7 for 2000–2299', () => {
    expect(utils.eloToLichessLevel(2000)).toBe(7);
    expect(utils.eloToLichessLevel(2200)).toBe(7);
    expect(utils.eloToLichessLevel(2299)).toBe(7);
  });

  it('8 for 2300+', () => {
    expect(utils.eloToLichessLevel(2300)).toBe(8);
    expect(utils.eloToLichessLevel(3000)).toBe(8);
    expect(utils.eloToLichessLevel(9999)).toBe(8);
  });
});

// ── eloToUCIElo ──────────────────────────────────────────────────────────

describe('eloToUCIElo', () => {
  it('clamps below 400 to 1320', () => {
    expect(utils.eloToUCIElo(0)).toBe(1320);
    expect(utils.eloToUCIElo(399)).toBe(1320);
  });

  it('maps 400 → 1320', () => {
    expect(utils.eloToUCIElo(400)).toBe(1320);
  });

  it('maps 1450 (midpoint approximation)', () => {
    // 1450 is exactly halfway through 400-2500
    // Expected: 1320 + (3190-1320) * ((1450-400)/(2500-400))
    // = 1320 + 1870 * (1050/2100) = 1320 + 1870 * 0.5 = 1320 + 935 = 2255
    expect(utils.eloToUCIElo(1450)).toBe(2255);
  });

  it('maps 2500 → 3190', () => {
    expect(utils.eloToUCIElo(2500)).toBe(3190);
  });

  it('clamps above 2500 to 3190', () => {
    expect(utils.eloToUCIElo(3000)).toBe(3190);
    expect(utils.eloToUCIElo(9999)).toBe(3190);
  });

  it('linear — 1000 maps to ~1644', () => {
    // 1320 + 1870 * (600/2100) = 1320 + 534.28... = 1854
    // Wait: 1000-400 = 600. 600/2100 = 0.2857... 1870 * 0.2857 = 534.28
    // 1320 + 534 = 1854
    expect(utils.eloToUCIElo(1000)).toBe(1854);
  });

  it('linear — 2000 maps to ~2749', () => {
    // 2000-400 = 1600. 1600/2100 = 0.7619... 1870 * 0.7619 = 1424.76
    // 1320 + 1425 = 2745
    // Let me compute precisely: 1320 + 1870 * (1600/2100) = 1320 + 1870 * 16/21
    // = 1320 + 29920/21 = 1320 + 1424.76... = 2744.76... → round → 2745
    expect(utils.eloToUCIElo(2000)).toBe(2745);
  });

  it('rounds to nearest integer', () => {
    // 401 elo: 1320 + 1870 * (1/2100) = 1320 + 0.89 = 1320.89 → 1321
    expect(utils.eloToUCIElo(401)).toBe(1321);
  });
});

// ── PIECE_MAP ──────────────────────────────────────────────────────────

describe('PIECE_MAP', () => {
  it('maps all 12 piece types', () => {
    expect(utils.PIECE_MAP).toEqual({
      wk: 'K', wq: 'Q', wr: 'R', wb: 'B', wn: 'N', wp: 'P',
      bk: 'k', bq: 'q', br: 'r', bb: 'b', bn: 'n', bp: 'p',
    });
  });
});

function piece(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

// ── buildFENFromPieces ─────────────────────────────────────────────────

describe('buildFENFromPieces', () => {

  it('null when no piece divs', () => {
    const root = document.createElement('div');
    expect(utils.buildFENFromPieces(root)).toBeNull();
  });

  it('null for < 3 pieces (noise guard)', () => {
    const root = document.createElement('div');
    root.appendChild(piece('piece wk square-11'));
    root.appendChild(piece('piece bk square-88'));
    expect(utils.buildFENFromPieces(root)).toBeNull();
  });

  it('parses starting position', () => {
    const root = document.createElement('div');
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'.split('|')
    // black back rank (rank 8)
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    // black pawns (rank 7)
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece bp square-${f + 1}7`));
    // white pawns (rank 2)
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece wp square-${f + 1}2`));
    // white back rank (rank 1)
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}1`)));

    expect(utils.buildFENFromPieces(root)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
  });

  it('parses position after 1.e4', () => {
    const root = document.createElement('div');
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece bp square-${f + 1}7`));
    // e4 pawn (file 5, rank 4)
    root.appendChild(piece('piece wp square-54'));
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}1`)));
    for (let f = 0; f < 8; f++) { if (f !== 4) root.appendChild(piece(`piece wp square-${f + 1}2`)); }

    expect(utils.buildFENFromPieces(root)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
  });
});

// ── getTurnFromMoveList ─────────────────────────────────────────────────

describe('getTurnFromMoveList', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('defaults to "w" when no moves', () => {
    expect(utils.getTurnFromMoveList()).toBe('w');
  });

  it('odd moves = "b" (white just moved)', () => {
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.setAttribute('data-whole-move-number', String(i));
      document.body.appendChild(el);
    }
    expect(utils.getTurnFromMoveList()).toBe('b');
  });

  it('even moves = "w" (black just moved)', () => {
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.setAttribute('data-whole-move-number', String(i));
      document.body.appendChild(el);
    }
    expect(utils.getTurnFromMoveList()).toBe('w');
  });

  it('uses .node.selected as fallback selector', () => {
    for (let i = 0; i < 5; i++) {
      const el = document.createElement('div');
      el.className = 'node selected';
      document.body.appendChild(el);
    }
    expect(utils.getTurnFromMoveList()).toBe('b');
  });
});

// ── getFEN (all 5 fallback methods) ─────────────────────────────────────

describe('getFEN', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('null when no board element', () => {
    expect(utils.getFEN()).toBeNull();
  });

  it('method 1: direct game-fen attribute', () => {
    const board = document.createElement('wc-chess-board');
    board.setAttribute('game-fen', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    document.body.appendChild(board);
    expect(utils.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  it('method 1: fen attribute fallback', () => {
    const board = document.createElement('chess-board');
    board.setAttribute('fen', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    document.body.appendChild(board);
    expect(utils.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });

  it('method 2: React internal state', () => {
    const board = document.createElement('wc-chess-board');
    board[Object.keys(board).find(k => k.startsWith('__')) || '__reactInternal$test'] = {
      setupFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    };
    document.body.appendChild(board);
    expect(utils.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('method 3: light DOM pieces', () => {
    const root = document.createElement('wc-chess-board');
    // 3 move nodes → odd → 'b'
    for (let i = 0; i < 3; i++) {
      const m = document.createElement('div');
      m.setAttribute('data-whole-move-number', String(i));
      document.body.appendChild(m);
    }
    // 1.e4 position
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    for (let f = 0; f < 8; f++) root.appendChild(piece(`piece bp square-${f + 1}7`));
    root.appendChild(piece('piece wp square-54'));
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => root.appendChild(piece(`piece ${p} square-${f + 1}1`)));
    for (let f = 0; f < 8; f++) { if (f !== 4) root.appendChild(piece(`piece wp square-${f + 1}2`)); }
    document.body.appendChild(root);

    expect(utils.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1');
  });

  it('method 4: shadow DOM', () => {
    const root = document.createElement('wc-chess-board');
    const shadow = root.attachShadow({ mode: 'open' });
    for (let i = 0; i < 3; i++) {
      const m = document.createElement('div');
      m.setAttribute('data-whole-move-number', String(i));
      document.body.appendChild(m);
    }
    'br,bn,bb,bq,bk,bb,bn,br'.split(',').forEach((p, f) => shadow.appendChild(piece(`piece ${p} square-${f + 1}8`)));
    for (let f = 0; f < 8; f++) shadow.appendChild(piece(`piece bp square-${f + 1}7`));
    shadow.appendChild(piece('piece wp square-54'));
    'wr,wn,wb,wq,wk,wb,wn,wr'.split(',').forEach((p, f) => shadow.appendChild(piece(`piece ${p} square-${f + 1}1`)));
    for (let f = 0; f < 8; f++) { if (f !== 4) shadow.appendChild(piece(`piece wp square-${f + 1}2`)); }
    document.body.appendChild(root);

    expect(utils.getFEN()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1');
  });

  it('method 5: window state', () => {
    const board = document.createElement('wc-chess-board');
    document.body.appendChild(board);
    window.chessground = { state: { fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' } };
    expect(utils.getFEN()).toBe('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    delete window.chessground;
  });

  it('null when all 5 methods fail (empty board)', () => {
    const board = document.createElement('wc-chess-board');
    document.body.appendChild(board);
    expect(utils.getFEN()).toBeNull();
  });
});

// ── getPlayerColor ──────────────────────────────────────────────────────

describe('getPlayerColor', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('default "white" when no board', () => {
    expect(utils.getPlayerColor()).toBe('white');
  });

  it('"white" by default', () => {
    document.body.appendChild(document.createElement('wc-chess-board'));
    expect(utils.getPlayerColor()).toBe('white');
  });

  it('"black" when flipped attribute', () => {
    const b = document.createElement('wc-chess-board');
    b.setAttribute('flipped', '');
    document.body.appendChild(b);
    expect(utils.getPlayerColor()).toBe('black');
  });

  it('"black" when orientation="black"', () => {
    const b = document.createElement('chess-board');
    b.setAttribute('orientation', 'black');
    document.body.appendChild(b);
    expect(utils.getPlayerColor()).toBe('black');
  });

  it('"black" when .flipped class', () => {
    const b = document.createElement('wc-chess-board');
    b.classList.add('flipped');
    document.body.appendChild(b);
    expect(utils.getPlayerColor()).toBe('black');
  });
});

// ── getOpponentElo ─────────────────────────────────────────────────────

describe('getOpponentElo', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('default 1500 when no ratings', () => {
    expect(utils.getOpponentElo()).toBe(1500);
  });

  it('strategy 1: .board-player-component:first-child .user-tagline-rating', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    const r = document.createElement('span');
    r.className = 'user-tagline-rating';
    r.textContent = ' 1850 ';
    sec.appendChild(r);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(1850);
  });

  it('strategy 2: .player-component.player-top .user-tagline-rating', () => {
    const sec = document.createElement('div');
    sec.className = 'player-component player-top';
    const r = document.createElement('span');
    r.className = 'user-tagline-rating';
    r.textContent = '1920';
    sec.appendChild(r);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(1920);
  });

  it('strategy 3: [data-opponent-rating]', () => {
    const el = document.createElement('div');
    el.setAttribute('data-opponent-rating', '1740');
    document.body.appendChild(el);
    expect(utils.getOpponentElo()).toBe(1740);
  });

  it('strategy 4: [data-rating] on opponent section', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    const inner = document.createElement('span');
    inner.setAttribute('data-rating', '2010');
    sec.appendChild(inner);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(2010);
  });

  it('strategy 5: .rating-number inside opponent section', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    const r = document.createElement('span');
    r.className = 'rating-number';
    r.textContent = '1670';
    sec.appendChild(r);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(1670);
  });

  it('strategy 6: [class*="rating"] with 3–4 digit text', () => {
    const div = document.createElement('div');
    div.className = 'player-rating';
    div.textContent = '2120';
    document.body.appendChild(div);
    expect(utils.getOpponentElo()).toBe(2120);
  });

  it('strategy 7: max from .user-tagline-rating (no earlier match)', () => {
    // Elements that don't match strategies 1-6
    const r1 = document.createElement('span');
    r1.className = 'user-tagline-rating';
    r1.textContent = '1200';
    document.body.appendChild(r1);
    const r2 = document.createElement('span');
    r2.className = 'user-tagline-rating';
    r2.textContent = '1850';
    document.body.appendChild(r2);
    expect(utils.getOpponentElo()).toBe(1850);
  });

  it('strategy 8: React internal state', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    sec.__reactInternalState = { rating: 1880 };
    Object.setPrototypeOf(sec.__reactInternalState, null);
    document.body.appendChild(sec);
    // strategy 8 iterates known keys starting with __
    // give it a key that matches
    const key = Object.keys(sec).find(k => k.startsWith('__'));
    if (!key) {
      // force-set a __ key if none (jsdom may strip it)
      sec['__testKey'] = { rating: 1880 };
    }
    expect(utils.getOpponentElo()).toBe(1880);
  });

  it('strategy 9: window.__PRELOADED_STATE__', () => {
    window.__PRELOADED_STATE__ = { game: { opponent: { rating: 2150 } } };
    expect(utils.getOpponentElo()).toBe(2150);
    delete window.__PRELOADED_STATE__;
  });

  it('rejects rating < 100 (fails through all strategies to 1500)', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    const r = document.createElement('span');
    r.className = 'user-tagline-rating';
    r.textContent = '42';
    sec.appendChild(r);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(1500);
  });

  it('rejects rating > 4000 (fails through all strategies to 1500)', () => {
    const sec = document.createElement('div');
    sec.className = 'board-player-component';
    const r = document.createElement('span');
    r.className = 'user-tagline-rating';
    r.textContent = '9999';
    sec.appendChild(r);
    document.body.appendChild(sec);
    expect(utils.getOpponentElo()).toBe(1500);
  });
});

// ── isGameOver ──────────────────────────────────────────────────────────

describe('isGameOver', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('false by default', () => {
    expect(utils.isGameOver()).toBe(false);
  });

  it('detects .game-over-modal-content', () => {
    document.body.appendChild(el('.game-over-modal-content'));
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .game-over-modal-component', () => {
    document.body.appendChild(el('.game-over-modal-component'));
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .game-over-buttons-component', () => {
    document.body.appendChild(el('.game-over-buttons-component'));
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .game-result-component', () => {
    document.body.appendChild(el('.game-result-component'));
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects .board-modal-container', () => {
    document.body.appendChild(el('.board-modal-container'));
    expect(utils.isGameOver()).toBe(true);
  });

  it('detects [class*="result-text"]', () => {
    const e = document.createElement('div');
    e.className = 'some-random-result-text-container';
    document.body.appendChild(e);
    expect(utils.isGameOver()).toBe(true);
  });

  function el(className) {
    const e = document.createElement('div');
    e.className = className.startsWith('.') ? className.slice(1) : className;
    return e;
  }
});
