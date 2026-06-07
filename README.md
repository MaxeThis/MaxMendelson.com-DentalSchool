# UMSOD Block Exchange

A static site for University of Maryland School of Dentistry students to swap blocks. Students register with their name, S# (5 digits, the `S` is added automatically), and phone number, then post blocks they want to give up. Other students can filter and view the calendar and reach out by phone or text.

- Block types: Oral Surgery/Urg Care (BLK-SURGERY, BLK-OS, and BLK-UCARE are treated as one), Ortho, Special Care, Peds, Emergency, On-Call, Screening, Hospital, Pan, Mock Boards, Education/Other. Hospital, Mock Boards, and Education/Other are display/filter-only — they can't be posted for swap
- Labels are self-healing: each axiUm code maps to a canonical name (`SCHEDULE_NAME_MAP`, with hyphen-insensitive + OCR-digit repair so `BLKOS`/`09:OO` still resolve) and each block type folds through `TYPE_ALIASES` to its canonical label. To rename or merge a type, edit those maps in one place — existing posted blocks and imported schedules are rewritten to match the next time their owner (or the admin) loads the app, so no manual database edits are needed
- Mon–Fri, morning + afternoon
- Download an `.ics` of your schedule (deterministic event IDs, so re-importing updates events in place instead of duplicating), or subscribe to a **live** auto-updating calendar feed (optional — deploy the Cloudflare Worker in [`worker/`](worker/README.md))
- Filter the calendar by block type and/or morning/afternoon
- Each student can see and remove their own posted blocks
- Assist board for posting clinic appointments that need an assist (Endo / Fixed / Remo / Operative). Posts go live for everyone at 8 AM the day before — Endo opens 1 week ahead. Times are 7 AM, 9:30 AM, 1 PM (2 PM on Mondays), 4 PM
- Privacy policy included
- PerioMaxer ad slot at the top (linking to the App Store)

Everything is static HTML/CSS/JS — deployable on GitHub Pages. Shared data lives in a free Firebase Firestore database.

## 1. Firebase setup (one time, ~5 minutes)

You need a Firebase project to store the shared blocks. It is free for this use case.

1. Go to <https://console.firebase.google.com/> and click **Add project**. Name it anything (e.g. `umsod-block-exchange`). You can disable Google Analytics.
2. Inside the project, click the **`</>`** (Web) icon to register a web app. Give it a nickname and click **Register**. Firebase will show you a `firebaseConfig` object — copy those values.
3. Open `firebase-config.js` in this repo and paste the values in place of the `REPLACE_ME_*` strings. Commit the change. These values are safe to commit.
4. In the Firebase console, go to **Build → Firestore Database** and click **Create database**. Pick **Start in production mode** and a region close to Maryland (e.g. `us-east4`).
5. Open the **Rules** tab of Firestore, replace everything with the rules below, and click **Publish**:

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
         return t in ['Oral Surgery/Urg Care','Oral Surgery','Urgent Care','Ortho','Special Care','Peds','Emergency','On-Call','Screening','Hospital','Pan','Mock Boards','Education/Other'];
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
         // Combined with App Check this blocks direct REST scraping.
         allow read: if request.auth != null;

         allow create: if sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.keys().hasAll(['sNumber','name','phone','pinHash','createdAt','updatedAt'])
           && request.resource.data.sNumber == sNumber
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone)
           && validPinHash(request.resource.data.pinHash)
           && request.resource.data.createdAt is number
           && request.resource.data.updatedAt is number;

         // Updates may change name/phone/updatedAt only; pinHash + sNumber +
         // createdAt are locked. This prevents account takeover via update.
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
       // Reads require auth; writes are shape-checked to prevent
       // clients from spamming arbitrary data.
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

       // Private site configuration (admin hash). The client reads
       // it while bootstrapping the admin gate; only anon-signed-in
       // users can read it so the hash isn't exposed via view-source.
       // All writes happen manually in the Firebase console.
       match /config/{doc} {
         allow read: if request.auth != null;
         allow write: if false;
       }

       // Client-side error reports so the site owner can diagnose
       // failures without asking users to open DevTools. Read only
       // from the Firebase console; tight schema prevents abuse.
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

Firestore's free tier (Spark plan) has **hard caps** — 50K reads, 20K writes, and 1 GB storage per day. You cannot be charged on this plan; the worst case is the site stops working for the rest of the day. Defenses layered on top of that:

1. **Firebase App Check with reCAPTCHA v3** — the single best defense. It blocks requests that don't come from your real site (curl, bots, automation). Free, no user friction.
   - Firebase console → **Build → App Check**. Register your web app with reCAPTCHA v3, copy the site key.
   - Paste the site key into `firebase-config.js` → `RECAPTCHA_V3_SITE_KEY`.
   - Back in the App Check console, open **Firestore** under APIs and switch enforcement from "Unenforced" to **Enforced**.
   - Add your domains (the GitHub Pages URL and `maxmendelson.com`) under the reCAPTCHA admin console's "Domains" list.
2. **Tight Firestore rules** — every field is type-checked and size-bounded, so a single write can't store a MB of data. See the rules above.
3. **Narrow read query** — the client only subscribes to blocks from today onward, so a huge historical dataset wouldn't amplify reads per user. The Assist board uses the same `date >= today` range query and only subscribes while the Assist tab is open, so reads stay near zero when nobody is actively looking. Old blocks/assists can also be auto-expired: in the Firestore console, open **TTL** and add a policy on `blocks.createdAt` (and `assists.createdAt`) with a long-ish TTL (e.g., 180 days of milliseconds = 180\*24\*60\*60\*1000) if you want automatic cleanup. Or delete old rows manually.
4. **Client-side rate limits** — in `app.js`, each browser tab is capped at 8 sign-in attempts/min and 6 posts/min. Doesn't stop a determined attacker but stops accidental loops.
5. **Budget alerts** — Firebase console → **Usage and billing** → **Details & settings** → **Modify budget**. Set an alert to email you if traffic spikes unusually.

If someone does start abusing the site, deleting the Firestore database and re-creating it with App Check enforced is usually enough to shut it down.

## Notes and trade-offs

- **No real auth.** The site trusts users to enter their own S#. This keeps the site free and one-click. Because the Firestore rules allow any delete, a bad actor could in theory delete others’ blocks — if that ever comes up, adding Firebase Auth (Google sign-in with `@umaryland.edu`) is the right next step.
- **Phone numbers are public** to anyone with the site URL. The privacy policy makes this explicit and the sign-up form requires the user to agree.
- **Local cache only for convenience.** The source of truth for profiles and blocks is Firestore. Your browser just caches your current profile so you don’t re-enter your S# every visit.
