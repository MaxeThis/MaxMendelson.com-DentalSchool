# UMSOD Block Exchange

A static site for University of Maryland School of Dentistry students to swap blocks. Students register with their name, S# (5 digits, the `S` is added automatically), and phone number, then post blocks they want to give up. Other students can filter and view the calendar and reach out by phone or text.

- 7 block types: Oral Surgery, Ortho, Special Care, Peds, Emergency, On-Call, Screening
- Mon–Fri, morning + afternoon
- Filter the calendar by block type and/or morning/afternoon
- Each student can see and remove their own posted blocks
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
         return p is string && p.size() >= 10 && p.size() <= 25;
       }
       function validName(n) {
         return n is string && n.size() > 0 && n.size() <= 80;
       }
       function validPinHash(h) {
         // PBKDF2 SHA-256 hex = 64 chars; keep room for versioning.
         return h is string && h.size() >= 32 && h.size() <= 128;
       }
       function validType(t) {
         return t in ['Oral Surgery','Ortho','Special Care','Peds','Emergency','On-Call','Screening'];
       }
       function validTime(t) {
         return t == 'morning' || t == 'afternoon';
       }
       function validDate(d) {
         return d is string && d.matches('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
       }

       // User profiles, one doc per S#.
       match /users/{sNumber} {
         // Anyone can read a profile. The PIN is stored only as a PBKDF2
         // hash so it isn't recoverable from a read. Still, the hash is
         // readable — rely on App Check + a PIN of reasonable length.
         allow read: if true;

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
         allow read: if true;

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

         // Updates limited to contact fields; identity + date/time/type/createdAt stay put.
         allow update: if request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.date == resource.data.date
           && request.resource.data.time == resource.data.time
           && request.resource.data.type == resource.data.type
           && request.resource.data.createdAt == resource.data.createdAt
           && validName(request.resource.data.name)
           && validPhone(request.resource.data.phone);

         // Delete is open (UI only exposes it on your own blocks). If abuse
         // shows up, add Firebase Auth and tighten this.
         allow delete: if true;
       }
     }
   }
   ```
6. (Optional but recommended) In **Build → Authentication → Settings → Authorized domains**, add `maxmendelson.com` and your GitHub Pages URL (e.g. `maxethis.github.io`). This isn’t strictly required for Firestore but it helps if you add auth later.

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

1. In GoDaddy / wherever your DNS lives, add these records:
   - `A` `@` → `185.199.108.153`
   - `A` `@` → `185.199.109.153`
   - `A` `@` → `185.199.110.153`
   - `A` `@` → `185.199.111.153`
   - `CNAME` `www` → `<your-github-username>.github.io`
2. The `CNAME` file in this repo is already set to `maxmendelson.com`. If you want a subdomain instead (e.g. `blocks.maxmendelson.com`), edit that file.
3. In GitHub **Settings → Pages**, enter `maxmendelson.com` as the custom domain and wait for the TLS cert to provision (can take up to ~20 minutes). Turn on **Enforce HTTPS** once it’s available.

## 4. PerioMaxer ad link

Open `index.html` and search for `apps.apple.com/app/periomaxer`. Replace that URL with the real App Store URL for PerioMaxer.

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
3. **Narrow read query** — the client only subscribes to blocks from today onward, so a huge historical dataset wouldn't amplify reads per user. Old blocks can also be auto-expired: in the Firestore console, open **TTL** and add a policy on `blocks.createdAt` with a long-ish TTL (e.g., 180 days of milliseconds = 180\*24\*60\*60\*1000) if you want automatic cleanup. Or delete old rows manually.
4. **Client-side rate limits** — in `app.js`, each browser tab is capped at 8 sign-in attempts/min and 6 posts/min. Doesn't stop a determined attacker but stops accidental loops.
5. **Budget alerts** — Firebase console → **Usage and billing** → **Details & settings** → **Modify budget**. Set an alert to email you if traffic spikes unusually.

If someone does start abusing the site, deleting the Firestore database and re-creating it with App Check enforced is usually enough to shut it down.

## Notes and trade-offs

- **No real auth.** The site trusts users to enter their own S#. This keeps the site free and one-click. Because the Firestore rules allow any delete, a bad actor could in theory delete others’ blocks — if that ever comes up, adding Firebase Auth (Google sign-in with `@umaryland.edu`) is the right next step.
- **Phone numbers are public** to anyone with the site URL. The privacy policy makes this explicit and the sign-up form requires the user to agree.
- **Local cache only for convenience.** The source of truth for profiles and blocks is Firestore. Your browser just caches your current profile so you don’t re-enter your S# every visit.
