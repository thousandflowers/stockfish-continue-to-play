# Contributing

Thanks for wanting to improve Stockfish Continue to Play!

## Local dev

1. Clone → `chrome://extensions` → Developer mode → Load unpacked extension
2. Edit → Refresh extension → Test on Chess.com / Lichess
3. For debug logs: open `content_chesscom.js` / `content_lichess.js`, set `DEBUG = true`

### Running tests

```bash
npm install
npm test        # 76 tests across chess + lichess utils
npm run test:watch  # dev mode
```

Tests use **the same `lib/*-utils.js` files** the extension loads — no mocked copies, no bundler shims.

## Pull request

- One change per PR
- `npm test` must pass (CI will check)
- Manually test the change on Chess.com and Lichess before opening
- Mention if the change affects UI, FEN, or Elo detection

## File structure

| File | Role |
|------|------|
| `lib/chess-utils.js` | Pure DOM functions for Chess.com (FEN, Elo, turn, color, game-over) |
| `lib/lichess-utils.js` | Pure DOM functions for Lichess (editor form, selectors, game-over) |
| `tests/chess-utils.test.js` | 54 tests — every Elo strategy, FEN fallback, and mapping |
| `tests/lichess-utils.test.js` | 22 tests — editor auto-start, selectors, form builders |
| `content_chesscom.js` | Game-over detection + button injection on Chess.com |
| `content_lichess.js` | Auto-start on Lichess /editor + game-over detection |
| `stockfish.js` | Stockfish WASM (~10 MB) |
| `service-worker.js` | MV3 service worker (install handler) |
| `popup.html` / `popup.js` | Popup on/off toggle |
| `package.json` / `vitest.config.js` | Test runner (vitest + jsdom) |

## Notes

- Stockfish runs in an isolated Web Worker
- FEN is extracted with **5 fallback methods** (attribute, React state, light DOM, shadow DOM, window state)
- Elo is detected with **9 fallback strategies**, logged as `[elo:1]`–`[elo:9]`
- Lichess level is auto-calibrated to opponent Elo
