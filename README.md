# ♟️ Stockfish Continue to Play

**Browser extension per Chess.com e Lichess — dopo che l'avversario abbandona, continua la partita contro Stockfish.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)]()
[![Manifest](https://img.shields.io/badge/MV3-Chrome-brightgreen)]()
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## Il problema

Stai vincendo. L'avversario abbandona. Partita finita — ma tu volevi giocarla fino in fondo.

Questa estensione intercetta la fine della partita su Chess.com o Lichess, estrae la posizione finale (FEN) e la carica su Lichess contro Stockfish — con difficoltà automaticamente adattata all'Elo del tuo avversario. **Niente setup. Un click.**

---

## Demo

```
Chess.com: Game Over → [🔗 Continua su Lichess] → click
       ↓
Lichess: /editor con la tua posizione → Stockfish (livello adattivo)
       ↓
Gioca!
```

---

## Caratteristiche

- **Supporto Chess.com + Lichess** — cattura la posizione finale su entrambi i siti
- **Difficoltà adattiva** — Stockfish si imposta automaticamente sul livello del tuo avversario (da 1320 a 3190 Elo)
- **Niente backend** — Stockfish gira in WASM nel browser, 0 server, 0 KB inviati
- **Zero configurazione** — installa e gioca
- **On/Off toggle** — popup per disattivare quando non serve
- **Open source** — niente tracking, niente telemetria

### Adattamento Elo

| Elo avversario | Livello | Skill Level |
|:---:|:---:|:---:|
| &lt;800 | 1 | 0 |
| 800–1000 | 2 | 3 |
| 1000–1200 | 3 | 6 |
| 1200–1400 | 4 | 9 |
| 1400–1600 | 5 | 12 |
| 1600–1800 | 6 | 15 |
| 1800–2000 | 7 | 18 |
| 2000+ | 8 | 20 |

Stockfish usa `UCI_Elo` + `UCI_LimitStrength` per una simulazione realistica, non solo limiti di profondità.

---

## Installazione

```bash
# 1. Clona il repo
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git

# 2. Vai su chrome://extensions → Modalità sviluppatore

# 3. Carica estensione non pacchettizzata → seleziona la cartella
```

---

## Come funziona

1. **Chess.com** — Il content script rileva la schermata Game Over, inietta il bottone "Continua su Lichess"
2. **FEN extraction** — Legge la posizione dal DOM con 5 metodi di fallback (attributi, shadow DOM, window state, ricostruzione pezzi)
3. **Apertura Lichess** — Salva FEN + livello nello storage e apre `/editor` su Lichess
4. **Auto-start** — Il content script su Lichess legge lo storage, imposta livello e colore, clicca "vs Computer" automaticamente

Lo Stockfish engine (compilato in WASM) gira in un Web Worker isolato — comunicazione via UCI protocol over `postMessage`.

---

## Struttura

```
├── manifest.json           # Chrome MV3
├── content_chesscom.js     # Injection + FEN extraction (Chess.com)
├── content_lichess.js      # Auto-start + game-over (Lichess)
├── engine.js               # Stockfish Web Worker + UCI wrapper
├── stockfish.js            # Stockfish WASM (~10 MB)
├── service-worker.js       # Service worker minimo
├── popup.html / popup.js   # Toggle on/off
└── icons/
```

---

## License

MIT — vedi [LICENSE](LICENSE).
