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

describe('fenToBoard', () => {
  it('parses the start position', () => {
    const b = c.fenToBoard(START);
    expect(b.e1).toBe('K'); expect(b.e8).toBe('k'); expect(b.a2).toBe('P');
    expect(Object.keys(b).length).toBe(32);
  });
});

describe('diffBoards', () => {
  const board = (fen) => c.fenToBoard(fen);
  it('a quiet move is one moved piece, nothing added or removed', () => {
    const before = board(START);
    const after = c.applyUciMove(before, 'e2e4').board;
    const d = c.diffBoards(before, after);
    expect(d.moved).toEqual([{ from: 'e2', to: 'e4', piece: 'P' }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
  it('a capture moves the capturer and removes the captured piece', () => {
    const before = board('4k3/8/8/8/8/8/4r3/4K2R w K - 0 1');
    const after = c.applyUciMove(before, 'e1e2').board; // Kxe2
    const d = c.diffBoards(before, after);
    expect(d.moved).toEqual([{ from: 'e1', to: 'e2', piece: 'K' }]);
    expect(d.removed).toEqual(['e2']); // the rook node has to go, the king takes its square
  });
  it('castling moves both king and rook', () => {
    const before = board('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    const after = c.applyUciMove(before, 'e1g1').board;
    const d = c.diffBoards(before, after);
    expect(d.moved.map(m => m.from + m.to).sort()).toEqual(['e1g1', 'h1f1']);
  });
  it('promotion removes the pawn and adds the new piece', () => {
    const before = board('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    const after = c.applyUciMove(before, 'a7a8q').board;
    const d = c.diffBoards(before, after);
    expect(d.removed).toEqual(['a7']);
    expect(d.added).toEqual([{ sq: 'a8', piece: 'Q' }]);
  });
  it('no change means no work for the renderer', () => {
    const b = board(START);
    expect(c.diffBoards(b, { ...b })).toEqual({ moved: [], added: [], removed: [] });
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
