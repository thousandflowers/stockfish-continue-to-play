# Reddit launch posts

Drafts for announcing the extension, one per subreddit, written against each sub's actual
rules (read from `/about/rules.json`, September 2026). They are different posts on purpose:
the same text copy-pasted five times is what gets you removed.

Read this first, then pick a sub.

## The one rule that gets people banned

Every relevant sub enforces some version of Reddit's self-promotion guidance: your account
should be participating, not just advertising. r/chess spells it out as the 10% guideline,
r/InternetIsBeautiful as 90/10, r/opensource as "no drive-by posting". If the account
posting this has no other recent activity, the post gets removed regardless of how good the
extension is.

So before posting anywhere: spend a week actually commenting in the sub you plan to post in.
Answer questions, argue about openings, whatever. Then post.

## Where to post, and in what order

| Sub | Members | Fit | Notes |
|---|---|---|---|
| r/chess | ~2.5M | medium | Strictest. Self-promo allowed within the 10% rule. High reward, high removal risk. Post here last, once you have karma and a track record. |
| r/chesscom | ~77k | good | Most on-topic audience: people who play on the site the extension modifies. Self-promotion "to a minimum", so one post, no follow-ups. |
| r/chessprogramming | ~20k | good | Wants technical substance. Lead with the engineering (FEN extraction, WASM in MV3, UCI_Elo mapping), not the pitch. |
| r/chrome_extensions | ~50k | easy | Made for this. No anti-promo rule, just no spam. |
| r/opensource | ~384k | good | Needs the `Promotional` flair and an OSI licence (GPLv3 qualifies). Title must not be sensationalised. |
| r/SideProject | ~849k | easy | No listed rules. Low signal but friendly. |
| r/coolgithubprojects | ~121k | easy | Link post to the repo. |
| r/firefox | ~295k | maybe | Only once the AMO listing is live. Posting a "load it as a temporary add-on" build here will annoy people. |

Do NOT post to r/chessbeginners: its rules ban self-promotion outright and specifically ban
posting about a chess tool you coded.

Space the posts out. Three subs in one evening reads as a spam run.

## Before you post anything

The README says the extension is not published on either store yet, so every post below has
to send people to a GitHub release and a "load unpacked" dance. That is a real conversion
cliff and it also makes the post feel more like a request for testers than a launch.

Two options:
1. Post now, framed honestly as "unsigned, install by hand, I want feedback". Smaller
   audience, better feedback, no wasted shot at the big subs.
2. Wait for the Chrome Web Store listing, then post with a real install link.

If you can wait, wait. If you post now, use the honest framing: every draft below does.

---

## r/chrome_extensions

Easiest sub, good place to test the wording before the bigger ones.

**Title**

```
I made an extension that lets you keep playing a Chess.com game after it ends
```

**Body**

```
On Chess.com, when your opponent resigns or flags in a position you actually wanted to
play out, that is it. You get a rematch button and a Game Review button, and the position
is gone.

This adds a "Keep Playing" button to the game-over dialog. Press it and the same board keeps
going, with Stockfish in the opponent's seat, from the position you were just in. No new tab,
no redirect, no re-entering the FEN somewhere else.

A few things that took longer than expected:

- Stockfish runs in-page as WebAssembly, so the extension makes no network requests at all.
  It works with Wi-Fi off. Getting a WASM worker to run under MV3's CSP without it counting
  as remote code was most of the work.
- The engine's UCI_Elo is set from the rating of the opponent you just played, so the
  continuation feels roughly like the game did. You can override it.
- The UI is built from Chess.com's own classes: the promotion picker, the result card, the
  move hints are the site's, not mine on top of the site.
- You can walk back through the move list first and continue from an earlier position, which
  is the part I use most. Lose to a mate, rewind three moves, try it differently.

It is not on the Web Store yet. Right now it is a zip from the releases page and a
"Load unpacked" in developer mode. Chrome and Firefox builds both exist.

Source (GPLv3, since it bundles Stockfish):
https://github.com/thousandflowers/stockfish-continue-to-play

Happy to answer anything about the MV3 side of it.
```

Attach `press/video/demo-720.mp4`.

---

## r/chesscom

The most on-topic audience. Rule 11 says keep self-promotion to a minimum, so this is a
one-shot post: no reposts, no "update" posts a week later.

**Title**

```
Built a browser extension so you can keep playing after your opponent resigns
```

**Body**

```
The thing that finally annoyed me enough to build something: bullet and blitz opponents
resign or disconnect in positions that were still interesting, and Chess.com offers you a
rematch or a review, but never just "keep going from here".

So the extension adds a Keep Playing button to the game-over dialog. Same board, same
position, Stockfish takes the opponent's seat. It also shows up under the move list on
finished games you come back to, so you can step back to the move where it went wrong and
continue from there instead.

Stockfish's strength is matched to the rating of whoever you just played, and it does not
answer instantly in a game that was on a ten-minute clock, it takes roughly as long as your
opponent was taking. Castling, en passant, promotion and repetition are all decided by the
engine rather than by my own board code.

The engine runs inside the browser as WebAssembly. It makes no network requests, it has no
account and no analytics, and it works offline.

Not affiliated with Chess.com in any way. It reads the position off the page and draws on
the board, nothing else. Source is public, GPLv3 because it bundles Stockfish:
https://github.com/thousandflowers/stockfish-continue-to-play

It is not in the Chrome Web Store yet, so for now it is a manual install from the releases
page. If people use it I will get it listed properly.
```

Attach `press/video/demo-720.mp4`.

---

## r/chessprogramming

Rule 2 removes posts whose main purpose is promotion unless there is substantial technical
content. So this post is mostly about the engineering, and the link is at the end.

**Title**

```
Running Stockfish WASM inside a Chess.com page under MV3: what actually worked
```

**Body**

```
I have been building an extension that continues a finished Chess.com game against Stockfish
on the site's own board, and a few parts were more annoying than I expected. Writing them up
in case anyone else is putting an engine inside someone else's page.

Reading the position

The board is a custom element, not a DOM grid you can reliably diff. The position lives in
the page's own JS context, which a content script cannot touch directly. So there is a second
script injected into the page context whose only job is to read the current FEN, the side to
move and the two ratings, and post them out. It is read-only: it calls nothing that mutates
a game and holds no extension permissions. Keeping that boundary narrow was the difference
between something I was willing to ship and something I was not.

The engine, and the remote-code question

stockfish.js plus the 7 MB .wasm both ship inside the package. The loader is fetched with
chrome.runtime.getURL() and run in a Worker; the .wasm address handed to it is another
getURL(). Nothing is fetched at runtime, and the e2e suite asserts it the blunt way: the
Playwright page routes every request, fulfils only the fixture page and chrome-extension://
URLs, and aborts the rest. If the extension reached for the network the run would fail.

The thing to know if you do this: a reviewer who greps your content script and finds
new Worker(blobUrl) will assume remote code and bounce you. The blob wraps a file that ships
in the package. Say so explicitly in the submission.

Move legality

I do not generate moves. Legal moves come from the engine, and mate and stalemate are its
call too. The draws that leave legal moves on the board (threefold repetition, the 50-move
rule, insufficient material) are decided in lib/chess-core.js from the same move list,
because the engine will happily keep playing a dead position. Castling by dropping the king
on your own rook is the Chess.com convention, so the UI maps that gesture to the UCI move
rather than inventing its own.

Difficulty and pacing

Opponent rating comes from the bridge (their getHeaders names both players, so there is no
guessing which row is the opponent) and maps linearly onto UCI_Elo: 400-2500 clamped, then
scaled onto Stockfish's 1320-3190 range, with UCI_LimitStrength on. Manual overrides at
800/1200/1600/2000/max.

Search is a fixed go depth 12. The strength knob is UCI_Elo, not depth. What varies is when
the move is delivered: every reply is held to roughly 0.7x the average move time of the
finished game (read off its clocks), clamped to 400-1600 ms, with jitter so it is never
twice the same beat. An engine that answers in 40 ms to a position your opponent had been
sitting on for eight seconds reads as a glitch even when the move is right.

Everything is GPLv3, since it bundles Stockfish. Code, including how the binary is fetched
and checksum-pinned:
https://github.com/thousandflowers/stockfish-continue-to-play

Interested in how other people map opponent rating to engine strength. Mine is a straight
linear map onto UCI_Elo and I suspect that is too crude at the low end, where UCI_Elo's own
behaviour stops being linear in anything a human would recognise as playing strength.
```

No video needed here. Text posts do better.

---

## r/opensource

Needs the `Promotional` flair. Title must not be sensationalised.

**Title**

```
Stockfish Continue to Play: a GPLv3 browser extension that continues a finished Chess.com game against Stockfish
```

**Body**

```
Chess.com ends a game and the position disappears behind a rematch button. This extension
adds a Keep Playing button to the game-over dialog: the same board keeps going with Stockfish
in the opponent's seat, from the final position or any earlier move you walk back to.

Why it is GPLv3: it bundles Stockfish, which is GPLv3, and distributing the engine inside the
package makes the whole thing a combined work. Up to v3.0.0 the project was MIT; that code is
still here and redistributed under the GPL, with the MIT notice preserved as MIT requires.
The licence notes are in LICENSE.MIT and LISTING-LICENSE-NOTE.md if anyone wants to check
the reasoning rather than take my word for it.

On privacy, which people reasonably ask about for anything that touches a logged-in site:
the engine runs in the browser as WebAssembly, the extension makes no network requests at
all, and the test suite verifies the whole flow with the browser context offline. The only
stored state is two local preferences, on/off and engine strength.

Which Stockfish build is bundled, its checksum, and what is and is not known about its
provenance is documented in vendor/STOCKFISH-PROVENANCE.md, because "trust me, it is
Stockfish" is not good enough for a 7 MB binary.

https://github.com/thousandflowers/stockfish-continue-to-play

Not on either store yet, so it installs from a release zip for now. Contributions and
scepticism both welcome.
```

---

## r/SideProject

Short. No rules listed, and long posts do not do better here.

**Title**

```
Your opponent resigns, the game is over, the position is gone. I got annoyed enough to fix it.
```

**Body**

```
Chess.com does not let you keep playing a finished game. If someone resigns or flags in a
position you actually wanted to play out, your options are a rematch or a computer review of
what already happened.

So: a browser extension that adds a Keep Playing button to the game-over screen. Same board,
same position, Stockfish takes over for your opponent, strength matched to whoever you just
played. You can also rewind through the move list and continue from an earlier move, which
turned out to be the thing I use it for most.

Everything runs in the browser. No servers, no account, no analytics, works offline.

Open source, GPLv3: https://github.com/thousandflowers/stockfish-continue-to-play

Still a manual install from the releases page, Web Store submission is next. If you play
blitz and want to break it, I would like to hear about it.
```

Attach `press/video/demo-square.mp4`.

---

## r/chess

Post here last, and only with a participating account. Rules that bite: no low-quality
submissions, and the 10% self-promotion guideline. A "look at my thing" post from a fresh
account gets removed.

Best framing for this sub is the chess behaviour, not the software.

**Title**

```
I got tired of opponents resigning in interesting positions, so I made the game continue against Stockfish
```

**Body**

```
In bullet and blitz the most interesting part of the game is often still ahead when someone
resigns, flags or disconnects. Chess.com then offers you a rematch or a review, and the
position you were curious about is gone.

I wrote a browser extension that adds a Keep Playing button to the game-over dialog. The same
board keeps going, from the same position, with Stockfish in the opponent's seat at roughly
the rating of the player who just left.

The part I did not expect to like as much: it also appears under the move list on any
finished game, so you can walk back to the move where it went wrong and continue from there.
Losing a rook endgame, rewinding four moves and trying the other plan has taught me more than
the same position in an analysis board does, because the engine is playing at my opponent's
strength rather than showing me the objectively best line.

It is not an analysis tool and it deliberately does nothing during a live game. The button
only ever exists after a game has ended.

Free, open source, runs entirely in the browser with no network access:
https://github.com/thousandflowers/stockfish-continue-to-play

Not in the Chrome store yet, so it is a manual install for now.
```

Attach `press/video/demo-720.mp4`.

---

## Comment replies you will need

Have these ready. The first two come up every single time.

**"Isn't this a cheating tool?"**

```
It only exists after the game is over. The button is drawn from the game-over state, and
during a live game the extension does nothing at all: no evaluation, no arrows, no engine
running. It also never talks to Chess.com's servers, it reads the position that is already
on your screen.
```

**"Why not just use the analysis board / play vs computer?"**

```
You can, and if you want the objectively best move that is the better tool. The difference is
that this keeps the game: same board, same clock row, an opponent at roughly the strength of
the person who just left, and it starts from the position with no setup. Analysis boards tell
you what you should have played. This lets you play it.
```

**"Does it work on Lichess?"**

```
Not currently. It reads Chess.com's board component specifically. Lichess already has
"continue from here", which is most of why I built this for Chess.com instead.
```

**"7 MB binary in a browser extension?"**

```
That is the Stockfish WASM build, and it is the whole reason there is no server. It is
checksum-pinned in stockfish.sha256 and fetched by scripts/download-stockfish.sh when you
build from source; the release zips have it already bundled. Provenance notes are in
vendor/STOCKFISH-PROVENANCE.md.
```
