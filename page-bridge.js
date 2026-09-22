// ── Page-world bridge ────────────────────────────────────────────────────────
// Runs in the PAGE's JavaScript world (manifest: "world": "MAIN"), which is the
// only place Chess.com's board component can be reached from. A normal content
// script lives in an isolated world where page objects are invisible, and this
// extension has the scars to prove it: branches that read React state and page
// globals never once fired and were deleted (see ARCHITECTURE.md).
//
// From here `document.querySelector('wc-chess-board').game` is an object with
// getFEN(), getTurn(), getPlayingAs(), getLegalMoves(), isCheck(), getResult()
// and a hundred more — everything the content script currently rebuilds by
// scraping piece divs and parsing the URL.
//
// This file is READ-ONLY by construction. It calls nothing that changes a game:
// no move(), no setMode(), no resign(), no agreeDraw(). It publishes what it
// read over window.postMessage and stops there. It cannot do more even by
// accident — the page world has no access to chrome.*, so it holds no
// permissions of its own.
(() => {
  const CHANNEL = 'sfct-page-state';
  const POLL_MS = 400;

  const board = () => document.querySelector('wc-chess-board, chess-board');

  // Every read is wrapped: this is an undocumented surface, and a getter that
  // throws must cost us one field, never the whole snapshot.
  const read = (game, name) => {
    try { return typeof game[name] === 'function' ? game[name]() : undefined; }
    catch (_) { return undefined; }
  };

  // Structured clone chokes on anything of theirs that carries a function, so
  // every object crosses as plain JSON or not at all.
  const json = (v) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch (_) { return null; } };

  function snapshot() {
    const el = board();
    const game = el && el.game;
    if (!game) return null;
    // Measured on live pages: getFEN() is the position being SHOWN, following
    // the move list as you walk back through it, and it carries the real
    // castling rights and the real en-passant square - both of which the
    // page-scraping path can only estimate.
    const fen = read(game, 'getFEN');
    if (typeof fen !== 'string' || fen.split(' ').length < 4) return null;
    const check = read(game, 'isCheck');
    return {
      fen,
      // Their own constants, read off getJCEGameCopy(): WHITE 1, BLACK 2.
      turn: read(game, 'getTurn') ?? null,
      playingAs: read(game, 'getPlayingAs') ?? null,
      mode: (read(game, 'getMode') || {}).name ?? null,
      // Per-node truth about the position on the board: checkmate, stalemate,
      // draw, threefold, insufficient and fiftyMoveRule all follow the move you
      // are looking at.
      //
      // ONE FIELD IN HERE DOES NOT, and it is the one whose name invites the
      // mistake: info.gameOver was true at EVERY node of a finished game, move
      // 10 of 45 included. It says this GAME ended, never this POSITION is
      // terminal. Their object is published as they built it, misleading key
      // and all, because reshaping it would only move the lie somewhere else.
      info: json(read(game, 'getPositionInfo')),
      // isCheck() answers with a SQUARE ("f8"), not a boolean. The boolean is
      // info.check. The name here says which one this is.
      checkSquare: typeof check === 'string' ? check : null,
      // Both ratings, named outright - no working out which row on the page
      // belongs to the opponent.
      headers: json(read(game, 'getHeaders')),
      result: json(read(game, 'getResult')),
    };
  }

  // Published every tick, not only on change. Publishing on change alone means
  // a listener that attaches later never hears anything at all until the
  // position moves — and the content script attaching after the first tick is
  // a race, not an edge case. A small object 2.5 times a second costs nothing.
  function publish() {
    let state = null;
    try { state = snapshot(); } catch (_) { state = null; }
    window.postMessage({ __sfct: 'page-state', state }, window.location.origin);
  }

  publish();
  setInterval(publish, POLL_MS);
})();
