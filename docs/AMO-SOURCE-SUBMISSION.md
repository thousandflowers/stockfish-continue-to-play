# AMO source-code submission

Mozilla requires a source-code upload when an add-on ships code that is minified, obfuscated
or machine-generated. This add-on ships two such files: `stockfish.js`, a 21 KB minified Emscripten loader, and
`stockfish.wasm`, the 7 MB compiled engine. Everything else in the package is hand-written
and readable as shipped.

Without this, AMO review stalls on "please provide the source". Attach the source archive and
paste the notes below into the form.

## What to upload

A source archive of the repository at the released tag. `stockfish.js` is deliberately **not**
in git - it is ~10 MB and is fetched by a script against a pinned checksum - so include the
script, not the binary:

```bash
npm run source-archive          # or: npm run source-archive v3.2.0
```

That archive contains `scripts/download-stockfish.sh`, `stockfish.sha256` and
`vendor/STOCKFISH-PROVENANCE.md`, which together let a reviewer reproduce both engine files
byte for byte.

## Notes for the reviewer - paste this into the form

```
The only non-readable files in this add-on are the vendored Stockfish chess engine:
stockfish.js, a minified Emscripten loader, and stockfish.wasm, the compiled engine and its
neural network. Neither is built by this project. They are the files
bin/stockfish-18-lite-single.js and bin/stockfish-18-lite-single.wasm from the npm package
stockfish@18.0.8 (nmrugg/stockfish.js), renamed but byte-for-byte unmodified, and
redistributed under the GPLv3.

They are not in this source archive because together they are about 7 MB and are kept out of
version control. To obtain the byte-identical files that are in the package:

    bash scripts/download-stockfish.sh

The script downloads both and verifies them against the SHA-256 digests pinned in
stockfish.sha256. You can verify the copies inside the submitted package directly:

    shasum -a 256 -c stockfish.sha256

That checks every line, so a matching loader beside a modified binary still fails. You can
also compare against upstream without trusting us at all:

    npm pack stockfish@18.0.8
    tar xzf stockfish-18.0.8.tgz
    shasum -a 256 package/bin/stockfish-18-lite-single.js package/bin/stockfish-18-lite-single.wasm

vendor/STOCKFISH-PROVENANCE.md records which upstream build this is, where it came from, and
what remains unknown about it.

To rebuild the reviewed package from this source:

    bash scripts/download-stockfish.sh
    npm install          # devDependencies only: vitest, jsdom, playwright. Not shipped.
    npm run package      # writes stockfish-continue-to-play-firefox-<version>.zip

scripts/package.sh lists every packaged path explicitly and renames manifest-firefox.json to
manifest.json inside the Firefox zip. Nothing in node_modules, tests/ or scripts/ is
packaged.

Build environment: Node 20 or later, bash, zip, python3 (used only to read the version out
of manifest.json). No compiler, no bundler, no transpiler - the shipped JavaScript is the
source JavaScript, and the .wasm is downloaded prebuilt from upstream, not compiled here.

Runtime behaviour worth confirming: the add-on makes no network requests at all. The loader
is read out of the package with runtime.getURL() and run in a Web Worker, and it is handed
the packaged .wasm through another runtime.getURL() address, passed in the fragment of the
worker URL because a blob worker has no base URL to resolve a relative path against. The
add-on works with the browser offline; the end-to-end suite verifies this by running the
whole flow with the browser context offline from the first byte.
```

## Re-check this after any engine bump

`stockfish.sha256`, the digests in `vendor/STOCKFISH-PROVENANCE.md` and the engine release
tag in `scripts/download-stockfish.sh` must all move together, and the offline check must be
re-run. That check is what makes the "no remote code" answer true: the loader is perfectly
capable of fetching its `.wasm` over the network, and only does not because it is handed a
package-internal URL. A future build, or a careless change to how that URL is built, could
quietly turn this into a real download.
