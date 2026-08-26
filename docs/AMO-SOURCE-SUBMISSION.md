# AMO source-code submission

Mozilla requires a source-code upload when an add-on ships code that is minified, obfuscated
or machine-generated. This add-on ships one such file: `stockfish.js`, the vendored Stockfish
engine. Everything else in the package is hand-written and readable as shipped.

Without this, AMO review stalls on "please provide the source". Attach the source archive and
paste the notes below into the form.

## What to upload

A source archive of the repository at the released tag. `stockfish.js` is deliberately **not**
in git - it is ~10 MB and is fetched by a script against a pinned checksum - so include the
script, not the binary:

```bash
git archive --format=zip --prefix=stockfish-continue-to-play/ -o source-v3.1.0.zip v3.1.0
```

That archive contains `scripts/download-stockfish.sh`, `stockfish.js.sha256` and
`vendor/STOCKFISH-PROVENANCE.md`, which together let a reviewer reproduce the exact engine
file byte for byte.

## Notes for the reviewer - paste this into the form

```
The only non-readable file in this add-on is stockfish.js, the vendored Stockfish chess
engine. It is not built by this project: it is nmrugg/stockfish.js, the upstream JavaScript
build of Stockfish, redistributed unmodified under the GPLv3.

It is not included in this source archive because it is roughly 10 MB and is kept out of
version control. To obtain the byte-identical file that is in the package:

    bash scripts/download-stockfish.sh

The script downloads the file and verifies it against the SHA-256 pinned in
stockfish.js.sha256. You can also verify the copy inside the submitted package directly:

    shasum -a 256 stockfish.js
    cat stockfish.js.sha256

Both must print the same digest. vendor/STOCKFISH-PROVENANCE.md records exactly which
upstream build this is and where it came from.

To rebuild the reviewed package from this source:

    bash scripts/download-stockfish.sh
    npm install          # devDependencies only: vitest, jsdom, playwright. Not shipped.
    npm run package      # writes stockfish-continue-to-play-firefox-<version>.zip

scripts/package.sh lists every packaged path explicitly and renames manifest-firefox.json to
manifest.json inside the Firefox zip. Nothing in node_modules, tests/ or scripts/ is
packaged.

Build environment: Node 20 or later, bash, zip, python3 (used only to read the version out
of manifest.json). No compiler, no bundler, no transpiler - the shipped JavaScript is the
source JavaScript.

Runtime behaviour worth confirming: the add-on makes no network requests at all. The engine
is read out of the package with runtime.getURL() and run in a Web Worker. It works with the
browser offline.
```

## Re-check this after any engine bump

The digest above and `stockfish.js.sha256` must be regenerated together, and the offline
check in `CWS-AUDIT.md` §1 must be re-run: the vendored file contains two dormant loader
branches that would fetch `stockfish.wasm` / `stockfish-part-N.wasm` if a future build
stopped embedding the engine. In this build neither branch is reachable, which is what makes
the "no remote code" answer true. A different build could change that.
