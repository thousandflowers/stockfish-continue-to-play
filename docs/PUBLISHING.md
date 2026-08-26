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
| AMO source archive | `npm run source-archive v3.1.1` |
| AMO reviewer notes | `docs/AMO-SOURCE-SUBMISSION.md` |
| Mozilla's own validator passing | `npm run lint:ff` - see the known findings below |
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
4. **Source code upload: required.** AMO asks because `stockfish.js` is
   minified vendored code. Build the archive and paste the reviewer notes:

   ```bash
   npm run source-archive v3.1.1     # writes source-v3.1.1.zip
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

`npm run lint:ff` currently reports **1 error and 2 warnings**. Both are
understood; neither is an accident.

### ERROR - `FILE_TOO_LARGE` on `stockfish.js`

The engine is ~10 MB and the linter will not parse files over 5 MB, so it
cannot scan it automatically.

This is why AMO demands the source submission: a human reviewer verifies the
binary instead. Provide `source-<tag>.zip` and the reviewer notes and the review
has what it needs - the notes include the two commands that prove the shipped
file is byte-identical to the upstream Stockfish build, against the checksum
pinned in `stockfish.js.sha256`.

**If AMO's server-side validation rejects the upload outright on this error**
rather than routing it to manual review, the options, worst to best:

1. Ask on the add-ons developer forum for a manual-review exception. Bundling a
   chess engine is a normal thing to do and the source is public.
2. Split the engine into sub-5 MB parts fetched and concatenated before the
   Worker blob is created. Do **not** do this by renaming JavaScript to `.txt`
   to dodge the scanner - that reads as evasion and is worse than the problem.
3. Ship Firefox unlisted (self-distributed, signed but not on AMO) and keep
   Chrome as the listed channel.

Do not pre-emptively rebuild the packaging for this. Try the upload first.

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
