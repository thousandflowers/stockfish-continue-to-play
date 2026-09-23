# Press kit

Everything needed to announce the extension, and the scripts that regenerate it.

## What is here

```
press/
  REDDIT.md          launch posts, one per subreddit, with the rules they were written against
  video/             MP4s for social platforms (they compress better than GIFs there)
    demo-720.mp4         1280x800, the full flow ending in mate
    demo-square.mp4      1000x1000, board only, for feeds that crop to 1:1
    any-position.mp4     walking back the move list and continuing from an earlier move
    promotion.mp4        the promotion picker
    github-social-preview-1280x640.png
```

Elsewhere in the repo:

```
docs/demo.gif              README hero
docs/media/*.gif           README feature pair
docs/media/social-preview.png   upload in repo Settings > Social preview
store/screenshots/*.png    Chrome Web Store and AMO, 1280x800
store/promo-tile-440x280.png    CWS small promo tile
store/marquee-1400x560.png      CWS marquee tile (invite-only slots)
```

## Regenerating

The build scripts live in `.media-build/` (ignored by git, since the raw captures are large).
They read the raw screen recordings from `~/Desktop/stockfish-media` by default:

```bash
cd .media-build
bash build-store.sh     # 1280x800 store screenshots + promo tile + marquee
bash build-motion.sh    # README GIFs and social MP4s
SRC=/path/to/captures bash build-motion.sh   # if the captures moved
```

Captions for the store screenshots are arguments inside `build-store.sh`, so changing the
copy means editing that file and re-running it, not editing PNGs.

Rendering uses the headless Chrome shell that Playwright already installed for the e2e
tests, so there is no extra dependency beyond ffmpeg, gifsicle and ImageMagick.

## Recording new captures

The existing ones were recorded on chess.com against finished GM games, with the released
3.3.0 build and the cursor visible. If you record more:

- Record at 2560x1600 (retina 1280x800) so the downscale stays sharp.
- Keep the cursor on. The earlier cursorless takes read as fake.
- Chess.com's ad slot sits to the right of the board and shows up as a black rectangle in
  crops. Crop to the board and the dialog, or check the right edge before shipping the frame.
- Let the result card land and hold for a second before stopping. That last beat is the
  payoff in every clip.

## Rough usage notes per platform

| Platform | Use |
|---|---|
| GitHub README | `docs/demo.gif` at the top, the two smaller GIFs below it |
| GitHub social preview | `docs/media/social-preview.png`, Settings > Social preview |
| Reddit | upload the MP4 directly; `REDDIT.md` says which per post |
| X / Mastodon | `video/demo-720.mp4`, or `demo-square.mp4` for a timeline that crops |
| Chrome Web Store | `store/screenshots/*.png` in numbered order, `promo-tile-440x280.png` |
| AMO | same screenshots, same order |
| Product Hunt / Hacker News | the social preview as the thumbnail, MP4 in the first comment |
