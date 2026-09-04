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
# AMO site, not here - see docs/PUBLISHING.md. This script handles the package,
# the source archive AMO requires, and the reviewer notes that go with it.
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

# AMO wants the human-readable source beside the package, because the vendored
# loader is minified and the engine is a compiled binary. Uploading it in the same
# call is what keeps a listed submission from stalling in review.
SOURCE="source-v${VERSION}.zip"
[ -f "$SOURCE" ] || bash scripts/source-archive.sh "v${VERSION}"

# The reviewer notes live in one place - the fenced block in the doc - so they
# cannot drift from what a human would have pasted into the form.
NOTES="$STAGE/amo-metadata.json"
python3 scripts/amo-metadata.py "$NOTES"

echo "→ uploading v${VERSION} to AMO (channel: ${CHANNEL}), with $SOURCE and the reviewer notes"
npx web-ext sign \
  --source-dir "$STAGE" \
  --artifacts-dir "$ROOT/dist-amo" \
  --channel "$CHANNEL" \
  --upload-source-code "$ROOT/$SOURCE" \
  --amo-metadata "$NOTES" \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"

echo
echo "✓ uploaded and in review, source archive and reviewer notes included."
echo "  Only the listing copy is web-form only, and only for a first submission:"
echo "  store/LISTING.md"
