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
    FILES, eloToUCIElo, fenToBoard,
    applyUciMove, toUci, legalDestsFrom, isLegalMove, parsePerftMove,
  };
}
