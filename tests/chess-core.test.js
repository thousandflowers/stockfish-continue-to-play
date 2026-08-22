import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';

let c;
beforeAll(async () => { c = await import(path.resolve('lib/chess-core.js')); });

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('eloToUCIElo', () => {
  it('clamps below 400 → 1320', () => {
    expect(c.eloToUCIElo(0)).toBe(1320);
    expect(c.eloToUCIElo(399)).toBe(1320);
    expect(c.eloToUCIElo(400)).toBe(1320);
  });
  it('clamps above 2500 → 3190', () => {
    expect(c.eloToUCIElo(2500)).toBe(3190);
    expect(c.eloToUCIElo(9999)).toBe(3190);
  });
  it('linear interpolation', () => {
    expect(c.eloToUCIElo(1450)).toBe(2255); // exact midpoint
    expect(c.eloToUCIElo(1000)).toBe(1854);
    expect(c.eloToUCIElo(2000)).toBe(2745);
    expect(c.eloToUCIElo(401)).toBe(1321); // rounds
  });
});

describe('fenToBoard / boardToPlacement', () => {
  it('parses the start position', () => {
    const b = c.fenToBoard(START);
    expect(b.e1).toBe('K');
    expect(b.d8).toBe('q');
    expect(b.a1).toBe('R');
    expect(b.e4).toBeUndefined();
    expect(Object.keys(b)).toHaveLength(32);
  });
  it('round-trips placement', () => {
    expect(c.boardToPlacement(c.fenToBoard(START))).toBe(START.split(' ')[0]);
    const mid = 'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R';
    expect(c.boardToPlacement(c.fenToBoard(mid + ' w KQkq - 4 4'))).toBe(mid);
  });
});

describe('castlingFromBoard', () => {
  it('full rights at start', () => {
    expect(c.castlingFromBoard(c.fenToBoard(START))).toBe('KQkq');
  });
  it('drops a side when its rook is gone', () => {
    const b = c.fenToBoard(START);
    delete b.h1;
    expect(c.castlingFromBoard(b)).toBe('Qkq');
  });
  it('"-" when no king on home square', () => {
    const b = c.fenToBoard(START);
    delete b.e1; delete b.e8;
    expect(c.castlingFromBoard(b)).toBe('-');
  });
});

describe('applyUciMove', () => {
  it('does not mutate the input board (immutable)', () => {
    const b = { e2: 'P' };
    c.applyUciMove(b, 'e2e4');
    expect(b).toEqual({ e2: 'P' });
  });
  it('plays a quiet move', () => {
    const { board, moved } = c.applyUciMove({ e2: 'P' }, 'e2e4');
    expect(board).toEqual({ e4: 'P' });
    expect(moved.capture).toBe(false);
  });
  it('captures', () => {
    const { board, moved } = c.applyUciMove({ d4: 'P', e5: 'p' }, 'd4e5');
    expect(board).toEqual({ e5: 'P' });
    expect(moved.capture).toBe(true);
  });
  it('en passant removes the bypassed pawn', () => {
    const { board, moved } = c.applyUciMove({ e5: 'P', d5: 'p' }, 'e5d6');
    expect(board).toEqual({ d6: 'P' });
    expect(moved.enPassant).toBe(true);
    expect(moved.capture).toBe(true);
  });
  it('castles king-side (white)', () => {
    const { board, moved } = c.applyUciMove({ e1: 'K', h1: 'R' }, 'e1g1');
    expect(board).toEqual({ g1: 'K', f1: 'R' });
    expect(moved.castle).toBe('k');
  });
  it('castles queen-side (black)', () => {
    const { board, moved } = c.applyUciMove({ e8: 'k', a8: 'r' }, 'e8c8');
    expect(board).toEqual({ c8: 'k', d8: 'r' });
    expect(moved.castle).toBe('q');
  });
  it('promotes (auto-queen suffix and explicit piece)', () => {
    expect(c.applyUciMove({ e7: 'P' }, 'e7e8q').board).toEqual({ e8: 'Q' });
    expect(c.applyUciMove({ e7: 'P' }, 'e7e8n').board).toEqual({ e8: 'N' });
    expect(c.applyUciMove({ e2: 'p' }, 'e2e1q').board).toEqual({ e1: 'q' });
  });
  it('returns moved=null on an empty from-square', () => {
    expect(c.applyUciMove({}, 'e2e4').moved).toBeNull();
  });
});

describe('toUci', () => {
  it('plain move', () => { expect(c.toUci({ e2: 'P' }, 'e2', 'e4')).toBe('e2e4'); });
  it('auto-queens a white promotion', () => { expect(c.toUci({ e7: 'P' }, 'e7', 'e8')).toBe('e7e8q'); });
  it('auto-queens a black promotion', () => { expect(c.toUci({ e2: 'p' }, 'e2', 'e1')).toBe('e2e1q'); });
  it('no promo for a non-pawn reaching the back rank', () => {
    expect(c.toUci({ e7: 'R' }, 'e7', 'e8')).toBe('e7e8');
  });
});

describe('legalDestsFrom / isLegalMove', () => {
  const legal = ['e2e4', 'e2e3', 'd2d4', 'e7e8q', 'e7e8r'];
  it('collects destinations for a from-square', () => {
    expect([...c.legalDestsFrom(legal, 'e2')].sort()).toEqual(['e3', 'e4']);
    expect([...c.legalDestsFrom(legal, 'e7')]).toEqual(['e8']);
  });
  it('null legal list → null dests', () => { expect(c.legalDestsFrom(null, 'e2')).toBeNull(); });
  it('isLegalMove matches prefix, incl. promotions', () => {
    expect(c.isLegalMove(legal, 'e2', 'e4')).toBe(true);
    expect(c.isLegalMove(legal, 'e7', 'e8')).toBe(true);
    expect(c.isLegalMove(legal, 'e2', 'e5')).toBe(false);
  });
  it('isLegalMove returns false when legal list is unknown (null)', () => {
    expect(c.isLegalMove(null, 'e2', 'e4')).toBe(false);
  });
});

describe('parsePerftMove', () => {
  it('parses move lines', () => {
    expect(c.parsePerftMove('e2e4: 20')).toBe('e2e4');
    expect(c.parsePerftMove('e7e8q: 1')).toBe('e7e8q');
  });
  it('ignores non-move lines', () => {
    expect(c.parsePerftMove('Nodes searched: 20')).toBeNull();
    expect(c.parsePerftMove('info depth 1 seldepth 1')).toBeNull();
    expect(c.parsePerftMove('')).toBeNull();
  });
});
