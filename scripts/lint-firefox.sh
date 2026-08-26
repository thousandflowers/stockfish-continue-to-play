#!/usr/bin/env bash
# Run Mozilla's addons-linter against the built Firefox package.
# This is the same validator AMO runs on submission, so run it before uploading.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
ZIP="stockfish-continue-to-play-firefox-${VERSION}.zip"
[ -f "$ZIP" ] || { echo "✗ $ZIP not built - run: npm run package" >&2; exit 1; }
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
unzip -q "$ZIP" -d "$STAGE"
# Lint the package, not the working tree: the working tree has no manifest.json
# for Firefox, and carries tests/ and store/ that never ship.
npx web-ext lint --source-dir "$STAGE" --output text
