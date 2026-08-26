# Chrome Web Store submission audit

Audited commit: `eb8592f` (main, 2026-08-23). Read-only audit - no code was changed.

**Two files named in the request do not exist**: `engine.js` and `content_lichess.js`. The
Lichess redirect and the separate engine module were removed in v3.0.0; the shipped JS is
`content_chesscom.js`, `lib/chess-core.js`, `lib/chess-dom.js`, `popup.js`,
`service-worker.js`, plus the vendored `stockfish.js`. `tests/e2e/load.mjs`,
`tests/*.test.js` and `vitest.config.js` are development-only and are not packaged.

**Verdict: no rejection-blocking defect in the code.** Everything blocking is dashboard
paperwork (listing assets, permission justifications, data declaration) plus one packaging
decision. Details below.

---

## 1. Remote code

MV3 forbids executing code that is not in the package. **This extension executes no remote
code.** Every construct that could load code:

| Site | What it does | Verdict |
|---|---|---|
| `content_chesscom.js:75` | `fetch(chrome.runtime.getURL('stockfish.js'))` | **NON-BLOCKING** - reads a file inside the package, not the network |
| `content_chesscom.js:78` | `URL.createObjectURL(new Blob([src], {type:'application/javascript'}))` | **NON-BLOCKING** - wraps that packaged text |
| `content_chesscom.js:79` | `new Worker(blobUrl)` | **NON-BLOCKING** - runs packaged code in a worker |
| everywhere else | no `eval`, no `new Function`, no `import()`, no `document.write`, no injected `<script>`, no `innerHTML` in any shipped file | clean |

Grep evidence: those three lines are the *only* matches for
`fetch(|import(|eval(|new Function|createElement('script')|innerHTML|document.write|new Worker|createObjectURL|Blob(`
across `content_chesscom.js`, `lib/*.js`, `popup.js`, `service-worker.js`, `popup.html`.
The single external URL anywhere in the shipped files is a GitHub link in `popup.html:114`,
which is a user-clicked `<a href>`, not a request.

### Is the Stockfish binary bundled or downloaded?

**Bundled, and verified so empirically.**

- `stockfish.js` (10,509,235 bytes) ships inside the zip. It is Stockfish.js 18 (header,
  `stockfish.js:1-8`), a single-file **ASM.JS** build - JavaScript, not WebAssembly - with
  the neural network embedded as 8,579,760 bytes of base64 across 104 chunks. Verified:
  `WebAssembly` appears 0 times in the file, no embedded base64 run carries the WebAssembly
  magic (`AGFzbQ`), and the engine reports itself over UCI as
  `id name Stockfish 18 Lite ASM.JS`.
- `scripts/download-stockfish.sh:11` fetches it **at build time** from
  `github.com/thousandflowers/stockfish-continue-to-play/releases/download/v2.0/stockfish.js`
  and verifies it against `stockfish.js.sha256` (`scripts/download-stockfish.sh:13-31`).
  That script never runs in the browser and is not packaged.
- **Runtime proof**: loading the unpacked extension, then calling
  `context.setOffline(true)` *before* the engine starts, the engine still reaches ready
  ("engine ready - ♟ Stockfish 1450 · Your move") and no `.wasm` request is made. With the
  network switched off entirely, nothing it needs comes from the network.

Two dead loader branches survive inside the vendored file and are worth knowing about when
you next bump the engine - **NON-BLOCKING**, neither is reachable in this build:

- `stockfish.js` sets `Z="stockfish.wasm"` and would resolve it via `locateFile` /
  script directory if `Module.wasmBinary` were absent. It is not absent here.
- a multi-part path, `c(enginePartsCount)`, fetches `stockfish-part-N.wasm` files. This
  build defines no `enginePartsCount`, so the branch is never entered.

If a future engine build drops the embedded binary, both branches would turn into runtime
network fetches of code - which *would* be a policy violation. Re-run the offline check
after any engine upgrade.

### CSP

`manifest.json:46-47` declares
`"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`.

**~~NON-BLOCKING - `wasm-unsafe-eval` is not needed by this build and should come out.~~
Removed in v3.1.0 from both manifests; all 15 e2e checks still pass.** The
bundled engine is the ASM.JS build; it never touches WebAssembly, so the directive loosens
the CSP for nothing and invites a reviewer to ask why an extension that "doesn't run
WebAssembly" asks for permission to compile it. Drop it from both manifests, reload the
extension and play a game to confirm nothing breaks. (Not edited by this audit.)

**NON-BLOCKING risk, outside your control:** the worker is created from a content script,
so it runs against **chess.com's** page CSP, not the extension CSP. It works on chess.com
today (verified on a live game). If chess.com ever tightens `worker-src`/`script-src` to
exclude `blob:`, the engine stops loading and the user sees "Engine failed to load."
(`content_chesscom.js:324`). Nothing to fix now; know the failure signature.

---

## 2. Permissions

### Declared

| Declaration | manifest line | Used at | Verdict |
|---|---|---|---|
| `permissions: ["storage"]` | 6-8 | `service-worker.js:2`; `popup.js:13,18,20,26`; `content_chesscom.js:828,962,984` | justified |
| `host_permissions: ["*://*.chess.com/*"]` | 9-11 | **nothing** | **NON-BLOCKING - declared but unused, recommend deleting** |
| `content_scripts.matches` | 33-34 | all of `content_chesscom.js` | justified, could be tighter |
| `web_accessible_resources.matches` | 40-45 | needed by `content_chesscom.js:75` | justified |
| `optional_permissions` | - | absent | fine |

**`host_permissions` is dead weight.** It grants API-level access to chess.com (fetch from
the service worker, cookies, and so on) and the extension makes no such call: there is no
`fetch`/`XMLHttpRequest` to chess.com anywhere (§1), no `tabs`, no `scripting`, no
`cookies`. The content script is injected by `content_scripts.matches` and the engine file
is reachable through `web_accessible_resources.matches` - neither needs
`host_permissions`. Removing it drops one install-time warning and one thing a reviewer has
to be convinced of. (Verify with a real run after removing; it is a one-line change but
this audit did not make it.)

**Matches are broader than needed on scheme only** - `*://` covers `http://`.
`https://*.chess.com/game/*` and `https://*.chess.com/play/*` describe the real product.
**NON-BLOCKING.**

**`web_accessible_resources` lets any chess.com page detect the extension** by probing
`chrome-extension://<id>/stockfish.js`. Adding `"use_dynamic_url": true` (manifest:41-44)
removes that fingerprinting surface. **NON-BLOCKING.**

### Dashboard justification text - paste as-is

**Single purpose**

> When a game on Chess.com finishes, this extension adds one button to the game-over dialog:
> "Continue vs Computer". Pressing it lets you keep playing the final position against a
> Stockfish chess engine that runs entirely inside your browser, on the same board you were
> already playing on. That is the extension's only function.

**`storage` justification**

> The extension stores two preferences on the user's own device: whether the extension is
> switched on, and which engine strength the user picked in the popup (automatic, a fixed
> rating, or full strength). Without storage these would reset on every page load and the
> on/off switch in the popup could not work. Nothing else is stored and nothing is ever
> sent anywhere.

**Host permission justification** (only if you keep `*://*.chess.com/*`)

> The extension works exclusively on Chess.com game pages. It needs access to those pages to
> read the final position from the board after a game ends and to draw the continued game on
> that same board. It makes no network requests to Chess.com and does not read or transmit
> account data, cookies, or anything the user did not already have on screen.

**Remote code question - answer "No, I am not using remote code"**

> All code, including the Stockfish engine, is contained in the package.
> The engine file is read from the extension's own package with
> chrome.runtime.getURL() and run in a Web Worker. Nothing is fetched from the network at
> runtime; the extension works with the browser offline.

---

## 3. Data

**Outbound network calls at runtime: none.** The only `fetch` is
`content_chesscom.js:75`, and its argument is `chrome.runtime.getURL('stockfish.js')` - a
package-internal URL. Verified by running the extension with the browser offline (§1).

**Storage writes** - all `chrome.storage.local`, all on the user's own machine:

| Write | Value |
|---|---|
| `service-worker.js:2` | `{ active: true }` on install |
| `popup.js:20` | `{ strength: 'auto' \| '800' \| '1200' \| '1600' \| '2000' \| 'max' }` |
| `popup.js:26` | `{ active: <boolean> }` |

`chrome.storage.sync` is never used, so nothing leaves the device even through Chrome sync.

**Analytics / telemetry: none.** No `sendBeacon`, no pixel, no third-party script. Logging
is compiled out: `content_chesscom.js:11` sets `const DEBUG = false`, and `log()`/`warn()`
(`:12-13`) do nothing in the shipped build.

**What the extension reads but never transmits:** the board position, the opponent's
displayed rating (`lib/chess-dom.js:155-171`), the move list and its clocks
(`lib/chess-dom.js:183-204`), and the opponent's displayed name, which it temporarily
replaces with "Stockfish (rating)" while you play (`content_chesscom.js:265-272`, restored
at `:340`). All of it stays in the tab.

**Data Use form:** tick **nothing**. Then certify all three statements - you do not sell
data, you do not use it for unrelated purposes, you do not use it for creditworthiness.

**Privacy policy URL:** not required while you declare zero data collection. It becomes
mandatory the moment you tick any category. Publishing a five-line policy anyway costs
nothing and pre-empts the question - AMO asks the same. Suggested text:

> Stockfish Continue to Play does not collect, transmit or sell any data. Two preferences
> (on/off, engine strength) are stored locally in your browser and never leave your device.
> The chess engine runs entirely on your computer; the extension makes no network requests.

---

## 4. Package

The zip currently produced (`stockfish-continue-to-play.zip`) contains **14 entries,
11,089,306 bytes uncompressed (10.6 MiB), 6.8 MiB compressed**:

```
manifest.json               1,212      lib/chess-dom.js       11,764
service-worker.js              97      lib/chess-core.js       8,197
content_chesscom.js        43,162      icons/icon16.png          692
popup.html                  3,128      icons/icon32.png        1,932
popup.js                    1,042      icons/icon48.png        5,016
                                       icons/icon128.png     503,829
                                       stockfish.js       10,509,235
```

Correctly **excluded** already: `.git` (8.1 MB), `node_modules` (59 MB), `tests/` (72 KB),
`scripts/`, `.github/`, `*.md`, `package.json`, `package-lock.json`, `vitest.config.js`,
`stockfish.js.sha256`, and `manifest-firefox.json` (which must never ship in the Chrome
zip). No source maps exist in the repo. There is no `.claude/` directory here.

Findings:

- **~~NON-BLOCKING - the zip is built by a hand-typed `zip` command, not a committed
  script.~~ Fixed in v3.1.0 by `scripts/package.sh`.** `package.json` has only `test`, `test:watch`, `test:e2e`. One forgetful
  invocation from the repo root (`zip -r … .`) would ship `node_modules` and `.git`.
  Add a `package` script that lists exactly the 8 paths above and nothing else.
- **~~NON-BLOCKING - `icons/icon128.png` is 503,829 bytes.~~ Fixed in v3.1.1, and the
  diagnosis was too kind.** The file was not an oversized 128×128 - it was **640×640**,
  declared in the manifest under the `128` key. Worse, "the other three icons are already
  fine" was wrong: **all four** icons had no alpha channel and carried the editor's grey
  transparency checkerboard baked into the pixels, so every one of them drew a grey tile
  behind the knight in the toolbar. Rebuilt from the master at true sizes with real alpha:
  503,829 → 18,279 bytes for the 128, package 10.6 → 10.2 MiB.
- Size is nowhere near the 2 GB store limit. The user-visible cost is a ~6.8 MiB install.

---

## 5. Manifest hygiene

| Field | Value | Verdict |
|---|---|---|
| `name` (`:3`) | "Stockfish Continue to Play", 26 chars | fine (limit 45) |
| `version` (`:4`) | `3.0.0` | valid format; **stale** - five feature PRs merged since (#11-#15). Bump to `3.1.0` in `manifest.json`, `manifest-firefox.json` and `package.json` so the store version matches what you tested. **NON-BLOCKING** |
| `description` (`:5`) | 109 chars | fine (limit 132) |
| `icons` (`:24-29`) | 16/32/48/128 all present | fine - 128 is the one the store requires |
| `action` (`:15-23`) | `default_popup` + `default_icon` | fine; `default_title` is missing, so the toolbar tooltip falls back to the extension name. **NON-BLOCKING** |
| `content_security_policy` (`:46-48`) | `script-src 'self' 'wasm-unsafe-eval'` | `'self'` is right; **`wasm-unsafe-eval` is unnecessary** - this build has no WebAssembly (§1). Remove it |
| required fields | all present | no missing keys |

Recommended additions, none of them blocking: `minimum_chrome_version` (the MV3
object-form `web_accessible_resources` needs Chrome 103+),
`homepage_url`, `author`.

**BLOCKING for submission, not in the repo:** the dashboard will not accept a listing
without at least one screenshot (1280×800 or 640×400) and a store icon; a 440×280 promo
tile is expected too. None exist in this repository - produce them before you start the
submission form.

---

## 6. Firefox divergence

Normalised diff of `manifest.json` against `manifest-firefox.json` - exactly two
differences, everything else is identical:

1. **Background** - Chrome `"service_worker": "service-worker.js"` (`manifest.json:12-14`)
   vs Firefox `"scripts": ["service-worker.js"]` (`manifest-firefox.json:18-20`). Correct:
   Firefox MV3 uses event pages, not service workers.
2. **`browser_specific_settings.gecko`** - present only in the Firefox manifest
   (`manifest-firefox.json:6-11`), with `id` and `strict_min_version: "128.0"`. Both keys
   AMO requires are present; 128 is a safe floor for MV3.

Flags:

- **~~NON-BLOCKING (AMO)~~ Fixed in v3.1.1** - the hand-typed placeholder id
  `{a1b2c3d4-e5f6-7890-abcd-ef1234567890}` is now `stockfish-continue@thousandflowers`.
  Ids are permanent once published, and it was changed before any publish.
- **~~BLOCKING (AMO only, irrelevant to Chrome)~~ Written up in v3.1.1** -
  `docs/AMO-SOURCE-SUBMISSION.md` has the archive command, the reviewer notes and the
  reproduce-the-binary steps. `stockfish.js` is still minified vendored code, so the
  submission itself is still required.
- **~~NON-BLOCKING~~ Done in v3.1.0** - `scripts/package.sh` renames
  `manifest-firefox.json` to `manifest.json` for the Firefox zip.

---

## 7. Single purpose

> **When a game ends on Chess.com, this extension lets you keep playing the final position
> against a Stockfish engine running locally in your browser, on the same board.**

Everything in the code serves that sentence. There is no second feature: no content script
on any other site, no tab/history/cookie/bookmark access, no network, no background work
beyond setting a default on install (`service-worker.js:1-3`). The popup does two things,
both in service of the purpose: an on/off switch and an engine-strength selector
(`popup.js:17-28`).

One behaviour a reviewer may ask about, worth pre-empting in the listing: while you play
the continuation, the extension **rewrites the opponent's displayed name** on the board to
"Stockfish (rating)" (`content_chesscom.js:265-272`) and hides Chess.com's own pieces with
a stylesheet while it draws the position itself (`content_chesscom.js:172-176`). Both are
reverted when the game is left (`content_chesscom.js:337-345`). It is honest UI - it stops
you thinking you are still playing a person - but it is a visible modification of the
site's own chrome, so say so plainly rather than let a reviewer discover it.

---

## 8. Failure modes - what happens when a selector stops matching

Chess.com renames classes regularly; this section is what happens on the day it does.
**No path found that throws uncaught into the page.**

| Site | Selector / read | On no match |
|---|---|---|
| `lib/chess-dom.js:88` | `wc-chess-board, chess-board` | returns `null` → `content_chesscom.js:830-831` shows "Position not found." banner. Graceful |
| `lib/chess-dom.js:92` | `game-fen` / `fen` attribute | falls through to the piece scrape (this is the path that actually runs on chess.com today) |
| `lib/chess-dom.js:14,27` | `[class*="piece"][class*="square-"]`, `<3` pieces | returns `null` → same "Position not found." banner |
| `lib/chess-dom.js:100-106` | `board.shadowRoot` | wrapped in `try/catch` |
| `lib/chess-dom.js:65-76` | ply nodes, then last-move highlight | **falls back to `'w'`** → side to move can be wrong → the engine may start playing the user's colour. Silent, and the worst functional degradation in the list. **NON-BLOCKING for review, real bug risk** |
| `lib/chess-dom.js:124` | `[class*="player"][class*="top"]` | `null` → `getPlayerColor()` (`:131-136`) falls back to `'white'`; wrong colour if the board is not flipped and no "You" tag exists |
| `lib/chess-dom.js:160-169` | rating nodes | falls back to **1500**, so the engine is sized for a 1500 opponent. Silent |
| `lib/chess-dom.js:183-204` | move clocks | `null` → pacing falls back to the user's own move times. Silent, harmless |
| `lib/chess-dom.js:213` | `[class*="game-over-modal"]` … | `null` → `content_chesscom.js:884` injects the floating fallback button instead. Graceful |
| `lib/chess-dom.js:219-224` | modal buttons | `null` → trigger docks under the modal itself |
| `lib/chess-dom.js:229-238` | `isGameOver()` | each selector individually wrapped in `try/catch` → `false` |
| `lib/chess-dom.js:246` | click → square | `null` on out-of-bounds → handlers bail |
| `content_chesscom.js:209-217` | `findActiveBoard()` | `null` → `:286` "Board not found." banner |
| `content_chesscom.js:265-272` | opponent name node | `null` → renaming is skipped; the restore call is optional-chained (`:340`) |
| `content_chesscom.js:75-99` | engine fetch/worker | HTTP error throws inside the promise, caught at `:99` → rejects → `:320-325` "Engine failed to load." banner |
| `content_chesscom.js:283-329` | whole start path | wrapped in `try/catch`, message surfaced to the user at `:328` |
| `content_chesscom.js:913-915` | `chrome.runtime?.id` | guarded, and the poll stops itself once the extension context is gone |

Two things to know, neither blocking:

- **`syncBoardToState()` (`content_chesscom.js:404-474`) uses `try/finally`, not
  `try/catch`.** The lock is released correctly, but an exception inside it propagates out
  of a `setInterval` callback (`:527-538`), so a rendering bug would log an uncaught error
  once per second in the page console. Nothing breaks for the site, but it is noisy and it
  is the one place a reviewer running with the console open might notice red text.
- **Two always-on timers per chess.com game page**: `setInterval(tryInject, 200)`
  (`:971`) and a 1 s navigation poll (`:974-981`), plus a 1 s board refresh while playing
  (`:527`). Cheap, but they run for as long as the tab is open.

---

## Checklist

### Must fix before you submit

1. **~~Produce the listing assets.~~ Done in v3.1.1.** `store/` now holds five 1280×800
   screenshots, the 440×280 promo tile and a real 128×128 store icon, and
   `store/LISTING.md` carries the paste-ready copy for every field of both dashboards.
2. **Answer the remote-code question "No"** and paste the justification from §2 - a
   reviewer seeing `new Worker(blobUrl)` (`content_chesscom.js:79`) without an explanation
   is the single most likely cause of a bounce.
3. **~~Decide `host_permissions`.~~ Done in v3.1.0.** Deleted from both manifests; the
   only `chrome.*` APIs the shipped code touches are `runtime` and `storage`, neither of
   which needs it. 97 unit tests and all 15 e2e checks still pass. Original wording:
   delete `manifest.json:9-11`, re-run `npm test` and `npm run test:e2e`, and confirm a
   real game on chess.com still works. That removes an install warning you cannot
   otherwise justify, since nothing uses it.
4. **Fill the Data Use form as "does not collect user data"** and certify the three
   statements (§3). The exact ticks are written out in `store/LISTING.md`, and `PRIVACY.md`
   is published for the policy URL - so this is now form-filling, not a decision.
5. **~~Bump the version~~ Done in v3.1.0.** `manifest.json`, `manifest-firefox.json` and
   `package.json` all read `3.1.0`.
6. **~~Commit a packaging script~~ Done in v3.1.0.** `scripts/package.sh` (`npm run
   package`) lists every packaged path explicitly and builds both store zips, renaming
   `manifest-firefox.json` to `manifest.json` for the Firefox one. It re-verifies the
   engine checksum first and adds `LICENSE`, `LICENSE.stockfish` and `LICENSE.MIT` to the
   package, so the GPLv3 notices travel with the binary that carries them.
7. **~~Sort the GPL attribution.~~ Done 2026-08-23.** `stockfish.js:1-8` is GPLv3 and the
   project relicensed to match: `LICENSE` is now GPLv3, with `LICENSE.stockfish`,
   `LICENSE.MIT` and `vendor/STOCKFISH-PROVENANCE.md` alongside it. Original wording: the
   package you distribute is a combined work: keep the engine's notice intact, state in the
   listing and in a `NOTICE`/`LICENSES` file that the bundled engine is Stockfish.js
   (GPLv3) with a link to its source. This is
   a licensing obligation, not a store rule, but it is the kind of thing that is painful to
   fix after publishing.

### Can wait until after review

- **~~Recompress `icons/icon128.png`~~ Done in v3.1.1** — and the size was the smaller
  half of it: the file was **640×640, not 128×128**, and all four icons had the grey
  transparency checkerboard **baked into the pixels** (no alpha channel at all), so the
  toolbar drew a grey tile behind the knight. Rebuilt from the master with real alpha:
  503,829 → 18,279 bytes, package 10.6 → 10.2 MiB.
- `"use_dynamic_url": true` on `web_accessible_resources` (`manifest.json:41-44`) so
  chess.com cannot fingerprint the extension.
- Narrow `content_scripts.matches` to `https://` (`manifest.json:33-34`).
- Add `minimum_chrome_version: "103"`, `action.default_title`, `homepage_url`.
- Wrap `syncBoardToState()` in `try/catch` so a rendering bug cannot log once a second.
- **~~Firefox/AMO~~ Done.** Gecko id is now `stockfish-continue@thousandflowers` (v3.1.1),
  the source-submission notes are in `docs/AMO-SOURCE-SUBMISSION.md` (v3.1.1), and
  `scripts/package.sh` scripts the `manifest-firefox.json` → `manifest.json` rename
  (v3.1.0).
- Re-run the offline check from §1 after any future engine bump; it is the one test that
  proves the remote-code answer is still true.

---

## Addendum - 2026-08-26, found while producing the listing assets

Two defects the read-only audit could not see, because both only show up when you render the
UI rather than read it:

1. **The popup hardcoded its own version.** `popup.html` printed `v3.0.0` in the footer as a
   literal string; it had been wrong since the 3.1.0 bump and would have gone out that way.
   It now reads `chrome.runtime.getManifest().version`, and `tests/popup.test.js` fails if a
   literal version string ever reappears in that file.
2. **The popup named the button wrongly.** It said the *"Continue vs AI"* button appears on
   the game-over dialog; the button has always said **"Continue vs Computer"**. The test
   suite now reads the label straight out of `content_chesscom.js` and asserts the popup
   quotes that exact string, so the two cannot drift apart again.

Also fixed here: the strength dropdown's first option was long enough to be clipped by the
260px popup (`Auto - match the opponent you played` -> `Auto · match your opponent`), and
the icon defects described above.

