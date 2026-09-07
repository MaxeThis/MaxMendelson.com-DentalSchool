# UMSOD Block Exchange

A static site for University of Maryland School of Dentistry students to swap blocks. Students register with their name, S# (5 digits, the `S` is added automatically), and phone number, then post blocks they want to give up. Other students can filter and view the calendar and reach out by phone or text.

- Block types: Oral Surgery (BLK-SURGERY and BLK-OS), Urgent Care (BLK-UCARE), Ortho, Special Care, Peds, Perio, Emergency, On-Call, Screening, Hospital, Pan, Mock Boards, Clerkship, Education/Other, Shady Grove. Hospital, Mock Boards, Clerkship, and Education/Other are display/filter-only (can't be posted for swap); Shady Grove is admin-filter-only (kept out of the swap-calendar filter and post form since it's never posted)
- Labels are self-healing: each axiUm code maps to a canonical name (`SCHEDULE_NAME_MAP`, with hyphen-insensitive + OCR-digit repair so `BLKOS`/`09:OO` still resolve) and each block type folds through `TYPE_ALIASES` to its canonical label. To rename or merge a type, edit those maps in one place — existing posted blocks and imported schedules are rewritten to match the next time their owner (or the admin) loads the app, so no manual database edits are needed. The one thing that can't self-heal is a *split*: records stored under the retired merged "Oral Surgery/Urg Care" label could be either type, so the audit (`tools/firestore-admin.mjs audit`) flags them for manual re-typing and students can fix their own rows by editing or re-importing their schedule
- Mon–Fri, morning + afternoon
- Download an `.ics` of your schedule (deterministic event IDs, so re-importing updates events in place instead of duplicating), or subscribe to a **live** auto-updating calendar feed (optional — deploy the Cloudflare Worker in [`worker/`](worker/README.md))
- Filter the calendar by block type and/or morning/afternoon
- Each student can see and remove their own posted blocks
- Assist board for posting clinic appointments that need an assist (Endo / Fixed / Remo / Operative). Posts go live for everyone at 8 AM the day before — Endo opens 1 week ahead. Times are 7 AM, 9:30 AM, 1 PM (2 PM on Mondays), 4 PM
- Privacy policy included
- PerioMaxer ad slot at the top (linking to the App Store)

Everything is static HTML/CSS/JS — deployable on GitHub Pages. Shared data lives in a free Firebase Firestore database.

## Articulator Baser

The browser app at `/baser/` imports STL/OBJ scans, fits an articulator base, and exports an STL. Scans and labels remain on the user's device. It includes Honeycomb, Diamond lattice, Chevron, and Wave filler designs alongside the original options, plus two-line stencil engraving with a live preview, size/alignment controls, and fit checks before export. All wall designs construct their openings and engraved recesses directly, including Windows, MedStar OMFS, and Round bars.

Typing updates the SVG label preview immediately. Press **Enter** or **Apply lettering** to update the 3D plate; **View back wall** and **Export STL** also apply the latest draft. Pausing or moving between fields keeps the draft intact without rebuilding the mesh.

**Admin → Baser usage** shows anonymous browser/session counts, successful exports, errors, active time, and daily activity. Click **Email me a sign-in link** to verify the owner's email once on that browser. No filenames, models, or entered text are collected. Setup, privacy boundaries, and database deployment are documented in [ANALYTICS.md](ANALYTICS.md).

Run checks with Node 24:

```sh
node test/test-parser.js
node test/test-site.js
node test/test-calendar-worker.js
node test/test-usage.mjs
node test/test-usage-lifecycle.mjs
node test/test-admin-analytics.mjs
node test/test-baser.mjs
node test/test-world-bounds.mjs
```

The Baser suite tests real closed meshes, engraving recesses, synthetic model unions, and binary STL round trips using the checked-in geometry libraries. The bounds suite checks exact model measurements after transforms and geometry changes. Database access tests use a separate local emulator; see the analytics guide.

For browser acceptance checks, use Node 24, Playwright 1.62.1, and a local HTTP server. In one terminal, from the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

In another terminal, install the test dependency outside the repository and run the suite. This example uses the installed macOS Chrome binary; change `CHROME_BIN` for another Chromium installation, or omit it if Playwright's Chromium is installed.

```sh
npm install --prefix /tmp/baser-browser-tools --no-save playwright@1.62.1
PLAYWRIGHT_MODULE=/tmp/baser-browser-tools/node_modules/playwright \
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
QA_OUTPUT=/tmp/baser-browser-qa \
node test/test-browser.mjs
```

`TEST_ORIGIN` defaults to `http://127.0.0.1:8000` and must be local. `QA_PART=site` runs only the root/admin checks; `QA_PART=lettering` runs the narrower lettering/export check. The default runs all checks. Screenshots, a downloaded synthetic STL, and `report.json` are saved under `QA_OUTPUT`. Chrome runs in an isolated temporary profile. Root-site Firebase and admin records are synthetic fixtures; Baser checks assert that no model, text, or analytics requests leave localhost. The browser suite covers import, the four new patterns, engraving controls, undo, mobile layout, export, reset, and admin usage metrics.

The interaction regression uses an 81,920-triangle synthetic model, measures rapid input and pause delays, and verifies every final letter stroke in the downloaded STL. It also checks explicit Apply, draft preservation across fields/settings, and stale-draft clearing on undo or replacement import:

```sh
PLAYWRIGHT_MODULE=/tmp/baser-browser-tools/node_modules/playwright \
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
QA_PATTERN=text QA_OUTPUT=/tmp/baser-interaction-qa \
node test/test-baser-interaction.mjs
```

Repeat with `QA_PATTERN=wide` and `QA_PATTERN=bars` for the other original wall designs. Timing measurements, screenshots, and STL downloads are saved under `QA_OUTPUT`; no real model or account data is used. The test also requires every loaded application module to share the current cache version.

## 1. Firebase setup (one time, ~5 minutes)

You need a Firebase project to store the shared blocks. It is free for this use case.

1. Go to <https://console.firebase.google.com/> and click **Add project**. Name it anything (e.g. `umsod-block-exchange`). You can disable Google Analytics.
2. Inside the project, click the **`</>`** (Web) icon to register a web app. Give it a nickname and click **Register**. Firebase will show you a `firebaseConfig` object — copy those values.
3. Open `firebase-config.js` in this repo and paste the values in place of the `REPLACE_ME_*` strings. Commit the change. These values are safe to commit.
4. In the Firebase console, go to **Build → Firestore Database** and click **Create database**. Pick **Start in production mode** and a region close to Maryland (e.g. `us-east4`).
5. Use the checked-in **[firestore.rules](firestore.rules)**, which includes the protected Baser analytics collection. For an existing deployment, use the change-preserving helper in [ANALYTICS.md](ANALYTICS.md). The example below describes the older ScheduleMaxer rules only; **do not replace the deployed rules with this incomplete example**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       // Helpers
       function validPhone(p) {
         // Phone is optional — allow empty or up to 25 chars.
         return p is string && p.size() <= 25;
       }
       function validName(n) {
         return n is string && n.size() > 0 && n.size() <= 80;
       }
       function validPinHash(h) {
         // PBKDF2 SHA-256 hex = 64 chars; keep room for versioning.
         return h is string && h.size() >= 32 && h.size() <= 128;
       }
       function validType(t) {
         // 'Oral Surgery/Urg Care' is the retired merged label — kept valid so
         // legacy blocks stored under it can still be updated (urgent flag etc.).
         return t in ['Oral Surgery/Urg Care','Oral Surgery','Urgent Care','Ortho','Special Care','Peds','Perio','Emergency','On-Call','Screening','Hospital','Pan','Mock Boards','Clerkship','Education/Other','Shady Grove'];
       }
       function validTime(t) {
         return t == 'morning' || t == 'afternoon';
       }
       function validDate(d) {
         return d is string && d.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
       }

       // User profiles, one doc per S#.
       match /users/{sNumber} {
         // Reads require an authenticated session (anonymous auth counts).
         // Anonymous auth and App Check do not prove a student's identity.
         allow read: if request.auth != null;

         allow create: if sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.keys().hasAll(['sNumber','name','phone','pinHash','createdAt','updatedAt'])
           && request.resource.data.sNumber == sNumber
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && validPinHash(request.resource.data.pinHash)
           && request.resource.data.createdAt is number
           && request.resource.data.updatedAt is number;

         // pinHash + sNumber + createdAt are locked. These legacy rules
         // do not check the requester owns the profile; other fields,
         // including its schedule, can still be changed by other clients.
         allow update: if sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.pinHash == resource.data.pinHash
           && request.resource.data.createdAt == resource.data.createdAt
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && request.resource.data.updatedAt is number;

         allow delete: if false;
       }

       // Posted blocks.
       match /blocks/{blockId} {
         allow read: if request.auth != null;

         allow create: if request.resource.data.keys().hasAll(
             ['date','time','type','name','sNumber','phone','createdAt']
           )
           && request.resource.data.sNumber is string
           && request.resource.data.sNumber.matches('^S[0-9]{5}$')
           && validDate(request.resource.data.date)
           && validTime(request.resource.data.time)
           && validType(request.resource.data.type)
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && request.resource.data.createdAt is number
           && (request.resource.data.notes == null
               || (request.resource.data.notes is string
                   && request.resource.data.notes.size() <= 200));

         // Updates may change contact info, the block's date/time/type/notes,
         // and the urgent flag (used by the inline "Edit" form in My Blocks).
         // sNumber + createdAt stay locked so an attacker can't reassign
         // ownership or rewrite a post's age.
         allow update: if request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.createdAt == resource.data.createdAt
           && validDate(request.resource.data.date)
           && validTime(request.resource.data.time)
           && validType(request.resource.data.type)
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && (request.resource.data.notes == null
               || (request.resource.data.notes is string
                   && request.resource.data.notes.size() <= 200));

         // Delete is open (UI only exposes it on your own blocks). If abuse
         // shows up, add Firebase Auth and tighten this.
         allow delete: if true;
       }

       // Assist requests. Same auth-gated read pattern as blocks; tight
       // shape check on create; updates limited to the contact fields so
       // a profile rename can propagate without exposing identity/date
       // fields. The query that backs this collection is a single-field
       // range on `date`, so no composite index is needed.
       match /assists/{assistId} {
         allow read: if request.auth != null;

         allow create: if request.resource.data.keys().hasAll(
             ['sNumber','name','phone','date','time','procedure','chair','notes','createdAt']
           )
           && request.resource.data.sNumber is string
           && request.resource.data.sNumber.matches('^S[0-9]{5}$')
           && validDate(request.resource.data.date)
           && request.resource.data.time in ['7am','9:30am','1pm','2pm','4pm']
           && request.resource.data.procedure in ['Endo','Fixed','Remo','Operative']
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && (request.resource.data.chair == null
               || (request.resource.data.chair is string
                   && request.resource.data.chair.size() <= 10))
           && (request.resource.data.notes == null
               || (request.resource.data.notes is string
                   && request.resource.data.notes.size() <= 200))
           && request.resource.data.createdAt is number;

         // Updates change only the contact fields (name + phone) so
         // identity/date/time/procedure/createdAt cannot be tampered with.
         allow update: if request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.date == resource.data.date
           && request.resource.data.time == resource.data.time
           && request.resource.data.procedure == resource.data.procedure
           && request.resource.data.createdAt == resource.data.createdAt
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone);

         // Same delete posture as /blocks: open. UI only exposes the
         // cancel button on your own posts.
         allow delete: if true;
       }

       // Session records so the admin view can compute usage
       // frequency, total time, and who is online right now.
       // Reads require auth; legacy write validation does not establish
       // who owns a session or enforce a server-side rate limit.
       match /sessions/{sessionId} {
         allow read: if request.auth != null;
         allow create: if request.resource.data.keys().hasAll(['sNumber','startedAt','lastActive'])
           && request.resource.data.sNumber is string
           && request.resource.data.sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.startedAt is number
           && request.resource.data.lastActive is number;
         // Only the lastActive timestamp may change on update.
         allow update: if request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.startedAt == resource.data.startedAt
           && request.resource.data.lastActive is number;
         allow delete: if false;
       }

       // Site configuration (admin hash). The client reads
       // it while bootstrapping the admin gate; only anon-signed-in
       // users can read it. It is not private to the administrator.
       // All writes happen manually in the Firebase console.
       match /config/{doc} {
         allow read: if request.auth != null;
         allow write: if false;
       }

       // Client-side error reports so the site owner can diagnose
       // failures without asking users to open DevTools. Read only
       // from the Firebase console; field bounds alone do not prevent abuse.
       match /clientErrors/{errorId} {
         allow read, update, delete: if false;
         allow create: if request.resource.data.keys().hasAll(
             ['context','message','code','sNumber','userAgent','url','timestamp']
           )
           && request.resource.data.context is string
           && request.resource.data.context.size() <= 60
           && request.resource.data.message is string
           && request.resource.data.message.size() <= 500
           && request.resource.data.code is string
           && request.resource.data.code.size() <= 60
           && request.resource.data.sNumber is string
           && request.resource.data.sNumber.size() <= 6
           && request.resource.data.userAgent is string
           && request.resource.data.userAgent.size() <= 300
           && request.resource.data.url is string
           && request.resource.data.url.size() <= 200
           && request.resource.data.timestamp is number;
       }
     }
   }
   ```
6. **Enable Anonymous Auth.** In **Build → Authentication → Sign-in method**, enable the **Anonymous** provider. The client signs in anonymously at boot so Firestore rules can require `request.auth != null` for reads. Without this step every read will fail with `permission-denied`.
7. **Seed the admin config.** In Firestore, create a doc at path `config/admin` with a single field:
   - `hash` *(string)*: PBKDF2-SHA256 of your admin secret, salt `umsod-admin-v1`, 200,000 iterations, hex output.
   To generate the hash for a new secret, run:
   ```bash
   python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha256', b'YOURSECRET', b'umsod-admin-v1', 200000).hex())"
   ```
   Paste the resulting hex string as `config/admin.hash`.
8. (Optional) In **Build → Authentication → Settings → Authorized domains**, add `maxmendelson.com` and your GitHub Pages URL (e.g. `maxethis.github.io`).

## 2. Run it locally

Because it is plain HTML/JS, you can just open `index.html`, but some browsers block `file://` access to Firestore. Easiest is:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## 3. Deploy to GitHub Pages

1. Push this repo to GitHub.
2. On GitHub, open **Settings → Pages**. Under **Source**, pick the branch you want to serve from (e.g. `main`) and `/ (root)`. Save.
3. Wait a minute. GitHub will show the URL (e.g. `https://maxethis.github.io/MaxMendelson.com-DentalSchool/`). Open it — you should see the site.

### Custom domain (maxmendelson.com)

When you're ready to hook up `maxmendelson.com`:

1. Create a file called `CNAME` in the repo root containing just one line: `maxmendelson.com`
2. In GoDaddy / wherever your DNS lives, add these records:
   - `A` `@` → `185.199.108.153`
   - `A` `@` → `185.199.109.153`
   - `A` `@` → `185.199.110.153`
   - `A` `@` → `185.199.111.153`
   - `CNAME` `www` → `<your-github-username>.github.io`
2. The `CNAME` file in this repo is already set to `maxmendelson.com`. If you want a subdomain instead (e.g. `blocks.maxmendelson.com`), edit that file.
3. In GitHub **Settings → Pages**, enter `maxmendelson.com` as the custom domain and wait for the TLS cert to provision (can take up to ~20 minutes). Turn on **Enforce HTTPS** once it’s available.

## 4. PerioMaxer ad link

The banner and footer link to `https://apps.apple.com/app/apple-store/id6762096578?pt=120200831&ct=maxmendelson.com&mt=8` (App Store ID `6762096578`, with attribution params `pt=120200831&ct=maxmendelson.com`). The banner is currently hidden via the `hidden` class on `#periomaxer-ad` in `index.html`; remove that class to show it.

## 5. Files

| File | What it does |
| --- | --- |
| `index.html` | All UI — registration gate, calendar, my blocks, post form, profile, PerioMaxer ad |
| `styles.css` | Styling |
| `app.js` | All logic — profile, Firestore sync, calendar, filters, posting, deletion |
| `firebase-config.js` | Your Firebase project config (fill in once) |
| `privacy.html` | Privacy policy page |
| `CNAME` | Custom domain for GitHub Pages (`maxmendelson.com`) |
| `.nojekyll` | Tells GitHub Pages not to run Jekyll |

## Sign-in flow

- The user enters their 5-digit S#.
- If a profile already exists, they're prompted for their **PIN** (4–6 digits) to sign in.
- If no profile exists, they're prompted once for name + phone + PIN + privacy-policy agreement, and a profile is created under `users/S#####`.
- PINs are never stored in plaintext and never leave the browser — the browser hashes them with **PBKDF2 (SHA-256, 200,000 iterations, S#-salted)** via Web Crypto, and only the hash goes to Firestore.
- Once signed in, the S# + name + phone are cached in `localStorage` (PIN and hash are **not** cached) so the user stays signed in on that device across browser restarts.
- The **Account** tab in the top bar lets them edit their name or phone (changes propagate to their existing posted blocks) and **sign out** (clears the local cache; they'll be asked for PIN on next sign-in).

## Preventing spam / quota abuse

Check the Firebase console for the project's current billing plan and quotas. Daily read/write quotas can interrupt service; stored-data limits are separate from daily operation limits. Defenses layered on top of those quotas:

1. **Firebase App Check with reCAPTCHA v3** — reject requests without valid app attestation after enforcement is enabled. This reduces abuse but does not identify the student, enforce ownership, or prevent every bot/scraping request. See [Firebase's App Check security model](https://firebase.google.com/docs/app-check).
   - Firebase console → **Build → App Check**. Register your web app with reCAPTCHA v3, copy the site key.
   - Paste the site key into `firebase-config.js` → `RECAPTCHA_V3_SITE_KEY`.
   - Back in the App Check console, open **Firestore** under APIs and switch enforcement from "Unenforced" to **Enforced**.
   - Add your domains (the GitHub Pages URL and `maxmendelson.com`) under the reCAPTCHA admin console's "Domains" list.
2. **Firestore rules** — validate permitted fields and enforce access using a trusted authenticated identity. The legacy ScheduleMaxer rules above have incomplete field restrictions and no per-student ownership check; see the security limitations below.
3. **Narrow read queries** — the block subscription begins yesterday, while assists use `date >= today` and subscribe only while the Assist tab is open. These limit historical reads. Existing `createdAt` values are numeric milliseconds, so they cannot directly serve as Firestore TTL fields. Automatic cleanup requires a Date/Timestamp field (for example, `expireAt`) and a matching TTL policy. See [Firestore TTL requirements](https://firebase.google.com/docs/firestore/ttl).
4. **Client-side rate limits** — in `app.js`, each browser tab is capped at 8 sign-in attempts/min and 6 posts/min. Doesn't stop a determined attacker but stops accidental loops.
5. **Budget alerts** — Firebase console → **Usage and billing** → **Details & settings** → **Modify budget**. Set an alert to email you if traffic spikes unusually.

If abuse occurs, preserve the data, inspect the affected collections and rules, and restrict the offending access path. Deleting the database loses user data and does not repair the authorization weakness.

## Notes and trade-offs

- **Legacy ScheduleMaxer identity is client-side.** The S#/PIN comparison and saved admin flag control the UI. Anonymous Firebase auth does not bind the requester to an S#. The rules above allow profile/schedule/post changes without verified ownership, open block/assist deletion, and authenticated reads of profile PIN hashes, schedules, and session data. A local admin unlock is not a server authorization boundary. These limits also mean legacy online/session statistics are approximate, client-reported values.
- **Ownership migration requires an account transition.** Add a verified student sign-in method, assign an immutable owner UID through a trusted migration/account-linking process, then require matching `request.auth.uid` for private reads and writes. Move PIN verifiers out of client-readable documents and put admin access behind a trusted UID/custom claim. Test existing-account linking and rules in the emulator before enforcing them so current users retain access. Firebase documents the [owner-UID rule pattern](https://firebase.google.com/docs/firestore/security/rules-conditions).
- **Phone numbers on posts are visible to site users.** Do not treat posted contact details, schedules, PIN verifiers, or legacy session records as protected by the current UI gates.
- **Local cache only for convenience.** The source of truth for profiles and blocks is Firestore. Your browser just caches your current profile so you don’t re-enter your S# every visit.

## Regression checks

Run `node test/test-parser.js` and `node test/test-site.js` before deploying site changes. They cover schedule parsing/ICS generation, contact HTML escaping, calendar date validation, schedule synchronization, pending account/session operations, and registration races without accessing live user data.
