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
// It publishes what it reads over window.postMessage, and answers a small set of
// commands from the isolated world.
//
// FAIR PLAY. Anything that changes the board is refused here unless Chess.com's
// own game reports a result — which is "*" for as long as one is being played.
// The content script has already reached the same conclusion from the page's
// DOM before it asks. Two independent checks, in two different worlds, on two
// different sources, and neither can stand in for the other: a stale game-over
// node cannot fool the game object, and a misread result cannot get past the
// DOM. Nothing that ends or alters a real game is reachable from here at all —
// no setMode, no resign, no agreeDraw — and the page world has no access to
// chrome.*, so this holds no permissions of its own.
(() => {
  const CHANNEL = 'sfct-page-state';
  const POLL_MS = 400;

  // The LARGEST VISIBLE board, the same rule the content script uses to pick the
  // one it plays on. querySelector takes the first in the document, and a page
  // carrying more than one — a review page does — then has the two of us reading
  // and drawing on different boards.
  function board() {
    const all = [...document.querySelectorAll('wc-chess-board, chess-board')]
      .filter(b => document.body.contains(b));
    let best = null, bestW = 0;
    for (const b of all) {
      const r = b.getBoundingClientRect();
      if (r.width > bestW) { best = b; bestW = r.width; }
    }
    // A width of zero everywhere means nothing has been laid out yet — or there
    // is no layout engine at all, which is how the tests run. Take the first
    // rather than deciding there is no board.
    return bestW > 0 ? best : (all[0] || null);
  }

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

  // ── Commands ───────────────────────────────────────────────────────────────
  // Only these four. `legal` reads; the other three change the board and are
  // gated on the game having a result.
  const CHANGES = new Set(['continuation', 'move', 'reset']);

  function hasResult(game) {
    try {
      const r = game.getResult();
      return typeof r === 'string' && r !== '' && r !== '*';
    } catch (_) { return false; }
  }

  const OPS = {
    // Branch off the position being shown. Our moves then land in a variation
    // beside the real game, which resetToMainLine() discards untouched.
    continuation: (g) => g.createContinuation(),
    move: (g, a) => g.move(a),
    reset: (g) => g.resetToMainLine(),
    legal: (g, a) => (a && a.square ? g.getLegalMovesForSquare(a.square) : g.getLegalMoves()),
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__sfct !== 'cmd' || !OPS[d.op]) return;
    const reply = (ok, value) => window.postMessage(
      { __sfct: 'cmd-reply', id: d.id, ok, value }, window.location.origin);
    const el = board();
    const game = el && el.game;
    if (!game) return reply(false, 'nessuna partita');
    if (CHANGES.has(d.op) && !hasResult(game)) return reply(false, 'partita in corso');
    try {
      const value = OPS[d.op](game, d.args);
      // Returns are large and self-referential; the caller only needs to know it
      // worked and where the board ended up.
      reply(true, d.op === 'legal' ? (Array.isArray(value) ? value : null) : read(game, 'getFEN') || null);
    } catch (err) {
      reply(false, String(err).slice(0, 140));
    }
  });
})();
