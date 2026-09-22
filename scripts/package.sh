#!/usr/bin/env bash
# Build the store zips. Lists every packaged path explicitly: a `zip -r . `
# from the repo root would ship node_modules/, .git/ and the tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
for f in stockfish.js stockfish.wasm; do
  [ -f "$f" ] || { echo "✗ $f missing - run scripts/download-stockfish.sh" >&2; exit 1; }
done
bash scripts/download-stockfish.sh >/dev/null   # re-verifies the pinned checksum

# Everything that ships, minus the manifest (added per-target below).
# GPLv3: the engine's notices travel with the binary that carries them.
PAYLOAD=(
  service-worker.js
  content_chesscom.js
  page-bridge.js
  popup.html
  popup.js
  lib
  icons
  stockfish.js
  stockfish.wasm
  LICENSE
  LICENSE.stockfish
  LICENSE.MIT
)

build() {  # build <target>
  local target="$1" out="stockfish-continue-to-play-${1}-${VERSION}.zip"
  local stage; stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN
  cp -R "${PAYLOAD[@]}" "$stage/"
  if [ "$target" = firefox ]; then
    python3 scripts/firefox-manifest.py > "$stage/manifest.json"
  else
    cp manifest.json "$stage/manifest.json"
  fi
  rm -f "$out"
  (cd "$stage" && zip -qr - .) > "$out"
  echo "✓ $out  ($(du -h "$out" | cut -f1), $(unzip -l "$out" | tail -1 | awk '{print $2}') entries)"
}

build chrome
build firefox
