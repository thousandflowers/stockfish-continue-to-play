#!/usr/bin/env bash
# Download the Stockfish engine (~10 MB), which is kept out of git.
# Integrity is verified against the pinned checksum in stockfish.js.sha256.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/stockfish.js"
SHA_FILE="$ROOT/stockfish.js.sha256"
# Engine-binary release tag — versioned independently of the extension version.
VERSION="${1:-2.0}"
URL="https://github.com/thousandflowers/stockfish-continue-to-play/releases/download/v${VERSION}/stockfish.js"

verify() {
  if [ ! -f "$SHA_FILE" ]; then
    [ -n "${ALLOW_UNVERIFIED_ENGINE:-}" ] && { echo "⚠ no checksum file — proceeding (ALLOW_UNVERIFIED_ENGINE set)"; return 0; }
    echo "✗ no checksum file ($SHA_FILE) — refusing to use an unverified engine binary." >&2
    echo "  Set ALLOW_UNVERIFIED_ENGINE=1 to override." >&2
    return 1
  fi
  local want have
  want="$(cut -d' ' -f1 < "$SHA_FILE")"
  have="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
  if [ "$want" != "$have" ]; then
    echo "✗ checksum mismatch for stockfish.js" >&2
    echo "  expected $want" >&2
    echo "  got      $have" >&2
    return 1
  fi
  echo "✓ checksum OK"
}

if [ -f "$OUT" ] && [ -s "$OUT" ]; then
  echo "✓ stockfish.js already present ($(du -h "$OUT" | cut -f1))"
  verify
  exit 0
fi

echo "↓ downloading stockfish.js (~10 MB) from v${VERSION}…"
if command -v curl >/dev/null 2>&1; then curl -fSL -o "$OUT" "$URL"
elif command -v wget >/dev/null 2>&1; then wget -O "$OUT" "$URL"
else echo "✗ need curl or wget" >&2; exit 1; fi

[ -f "$OUT" ] && [ -s "$OUT" ] || { echo "✗ download failed" >&2; exit 1; }
verify
echo "✓ done ($(du -h "$OUT" | cut -f1))"
