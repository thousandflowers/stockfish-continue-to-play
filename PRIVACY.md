# Privacy Policy

**Stockfish Continue to Play** does not collect, transmit, store on any server, or sell any
data. There is no account, no analytics, no telemetry, and no third-party service involved.

Last updated: 2026-08-26. Applies to version 3.1.0 and later, on both Chrome and Firefox.

## What leaves your device

Nothing.

The extension makes no network requests at runtime. The Stockfish engine is a file inside
the extension package; it is read with `chrome.runtime.getURL()` and run in a Web Worker on
your own machine. You can verify this by switching your network off entirely: the extension
still works.

## What is stored, and where

Two preferences, in `chrome.storage.local`, which lives in your browser profile on your own
computer:

| Key | Value | Why |
|---|---|---|
| `active` | `true` / `false` | the on/off switch in the popup |
| `strength` | `auto`, `800`, `1200`, `1600`, `2000` or `max` | the engine strength you picked |

`chrome.storage.sync` is never used, so these do not travel between your devices through
browser sync either. Uninstalling the extension removes them.

## What the extension reads but never transmits

To draw and play the continued game it reads, from the Chess.com page already open in front
of you: the position on the board, the move list and its clocks, the opponent's displayed
rating, and the opponent's displayed name. All of it stays inside that browser tab and is
discarded when you leave the page. While you play the continuation the extension replaces
the opponent's displayed name with "Stockfish (rating)" so you cannot mistake the engine for
a person; the original name is restored when you stop.

## Permissions

- **`storage`** - to remember the two preferences above.
- **Access to `chess.com` game pages** - the content script runs only on
  `*://*.chess.com/game/*` and `*://*.chess.com/play/*`, and only to read the finished
  position and draw the continued game on that same board. The extension makes no network
  request to Chess.com and does not read or transmit account data or cookies.

The extension declares no other permissions.

## Children

The extension collects no data from anyone, of any age.

## Changes

Any future version that collects anything at all would require a new version of this
document and a new data declaration in the store listing. The document is versioned in git
alongside the code, so its history is public:
<https://github.com/thousandflowers/stockfish-continue-to-play/commits/main/PRIVACY.md>

## Contact

Open an issue: <https://github.com/thousandflowers/stockfish-continue-to-play/issues>
