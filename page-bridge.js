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

  function snapshot() {
    const el = board();
    const game = el && el.game;
    if (!game) return null;
    const fen = read(game, 'getFEN');
    if (typeof fen !== 'string' || fen.split(' ').length < 4) return null;
    return {
      fen,
      turn: read(game, 'getTurn') ?? null,
      playingAs: read(game, 'getPlayingAs') ?? null,
      over: read(game, 'isGameOver') ?? null,
      check: read(game, 'isCheck') ?? null,
      // Shapes here are not documented, so they travel as plain JSON or not at
      // all; the isolated side decides what it recognises.
      result: (() => { try { return JSON.parse(JSON.stringify(read(game, 'getResult') ?? null)); } catch (_) { return null; } })(),
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
