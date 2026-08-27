# Publishing to the Chrome Web Store and AMO

Everything that can be automated is automated. What is left needs a human,
because both stores require an account, a payment or an identity check, and
listing copy typed into a web form. This document is the short version of what
only you can do, and the exact commands for everything else.

Read [`../store/LISTING.md`](../store/LISTING.md) alongside this: it has the
paste-ready text for every field either dashboard asks for.

---

## What is already done

| | Status |
|---|---|
| Package built reproducibly | `npm run package` - both zips, explicit path list, checksum-verified engine |
| Screenshots, promo tile, store icon | `store/` |
| Listing copy for every field | `store/LISTING.md` |
| Privacy policy at a public URL | `PRIVACY.md` |
| AMO source archive | `npm run source-archive` |
| AMO reviewer notes | `docs/AMO-SOURCE-SUBMISSION.md` |
| Mozilla's own validator passing | `npm run lint:ff` - `errors 0` since v3.2.0 |
| Package upload scripted | `npm run publish:cws`, `npm run publish:amo` |

## What only you can do

1. **Chrome**: create a Chrome Web Store developer account and pay the one-time
   **$5 USD** registration fee. There is no way around the fee and no API for it.
2. **Firefox**: create an addons.mozilla.org account. Free.
3. Type the listing copy into both dashboards. Neither API can set the
   description, screenshots or category - those are web-form only.
4. Generate the API credentials below, if you want the *next* release to be one
   command instead of a form.

---

## Chrome Web Store

### First submission - by hand

1. Register: <https://chrome.google.com/webstore/devconsole>. Pay the $5.
2. **New item** → upload `stockfish-continue-to-play-chrome-<version>.zip`.
   Build it first with `npm run package`.
3. Fill the listing from [`../store/LISTING.md`](../store/LISTING.md): name,
   short description, full description, category `Entertainment`.
4. Upload from `store/`: `screenshots/*.png` (five, 1280×800),
   `promo-tile-440x280.png`, `store-icon-128.png`.
5. **Privacy practices tab.** This is where submissions die. Paste, from
   `store/LISTING.md`: the single-purpose statement, the `storage`
   justification, and the remote-code answer. Answer **"No, I am not using
   remote code"** - the engine is inside the package; the `new Worker(blobUrl)`
   in `content_chesscom.js` wraps a packaged file, not a download.
6. **Data use**: tick nothing, certify all three statements. Privacy policy URL:
   `https://github.com/thousandflowers/stockfish-continue-to-play/blob/main/PRIVACY.md`
7. Submit. A first review usually takes a few days; it can take longer when an
   extension asks about remote code, which is why step 5 matters.

### Later releases - one command

Once the item exists you have an item id (the 32 characters in the dashboard
URL). Set up an OAuth client once:

1. <https://console.cloud.google.com> → new project → enable the
   **Chrome Web Store API**.
2. **Credentials** → *Create credentials* → *OAuth client ID* → **Desktop app**.
   Keep the client id and secret.
3. Get a refresh token: visit, in a browser signed in as the developer account,

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```

   then exchange the code it shows you:

   ```bash
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d client_id=YOUR_CLIENT_ID -d client_secret=YOUR_CLIENT_SECRET \
     -d code=THE_CODE -d grant_type=authorization_code \
     -d redirect_uri=urn:ietf:wg:oauth:2.0:oob | jq .refresh_token
   ```

4. Then:

   ```bash
   export CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... CWS_ITEM_ID=...
   npm run package
   npm run publish:cws              # uploads as a draft
   npm run publish:cws -- --publish # submits for review
   ```

Keep those four values out of the repo. They publish under your name.

---

## Firefox / AMO

### First submission

1. Sign in at <https://addons.mozilla.org/developers/>.
2. **Submit a New Add-on** → *On this site* (listed).
3. Upload `stockfish-continue-to-play-firefox-<version>.zip`. Note the id
   `stockfish-continue@thousandflowers` is **permanent** from this moment.
4. **Source code upload: still required**, even after the engine change. AMO asks because
   the vendored loader is minified and the `.wasm` is compiled. Build the archive and paste
   the reviewer notes:

   ```bash
   npm run source-archive            # writes source-v<version>.zip
   ```

   The notes to paste are the fenced block in
   [`AMO-SOURCE-SUBMISSION.md`](AMO-SOURCE-SUBMISSION.md). Skipping this is the
   single most likely cause of a stalled review.
5. Listing copy: same text as Chrome, from `store/LISTING.md`. Category
   *Games & Entertainment*. Same screenshots.
6. Submit.

### Later releases - one command

Generate a credential pair at
<https://addons.mozilla.org/developers/addon/api/key/>, then:

```bash
export AMO_JWT_ISSUER='user:12345678:123' AMO_JWT_SECRET='...'
npm run package
npm run publish:amo              # listed
```

The script re-runs the linter before uploading and refuses to ship a package
that fails it. Source upload for each new version is still manual.

---

## Known linter findings, and what they mean

`npm run lint:ff` currently reports **0 errors and 2 warnings**. The error is fixed; the
warnings are deliberate.

### ~~ERROR - `FILE_TOO_LARGE` on `stockfish.js`~~ Fixed in v3.2.0

This used to be the one thing standing between the extension and an AMO listing, and AMO's
validator did stop the first submission on it:

```
1 error, 2 warnings, 0 notices
File is too large to parse.  ->  stockfish.js
```

The linter will not parse a JavaScript file over 5 MB, and the ASM.JS engine was 10.5 MB of
JavaScript. Even where it does not hard-block, an unscannable file means **manual review for
every future version** - a permanent tax rather than a one-off.

Fixed by bundling a different upstream build: `stockfish-18-lite-single` instead of
`stockfish-18-asm`. Same strength tier, but the engine is a real `.wasm` binary beside a
21 KB loader, and linters do not parse binaries. `npm run lint:ff` now reports `errors 0`,
and the package went from 10.6 MiB to 5.5 MiB zipped as a bonus.

Renaming JavaScript to `.txt` to hide it from the scanner was considered and rejected - it
reads as evasion and is worse than the problem.

### WARNING ×2 - `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`

`browser_specific_settings.gecko.data_collection_permissions` is required for
new AMO submissions, but only exists in Firefox 140+ (142+ on Android). Our
`strict_min_version` is `128.0`.

Deliberate. Older Firefox ignores the unknown key, so the add-on still works on
128-139; raising the floor to 140 would drop twelve Firefox versions to silence a
warning that changes nothing. Revisit when 140 is old enough not to matter.

---

## After it is live

- Put the store links in `README.md`, replacing the "not yet published" note.
- Chrome auto-updates from the store; the GitHub release stays as the
  install-from-source path.
- Every later version needs the version bumped in `manifest.json`,
  `manifest-firefox.json` and `package.json` together - `npm run package` reads
  the first one, and a mismatch ships a zip whose name lies about its contents.
