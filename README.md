# ♟️ Stockfish Continue to Play

**Browser extension for Chess.com — when a game ends, keep playing the final position vs Stockfish on the same board. One click.**

[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](#installation)
[![Firefox](https://img.shields.io/badge/Firefox-MV3-FF7139?logo=firefoxbrowser&logoColor=white)](#firefox)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## The problem

You're winning. Your opponent resigns, disconnects, or times out. Game over — but you
wanted to play it through. This extension adds a **Continue vs Computer** button to the
game-over screen. Click it and you keep playing the exact final position against
Stockfish, right there on the Chess.com board, with difficulty matched to your
opponent's rating.

```
Chess.com: Game Over  →  [♟ Continue vs Computer]  →  play the position vs Stockfish (inline)
```

---

## Features

- **Inline on the real board** — no redirect, no new tab; you keep playing on the Chess.com board you were already on.
- **Adaptive difficulty** — Stockfish's `UCI_Elo` is matched to the opponent's rating read from the page.
- **No servers, no telemetry** — Stockfish runs entirely in your browser via WebAssembly. Nothing is uploaded.
- **Click or drag** — move pieces either way; legal destinations are highlighted; promotions auto-queen.
- **Correct chess** — castling, en-passant, checkmate/stalemate and repetition are handled by the engine itself (moves are replayed to Stockfish).
- **On/off toggle** — a popup to disable it when you don't want it.
- **Open source** — MIT.

---

## Installation

```bash
# 1. Clone
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git
cd stockfish-continue-to-play

# 2. Download the Stockfish engine (~10 MB, kept out of git, checksum-verified)
bash scripts/download-stockfish.sh

# 3a. Chrome / Edge / Brave / Arc / Opera
#     chrome://extensions → enable "Developer mode" → "Load unpacked" → pick this folder
```

> `stockfish.js` (~10 MB) is excluded from git to keep clones lean. The
> [download script](scripts/download-stockfish.sh) fetches it and verifies it against
> the pinned checksum in `stockfish.js.sha256`.

### Firefox

Firefox 128+ uses a separate manifest. Swap it in, then load the folder as a temporary
add-on:

```bash
cp manifest-firefox.json manifest.json
# about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → pick manifest.json
```

The extension is **not yet published** on the Chrome Web Store or Firefox Add-ons —
install from source as above.

---

## How to use

1. Finish (or lose/win) a game on Chess.com.
2. On the game-over screen, click **♟ Continue vs Computer**.
3. Play. The badge in the top-right shows whose turn it is; click it to stop.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, testing, and PR guidelines.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the FEN extraction, the move-history engine
model, difficulty mapping, and project structure.

---

## License

MIT — see [LICENSE](LICENSE).
