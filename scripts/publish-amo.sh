#!/usr/bin/env bash
# Upload and sign the Firefox build on addons.mozilla.org.
#
# Needs an AMO API credential pair, generated once at
#   https://addons.mozilla.org/developers/addon/api/key/
# and exported before running:
#   export AMO_JWT_ISSUER='user:12345678:123'
#   export AMO_JWT_SECRET='...'
# Never commit these. They are account-wide: anyone holding them can publish
# under your name.
#
# The listing itself (description, screenshots, categories) is filled in on the
# AMO site, not here - see docs/PUBLISHING.md. This script handles the package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER - see the header of this script}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET - see the header of this script}"

VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
ZIP="stockfish-continue-to-play-firefox-${VERSION}.zip"
CHANNEL="${1:-listed}"        # listed = public on AMO; unlisted = self-distributed

[ -f "$ZIP" ] || { echo "✗ $ZIP not built - run: npm run package" >&2; exit 1; }

# Sign from the exact artifact that was reviewed, not from the working tree.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
unzip -q "$ZIP" -d "$STAGE"

echo "→ validating $ZIP with the AMO linter before uploading"
npx web-ext lint --source-dir "$STAGE" --output text || {
  echo "✗ the linter is unhappy. Read docs/PUBLISHING.md before forcing this." >&2
  exit 1
}

echo "→ uploading v${VERSION} to AMO (channel: ${CHANNEL})"
npx web-ext sign \
  --source-dir "$STAGE" \
  --artifacts-dir "$ROOT/dist-amo" \
  --channel "$CHANNEL" \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"

echo
echo "✓ uploaded. A listed submission still needs, on the AMO site:"
echo "   1. the source archive  ->  npm run source-archive"
echo "   2. the listing copy    ->  store/LISTING.md"
