# Provenance of the bundled Stockfish engine

**Recorded: 2026-08-26**, for the engine that ships from v3.2.0 onward. Every field below is
either measured from the files that ship in the package or marked **UNKNOWN**. Nothing here
is guessed.

The history of the previous engine, and why it was replaced, is at the bottom.

## The files

| | `stockfish.js` | `stockfish.wasm` |
|---|---|---|
| Role | Emscripten loader | the engine and its neural network |
| Size | 21,429 bytes | 7,295,411 bytes |
| SHA-256 | `5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391` | `a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1` |

Both are kept out of git and fetched at build time by `scripts/download-stockfish.sh`, which
verifies them against `stockfish.sha256` with `shasum -c` - so a good loader beside a
tampered binary still fails.

## Version

Read from the engine itself, not guessed: the pair was loaded in a browser Web Worker and
sent `uci` on 2026-08-26. It answered:

```
Stockfish 18 Lite WASM by the Stockfish developers (see AUTHORS file)
id name Stockfish 18 Lite WASM
id author the Stockfish developers (see AUTHORS file)
uciok
```

So the version string is **`Stockfish 18 Lite WASM`**. The loader's header comment states
`Stockfish.js 18 (c) 2026, Chess.com, LLC` and names the neural network `nn-9067e33176e`.

## Build variant - WebAssembly, single-threaded, Lite

`stockfish-18-lite-single` upstream. The three choices are all deliberate:

- **WebAssembly, not ASM.JS.** Faster, smaller, and the engine is a genuine binary rather
  than 10.5 MB of JavaScript that no linter can parse.
- **Single-threaded.** The multi-threaded build needs cross-origin isolation headers
  (`COOP`/`COEP`) that chess.com does not send and this extension cannot add to someone
  else's page.
- **Lite.** The full build's `.wasm` is 108 MB. Lite is ~7 MB at the same tier of strength
  the extension was already shipping.

The loader resolves the `.wasm` from the fragment of its own worker URL
(`self.location.hash`); `content_chesscom.js` passes `chrome.runtime.getURL('stockfish.wasm')`
there, because a blob worker has no base URL to resolve a relative path against. That URL is
package-internal - verified below.

## Origin

| | |
|---|---|
| Upstream engine | https://github.com/official-stockfish/Stockfish |
| JavaScript port | https://github.com/nmrugg/stockfish.js |
| Neural network | `nn-9067e33176e` - https://tests.stockfishchess.org/nns?network_name=nn-9067e33176e |
| Obtained from | npm `stockfish@18.0.8`, files `bin/stockfish-18-lite-single.js` and `bin/stockfish-18-lite-single.wasm`, renamed to `stockfish.js` / `stockfish.wasm`. Bytes unmodified |
| Re-hosted at | https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/engine-18.0.8 - what `scripts/download-stockfish.sh` actually downloads |
| `nmrugg/stockfish.js` release | **18.0.8**, the npm package version |
| Upstream Stockfish commit | **UNKNOWN** - the binary carries no git revision |
| Build toolchain / date / flags | **UNKNOWN** - Emscripten output, but no toolchain version is recorded in the artifacts |

## Runtime behaviour, measured

- Loading the extension with the browser context set **offline before anything runs**, the
  full end-to-end suite still passes all 15 checks, and the only requests the page makes are
  `chrome-extension://` and `blob:`. **No external request, at all.**
- That is what makes the "no remote code" answer to both stores true: the `.wasm` is fetched
  from inside the package, not from the network.
- Re-run that check after any engine bump. It is the one test that proves the answer is
  still true - `tests/e2e/load.mjs` with `ctx.setOffline(true)` inserted before the first
  page is opened.

## GPLv3 corresponding source

The engine is GPLv3 (its own header, and upstream). Distributing the binary - which this
extension does, in every published package - carries the GPLv3 §6 obligation to make the
**corresponding source** available to whoever receives it.

- Engine: https://github.com/official-stockfish/Stockfish
- JavaScript port and its build scripts: https://github.com/nmrugg/stockfish.js, release
  **18.0.8**

**The compliance gap the previous version declared is now closed on the port side.** The old
binary came from a re-hosted copy of unknown upstream provenance, so this file could not
point at the source corresponding to the shipped binary. This one comes from a published,
versioned npm release of `nmrugg/stockfish.js`, recorded above, so a recipient can obtain
exactly the port revision that produced these bytes.

What remains UNKNOWN is the upstream **Stockfish** commit that the port compiled, because
the artifacts do not record it. Closing that would mean asking upstream or building from
source. Note the same gap applies to every distributed Stockfish.js build, not only this one.

---

## Superseded: the ASM.JS engine, v2.0 through v3.1.2

| | |
|---|---|
| Path in the package | `stockfish.js`, a single file |
| Size | 10,509,235 bytes |
| SHA-256 | `95bd29b21d2699d034683d4749549ec175730757f99b8a0e1c23c39771860b65` |
| UCI name | `Stockfish 18 Lite ASM.JS` |
| Obtained from | this project's own `v2.0` release asset - a re-host of unknown upstream provenance |

It was JavaScript, not WebAssembly: `WebAssembly` appeared **0 times** in the file, no
embedded base64 run carried the wasm magic (`AGFzbQ`), and ~8.6 MB of it was the network
weights as base64. The Emscripten wasm-loading template was present but unreachable.

**Why it was replaced.** Mozilla's `addons-linter` - the validator AMO runs on submission -
refuses to parse any JavaScript file over 5 MB and reports `FILE_TOO_LARGE` as an *error*.
A 10.5 MB JavaScript engine therefore could not be scanned, which stood between this
extension and an AMO listing and would have sent every future version to manual review. As
WebAssembly the engine is a binary: linters do not parse it, the error is gone, the package
is 3.5 MB smaller and the engine is faster.

The `v2.0` release asset is kept available and unchanged: it is the only copy whose checksum
matches what users of v2.0 through v3.1.2 received.
