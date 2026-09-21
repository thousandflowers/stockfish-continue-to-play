// ── DOM scraping for Stockfish Continue to Play (Chess.com) ─────────────────
// Reads the final position, player colour, opponent rating and game-over state
// from the Chess.com page. Needs `document`; no chrome.*, Worker or fetch — so
// it runs under jsdom in the unit tests. Kept independent of chess-core.js so it
// can be imported on its own (the content-script world loads both as globals).

const PIECE_MAP = {
  wk: 'K', wq: 'Q', wr: 'R', wb: 'B', wn: 'N', wp: 'P',
  bk: 'k', bq: 'q', br: 'r', bb: 'b', bn: 'n', bp: 'p',
};

// Build a FEN placement field from Chess.com piece <div>s (class "piece wp square-52").
function buildFENFromPieces(root) {
  // [data-sfct] is excluded: our overlay pieces carry Chess.com's own `piece`
  // class to borrow its sprite, and would otherwise be read back as position.
  const pieceDivs = root.querySelectorAll('[class*="piece"][class*="square-"]:not([data-sfct])');
  if (!pieceDivs.length) return null;
  const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
  let found = 0;
  pieceDivs.forEach(el => {
    let piece = null, file = -1, rank = -1;
    (el.className || '').split(/\s+/).forEach(c => {
      if (PIECE_MAP[c]) piece = PIECE_MAP[c];
      const m = c.match(/^square-(\d)(\d)$/);
      if (m) { file = parseInt(m[1], 10) - 1; rank = parseInt(m[2], 10) - 1; }
    });
    if (piece && file >= 0 && rank >= 0) { grid[7 - rank][file] = piece; found++; }
  });
  if (found < 3) return null; // noise guard
  return grid.map(row => {
    let s = '', e = 0;
    row.forEach(sq => { if (sq) { if (e) { s += e; e = 0; } s += sq; } else e++; });
    if (e) s += e;
    return s;
  }).join('/');
}

// A FEN placement field as a { e1: 'K', … } map of occupied squares.
function placementToMap(placement) {
  const board = {};
  placement.split('/').forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { c += parseInt(ch, 10); continue; }
      board['abcdefgh'[c] + (8 - r)] = ch; c++;
    }
  });
  return board;
}

// Best-effort castling rights for a scraped placement (king + rook on home squares).
// ponytail: home-square heuristic — it can over-grant if a king or rook moved away
//   and came back, but it can never take a castle AWAY from you: pieces at home
//   means the right is granted. Once play continues, Stockfish tracks the real
//   rights from the move list, so this only has to be right at capture time.
function castlingFromPlacement(placement) {
  const board = placementToMap(placement);
  let s = '';
  if (board.e1 === 'K' && board.h1 === 'R') s += 'K';
  if (board.e1 === 'K' && board.a1 === 'R') s += 'Q';
  if (board.e8 === 'k' && board.h8 === 'r') s += 'k';
  if (board.e8 === 'k' && board.a8 === 'r') s += 'q';
  return s || '-';
}

// The en-passant target square for a scraped position, read off the two squares
// Chess.com highlights for the last move.
//
// This is the one legal move a scraped FEN can lose. Castling is only ever
// over-granted, never withheld; promotion does not depend on the start FEN at
// all; and the halfmove/fullmove counters cannot make a move illegal. But with
// "-" in this field Stockfish does not generate the capture, `go perft 1` never
// returns it, and the move is refused — which reads as a bug, not as a rule.
//
// A double pawn push is the only move whose two highlighted squares sit on the
// same file two ranks apart with a pawn standing on the destination, so the
// square between them is the target. Exact whenever the highlight is there;
// Chess.com lets you switch move highlighting off, and then this is back to "-".
function enPassantTarget(placement, boardEl) {
  const board = activeBoard(boardEl);
  const squares = [];
  for (const hl of board ? board.querySelectorAll('[class*="highlight"][class*="square-"]') : []) {
    const m = String(hl.className).match(/square-(\d)(\d)/);
    if (m) squares.push({ file: +m[1], rank: +m[2] });
  }
  if (squares.length !== 2) return '-';
  const [a, b] = squares;
  if (a.file !== b.file || Math.abs(a.rank - b.rank) !== 2) return '-';

  const file = 'abcdefgh'[a.file - 1];
  const map = placementToMap(placement);
  const isPawn = (sq) => { const p = map[sq]; return p && p.toLowerCase() === 'p' ? p : null; };
  const pa = isPawn(file + a.rank), pb = isPawn(file + b.rank);
  if (!pa === !pb) return '-'; // a pawn at both ends, or neither: not a clean push

  const landed = pa || pb;
  const rank = pa ? a.rank : b.rank;
  const white = landed === 'P';
  // A white double push can only end on rank 4, a black one on rank 5.
  if (white ? rank !== 4 : rank !== 5) return '-';
  return file + (white ? 3 : 6);
}

// ── Side to move ────────────────────────────────────────────────────
// Needed whenever the position is scraped (the usual case). Navigating the move
// list after a game is the whole point of continuing from the position ON the
// board, so this has to follow the SELECTED ply, not the last one played.
//
// Three independent readings of the same fact, so one markup rename cannot
// silently flip the side and start a game with the wrong player up:
//
//   1. the INDEX of the selected ply in the history — ply 1 is White's, so the
//      parity of the index gives the side to move. Needs only that the ply
//      nodes are enumerable and one of them is marked, so it survives a rename
//      of the white-move / black-move classes, the likeliest change of all.
//   2. the colour class on that node — what this used to read on its own.
//   3. the board's last-move highlight — whichever colour's piece stands on a
//      highlighted square just moved, so the other side is up. It follows the
//      position being shown, so it stays right while you navigate.
//
// They agree in the normal case. When they cannot be reconciled the caller asks
// the player rather than guessing.
//
// A parity count over [data-whole-move-number] was tried and is wrong by
// construction — that attribute marks move PAIRS, so a live board reported
// "black to move" both after 1. e4 and after 1… e5.

// Every ply node, in the order played. Three shapes, so a rename of any one of
// them still leaves the history enumerable.
// The board to read. Callers that know which one is in play (the content
// script picks the largest VISIBLE board) hand it in; everything else takes
// the first one on the page. A review page can carry more than one.
const activeBoard = (el) => el || document.querySelector('wc-chess-board, chess-board');

function plyNodes() {
  return [...document.querySelectorAll(
    '[class*="white-move"], [class*="black-move"], [class*="main-line-ply"]')];
}

// The ply Chess.com is currently showing. Marked with a "selected" class while
// you navigate; the ARIA attributes are the same fact spelled another way.
function isSelectedPly(node) {
  return /(^|[\s-])selected([\s-]|$)/.test(String(node.className || '')) ||
    node.getAttribute?.('aria-selected') === 'true' ||
    node.getAttribute?.('aria-current') === 'true';
}

// Reading 1. Index 0 is White's first move, so after an even index Black is up.
const turnAfterPly = (i) => (i % 2 === 0 ? 'b' : 'w');

// Reading 2. null when the node carries no colour tag at all.
function turnFromPlyClass(node) {
  const cn = String(node?.className || '');
  if (/black-move/.test(cn)) return 'w';
  if (/white-move/.test(cn)) return 'b';
  return null;
}

// Reading 3. null when the board is not highlighting — Chess.com lets you turn
// move highlighting off. Our own overlay pieces are excluded: they carry
// Chess.com's `piece` class to borrow its sprite and would answer for it.
function turnFromHighlight(boardEl) {
  const board = activeBoard(boardEl);
  for (const hl of board ? board.querySelectorAll('[class*="highlight"][class*="square-"]') : []) {
    const sq = (String(hl.className).match(/square-(\d\d)/) || [])[1];
    const piece = sq && board.querySelector(`[class*="piece"][class*="square-${sq}"]:not([data-sfct])`);
    const side = piece && (String(piece.className).match(/\b(w|b)[kqrbnp]\b/) || [])[1];
    if (side) return side === 'w' ? 'b' : 'w'; // whoever just moved, the other is up
  }
  return null;
}

// The side to move, or null when the readings cannot be reconciled and the
// player has to be asked. Never guesses in a way that could start a game with
// the wrong side up.
function readSideToMove(boardEl) {
  const nodes = plyNodes();
  const sel = nodes.findIndex(isSelectedPly);

  if (sel >= 0) {
    const byIndex = turnAfterPly(sel);
    const byClass = turnFromPlyClass(nodes[sel]);
    if (!byClass || byClass === byIndex) return byIndex;
    return turnFromHighlight(boardEl); // the two list readings disagree — the board decides
  }

  // Nothing marked. The board is then the better witness than the end of the
  // list: it is the position actually on screen.
  const hl = turnFromHighlight(boardEl);
  if (hl) return hl;

  // No highlight either. Fall back to the end of the list, which is what
  // shipped before this and is right whenever the board sits at the final
  // position — the only case that can reach here on a finished game.
  if (!nodes.length) return null;
  const last = nodes.length - 1;
  const byIndex = turnAfterPly(last);
  const byClass = turnFromPlyClass(nodes[last]);
  return (!byClass || byClass === byIndex) ? byIndex : null;
}

// A FEN needs SOME side, and White is the harmless default for an empty page.
// Callers that must not guess use readSideToMove() and ask instead.
function getTurnFromMoveList(boardEl) {
  return readSideToMove(boardEl) || 'w';
}

// Extract the current FEN. A real board attribute carries castling/EP/clocks;
// scraped placement (no history) is the fallback.
//
// There is deliberately no React-state or window.<app-state> lookup: a content
// script runs in an isolated world, where page expandos on DOM nodes and page
// globals are invisible. Probing a live chess.com page with the extension loaded
// confirmed it — those branches never fired, they only made the cascade look
// richer than it is. What actually runs on chess.com today is the piece scrape.
// A scraped placement, completed into a full FEN. The two counters stay at
// "0 1": a continuation is a NEW game from this position, so starting its
// 50-move count and move number from zero is right rather than approximate.
const fenFrom = (placement, board) =>
  `${placement} ${getTurnFromMoveList(board)} ${castlingFromPlacement(placement)} ` +
  `${enPassantTarget(placement, board)} 0 1`;

function getFEN(boardEl) {
  const board = activeBoard(boardEl);
  if (!board) return null;

  // 1. board attribute — a full, authoritative FEN.
  const attr = board.getAttribute('game-fen') || board.getAttribute('fen');
  if (attr && attr.split('/').length >= 7) return attr;

  // 2. Light-DOM pieces → assemble a FEN (castling estimated from home squares).
  const lightPos = buildFENFromPieces(board);
  if (lightPos) return fenFrom(lightPos, board);

  // 3. Shadow-DOM pieces.
  try {
    const shadow = board.shadowRoot;
    if (shadow) {
      const shadowPos = buildFENFromPieces(shadow);
      if (shadowPos) return fenFrom(shadowPos, board);
    }
  } catch (_) {}

  return null;
}

function isFlipped(board) {
  return !!board && (
    board.hasAttribute('flipped') ||
    board.getAttribute('orientation') === 'black' ||
    board.classList.contains('flipped')
  );
}

// The player row on the far side of the board. Chess.com always renders you at
// the bottom and the opponent on top, but that row's class names keep changing
// (board-player-component → player-component player-top → player-row-top), so
// match the durable "player…top" shape instead of one generation's names.
function opponentRow() {
  return document.querySelector('[class*="player"][class*="top"], [class*="opponent"]');
}

// Which colour the user is playing. A flipped board means the user is Black.
// Otherwise the user is White — unless a "You" tag sits in the opponent's row,
// which happens when Chess.com resets the orientation in game review.
function getPlayerColor() {
  const board = document.querySelector('wc-chess-board, chess-board');
  if (isFlipped(board)) return 'black';

  const top = opponentRow();
  const youOnTop = !!top && (!!top.querySelector('[class*="you"]') || /\bYou\b/.test(top.textContent || ''));
  return youOnTop ? 'black' : 'white';
}

// A rating reads as a bare 3–4 digit number, sometimes parenthesised: chess.com
// renders bot ratings as "(250)".
const RATING_RE = /^\(?(\d{3,4})\)?$/;

function readRating(el) {
  const raw = el.getAttribute?.('data-rating') ?? el.getAttribute?.('data-opponent-rating') ??
    (el.children.length === 0 ? el.textContent : '');
  const m = RATING_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n > 100 && n < 4000) ? n : null;
}

// Opponent Elo, used only to pick the engine's strength. Read the first number
// that looks like a rating inside the opponent's row; if that row is not
// recognisable, take the strongest explicit rating node on the page. 1500 when
// the page carries no rating at all (logged-out pages don't).
// ponytail: no per-selector strategy list — the previous nine hardcoded
//   selectors all missed once chess.com renamed its classes, and every rename
//   needed another branch.
function getOpponentElo() {
  const top = opponentRow();
  if (top) {
    for (const el of top.querySelectorAll('*')) {
      const r = readRating(el);
      if (r) return r;
    }
  }
  const all = [...document.querySelectorAll('[class*="rating"], [data-rating], [data-opponent-rating]')]
    .map(readRating).filter(Boolean);
  return all.length ? Math.max(...all) : 1500;
}

// Average seconds per move in the game that just finished, read from the clock
// shown next to each ply when Chess.com renders one ("1:58", "0:59.4"). Each
// side's clock only counts down on its own moves, so the gap between one of its
// clocks and the next is what that move cost. Returns null when the move list
// carries no clocks — plenty of games (untimed, or with timestamps hidden) have
// none, and then the caller falls back to the pace it can measure itself.
function parseClock(text) {
  const m = String(text).trim().match(/^(?:(\d+):)?(\d{1,2})(?:[.:](\d))?$/);
  if (!m) return null;
  return (m[1] ? +m[1] * 60 : 0) + +m[2] + (m[3] ? +m[3] / 10 : 0);
}

function averageMoveSeconds() {
  const plies = [...document.querySelectorAll('[class*="white-move"], [class*="black-move"]')];
  if (plies.length < 4) return null;
  const perSide = { w: [], b: [] };
  for (const ply of plies) {
    const el = ply.querySelector('[class*="clock"], [class*="time"]');
    const secs = el && parseClock(el.textContent);
    if (secs === null || secs === undefined) continue;
    perSide[/black-move/.test(String(ply.className)) ? 'b' : 'w'].push(secs);
  }
  const gaps = [];
  for (const side of ['w', 'b']) {
    const clocks = perSide[side];
    for (let i = 1; i < clocks.length; i++) {
      const spent = clocks[i - 1] - clocks[i]; // clocks count down; increments can make this negative
      if (spent > 0 && spent < 300) gaps.push(spent);
    }
  }
  if (!gaps.length) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

// The game-over modal, and the row inside it that holds Chess.com's own buttons.
// Both are matched on the durable "game-over-modal" / "buttons" shapes: the
// data-cy hooks and .game-over-buttons-buttons this used to rely on are gone from
// today's markup (the real modal is .game-over-modal-shell-container with a
// .game-over-modal-shell-buttons row), and a version-specific anchor list only
// ever needs another entry.
function findGameOverModal() {
  return document.querySelector('[class*="game-over-modal"], [class*="game-over-container"], [data-cy="game-over-dialog"]');
}

// Chess.com's last own button in the modal — our trigger is inserted right after
// it so it lands in the same row, styled like a sibling. null when the modal has
// no button of its own.
function modalButtonAnchor(modal) {
  if (!modal) return null;
  const isClose = (el) => /close/i.test(String(el.className) + ' ' + (el.getAttribute('aria-label') || ''));
  const buttons = [...modal.querySelectorAll('button, a[role="button"]')].filter(b => !isClose(b));
  return buttons[buttons.length - 1] || null;
}

// Is this element actually on screen? A game-over surface left mounted but
// hidden — one belonging to a game a rematch has already replaced, or one
// rendered ahead of the result — must not read as a finished game, or the
// trigger appears over a live board. Fair play rests on this predicate alone.
//
// The computed style is checked first because it is the one thing jsdom can
// answer; checkVisibility() then covers what it cannot, an element hidden by an
// ANCESTOR, which getComputedStyle reports as visible on the child itself.
function isVisible(el) {
  if (!el) return false;
  const st = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
  if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  return true;
}

function isGameOver() {
  // Only true game-over signals — NOT generic board modals or the pawn-promotion
  // menu, which also appear mid-game and would falsely trigger the Continue button.
  // `[class*="game-over"]` is the durable catch-all: Chess.com has used a
  // "game-over-*" class on the result modal across many UI revisions.
  const selectors = [
    '[class*="game-over"]',
    '[data-cy="game-over-dialog"]',
    '.game-result-component', '[class*="result-text"]',
  ];
  return selectors.some(s => {
    try { return [...document.querySelectorAll(s)].some(isVisible); } catch (_) { return false; }
  });
}

// Board square ("e4") under a click, accounting for orientation.
function computeSquareFromClick(board, clientX, clientY) {
  const rect = board.getBoundingClientRect();
  const file = Math.floor(((clientX - rect.left) / rect.width) * 8);
  const rank = Math.floor(((clientY - rect.top) / rect.height) * 8);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  const flipped = isFlipped(board);
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return String.fromCharCode(97 + col) + (row + 1);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIECE_MAP, activeBoard, buildFENFromPieces, placementToMap, castlingFromPlacement,
    enPassantTarget, getTurnFromMoveList,
    plyNodes, isSelectedPly, turnFromPlyClass, turnFromHighlight, readSideToMove,
    getFEN, isFlipped, opponentRow, getPlayerColor, readRating, getOpponentElo,
    findGameOverModal, modalButtonAnchor, isVisible, isGameOver, computeSquareFromClick,
    parseClock, averageMoveSeconds,
  };
}
