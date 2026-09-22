# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html), and each entry links
to the release its zips were published under.

## [3.3.0] - 2026-09-21

### Added

- **The position now comes from Chess.com's own board.** A second script runs in
  the page's own JavaScript world, where their board component is reachable, and
  reads the position being shown straight from it - castling rights and the
  en-passant square included, both of which had to be estimated when all this
  extension could see was the piece divs. It reads and nothing else: no move, no
  resign, no mode change, and the page world holds no extension permissions of
  its own. Where it cannot reach - an older Chess.com, a browser that ignores
  `world: "MAIN"` - everything falls back to the scraping that shipped before.
- **The engine is calibrated on the opponent's real rating.** Their board names
  both ratings outright, so a bot rated 300 is played as 300 instead of as
  whichever rating-shaped number the page happened to show first.
- **Continue from the position you are looking at, not only the one the game
  ended on.** Walk back through the move list to the move where it went wrong
  and press Continue from there: lose to a mate, rewind three moves, play it
  differently. Still only ever after a game has ended - the trigger is gated on
  the same game-over check as before, which has been tightened rather than
  duplicated.
- **A "who is to move?" prompt** for the rare position whose side to move cannot
  be established. Starting the wrong side is only visible once the engine moves
  a piece it should not have been able to touch, so it asks instead of guessing.
- **Continued games can end in a draw.** A game here ended when the side to move
  ran out of legal moves, which is checkmate and stalemate and nothing else.
  Every other draw leaves legal moves on the board, so a continuation that
  reached two bare kings simply carried on until you closed it. The fifty-move
  rule, threefold repetition and insufficient material are now decided from the
  move list, and only ever where the side to move is known to have a legal move
  - mate outranks every draw, and a game that ends in mate on the hundredth
  quiet move is mate.

### Changed

- **The side to move follows the selected ply.** The piece placement always came
  from the board, which Chess.com re-renders as you navigate; only the turn was
  still read off the end of the move list, so an earlier position came out with
  the right pieces and the wrong player up. Three independent readings now agree
  on it: the index of the selected ply, its colour class, and the board's
  last-move highlight.
- **The trigger docks under the move-list column when there is no game-over
  card**, instead of falling through to a button floating over the window. A
  finished game you came back to is exactly where the move list gets walked, and
  there is no card there to hang off. The column is asked to be that much
  shorter - a padding on their element, never a node inserted into it - so the
  row of icons at its foot moves up rather than disappearing under the bar, and
  is handed back untouched when the trigger goes.
- **The viewed ply is read from the URL.** Chess.com writes it into the query
  string (`?move=20`) and rewrites it on every click in the move list. Probing a
  real finished game found no ply node carrying a "selected" class at all, so
  this is now the first of the readings, with the move list and the board behind
  it.
- **The legal-move markers are Chess.com's own**, not an imitation: `hint`,
  `capture-hint` and `highlight`, the same borrowing the pieces already do with
  `.piece` for the sprite, so they follow a restyle for free. Their ring is
  scaled to the board - the `5px` in their rule is a floor, a live board
  computes 7.5px on an 86px square - so ours is scaled the same way rather than
  coming out a third too thin. The checked king keeps its red glow, with
  Chess.com's own grow / wiggle / shrink timings, played when the check arrives
  instead of on every re-render.

### Fixed

- **No more queen nobody chose.** Two paths turned a promotion into a queen
  without asking: a `'q'` default in `toUci()`, and a fallback in the picker for
  when there was no board to hang it off. A promotion with nothing chosen is now
  not a move at all, and you are asked again.
- **You can see the legal-move markers, including on captures.** The dot was
  flat 18% black, which disappears on Chess.com's dark squares, and it sat
  BEHIND the pieces - so a capture destination, the one you most want to see,
  was covered by the piece standing on it. Markers now sit above the pieces,
  carry a pale rim so they read on light and dark squares alike, and a square
  with a piece on it gets a ring around the piece instead of a dot under it.
- **A king-versus-king ending can be continued.** The scraper rejected anything
  with fewer than three pieces as noise, so the most obviously drawn position on
  the board answered "Position not found." The guard is now that both kings are
  present, which is what actually tells a position from a stray match.
- **The trigger appears on a finished game whose result modal is gone.** It
  looked for `.game-result-component` and `result-text`; Chess.com dropped the
  `-component` suffix and renamed the other to `result-row`, so on a game you
  came back to nothing matched and the page read as "no game has ended here".
  Matched on the durable `game-result` / `game-review` shapes now, with both
  surfaces' class vocabularies pinned in a test - the trigger must be possible
  on a finished game and impossible on one in progress.
- **The engine is calibrated on your opponent, never on you.** When the player
  row could not be matched, the opponent's rating fell back to the largest
  rating on the page - which against anyone weaker than you is your own. Both
  rows are found together now and the opponent is whichever is not yours, with
  the "You" tag deciding when game review has reset the orientation.
- **Walking the move list no longer counts as leaving the page.** The
  navigation poller compared the whole URL, and Chess.com rewrites `?move=` on
  every click - so glancing at an earlier move during a continuation would have
  torn the game down.
- **Captures en passant are possible again.** The scraped FEN carried a hardcoded
  "-" in the en-passant field, so Stockfish never generated the capture and the
  move came back refused. The two squares Chess.com highlights for the last move
  give the target exactly. It stays "-" if you have switched Chess.com's move
  highlighting off.
- **A hidden game-over surface no longer counts as a finished game.** The check
  asked only whether a matching node existed, so one left mounted after a
  rematch could put the trigger up over a live board.
- **The position is read off the board the game is played on.** It was taken
  from the first board in the document while play happened on the largest
  visible one - a difference only a page with two boards can show, and a review
  page is such a page.
- **A position that is already checkmate or stalemate says so**, rather than
  announcing the result of a game that never started, and does not offer to play
  it again.

## [3.2.1] - 2026-09-04

### Changed

- **New icon.** A seahorse chess piece standing on the board, replacing the
  circuit-board knight. The small sizes are not the same picture as the large
  ones: at 16 px an eight-square board is two pixels per square and the piece
  dissolves into the pattern, so 16 and 32 are cut down to the piece itself and
  keep only the two or three squares behind it. `scripts/make-icons.py`
  regenerates every size from `store/icon-source-534.png`, finding the piece by
  its own darkness rather than by hardcoded coordinates, so the next change of
  artwork is one command.

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

[3.3.0]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.3.0
[3.2.1]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.2.1
[3.2.0]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.2.0
[3.1.2]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.2
[3.1.1]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.1
[3.1.0]: https://github.com/thousandflowers/stockfish-continue-to-play/releases/tag/v3.1.0
