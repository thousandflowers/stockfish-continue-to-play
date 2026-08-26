#!/usr/bin/env bash
# Upload (and optionally publish) the Chrome build on the Chrome Web Store.
#
# Needs a Google OAuth client and a refresh token, set up once - the walkthrough
# is in docs/PUBLISHING.md. Export before running:
#   export CWS_CLIENT_ID='....apps.googleusercontent.com'
#   export CWS_CLIENT_SECRET='...'
#   export CWS_REFRESH_TOKEN='1//...'
#   export CWS_ITEM_ID='...'      # the 32-char id, from the dashboard URL
#
# The listing copy and the screenshots are dashboard-only: the API cannot set
# them. This script ships the package; store/LISTING.md is the rest.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${CWS_CLIENT_ID:?see docs/PUBLISHING.md}"
: "${CWS_CLIENT_SECRET:?see docs/PUBLISHING.md}"
: "${CWS_REFRESH_TOKEN:?see docs/PUBLISHING.md}"
: "${CWS_ITEM_ID:?the item id from the dashboard URL - the first upload must be made by hand}"

VERSION="$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')"
ZIP="stockfish-continue-to-play-chrome-${VERSION}.zip"
[ -f "$ZIP" ] || { echo "✗ $ZIP not built - run: npm run package" >&2; exit 1; }

jq_get() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1',''))"; }

echo "→ exchanging the refresh token for an access token"
TOKEN="$(curl -sf -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${CWS_CLIENT_ID}" \
  -d "client_secret=${CWS_CLIENT_SECRET}" \
  -d "refresh_token=${CWS_REFRESH_TOKEN}" \
  -d grant_type=refresh_token | jq_get access_token)"
[ -n "$TOKEN" ] || { echo "✗ no access token - the refresh token is wrong or revoked" >&2; exit 1; }

echo "→ uploading v${VERSION} to item ${CWS_ITEM_ID}"
RESP="$(curl -sf -X PUT \
  -H "Authorization: Bearer ${TOKEN}" -H "x-goog-api-version: 2" \
  -T "$ZIP" \
  "https://www.googleapis.com/upload/chromewebstore/v1.1/items/${CWS_ITEM_ID}")"
STATE="$(printf '%s' "$RESP" | jq_get uploadState)"
echo "   uploadState: ${STATE}"
if [ "$STATE" != "SUCCESS" ]; then
  printf '%s\n' "$RESP" >&2
  echo "✗ upload rejected" >&2; exit 1
fi

if [ "${1:-}" != "--publish" ]; then
  echo "✓ uploaded as a draft. Review it in the dashboard, then re-run with --publish."
  exit 0
fi

echo "→ submitting for review"
curl -sf -X POST -H "Authorization: Bearer ${TOKEN}" -H "x-goog-api-version: 2" \
  -H "Content-Length: 0" \
  "https://www.googleapis.com/chromewebstore/v1.1/items/${CWS_ITEM_ID}/publish"
echo
echo "✓ submitted. Review typically takes a few days for a first submission."
