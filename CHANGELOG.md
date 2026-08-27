# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html), and each entry links
to the release its zips were published under.

## [3.2.0] - 2026-08-27

### Changed

- **The engine is WebAssembly, not ASM.JS.** The old build was a single 10.5 MB
  JavaScript file, which Mozilla's linter refuses to parse at all - it caps out at
  5 MB. The package now ships a 21 KB loader (`stockfish.js`) beside a 7 MB binary
  (`stockfish.wasm`), so the largest JavaScript file in the extension is 44 KB and
  the AMO blocker is gone. The build variant is `stockfish-18-lite-single`, and
  `vendor/STOCKFISH-PROVENANCE.md` records why single-threaded is the only option a
  content script has: the multi-threaded build needs cross-origin isolation headers
  it cannot set on chess.com.
- The packaged extension drops from 6.4 MB to 5.5 MB.
- Both engine files are checksum-pinned together, so the pin file is now
  `stockfish.sha256` rather than `stockfish.js.sha256`.

### Fixed

- The README described promotion as "auto-queen". It has offered a four-piece
  picker since 3.1.0.
- `ARCHITECTURE.md` still listed the checksum file under its old name.
- `LICENSE.stockfish` credited the bundled engine to `stockfish.js` alone, and had
  never been through the em-dash pass because it was written after it.

## [3.1.2] - 2026-08-26

### Added

- `browser_specific_settings.gecko.data_collection_permissions`, now required for
  every new AMO submission. This extension collects nothing, so the value is
  `{"required": ["none"]}`.
- Publishing is a scripted step: `npm run lint:ff` runs Mozilla's addons-linter,
  `npm run source-archive` builds the source zip AMO asks for, and
  `npm run publish:amo` / `publish:cws` upload to each store.

### Notes

- `data_collection_permissions` only exists in Firefox 140+, while
  `strict_min_version` is `128.0`, so the linter reports two version warnings.
  This is deliberate: older Firefox ignores the unknown key and the add-on still
  runs on 128-139. Raising the floor to 140 would drop twelve Firefox versions to
  silence a warning that changes nothing.

## [3.1.1] - 2026-08-26

### Fixed

- All four toolbar icons had the editor's grey transparency checkerboard baked
  into the pixels, so the browser drew a grey tile behind the knight. Rebuilt from
  the master artwork at true sizes with real alpha - the 128 alone went from
  503,829 to 18,279 bytes.
- The popup printed `v3.0.0` as a literal string, wrong since the 3.1.0 bump. It
  now reads `chrome.runtime.getManifest().version`, so it cannot drift again.
- The popup named a "Continue vs AI" button. The button has always read
  "Continue vs Computer".

## [3.1.0] - 2026-08-26

The first tagged release since 2.0.7. `v3.0.0` was merged but never tagged, so its
changes ship here too.

### Changed

- **No more redirect.** Up to 2.0.7 the extension moved you to Lichess to finish
  the position. A **Continue vs Computer** button now appears on the Chess.com
  game-over modal, and the board you were already looking at keeps going against
  Stockfish.

### Added

- Click or drag to move, with legal destinations highlighted.
- Castle by dropping the king on your own rook, and choose what a pawn promotes to.
- A king in check is marked red, the way Chess.com marks it.
- The engine is paced like the game you just played, rather than replying instantly
  in a game that had been running on a 10-minute clock.
- The game ends the way Chess.com ends one: a named result in a modal, with the
  final position left on the board.
- Strength is set in the popup - automatic (matched to the rating on the page), a
  fixed rating, or full strength.

### Fixed

- Side to move was wrong after every Black reply, so the engine could start playing
  your colour.
- The opponent's rating was read from a DOM chess.com no longer ships, so difficulty
  was mis-sized.

## 2.0 - 2.0.7 - 2026-06-09 to 2026-06-13

The Lichess era. The extension read the final position off Chess.com and opened it
on Lichess to play out, which 3.1.0 replaced entirely. Releases in this line dealt
with the Lichess handoff: posting the position directly, `variant=FromPosition` for
custom positions, and CSRF tokens on the request.

[3.2.0]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.2.0
[3.1.2]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.2
[3.1.1]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.1
[3.1.0]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.0
