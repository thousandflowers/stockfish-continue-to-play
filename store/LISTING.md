# Store listing - copy to paste into the dashboards

Everything a reviewer or a form asks for, written out. Copy the blocks verbatim: each answer
was written against the shipped code and re-checked against it, so the two agree. Where an
answer depends on how the engine is packaged - the remote-code question above all - the
reasoning is in [`../vendor/STOCKFISH-PROVENANCE.md`](../vendor/STOCKFISH-PROVENANCE.md) and
[`../docs/PUBLISHING.md`](../docs/PUBLISHING.md).

Assets in this folder:

| File | Where it goes | Required? |
|---|---|---|
| `screenshots/1-continue-vs-computer.png` | CWS screenshot 1, AMO screenshot 1 | **yes, at least one** |
| `screenshots/2-new-game-vs-stockfish.png` | screenshot 2 | no |
| `screenshots/3-playing-on-the-same-board.png` | screenshot 3 | no |
| `screenshots/4-result-and-play-again.png` | screenshot 4 | no |
| `screenshots/5-strength-and-on-off.png` | screenshot 5 | no |
| `promo-tile-440x280.png` | CWS "small promo tile" | expected |
| `store-icon-128.png` | CWS store icon | **yes** |
| `icon-source-534.png` | master artwork, not uploaded | - |

All screenshots are 1280x800 PNG, which is one of the two sizes Chrome accepts (the other is
640x400). There is no 1400x560 marquee tile here: it is only used for the homepage
promo slots you have to be invited into, so it is not worth making until then.

---

## Name

```
Stockfish Continue to Play
```

26 characters, under the 45-character limit.

## Short description (132 char limit)

```
After a game ends on Chess.com, continue the position vs Stockfish AI on the same page. One click, automatic.
```

109 characters. Identical to `description` in `manifest.json`, which is what the store
shows if you leave the field alone - keep the two in step.

## Category

`Entertainment` on Chrome. On AMO: `Games & Entertainment`.

## Full description

```
A game on Chess.com ends and the position is still interesting. Maybe you were winning
before you flagged. Maybe you want to see whether that endgame was actually holdable.
Chess.com will offer you a rematch or a review, but it will not let you simply keep playing
the position you were just in.

This extension adds one button to the game-over dialog: "Continue vs Computer". Press it and
the same board keeps going, against Stockfish, from the exact final position. No redirect, no
new tab, no re-entering the position by hand.

HOW IT WORKS

- Finish a game on Chess.com.
- The button appears on the game-over dialog.
- Play on. The badge in the top right shows whose turn it is; click it to stop and the
  original board comes straight back.

WHAT IT DOES WELL

- Inline on the real board. It is the Chess.com board you were already looking at, not a
  copy on another site.
- Adaptive difficulty. By default the engine is sized to the rating of the opponent you just
  played, so the continuation feels like the game did. You can override it: 800, 1200, 1600,
  2000, or full strength.
- Paced like a real game. The engine does not answer instantly in a game that was running on
  a ten-minute clock; it takes roughly as long as your opponent was taking.
- Correct chess. Castling, en passant, promotion, checkmate, stalemate and repetition are all
  decided by Stockfish itself, not by a re-implementation. Castle by dropping your king on
  the rook. Promote to whatever you want, not always a queen. A king in check turns red.
- The game ends properly. A named result, and the final position stays on the board until
  you leave.

PRIVACY

The engine runs entirely inside your browser. The extension makes no network requests at
all - it works with your computer offline. Nothing is collected, nothing is uploaded, there
is no account and no analytics. The only things stored are two preferences on your own
device: whether the extension is on, and the strength you picked.

OPEN SOURCE

Full source, including how the engine binary is fetched and checksum-verified:
https://github.com/thousandflowers/stockfish-continue-to-play

This extension bundles Stockfish, the open-source chess engine by the Stockfish developers
(https://github.com/official-stockfish/Stockfish), used under the GNU General Public License
v3; the JavaScript build is nmrugg/stockfish.js. Because of that, the extension itself is
released under the GPLv3, and its full source is available at the link above.

This extension is an independent project. It is not affiliated with, endorsed by, or
sponsored by Chess.com or Lichess.
```

The last two paragraphs are the licence and non-affiliation notices and are not optional -
see [`../LISTING-LICENSE-NOTE.md`](../LISTING-LICENSE-NOTE.md) for why each one is there.
Keep them as plain text with bare URLs: the description field does not render Markdown.

---

## Chrome Web Store: the questions the form asks

### Single purpose

```
When a game on Chess.com finishes, this extension adds one button to the game-over dialog:
"Continue vs Computer". Pressing it lets you keep playing the final position against a
Stockfish chess engine that runs entirely inside your browser, on the same board you were
already playing on. That is the extension's only function.
```

### `storage` justification

```
The extension stores two preferences on the user's own device: whether the extension is
switched on, and which engine strength the user picked in the popup (automatic, a fixed
rating, or full strength). Without storage these would reset on every page load and the
on/off switch in the popup could not work. Nothing else is stored and nothing is ever
sent anywhere.
```

### Host permission justification

Not needed. `host_permissions` was removed in v3.1.0 - nothing in the code used it. If the
form asks about `content_scripts.matches` instead:

```
The extension works exclusively on Chess.com game pages. It needs access to those pages to
read the final position from the board after a game ends and to draw the continued game on
that same board. It makes no network requests to Chess.com and does not read or transmit
account data, cookies, or anything the user did not already have on screen.
```

### Are you using remote code?

Answer **"No, I am not using remote code."**

```
All code, including the Stockfish engine, is contained in the package. The engine ships as
two packaged files: a small JavaScript loader and a WebAssembly binary. The loader is read
from the extension's own package with chrome.runtime.getURL() and run in a Web Worker, and
it is given the packaged .wasm through a chrome.runtime.getURL() address as well. Nothing is
fetched from the network at runtime; the extension works with the browser offline, and the
test suite verifies that by running the whole flow with the browser context set offline.
```

This is the answer that matters most. A reviewer who finds `new Worker(blobUrl)` in
`content_chesscom.js` without this explanation is the single most likely cause of a bounce.
The blob wraps a file that ships inside the package - it is not remote code.

### Data use

Tick **nothing**. Then certify all three statements:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://github.com/thousandflowers/stockfish-continue-to-play/blob/main/PRIVACY.md
```

Not strictly required while the data declaration is empty, but it costs nothing and answers
the question before it is asked.

---

## Firefox / AMO: what differs

- Upload the **firefox** zip, not the chrome one. `npm run package` builds both;
  the Firefox one has `manifest-firefox.json` renamed to `manifest.json` inside it.
- AMO requires a **source-code submission** because the vendored engine loader is minified.
  The build instructions are in [`../docs/AMO-SOURCE-SUBMISSION.md`](../docs/AMO-SOURCE-SUBMISSION.md);
  paste that file's "Notes for the reviewer" section into the source-upload form.
- The add-on id is `stockfish-continue@thousandflowers` and is permanent once published.
- Same screenshots, same description, same privacy answers. AMO asks the non-affiliation
  question implicitly through its trademark policy, so keep that paragraph.
