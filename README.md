# ♟️ Stockfish Continue to Play

**Browser extension for Chess.com & Lichess — after your opponent resigns, disconnects, or times out, continue the game vs Stockfish.**

[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://github.com/thousandflowers/stockfish-continue-to-play#installation)
[![Firefox](https://img.shields.io/badge/Firefox-MV3-FF7139?logo=firefoxbrowser&logoColor=white)](https://github.com/thousandflowers/stockfish-continue-to-play#firefox)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## The Problem

You're winning. Your opponent resigns. Game over — but you wanted to play it through.

This extension intercepts the game-over screen on Chess.com or Lichess, extracts the final board position (FEN), and loads it on Lichess against Stockfish — with difficulty automatically matched to your opponent's Elo. **No setup. One click.**

---

## Flow

```
Chess.com: Game Over → [🔗 Continue on Lichess] → click
       ↓
Lichess: /editor with your position → Stockfish (adaptive level)
       ↓
Play!
```

---

## Features

- **Chess.com + Lichess support** — captures final position on both platforms
- **Adaptive difficulty** — Stockfish auto-calibrates to opponent Elo via 9-strategy detection cascade
- **No backend** — Stockfish runs in WASM inside the browser. 0 servers, 0 KB sent
- **Zero configuration** — install and play
- **On/Off toggle** — popup to disable when not needed
- **Open source** — no tracking, no telemetry

### Difficulty Mapping

The extension reads your opponent's rating from the DOM using **9 independent strategies** (primary selectors, data attributes, React internal state, preloaded window state, and CSS wildcard patterns). Each strategy is logged as `[elo:1]`–`[elo:9]` so you can immediately identify which selector works — or which broke after a Chess.com update.

Once extracted, the Elo is mapped to two difficulty systems:

| Output | Range | Type |
|:---|:---:|:---|
| Lichess AI Level | 1–8 | Discrete (8 buckets) |
| Stockfish `UCI_Elo` | 1320–3190 | **Continuous** (linear interpolation) |

**`eloToUCIElo()`** maps the opponent's Elo (400–2500) linearly to Stockfish's UCI_Elo range (1320–3190). Values outside [400, 2500] are clamped. This gives a smooth difficulty curve without the jumps of bucket-based level selection — your opponent's exact strength is preserved in the UCI_Elo parameter sent to Stockfish.

The Lichess level (1–8) is used for the Lichess AI form, while the UCI_Elo value is stored alongside it for direct Stockfish control.

---

## Installation

```bash
# Clone
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git
cd stockfish-continue-to-play

# Download Stockfish WASM binary (~10 MB)
bash scripts/download-stockfish.sh

# Chrome: chrome://extensions → Developer mode → Load unpacked
# Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on
```

> `stockfish.js` (~10 MB) is excluded from git. The [download script](scripts/download-stockfish.sh) fetches it from the latest release. Or install Git LFS (`git lfs pull`) before loading.

### Firefox

Firefox 128+ supports the same MV3 manifest with minor differences. Load with:

```bash
# Copy the Firefox manifest over the default
cp manifest-firefox.json manifest.json
# Then load in about:debugging#/runtime/this-firefox
```

Or use the `manifest-firefox.json` file directly when packaging for Firefox Add-ons.

The extension is **not yet published** on the Chrome Web Store or Firefox Add-ons. Install from source using the instructions above.

---

## How It Works

1. **Chess.com** — Content script detects the Game Over screen, injects a "Continue on Lichess" button
2. **FEN extraction** — Reads the position from the DOM with 5 fallback methods (attributes, React internal state, light DOM pieces, shadow DOM, window state)
3. **Elo detection** — Reads opponent rating with 9 fallback strategies (CSS selectors, data attributes, React state, preloaded data)
4. **Open Lichess** — Saves FEN + level + UCI_Elo to storage and opens `/editor` on Lichess
5. **Auto-start** — Content script on Lichess reads storage, sets level and color, clicks "vs Computer" automatically

Logic shared between platforms lives in `lib/chess-utils.js` and `lib/lichess-utils.js` — pure DOM functions tested independently from the extension runtime. **95 tests** cover all extraction paths, including snapshot tests against realistic HTML fixtures.

The Stockfish engine (compiled to WASM) runs in an isolated Web Worker — communication via UCI protocol over `postMessage`.

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
├── CONTRIBUTING.md         # Local dev guide
├── LICENSE                 # MIT
└── .github/                # Issue templates
```

---

## Building from Source

No build step required. This is a plain browser extension — no bundlers, no transpilers, no npm.

```bash
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git
cd stockfish-continue-to-play
bash scripts/download-stockfish.sh
# Chrome: chrome://extensions → Developer mode → Load unpacked
# Firefox: cp manifest-firefox.json manifest.json, then about:debugging → Load Temporary Add-on
```

To enable debug logging, open the content scripts and set `DEBUG = true` at the top.

### Running Tests

```bash
npm install    # install vitest + jsdom
npm test       # runs 95 tests (vitest)
```

Tests run against the same `lib/*-utils.js` files used at runtime — no mocking the real code. Each FEN fallback and Elo strategy is tested individually. Snapshot E2E tests verify the full extraction pipeline against realistic HTML page fixtures.

### Browser Porting

- **Chrome MV3**: `manifest.json` — works as-is in Chrome, Edge, Brave, Arc, Opera.
- **Firefox MV3**: `manifest-firefox.json` — requires `browser_specific_settings.gecko.id` (replace the placeholder UUID with your Firefox Add-ons ID before publishing). Copy over `manifest.json` to test locally.
- **Safari**: Not yet supported. The extension uses MV3 `chrome.*` APIs; a Safari Xcode project wrapper would be needed.
---

## License

MIT — see [LICENSE](LICENSE).
