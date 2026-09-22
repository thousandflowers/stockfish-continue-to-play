# Architecture

## How it works

1. **Detect game over** - a content script on Chess.com watches for a *visible* game-over surface and injects a **Continue vs Computer** button: docked under the result card when there is one, under the move-list column when there is not.
2. **Capture the position** - on click it reads the FEN of the position currently ON the board, which is the one you are looking at after walking back through the move list, plus the player's colour and the opponent's rating to pick a difficulty.
3. **Play inline** - it hides the game-over modal and renders the position on the existing Chess.com board. Stockfish runs in a Web Worker; you move by click or drag, the engine replies.

There is no redirect and no backend: Stockfish runs in your browser as WebAssembly, in a Web Worker, and nothing is uploaded.

## Engine model: replay the move history

Rather than rebuilding a full FEN after each move (which is error-prone for castling
rights, en-passant and clocks), the content script keeps the captured **start FEN** plus
a list of **UCI moves** and sends:

```
position fen <startFen> moves <m1> <m2> …
```

Stockfish then tracks castling rights and en-passant natively when it generates moves.
Legal moves for the side to move are obtained with `go perft 1`; when that returns zero
moves the game has ended in checkmate or stalemate, and `probeMate()` tells the two
apart by searching the position - Stockfish scores a mated side `mate 0` and a
stalemated one `cp 0`. A local board map is kept for rendering and is updated immutably
(`applyUciMove` returns a new board).

## The draws the engine is never asked about

Running out of legal moves covers checkmate and stalemate. It covers nothing else: the
fifty-move rule, threefold repetition and insufficient material all leave legal moves on
the board, so a game that reached one of them used to run forever. Stockfish knows about
all three, but it is only ever asked what the legal moves ARE.

So they are decided here, from the same move list, by four pure helpers in
`chess-core.js`: `castlingAfter()` and `enPassantAfter()` keep the rights exact (unlike
the starting rights, which are scraped), `positionKey()` folds placement, side to move
and both rights into a repetition key, and `isInsufficientMaterial()` covers bare kings,
a king and one minor piece, and two bishops on one square colour. Two knights are
deliberately not a draw - mate with them is possible, only not forced.

The claim is only ever made where the side to move is KNOWN to have a legal move: a real
`bestmove`, or a `perft` that came back non-empty. That ordering is the rule itself -
mate outranks every draw, and a game that ends in mate on the hundredth quiet move is
mate.

## Difficulty mapping

`eloToUCIElo()` maps the opponent's rating (clamped to 400–2500) linearly onto
Stockfish's `UCI_Elo` range (1320–3190), then sets `UCI_LimitStrength true`. This gives a
smooth difficulty curve that mirrors the opponent's strength.

## The page-world bridge

`page-bridge.js` runs with `"world": "MAIN"` — inside Chess.com's own JavaScript,
the only place `document.querySelector('wc-chess-board').game` can be reached from.
It is read-only by construction: it calls no `move()`, no `resign()`, no `setMode()`,
and the page world holds no `chrome.*` permissions of its own. It publishes a small
object over `window.postMessage` every 400 ms and stops there.

Everything below was **measured** on live pages with the extension loaded — a finished
live game and `/play/computer` — not inferred from their docs, because there are none.

Their board exposes 99 methods. What the bridge takes, and why:

| Field | Source | What it settles |
|:--|:--|:--|
| `fen` | `getFEN()` | The position being SHOWN. Follows the move list as you walk back through it, and carries the real castling rights and the real en-passant square. |
| `playingAs` | `getPlayingAs()` | Which colour you are, when you are a player at all. `null` to a spectator. |
| `headers` | `getHeaders()` | Both ratings, named outright — `{ WhiteElo, BlackElo, … }`. |
| `theme` | `getOptions().themeAssets` | The board theme's own highlight colour and opacity, instead of sampling a square. |

Measured too, and not published until something reads them:

| Read | What it says |
|:--|:--|
| `getTurn()` | `1` = White, `2` = Black — their own constants, off `getJCEGameCopy()`. |
| `getMode().name` | `"playing"` vs `"observing"`. |
| `getPositionInfo()` | `checkmate` / `stalemate` / `draw` / `threefold` / `insufficient` / `fiftyMoveRule`, all following the shown position. |
| `isCheck()` | The square the check is on. |
| `getResult()` | `"*"` while a game is being played, `"1-0"` and friends once it is not. |

Two of their names mislead, and whoever publishes them next must not rename the lie away:

- **`getPositionInfo().gameOver` is not about the position.** It was `true` at *every* node of a
  finished game, move 10 of 45 included. It says this GAME ended. The per-node truth is
  its `checkmate` / `stalemate` / `draw`.
- **`isCheck()` does not return a boolean.** It returns a square, `"f8"`. The boolean is
  `getPositionInfo().check`.

When the bridge is absent — an older Chess.com, a browser where `world: "MAIN"` did not
take — every consumer falls back to the page-scraping path below, which is exactly what
shipped before it. The bridge can only add.

## Where this extension speaks

Nowhere of its own. There is no status pill and no banner: a continuation renames
Chess.com's own opponent row - name, rating and avatar - and that is the whole of
it. Esc gives the finished game back.

Only the **text of leaf nodes** they own and the `src` of their avatar image are
written. Never an inserted node, and never a class, which Vue diffs away and
fights over. `opponentTextSlot()` enforces the leaf rule and returns null rather
than pick something risky, because writing `textContent` on a node that owns
element children DELETES those children - which hands Vue the same
`insertBefore … not a child of this node` that took the board down on
2026-09-22, by another door. A rating-shaped leaf is refused too: their
`user-tagline-rating` matches the tagline pattern and sits after the username, so
ordering alone once put the engine's name into the rating box.

Their row redraws on every clock tick and takes our text with it. It is written
again on the one-second watchdog that already runs - no observer, no second
timer, and never a string we wrote ourselves mistaken for theirs.

The phase (`loading` / `thinking` / `your-move` / `over`) lives on `<html>` as
`data-sfct-phase`, where a test can wait for it and nobody can see it. It is
derived from the game's own state, never from the words on screen, so the two
cannot drift apart.

## Picking a piece up

The press and the release were both read, and nothing in between: there was no
`pointermove` handler in the extension at all, so a piece only moved once its
move had been committed. It now carries a pixel offset on top of the percentage
transform its square gave it, which keeps the square it belongs to and lets the
release simply drop the offset. Under four pixels of travel it is still a click,
so select-then-click keeps working. The piece transition is switched off while a
piece is carried - that transition is what makes a played move slide, and it is
exactly what made a dragged piece lag behind the cursor.

Their own `div.hover-square` was going to be reused for the destination square
and is not, for a measured reason: mid-drag on a live board it paints NOTHING -
`visibility` goes to visible and that is all, with a transparent background and
no border or shadow. The ring under their dragged piece is drawn by their WebGL
renderer; that node is a hit area, and it moves in pixels where everything here
moves in percentages.

## The cards this extension puts up

The result card is a node-for-node copy of their **v6** game-over modal: the same
`-shell-v6` / `-is-v6-modal-enabled` classes, the `header-header` wrapper, their
close button, `cc-button-x-large` buttons carrying their own glyph SVGs
(`arrow-spin-redo`, `arrow-chevron-left`, `mark-cross`), and their
`game-over-primary-cta-…` class, which is where the 16px side inset comes from.
Those classes are global and unscoped: rendered on a live game page beside their
modal, the copy computed identically on card, header, title, subtitle, button row
and button - 400px wide, buttons 368x56.

It is built, never cloned off the live modal. A clone carried their Game Review
star onto our button and their empty ad box (`game-over-ad-sidecar`, 300x282)
beside the card. Borrowing classes still follows their restyles and their theme,
which a copied hex value never does.

It stays a child of `<body>` and never enters their component tree. Inserting one
node of ours into one of their Vue components is what took the whole board down
once already.

**The standing cost of that trick:** our own cards now match every selector that
looks for THEIR game-over surfaces. So each of those is narrowed with
`:not([data-sfct])` - `isGameOver()`, `findGameOverModal()`, and the style that
hides their modal while you play - and every node inside a card carries the
attribute, not just the card itself. Both mistakes were made in order and caught
by the e2e run: the blocker hid our card, and then hid its insides, leaving a
card of full width and no height.

There is no painted fallback for a card whose classes computed to nothing. Their
modal stylesheet was measured present on a finished game reopened later - the one
case that reaches the hand-built card - so a fallback would only ever run on a
fixture.

## FEN extraction (fallback chain)

Tried in order; the first that yields a position wins:

| # | Source |
|:--|:-------|
| 0 | The bridge's `fen` — `getFEN()` in the page world, the position being shown, with real castling and en passant |
| 1 | `game-fen` / `fen` attribute on `wc-chess-board` (a full, authoritative FEN) |
| 2 | Light-DOM piece `<div>`s (`[class*="piece"][class*="square-"]`) → assembled FEN, castling estimated from home squares |

Sources 0 and 1 carry real castling/en-passant data, so they win over the scraped placement.

For a scraped position the en-passant field is **not** left blank: the two squares
Chess.com highlights for the last move give the target exactly, since a double pawn push
is the only move whose highlighted squares sit on one file two ranks apart with a pawn
on the destination. Without it Stockfish never generates the capture and the move comes
back refused, which reads as a bug rather than as a rule. Switch Chess.com's move
highlighting off and there is nothing to read, and the field is `-` again.

Castling rights stay the home-square heuristic, which can only ever over-grant, never
withhold - it will not take a castle away from you. The two counters stay `0 1`: a
continuation is a new game from this position, so counting its fifty-move rule from zero
is right rather than approximate.

**What actually runs on chess.com today is source 0**, and source 2 underneath it when
the bridge is silent. Source 1 never fires: a probe run against live chess.com pages (a
finished game and `/play/computer`, extension loaded) showed the board element carries
only `class`, `id` and `style` - no FEN attribute. The same probe confirmed source 0
holds at every depth of the move list, castling and en passant included. Earlier
versions also tried React state on the board element and page globals like
`window.chessground`; both were removed because a content script runs in an isolated
world where page expandos and page globals are invisible, so those branches could
never fire. Side-effect of scraping: side-to-move and castling rights are heuristics
until the first move, after which Stockfish tracks them from the move list.

## Side to move

Only needed when the position is scraped, which the bridge has made the uncommon case
rather than the usual one - a bridge FEN carries the side to move in its own field. It
stays the hardest thing on the
page to be sure about - because the placement follows the move list while a naive turn
reading does not. Get it wrong and the game starts with the wrong player up, which you
only notice once the engine moves a piece it should not have been able to touch.

`readSideToMove()` takes three independent readings:

1. the **index** of the selected ply among all ply nodes - ply 1 is White's, so the
   parity gives the turn. This needs only that the nodes are enumerable and one is
   marked, so it survives a rename of `white-move` / `black-move`.
2. the **colour class** on that node, which is what this used to read on its own.
3. the board's **last-move highlight** - whichever colour's piece stands on a
   highlighted square just moved, so the other side is up. It follows the position
   being shown, so it stays right while you navigate.

`selected` is matched as a whole class token, never inside a compound: a node classed
`de-selected` would otherwise anchor both list readings on the wrong ply, where they
agree with each other and the board is never consulted. Exactly one ply may claim the
selection. When nothing is marked the board wins over the end of the list, and only when
the board is silent too does the end of the list decide - which is right whenever the
position shown is the final one, the only case that can reach there.

When the readings cannot be reconciled the function returns `null` and the player is
**asked**, with a White / Black card. One question beats a game that is quietly wrong.

A parity count over `[data-whole-move-number]` was tried and is wrong by construction -
that attribute marks move *pairs*, so a live board reported "black to move" both after
`1. e4` and after `1… e5`.

## Opponent rating

`eloFromHeaders()` takes it straight from the bridge's `headers` when they are there:
their board names both ratings, so knowing which colour you play is enough. A bot game
reports `{ BlackElo: "300", WhiteElo: "null" }` - the bot's rating exact, and a
logged-out player's absent rating arriving as that four-letter string, which is refused
rather than turned into a number.

Underneath it, unchanged, the page-scraping path: `getOpponentElo()` reads the first
rating-looking number (`^\(?\d{3,4}\)?$`, chess.com
renders bot ratings as `(250)`) inside the opponent's player row, matched as
`[class*="player"][class*="top"]` - chess.com has renamed that row repeatedly
(`board-player-component` → `player-component player-top` → `player-row-top`), so the
selector matches the durable shape rather than one generation's class names. Falls back
to the strongest explicit rating node on the page, then to 1500.

## Project structure

```
├── lib/
│   ├── chess-core.js     # Pure chess logic (no DOM): FEN ↔ board, applyUciMove, Elo→UCI, perft parsing
│   └── chess-dom.js      # Chess.com DOM scraping: getFEN, colour, opponent Elo, game-over, click→square
├── content_chesscom.js   # Orchestration: engine worker, board rendering, input, lifecycle
├── service-worker.js     # MV3 background — sets the default on/off state
├── popup.html / popup.js # On/off toggle
├── stockfish.js          # Stockfish loader (21 KB, downloaded, git-ignored)
├── stockfish.wasm        # Stockfish engine (7 MB, downloaded, git-ignored)
├── stockfish.sha256      # Pinned engine checksums (both files)
├── manifest.json         # MV3 manifest (Firefox's is derived by scripts/firefox-manifest.py)
├── tests/                # vitest (jsdom): chess-core + chess-dom, with HTML fixtures
│   └── e2e/load.mjs      # real-browser end-to-end run (headed locally, headless in CI)
├── icons/                # 16 / 32 / 48 / 128
└── scripts/download-stockfish.sh
```

The manifests load `lib/chess-core.js`, `lib/chess-dom.js`, then `content_chesscom.js`
into the same content-script world; the libs expose their functions as globals there and
via `module.exports` for the tests.

## Browser support

| Browser | Status | Notes |
|:--------|:------:|:------|
| Chrome MV3 | ✅ | `manifest.json` - also Edge / Brave / Arc / Opera |
| Firefox MV3 | ✅ | `scripts/firefox-manifest.py`, Gecko 128+ |
| Safari | ❌ | Would need the Safari Web Extension Converter + a `browser.*` shim |

## Testing

```bash
npm install
npm test          # vitest (jsdom)
npm run test:watch
npm run test:e2e  # real Chromium + real Stockfish WASM (needs the engine binary)
```

`chess-core.test.js` covers the pure logic (move application incl. castling/en-passant/
promotion, FEN round-trips, Elo mapping, perft parsing). `chess-dom.test.js` runs the
scrapers against realistic HTML fixtures under jsdom. `tests/e2e/load.mjs` covers what
neither can: the extension actually loading in a browser, the engine worker starting,
moves round-tripping through Stockfish, and cleanup on stop.
