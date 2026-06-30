# Contributing

Thanks for helping out! This is a small, dependency-light browser extension.

## Local setup

```bash
git clone https://github.com/thousandflowers/stockfish-continue-to-play.git
cd stockfish-continue-to-play
npm install                      # vitest + jsdom (dev only)
bash scripts/download-stockfish.sh   # fetch the engine (~10 MB, git-ignored)
```

Load it unpacked:

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → pick the folder.
- **Firefox:** `cp manifest-firefox.json manifest.json`, then `about:debugging#/runtime/this-firefox` → Load Temporary Add-on.

After editing files, hit the reload icon on the extension card and refresh the Chess.com tab.

## Layout

See [ARCHITECTURE.md](ARCHITECTURE.md). In short:

- `lib/chess-core.js` — pure chess logic, no DOM. Unit-tested directly.
- `lib/chess-dom.js` — Chess.com DOM scraping. Tested under jsdom with HTML fixtures.
- `content_chesscom.js` — orchestration (engine worker, rendering, input, lifecycle).

Keep pure logic in `lib/` so it stays testable; keep DOM/engine wiring in the content
script.

## Testing

```bash
npm test            # run once
npm run test:watch  # watch mode
```

- Add pure-logic cases to `tests/chess-core.test.js`.
- Add scraping cases to `tests/chess-dom.test.js`; for new DOM shapes, drop a realistic
  page snapshot in `tests/fixtures/`.
- All tests must pass before a PR (CI runs `npm test` on push/PR).

## Conventions

- Match the existing style: small functions, early returns, named constants over magic
  numbers, immutable updates.
- No `console.log` in shipped paths — the content script logs only behind `DEBUG`
  (default `false`).
- Conventional commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Update `README.md` / `ARCHITECTURE.md` when behaviour or layout changes.

## A note on Chess.com selectors

Chess.com ships DOM changes regularly. FEN/colour/rating extraction in `lib/chess-dom.js`
uses a fallback cascade for resilience; if extraction breaks, add a new fallback and a
fixture that captures the new markup rather than replacing the existing ones.
