# Contributing

Thanks for wanting to improve Stockfish Continue to Play!

## Local dev

1. Clone → `chrome://extensions` → Modalità sviluppatore → Carica estensione non pacchettizzata
2. Modifica → tasto refresh sull'estensione → testa su Chess.com/Lichess
3. Per attivare debug log: apri `content_chesscom.js` e `content_lichess.js`, imposta `DEBUG = true`

## Pull request

- Una modifica per PR
- Testa manualmente la modifica su Chess.com e Lichess prima di aprire
- Menziona se la modifica cambia l'UI o la logica FEN

## Struttura file

| File | Ruolo |
|------|-------|
| `content_chesscom.js` | Rilevamento fine partita + FEN injection su Chess.com |
| `content_lichess.js` | Auto-start su Lichess /editor + fine partita Lichess |
| `stockfish.js` | Stockfish WASM (~10 MB) |
| `service-worker.js` | Service worker MV3 (install handler) |
| `popup.html` / `popup.js` | Popup toggle on/off |

## Note

- Stockfish gira in un Web Worker isolato
- La FEN viene estratta con 5 metodi di fallback (attributo, interno componente, luce DOM, shadow DOM, window state)
- Il livello Lichess viene calibrato automaticamente sull'Elo dell'avversario
