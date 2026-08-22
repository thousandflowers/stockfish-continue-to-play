// ── Pure chess logic for Stockfish Continue to Play ─────────────────────────
// No DOM, no chrome.*, no Worker — pure functions shared by the content script
// and the unit tests. Inputs are never mutated (immutable updates).
//
// Engine truth comes from move history: the content script keeps the captured
// start FEN plus a list of UCI moves and sends `position fen <start> moves …`
// to Stockfish, so castling rights, en-passant, the 50-move rule and threefold
// repetition are all handled natively by the engine. These helpers only need to
// keep a board map in sync for rendering and apply single moves.

const FILES = 'abcdefgh';

// Map opponent Elo (400–2500) → Stockfish UCI_Elo (1320–3190), clamped.
function eloToUCIElo(elo) {
  const clamped = Math.max(400, Math.min(2500, elo));
  return Math.round(1320 + (3190 - 1320) * ((clamped - 400) / (2500 - 400)));
}

// FEN placement field → { e4: 'P', … } map of occupied squares.
function fenToBoard(fen) {
  const rows = fen.split(' ')[0].split('/');
  const board = {};
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r] || '') {
      if (ch >= '1' && ch <= '8') { c += parseInt(ch, 10); continue; }
      board[FILES[c] + (8 - r)] = ch;
      c++;
    }
  }
  return board;
}

// Is `side`'s king attacked right now? Worked out from the board map alone —
// the engine cannot answer this (it never generates a capture of a king), and
// the answer is needed the instant a move is refused, to paint the king's square
// red the way Chess.com does.
const KNIGHT_HOPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

function kingSquare(board, side) {
  const king = side === 'w' ? 'K' : 'k';
  for (const sq in board) if (board[sq] === king) return sq;
  return null;
}

function isKingAttacked(board, side) {
  const sq = kingSquare(board, side);
  if (!sq) return false;
  const f0 = FILES.indexOf(sq[0]);
  const r0 = parseInt(sq[1], 10);
  // undefined = off the board, null = empty square
  const at = (f, r) => (f < 0 || f > 7 || r < 1 || r > 8) ? undefined : (board[FILES[f] + r] || null);
  const enemy = (p) => p && (side === 'w' ? p === p.toLowerCase() : p === p.toUpperCase());
  const is = (p, type) => p && p.toLowerCase() === type;

  // pawns: they capture towards us, so they sit one rank ahead of the king
  const ahead = side === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const p = at(f0 + df, r0 + ahead);
    if (enemy(p) && is(p, 'p')) return true;
  }
  for (const [df, dr] of KNIGHT_HOPS) {
    const p = at(f0 + df, r0 + dr);
    if (enemy(p) && is(p, 'n')) return true;
  }
  for (const [dirs, sliders] of [[ROOK_DIRS, 'rq'], [BISHOP_DIRS, 'bq']]) {
    for (const [df, dr] of dirs) {
      for (let i = 1; i < 8; i++) {
        const p = at(f0 + df * i, r0 + dr * i);
        if (p === undefined) break;      // ran off the board
        if (p === null) continue;        // empty, keep sliding
        if (enemy(p) && sliders.includes(p.toLowerCase())) return true;
        break;                           // any other piece blocks the line
      }
    }
  }
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const p = at(f0 + df, r0 + dr);
      if (enemy(p) && is(p, 'k')) return true;
    }
  }
  return false;
}

// What changed between two board maps. The renderer moves the existing piece
// nodes instead of rebuilding them, so a move animates instead of flickering.
// A piece that disappeared from one square and appeared on another is the same
// piece having moved; promotions come out as a removal plus an addition.
function diffBoards(prev, next) {
  const moved = [], added = [], removed = [];
  const before = new Map(Object.entries(prev));
  const after = new Map(Object.entries(next));
  for (const [sq, pc] of [...after]) {
    if (before.get(sq) === pc) { before.delete(sq); after.delete(sq); }
  }
  for (const [sq, pc] of [...after]) {
    let from = null;
    for (const [psq, ppc] of before) if (ppc === pc) { from = psq; break; }
    if (from !== null) { moved.push({ from, to: sq, piece: pc }); before.delete(from); after.delete(sq); }
  }
  for (const [sq, piece] of after) added.push({ sq, piece });
  for (const [sq] of before) removed.push(sq);
  return { moved, added, removed };
}

// Apply a UCI move (e.g. "e2e4", "e7e8q", "e1g1") to a board map.
// Returns a NEW board (immutable) plus a `moved` descriptor, or moved=null when
// there is no piece on the from-square.
function applyUciMove(board, uci) {
  const next = { ...board };
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promo = uci.length > 4 ? uci[4] : null;
  const piece = next[from];
  if (!piece) return { board: next, moved: null };

  const isPawn = piece === 'P' || piece === 'p';
  const isKing = piece === 'K' || piece === 'k';
  const white = piece === piece.toUpperCase();
  let enPassant = false;
  let castle = null;
  let capture = !!next[to];

  // En passant: a pawn moving diagonally onto an empty square captures the
  // pawn beside it (same file as the destination, same rank as the origin).
  if (isPawn && from[0] !== to[0] && !next[to]) {
    delete next[to[0] + from[1]];
    enPassant = true;
    capture = true;
  }

  // Castling: the king moves two files → bring the rook across too.
  if (isKing && Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0])) === 2) {
    const rank = from[1];
    const kingSide = to[0] > from[0];
    const rookFrom = (kingSide ? 'h' : 'a') + rank;
    const rookTo = (kingSide ? 'f' : 'd') + rank;
    if (next[rookFrom]) { next[rookTo] = next[rookFrom]; delete next[rookFrom]; }
    castle = kingSide ? 'k' : 'q';
  }

  delete next[from];
  next[to] = promo ? (white ? promo.toUpperCase() : promo.toLowerCase()) : piece;

  return { board: next, moved: { from, to, piece, promo, enPassant, castle, capture } };
}

// Build a UCI move string for a player drag/click, auto-queening promotions.
function toUci(board, from, to) {
  const piece = board[from];
  const promotes = (piece === 'P' && to[1] === '8') || (piece === 'p' && to[1] === '1');
  return from + to + (promotes ? 'q' : '');
}

// Legal-move helpers over a UCI legal-move list (from Stockfish `go perft 1`).
function legalDestsFrom(legalMoves, from) {
  if (!legalMoves) return null;
  const dests = new Set();
  for (const m of legalMoves) if (m.startsWith(from)) dests.add(m.slice(2, 4));
  return dests;
}

function isLegalMove(legalMoves, from, to) {
  if (!legalMoves) return false;
  return legalMoves.some(m => m.startsWith(from + to));
}

// Parse a Stockfish perft line ("e2e4: 20") → "e2e4", else null.
function parsePerftMove(line) {
  const m = line.match(/^([a-h][1-8][a-h][1-8][qrnb]?): \d+$/);
  return m ? m[1] : null;
}

// Node.js / test support — ignored inside the extension's content-script world.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FILES, eloToUCIElo, fenToBoard, diffBoards, kingSquare, isKingAttacked,
    applyUciMove, toUci, legalDestsFrom, isLegalMove, parsePerftMove,
  };
}
