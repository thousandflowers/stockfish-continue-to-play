#!/usr/bin/env bash
# Build the source archive AMO requires, because stockfish.js is minified
# vendored code. See docs/AMO-SOURCE-SUBMISSION.md for the reviewer notes that
# go with it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
REF="${1:-v${VERSION}}"
OUT="source-${REF}.zip"
git rev-parse --verify --quiet "$REF" >/dev/null \
  || { echo "✗ no such git ref: $REF - tag the release first" >&2; exit 1; }
# Archive the tag, never the working tree: the reviewer must get exactly what
# the tag says, with no stray local edits.
git archive --format=zip --prefix="stockfish-continue-to-play/" -o "$OUT" "$REF"
echo "✓ $OUT ($(du -h "$OUT" | cut -f1)) from $REF"
echo "  paste the 'Notes for the reviewer' block from docs/AMO-SOURCE-SUBMISSION.md"
