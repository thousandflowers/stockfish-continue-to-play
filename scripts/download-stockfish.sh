#!/usr/bin/env bash
# Download Stockfish WASM binary.
# stockfish.js (~10 MB) is omitted from git tracking to keep clones lean.
# Run this script to fetch it before loading the extension.
set -euo pipefail

VERSION="${1:-2.0}"
URL="https://github.com/thousandflowers/stockfish-continue-to-play/releases/download/v${VERSION}/stockfish.js"
OUT="$(cd "$(dirname "$0")/.." && pwd)/stockfish.js"

if [ -f "$OUT" ] && [ -s "$OUT" ]; then
  echo "✓ stockfish.js already exists ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

echo "↓ Downloading stockfish.js (~10 MB) from v${VERSION}..."
if command -v curl &>/dev/null; then
  curl -fSL -o "$OUT" "$URL"
elif command -v wget &>/dev/null; then
  wget -O "$OUT" "$URL"
else
  echo "✗ need curl or wget" >&2
  exit 1
fi

if [ -f "$OUT" ] && [ -s "$OUT" ]; then
  echo "✓ done ($(du -h "$OUT" | cut -f1))"
else
  echo "✗ download failed" >&2
  exit 1
fi
