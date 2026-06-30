# Architecture

## How it works

1. **Detect game over** — a content script on Chess.com watches for the game-over modal and injects a **Continue vs Computer** button next to Rematch / New Game.
2. **Capture the position** — on click it reads the final FEN and the player's colour from the page, and the opponent's rating to pick a difficulty.
3. **Play inline** — it hides the game-over modal and renders the position on the existing Chess.com board. Stockfish runs in a Web Worker; you move by click or drag, the engine replies.

There is no redirect and no backend: Stockfish (WebAssembly) runs in your browser and nothing is uploaded.

## Engine model: replay the move history

Rather than rebuilding a full FEN after each move (which is error-prone for castling
rights, en-passant and clocks), the content script keeps the captured **start FEN** plus
a list of **UCI moves** and sends:

```
position fen <startFen> moves <m1> <m2> …
```

Stockfish then tracks castling rights, en-passant, the 50-move rule and threefold
repetition natively. Legal moves for the side to move are obtained from the engine with
`go perft 1`; when that returns zero moves the game has ended (checkmate or stalemate)
and the overlay closes with a result banner. A local board map is kept only for
rendering and is updated immutably (`applyUciMove` returns a new board).

## Difficulty mapping

`eloToUCIElo()` maps the opponent's rating (clamped to 400–2500) linearly onto
Stockfish's `UCI_Elo` range (1320–3190), then sets `UCI_LimitStrength true`. This gives a
smooth difficulty curve that mirrors the opponent's strength.

## FEN extraction (fallback chain)

Tried in order; the first that yields a position wins:

| # | Source |
|:--|:-------|
| 1 | `game-fen` / `fen` attribute on `wc-chess-board` (a full, authoritative FEN) |
| 2 | React/internal state on the board element (`setupFen` / `game.fen` / …) |
| 3 | Global app state (`window.chessground.state.fen` / `window.board.game.fen` / `window.game.fen`) |
| 4 | Light-DOM piece `<div>`s (`[class*="piece"][class*="square-"]`) → assembled FEN, castling estimated from home squares |
| 5 | Same piece parsing inside the board's `shadowRoot` |

Sources 1–3 carry real castling/en-passant data, so they are preferred over the scraped
placement.

## Project structure

```
├── lib/
│   ├── chess-core.js     # Pure chess logic (no DOM): FEN ↔ board, applyUciMove, Elo→UCI, perft parsing
│   └── chess-dom.js      # Chess.com DOM scraping: getFEN, colour, opponent Elo, game-over, click→square
├── content_chesscom.js   # Orchestration: engine worker, board rendering, input, lifecycle
├── service-worker.js     # MV3 background — sets the default on/off state
├── popup.html / popup.js # On/off toggle
├── stockfish.js          # Stockfish engine (~10 MB, downloaded, git-ignored)
├── stockfish.js.sha256   # Pinned engine checksum
├── manifest.json         # Chrome MV3 manifest
├── manifest-firefox.json # Firefox MV3 manifest (Gecko 128+)
├── tests/                # vitest (jsdom): chess-core + chess-dom, with HTML fixtures
├── icons/                # 16 / 32 / 48 / 128
└── scripts/download-stockfish.sh
```

The manifests load `lib/chess-core.js`, `lib/chess-dom.js`, then `content_chesscom.js`
into the same content-script world; the libs expose their functions as globals there and
via `module.exports` for the tests.

## Browser support

| Browser | Status | Notes |
|:--------|:------:|:------|
| Chrome MV3 | ✅ | `manifest.json` — also Edge / Brave / Arc / Opera |
| Firefox MV3 | ✅ | `manifest-firefox.json`, Gecko 128+ |
| Safari | ❌ | Would need the Safari Web Extension Converter + a `browser.*` shim |

## Testing

```bash
npm install
npm test          # vitest (jsdom)
npm run test:watch
```

`chess-core.test.js` covers the pure logic (move application incl. castling/en-passant/
promotion, FEN round-trips, Elo mapping, perft parsing). `chess-dom.test.js` runs the
scrapers against realistic HTML fixtures under jsdom.
