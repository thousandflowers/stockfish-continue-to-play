# Architecture

## How It Works

1. **Chess.com** — Content script detects the Game Over screen, injects a "Continue on Lichess" button
2. **FEN extraction** — Reads the position from the DOM with 5 fallback methods (attributes, React internal state, light DOM pieces, shadow DOM, window state)
3. **Elo detection** — Reads opponent rating with 9 fallback strategies (CSS selectors, data attributes, React state, preloaded data)
4. **Open Lichess** — Saves FEN + level + UCI_Elo to storage and opens `/editor` on Lichess
5. **Auto-start** — Content script on Lichess reads storage, sets level and color, clicks "vs Computer" automatically

Logic shared between platforms lives in `lib/chess-utils.js` and `lib/lichess-utils.js` — pure DOM functions tested independently from the extension runtime. **95 tests** cover all extraction paths, including snapshot tests against realistic HTML fixtures.

The Stockfish engine (compiled to WASM) runs in an isolated Web Worker — communication via UCI protocol over `postMessage`.

---

## Difficulty Mapping

The extension reads your opponent's rating from the DOM using **9 independent strategies** (primary selectors, data attributes, React internal state, preloaded window state, and CSS wildcard patterns). Each strategy is logged as `[elo:1]`–`[elo:9]` so you can immediately identify which selector works — or which broke after a Chess.com update.

Once extracted, the Elo is mapped to two difficulty systems:

| Output | Range | Type |
|:---|:---:|:---|
| Lichess AI Level | 1–8 | Discrete (8 buckets) |
| Stockfish `UCI_Elo` | 1320–3190 | **Continuous** (linear interpolation) |

**`eloToUCIElo()`** maps the opponent's Elo (400–2500) linearly to Stockfish's UCI_Elo range (1320–3190). Values outside [400, 2500] are clamped. This gives a smooth difficulty curve without the jumps of bucket-based level selection — your opponent's exact strength is preserved in the UCI_Elo parameter sent to Stockfish.

The Lichess level (1–8) is used for the Lichess AI form, while the UCI_Elo value is stored alongside it for direct Stockfish control.

---

## FEN Extraction (5 Fallbacks)

| # | Method | Selector / Source |
|:--|:-------|:------------------|
| 1 | Attribute | `wc-chess-board[game-fen]` or `[fen]` |
| 2 | React state | Internal `__react...` fiber on board element |
| 3 | Light DOM | Piece divs (`[class*="piece"][class*="square-"]`) → build FEN |
| 4 | Shadow DOM | Same piece parsing inside `board.shadowRoot` |
| 5 | Window state | `window.chessground.state.fen` / `window.board.game.fen` / `window.game.fen` |

---

## Elo Detection (9 Strategies)

| # | Strategy | Logged as |
|:--|:---------|:----------|
| 1 | `.board-player-component:first-child .user-tagline-rating` | `[elo:1]` |
| 2 | `.player-component.player-top .user-tagline-rating` | `[elo:2]` |
| 3 | `[data-opponent-rating]` attribute | `[elo:3]` |
| 4 | `.board-player-component:first-child [data-rating]` | `[elo:4]` |
| 5 | `.board-player-component:first-child .rating-number` | `[elo:5]` |
| 6 | `[class*="rating"]:not(.user-tagline-rating)` with 3-4 digit text | `[elo:6]` |
| 7 | Max `.user-tagline-rating` across all elements | `[elo:7]` |
| 8 | React internal state on opponent section | `[elo:8]` |
| 9 | `window.__PRELOADED_STATE__` | `[elo:9]` |
| Fallback | `1500` | `[elo:0]` |

---

## Project Structure

```
├── lib/
│   ├── chess-utils.js      # Pure functions: FEN, Elo, turn, color, game-over (Chess.com)
│   └── lichess-utils.js    # Pure functions: editor form, selectors, game-over (Lichess)
├── tests/
│   ├── fixtures/              # HTML snapshot fixtures (realistic DOM pages)
│   ├── chess-utils.test.js    # 54 tests — FEN, Elo, color, turn, game-over
│   ├── lichess-utils.test.js  # 22 tests — editor auto-start, selectors, form
│   └── fixtures.test.js       # 19 tests — snapshot E2E extraction pipeline
├── content_chesscom.js     # Button injection + FEN extraction (Chess.com)
├── content_lichess.js      # Auto-start + game-over detection (Lichess)
├── stockfish.js            # Stockfish WASM binary (~10 MB)
├── service-worker.js       # Minimal MV3 service worker
├── popup.html / popup.js   # On/off toggle popup
├── package.json            # npm test runner (vitest + jsdom)
├── vitest.config.js        # Vitest configuration
├── icons/                  # Extension icons (16/32/48/128)
├── manifest.json           # Chrome MV3 manifest
├── manifest-firefox.json   # Firefox MV3 manifest
├── CONTRIBUTING.md         # Local dev guide
├── ARCHITECTURE.md         # This file
├── README.md               # User-facing docs
├── LICENSE                 # MIT
└── .github/                # CI + issue templates
```

---

## Browser Porting

| Browser | Status | Notes |
|:--------|:-------|:------|
| Chrome MV3 | ✅ Supported | `manifest.json`, works in Edge/Brave/Arc/Opera |
| Firefox MV3 | ✅ Supported | `manifest-firefox.json`, Gecko 128+ |
| Safari | ❌ Not yet | Needs Xcode project + `SFSafariExtensionHandler` |

**Safari**: Would require wrapping the extension with Apple's [Safari Web Extension Converter](https://developer.apple.com/documentation/safariservices/safari_web_extensions/converting_a_web_extension_for_safari). The `chrome.*` APIs would need a `browser.*` polyfill or explicit `Promise` wrappers since Safari uses the `browser` namespace (like Firefox). This also enables iOS support.

---

## Testing

```bash
npm install    # install vitest + jsdom
npm test       # runs 95 tests (vitest)
npm run test:watch  # dev mode
```

Tests use **the same `lib/*-utils.js` files** the extension loads — no mocked copies, no bundler shims. Snapshot E2E tests (`tests/fixtures.test.js`) load realistic HTML pages and verify the full extraction pipeline.

### Weekly Selector Audit

A scheduled GitHub Action runs every Sunday to test the extraction selectors against live Chess.com/Lichess pages. If all strategies return `null`/default, the workflow fails — signaling a possible frontend breakage.

The audit script (`scripts/audit-selectors.mjs`) uses Playwright to:
1. Open a completed game on Chess.com
2. Wait for the game-over modal
3. Run `getFEN()` and `getOpponentElo()` in the page context
4. Report which strategies matched
