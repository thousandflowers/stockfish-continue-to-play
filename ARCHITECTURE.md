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

## FEN extraction (fallback chain)

Tried in order; the first that yields a position wins:

| # | Source |
|:--|:-------|
| 1 | `game-fen` / `fen` attribute on `wc-chess-board` (a full, authoritative FEN) |
| 2 | Light-DOM piece `<div>`s (`[class*="piece"][class*="square-"]`) → assembled FEN, castling estimated from home squares |
| 3 | Same piece parsing inside the board's `shadowRoot` |

Source 1 carries real castling/en-passant data, so it wins over the scraped placement.

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

**What actually runs on chess.com today is source 2.** A probe run against live
chess.com pages (a finished game and `/play/computer`, extension loaded) showed the
board element carries only `class`, `id` and `style` - no FEN attribute. Earlier
versions also tried React state on the board element and page globals like
`window.chessground`; both were removed because a content script runs in an isolated
world where page expandos and page globals are invisible, so those branches could
never fire. Side-effect of scraping: side-to-move and castling rights are heuristics
until the first move, after which Stockfish tracks them from the move list.

## Side to move

Only needed when the position is scraped (the usual case), and the hardest thing on the
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

`getOpponentElo()` reads the first rating-looking number (`^\(?\d{3,4}\)?$`, chess.com
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
├── manifest.json         # Chrome MV3 manifest
├── manifest-firefox.json # Firefox MV3 manifest (Gecko 128+)
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
| Firefox MV3 | ✅ | `manifest-firefox.json`, Gecko 128+ |
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
