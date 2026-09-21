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

describe('isPromotion / toUci', () => {
  const pawns = () => c.fenToBoard('4k3/P7/8/8/8/8/7p/4K3 w - - 0 1');
  it('a pawn reaching the last rank promotes', () => {
    const b = pawns();
    expect(c.isPromotion(b, 'a7', 'a8')).toBe(true);
    expect(c.isPromotion(b, 'h2', 'h1')).toBe(true);
    expect(c.isPromotion(b, 'e1', 'e2')).toBe(false);
  });
  it('needs a choice for a promotion, and honours it', () => {
    const b = pawns();
    expect(c.toUci(b, 'a7', 'a8')).toBeNull();
    expect(c.toUci(b, 'a7', 'a8', 'n')).toBe('a7a8n');
    expect(c.toUci(b, 'e1', 'e2', 'n')).toBe('e1e2'); // not a promotion, no suffix
  });
});

describe('castleDestination', () => {
  const both = () => c.fenToBoard('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const legal = ['e1g1', 'e1c1', 'e1f1', 'e1d1'];
  it('king onto your own rook castles that side', () => {
    expect(c.castleDestination(both(), legal, 'e1', 'h1')).toBe('g1');
    expect(c.castleDestination(both(), legal, 'e1', 'a1')).toBe('c1');
  });
  it('null when that castle is not legal right now', () => {
    expect(c.castleDestination(both(), ['e1f1'], 'e1', 'h1')).toBeNull();
  });
  it('null for the opponent\'s rook, a non-king, or another rank', () => {
    expect(c.castleDestination(both(), legal, 'e1', 'h8')).toBeNull();
    expect(c.castleDestination(both(), legal, 'a1', 'h1')).toBeNull();
  });
});

describe('isKingAttacked', () => {
  const b = (fen) => c.fenToBoard(fen);
  it('start position: neither king is attacked', () => {
    expect(c.isKingAttacked(b(START), 'w')).toBe(false);
    expect(c.isKingAttacked(b(START), 'b')).toBe(false);
  });
  it('the queen check that ends fool\'s mate', () => {
    expect(c.isKingAttacked(b('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'), 'w')).toBe(true);
  });
  it('knight check', () => {
    expect(c.isKingAttacked(b('4k3/8/8/8/8/5n2/8/4K3 w - - 0 1'), 'w')).toBe(true);
  });
  it('a pawn checks diagonally, never from straight ahead', () => {
    expect(c.isKingAttacked(b('4k3/8/8/8/8/8/3p4/4K3 w - - 0 1'), 'w')).toBe(true);  // d2 hits e1
    expect(c.isKingAttacked(b('4k3/8/8/8/8/8/4p3/4K3 w - - 0 1'), 'w')).toBe(false); // e2 does not
  });
  it('a rook on the file checks, unless something blocks it', () => {
    expect(c.isKingAttacked(b('4k3/8/8/4r3/8/8/8/4K3 w - - 0 1'), 'w')).toBe(true);
    expect(c.isKingAttacked(b('4k3/8/8/4r3/8/4P3/8/4K3 w - - 0 1'), 'w')).toBe(false);
  });
  it('a bishop on the diagonal checks; a friendly piece in the way does not', () => {
    expect(c.isKingAttacked(b('4k3/8/8/8/1b6/8/8/4K3 w - - 0 1'), 'w')).toBe(true);
    expect(c.isKingAttacked(b('4k3/8/8/8/1b6/2P5/8/4K3 w - - 0 1'), 'w')).toBe(false);
  });
  it('kings cannot stand next to each other', () => {
    expect(c.isKingAttacked(b('8/8/8/8/8/8/4k3/4K3 w - - 0 1'), 'w')).toBe(true);
  });
  it('an enemy piece of the wrong kind is not a check', () => {
    expect(c.isKingAttacked(b('4k3/8/8/8/8/8/4b3/4K3 w - - 0 1'), 'w')).toBe(false);
  });
  it('no king on the board means nothing to check', () => {
    expect(c.isKingAttacked({ e2: 'r' }, 'w')).toBe(false);
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
  // No queen default. A promotion with nothing chosen is not a move: the
  // caller has to ask the player first, and the picker is the only way a
  // piece gets picked.
  it('refuses a white promotion with no piece chosen', () => {
    expect(c.toUci({ e7: 'P' }, 'e7', 'e8')).toBeNull();
  });
  it('refuses a black promotion with no piece chosen', () => {
    expect(c.toUci({ e2: 'p' }, 'e2', 'e1')).toBeNull();
  });
  it.each(['q', 'r', 'b', 'n'])('carries the chosen piece through (%s)', (p) => {
    expect(c.toUci({ e7: 'P' }, 'e7', 'e8', p)).toBe('e7e8' + p);
    expect(c.toUci({ e2: 'p' }, 'e2', 'e1', p)).toBe('e2e1' + p);
  });
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

// ── Draws ────────────────────────────────────────────────────────────────────
// Everything below exists because a game here only ends when the side to move
// has no legal move. Mate and stalemate do that; no other draw does, so a
// continuation that reached a dead endgame used to run forever.
describe('castlingAfter', () => {
  it('a king move kills both of its own rights and neither of the enemy’s', () => {
    expect(c.castlingAfter('KQkq', { from: 'e1', to: 'e2', piece: 'K' })).toBe('kq');
    expect(c.castlingAfter('KQkq', { from: 'e8', to: 'e7', piece: 'k' })).toBe('KQ');
  });
  it('a rook leaving home kills that side only', () => {
    expect(c.castlingAfter('KQkq', { from: 'h1', to: 'h5', piece: 'R' })).toBe('Qkq');
    expect(c.castlingAfter('KQkq', { from: 'a8', to: 'a5', piece: 'r' })).toBe('KQk');
  });
  it('capturing on a rook’s home square kills that right', () => {
    expect(c.castlingAfter('KQkq', { from: 'a1', to: 'a8', piece: 'R' })).toBe('Kk');
  });
  it('castling itself leaves nothing for that colour', () => {
    expect(c.castlingAfter('KQkq', { from: 'e1', to: 'g1', piece: 'K' })).toBe('kq');
  });
  it('a dash stays a dash', () => {
    expect(c.castlingAfter('-', { from: 'e2', to: 'e4', piece: 'P' })).toBe('-');
  });
});

describe('enPassantAfter', () => {
  it('a double push exposes the square it stepped over', () => {
    expect(c.enPassantAfter({ piece: 'P', from: 'e2', to: 'e4' })).toBe('e3');
    expect(c.enPassantAfter({ piece: 'p', from: 'd7', to: 'd5' })).toBe('d6');
  });
  it('a single push exposes nothing', () => {
    expect(c.enPassantAfter({ piece: 'P', from: 'e3', to: 'e4' })).toBe('-');
  });
  it('a piece moving two ranks is not a pawn push', () => {
    expect(c.enPassantAfter({ piece: 'R', from: 'e2', to: 'e4' })).toBe('-');
  });
});

describe('positionKey', () => {
  const board = { e1: 'K', e8: 'k' };
  it('the same placement with different rights is a different position', () => {
    expect(c.positionKey(board, 'w', 'KQ', '-')).not.toBe(c.positionKey(board, 'w', '-', '-'));
  });
  it('the same placement with the other side to move is a different position', () => {
    expect(c.positionKey(board, 'w', '-', '-')).not.toBe(c.positionKey(board, 'b', '-', '-'));
  });
  it('an en-passant square makes it a different position', () => {
    expect(c.positionKey(board, 'w', '-', 'e3')).not.toBe(c.positionKey(board, 'w', '-', '-'));
  });
  it('key order does not depend on how the map was built', () => {
    expect(c.positionKey({ e8: 'k', e1: 'K' }, 'w', '-', '-')).toBe(c.positionKey(board, 'w', '-', '-'));
  });
});

describe('isInsufficientMaterial', () => {
  it('bare kings', () => { expect(c.isInsufficientMaterial({ e1: 'K', e8: 'k' })).toBe(true); });
  it('king and one bishop', () => { expect(c.isInsufficientMaterial({ e1: 'K', c1: 'B', e8: 'k' })).toBe(true); });
  it('king and one knight', () => { expect(c.isInsufficientMaterial({ e1: 'K', b1: 'N', e8: 'k' })).toBe(true); });
  it('opposite bishops on the same colour cannot mate', () => {
    // c1 and f8 are both dark squares
    expect(c.isInsufficientMaterial({ e1: 'K', c1: 'B', e8: 'k', f8: 'b' })).toBe(true);
  });
  it('bishops on opposite colours can still mate', () => {
    // c1 dark, c8 light
    expect(c.isInsufficientMaterial({ e1: 'K', c1: 'B', e8: 'k', c8: 'b' })).toBe(false);
  });
  it('a single pawn is enough', () => {
    expect(c.isInsufficientMaterial({ e1: 'K', a2: 'P', e8: 'k' })).toBe(false);
  });
  it('a rook is enough', () => { expect(c.isInsufficientMaterial({ e1: 'K', a1: 'R', e8: 'k' })).toBe(false); });
  it('two knights are not an automatic draw', () => {
    expect(c.isInsufficientMaterial({ e1: 'K', b1: 'N', g1: 'N', e8: 'k' })).toBe(false);
  });
});
