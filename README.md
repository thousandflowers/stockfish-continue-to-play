# ♟️ Stockfish Continue to Play

**Browser extension for Chess.com & Lichess — after your opponent resigns, disconnects, or times out, continue the game vs Stockfish.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)]()
[![Manifest](https://img.shields.io/badge/MV3-Chrome-brightgreen)]()
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
- **Adaptive difficulty** — Stockfish auto-calibrates to opponent Elo
- **No backend** — Stockfish runs in WASM inside the browser. 0 servers, 0 KB sent
- **Zero configuration** — install and play
- **On/Off toggle** — popup to disable when not needed
- **Open source** — no tracking, no telemetry

### Difficulty Mapping

The table below shows how your opponent's Elo rating maps to a human-like difficulty. Internally, Stockfish uses the `UCI_Elo` setting (range **1320–3190**) for engine-level strength, which produces realistic play without artificial depth limits.

| Opponent Elo | Lichess Level | Stockfish `UCI_Elo` |
|:---:|:---:|:---:|
| <800 | 1 | 1320 |
| 800–1000 | 2 | 1500 |
| 1000–1200 | 3 | 1650 |
| 1200–1400 | 4 | 1800 |
| 1400–1600 | 5 | 2000 |
| 1600–1800 | 6 | 2200 |
| 1800–2000 | 7 | 2500 |
| 2000+ | 8 | 3190 |

The result: the engine plays at approximately your opponent's strength — not weaker, not stronger.

---

## Installation

```bash
# Clone
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git
cd stockfish-continue-to-play

# Download Stockfish WASM binary (~10 MB)
bash scripts/download-stockfish.sh

# Go to chrome://extensions → Developer mode
# Load unpacked extension → select this folder
```

> `stockfish.js` (~10 MB) is excluded from git. The [download script](scripts/download-stockfish.sh) fetches it from the latest release. Or install Git LFS (`git lfs pull`) before loading.

Or install from the [Chrome Web Store]() (coming soon).

---

## How It Works

1. **Chess.com** — Content script detects the Game Over screen, injects a "Continue on Lichess" button
2. **FEN extraction** — Reads the position from the DOM with 5 fallback methods (attributes, shadow DOM, window state, piece reconstruction)
3. **Open Lichess** — Saves FEN + level to storage and opens `/editor` on Lichess
4. **Auto-start** — Content script on Lichess reads storage, sets level and color, clicks "vs Computer" automatically

The Stockfish engine (compiled to WASM) runs in an isolated Web Worker — communication via UCI protocol over `postMessage`.

---

## Project Structure

```
├── manifest.json           # Chrome MV3 manifest
├── content_chesscom.js     # Button injection + FEN extraction (Chess.com)
├── content_lichess.js      # Auto-start + game-over detection (Lichess)
├── stockfish.js            # Stockfish WASM binary (~10 MB)
├── service-worker.js       # Minimal MV3 service worker
├── popup.html / popup.js   # On/off toggle popup
├── icons/                  # Extension icons (16/32/48/128)
├── CONTRIBUTING.md         # Local dev guide
├── LICENSE                 # MIT
└── .github/                # Issue templates
```

---

## Building from Source

No build step required. This is a plain Chrome extension — no bundlers, no transpilers, no npm.

1. Clone the repo
2. Load as unpacked extension in Chrome
3. Done

To enable debug logging, open the content scripts and set `DEBUG = true` at the top.
---

## License

MIT — see [LICENSE](LICENSE).
