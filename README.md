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

## Why I built this

In fast games — bullet, blitz — opponents resign or disconnect all the time, often in positions where the most interesting part is still ahead. I wanted to keep playing from exactly where we left off, without setting anything up.

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

## Roadmap

| | Status |
|---|:---:|
| Lichess support (full) | ✅ |
| Chess.com support (full) | 🔧 in progress |
| Chrome Web Store release | ◻︎ planned |
| Firefox Add-ons release | ◻︎ planned |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, testing, and PR guidelines.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details on difficulty mapping, FEN extraction (5 fallbacks), Elo detection (9 strategies), project structure, and browser porting.

---

## License

MIT — see [LICENSE](LICENSE).
