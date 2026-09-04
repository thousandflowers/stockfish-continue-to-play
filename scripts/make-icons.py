#!/usr/bin/env python3
"""Generate every icon the extension and the stores need, from one master file.

The master art is a chess piece standing on a full-bleed board. That reads well
large and turns to noise small: at 16 px an eight-square board is two pixels a
square, and the silhouette disappears into the pattern. So the small sizes are
cut down to the piece itself - the board survives as two or three big squares
behind it - while the large sizes keep the whole composition.

Usage: python3 scripts/make-icons.py [MASTER.png]
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "store" / "icon-source-534.png"

# Below this width the whole board cannot survive the downscale.
CROP_BELOW = 48
# How much of the piece's own size to leave as breathing room in a cropped icon.
CROP_MARGIN = 0.12
# A pixel this dark in every channel is the piece, not the board.
PIECE_MAX_CHANNEL = 90

SIZES = {
    16: ROOT / "icons/icon16.png",
    32: ROOT / "icons/icon32.png",
    48: ROOT / "icons/icon48.png",
    128: ROOT / "icons/icon128.png",
}
STORE_ICON = ROOT / "store" / "store-icon-128.png"


def piece_box(image):
    """The bounding box of the dark piece, as (left, top, right, bottom)."""
    rgb = image.convert("RGB")
    dark = rgb.point(lambda v: 255 if v < PIECE_MAX_CHANNEL else 0).convert("L")
    box = dark.point(lambda v: 255 if v == 255 else 0).getbbox()
    if box is None:
        raise SystemExit(
            f"✗ no dark piece found in {MASTER.name} - is the artwork still a "
            "dark piece on a light board?"
        )
    return box


def square_around(box, image_size, margin=CROP_MARGIN):
    """A square crop centred on `box`, grown by `margin`, clamped to the image."""
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    side = max(right - left, bottom - top) * (1 + margin)
    side = min(side, *image_size)
    half = side / 2
    # Slide the square back inside the frame rather than shrinking it: a smaller
    # square would zoom in further and clip the piece.
    cx = min(max(cx, half), image_size[0] - half)
    cy = min(max(cy, half), image_size[1] - half)
    return tuple(round(v) for v in (cx - half, cy - half, cx + half, cy + half))


def main(argv):
    master_path = Path(argv[1]) if len(argv) > 1 else MASTER
    master = Image.open(master_path).convert("RGBA")
    cropped = master.crop(square_around(piece_box(master), master.size))

    for size, out in SIZES.items():
        source = cropped if size < CROP_BELOW else master
        source.resize((size, size), Image.LANCZOS).save(out)
        print(f"✓ {out.relative_to(ROOT)}  {size}x{size}  "
              f"{'piece only' if source is cropped else 'full board'}")

    master.resize((128, 128), Image.LANCZOS).save(STORE_ICON)
    print(f"✓ {STORE_ICON.relative_to(ROOT)}  128x128  full board")


def self_check():
    box = square_around((178, 67, 348, 447), (534, 534))
    assert box[2] - box[0] == box[3] - box[1], f"not square: {box}"
    assert all(0 <= v <= 534 for v in box), f"outside the frame: {box}"
    # A piece hard against an edge must stay whole, not get clipped.
    edge = square_around((0, 0, 100, 400), (534, 534))
    assert edge[0] >= 0 and edge[1] >= 0, f"clipped: {edge}"
    assert edge[2] - edge[0] == edge[3] - edge[1], f"not square: {edge}"
    piece_box(Image.open(MASTER))          # and the real master still parses
    print("✓ self-check passed")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-check"]:
        self_check()
    else:
        main(sys.argv)
