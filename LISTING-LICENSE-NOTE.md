# Chrome Web Store listing - licence attribution

Paste these two sentences at the very end of the store listing description.

> This extension bundles Stockfish, the open-source chess engine by the Stockfish
> developers (https://github.com/official-stockfish/Stockfish), used under the GNU General
> Public License v3; the JavaScript build is nmrugg/stockfish.js. Because of that, the
> extension itself is released under the GPLv3, and its full source is available at
> https://github.com/thousandflowers/stockfish-continue-to-play.

Keep it as plain text - the listing description does not render Markdown, so the bare URLs
are deliberate. Do **not** put this in `manifest.json`: neither Chrome nor Firefox defines a
licence field there, and unknown keys only earn linter warnings.

---

## Second listing line - non-affiliation disclaimer

Paste this as its own paragraph, separate from the licence sentences above.

> This extension is an independent project. It is not affiliated with, endorsed by, or
> sponsored by Chess.com or Lichess.

Why it matters here specifically: the bundled engine build is **copyright Chess.com, LLC**
(`stockfish.js` header: "Stockfish.js 18 (c) 2026, Chess.com, LLC"), the extension runs on
chess.com pages, and its name contains "Stockfish". A user skimming the listing could
reasonably assume it is an official Chess.com product. Say plainly that it is not - it costs
one line and removes a trademark and impersonation question a reviewer would otherwise have
to ask.
