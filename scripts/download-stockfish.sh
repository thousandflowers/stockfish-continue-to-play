#!/usr/bin/env bash
# Download the Stockfish engine, which is kept out of git: a 21 KB loader and a
# 7 MB WebAssembly binary. Integrity is verified against the digests pinned in
# stockfish.sha256.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA_FILE="$ROOT/stockfish.sha256"
FILES=(stockfish.js stockfish.wasm)
# Engine-binary release tag - versioned independently of the extension version.
VERSION="${1:-18.0.8}"
BASE="https://github.com/thousandflowers/stockfish-continue-to-play/releases/download/engine-${VERSION}"

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"; else sha256sum "$@"; fi; }

verify() {
  if [ ! -f "$SHA_FILE" ]; then
    [ -n "${ALLOW_UNVERIFIED_ENGINE:-}" ] && { echo "⚠ no checksum file - proceeding (ALLOW_UNVERIFIED_ENGINE set)"; return 0; }
    echo "✗ no checksum file ($SHA_FILE) - refusing to use an unverified engine." >&2
    echo "  Set ALLOW_UNVERIFIED_ENGINE=1 to override." >&2
    return 1
  fi
  # -c checks every line, so a good loader next to a tampered .wasm still fails.
  ( cd "$ROOT" && sha -c "$SHA_FILE" ) || {
    echo "✗ checksum mismatch - delete the files and re-run to re-download." >&2
    return 1
  }
}

have_all() { for f in "${FILES[@]}"; do [ -s "$ROOT/$f" ] || return 1; done; }

if have_all; then
  echo "✓ engine already present ($(du -ch "${FILES[@]/#/$ROOT/}" | tail -1 | cut -f1))"
  verify
  exit 0
fi

for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] && continue
  echo "↓ downloading $f from engine-${VERSION}…"
  if command -v curl >/dev/null 2>&1; then curl -fSL -o "$ROOT/$f" "$BASE/$f"
  elif command -v wget >/dev/null 2>&1; then wget -O "$ROOT/$f" "$BASE/$f"
  else echo "✗ need curl or wget" >&2; exit 1; fi
  [ -s "$ROOT/$f" ] || { echo "✗ download failed: $f" >&2; exit 1; }
done

verify
echo "✓ done ($(du -ch "${FILES[@]/#/$ROOT/}" | tail -1 | cut -f1))"
