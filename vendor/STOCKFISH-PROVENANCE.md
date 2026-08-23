# Provenance of the bundled Stockfish engine

**Recorded: 2026-08-23.** Every field below is either measured from the file that ships in
the package or marked **UNKNOWN**. Nothing here is guessed.

## The file

| | |
|---|---|
| Path in the package | `stockfish.js` (kept out of git; fetched at build time by `scripts/download-stockfish.sh`) |
| Size | **10,509,235 bytes** |
| SHA-256 | **`95bd29b21d2699d034683d4749549ec175730757f99b8a0e1c23c39771860b65`** |
| Checksum pinned in the repo | `stockfish.js.sha256` — matches the value above |

## Version

Read from the engine itself, not guessed: the file was loaded in a browser Web Worker and
sent `uci` on 2026-08-23. It answered:

```
Stockfish 18 Lite ASM.JS by the Stockfish developers (see AUTHORS file)
id name Stockfish 18 Lite ASM.JS
id author the Stockfish developers (see AUTHORS file)
uciok
```

So the version string is **`Stockfish 18 Lite ASM.JS`**. Note that the version is *not*
recoverable by grepping the file: the engine's strings live inside the embedded data, and
plain-text searches for `id name`, `Stockfish <version>`, `dev-YYYYMMDD` and 40-character
hex all return nothing. Sending `uci` is the only way to read it.

The header comment of the file additionally states `Stockfish.js 18 (c) 2026, Chess.com,
LLC` and links the neural network `nn-9067e33176e`.

## Build variant — JavaScript, not WebAssembly

The UCI name says `ASM.JS`, and the file agrees:

- `WebAssembly` appears **0 times** in the 10.5 MB file.
- No embedded base64 run begins with the WebAssembly magic (`AGFzbQ` — `\0asm`).
- The Emscripten wasm-loading template *is* present (`Module.wasmBinary`, `locateFile`,
  `instantiateStreaming`), but it is unreachable: `instantiateStreaming` is only ever read
  off a variable that is never assigned `WebAssembly`.
- 33 base64 runs of 20 KB or more (~8.6 MB in total) carry the network weights, not code.

Practical consequences: the engine needs no `.wasm` file at runtime, and it was verified to
reach `readyok` with the browser **offline**. Any claim elsewhere in this repository that
the engine runs "via WebAssembly" is inaccurate for *this* build.

## Origin

| | |
|---|---|
| Upstream engine | https://github.com/official-stockfish/Stockfish |
| JavaScript port | https://github.com/nmrugg/stockfish.js |
| Neural network | `nn-9067e33176e` — https://tests.stockfishchess.org/nns?network_name=nn-9067e33176e |
| Obtained from | https://github.com/thousandflowers/stockfish-continue-to-play/releases/download/v2.0/stockfish.js — a **re-host inside this project's own releases**, fetched by `scripts/download-stockfish.sh:11` |
| Upstream Stockfish commit | **UNKNOWN** — the file carries no git revision, no `dev-` tag and no 40-character hex string |
| `nmrugg/stockfish.js` release tag | **UNKNOWN** — the re-hosted copy records no upstream release tag |
| Build toolchain | **UNKNOWN as shipped.** The file has the shape of Emscripten output, but contains no `emscripten` string and no toolchain version. Upstream builds with Emscripten; the version used for *this* binary is not recorded anywhere in it |
| Build date / flags | **UNKNOWN** |

## GPLv3 corresponding source

The engine is GPLv3 (its own header, and upstream). Distributing the binary — which this
extension does, in every published package — carries the GPLv3 §6 obligation to make the
**corresponding source** available to whoever receives it.

Source for the two upstream projects is public:

- Engine: https://github.com/official-stockfish/Stockfish
- JavaScript port and its build scripts: https://github.com/nmrugg/stockfish.js

**Open compliance gap, stated plainly:** because the upstream revision of this exact
binary is UNKNOWN, this file cannot point at *the* source that corresponds to *the* binary
being shipped — only at the projects it came from. To close it:

1. Re-fetch the engine from a **tagged release** of `nmrugg/stockfish.js` rather than from
   this project's own re-hosted copy.
2. Record that tag here, together with the upstream Stockfish commit it was built from.
3. Update `stockfish.js.sha256` and the SHA-256 above to the new file.

Until then, keep the re-hosted release asset available and unchanged: it is the only copy
whose checksum matches what users receive.
