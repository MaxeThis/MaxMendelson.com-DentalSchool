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

       // User profiles, one doc per S#.
       match /users/{sNumber} {
         // Anyone can read a profile (so contact info can show on blocks).
         allow read: if true;

         // Create: only when the doc id matches a valid S# and the body is well-formed.
         allow create: if sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.sNumber == sNumber
           && request.resource.data.name is string
           && request.resource.data.name.size() > 0
           && request.resource.data.phone is string
           && request.resource.data.phone.size() >= 10;

         // Update: allow name/phone edits; keep sNumber stable.
         allow update: if sNumber.matches('^S[0-9]{5}$')
           && request.resource.data.sNumber == sNumber
           && request.resource.data.name is string
           && request.resource.data.name.size() > 0
           && request.resource.data.phone is string
           && request.resource.data.phone.size() >= 10;

         allow delete: if false;
       }

       // Posted blocks.
       match /blocks/{blockId} {
         // Anyone can read the blocks (it's a shared exchange).
         allow read: if true;

         // Anyone can create a block as long as required fields are present
         // and well-formed. This is a low-stakes school tool, so we don't
         // run full auth — we just require sane data.
         allow create: if request.resource.data.keys().hasAll(
             ['date','time','type','name','sNumber','phone']
           )
           && request.resource.data.sNumber is string
           && request.resource.data.sNumber.matches('^S[0-9]{5}$')
           && (request.resource.data.time == 'morning' || request.resource.data.time == 'afternoon');

         // Allow updating only the contact fields (name/phone) so profile
         // edits propagate to already-posted blocks. Everything else is
         // locked to its original value.
         allow update: if request.resource.data.sNumber == resource.data.sNumber
           && request.resource.data.date == resource.data.date
           && request.resource.data.time == resource.data.time
           && request.resource.data.type == resource.data.type
           && request.resource.data.createdAt == resource.data.createdAt;

         // Allow anyone to delete — the UI only exposes delete on your own
         // blocks, but we can't verify that without auth. If abuse becomes a
         // problem, add Firebase Auth and tighten this rule.
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

- The user enters their 5-digit S# only.
- If a profile already exists in Firestore for that S#, they go straight into the app.
- If not, they’re prompted once for name + phone + privacy-policy agreement, and a profile is created under `users/S#####`.
- The S# + profile are cached in `localStorage` so they stay signed in on that device.
- The **Account** tab in the top bar lets them edit their name or phone (changes propagate to their existing posted blocks) and sign out.

## Notes and trade-offs

- **No real auth.** The site trusts users to enter their own S#. This keeps the site free and one-click. Because the Firestore rules allow any delete, a bad actor could in theory delete others’ blocks — if that ever comes up, adding Firebase Auth (Google sign-in with `@umaryland.edu`) is the right next step.
- **Phone numbers are public** to anyone with the site URL. The privacy policy makes this explicit and the sign-up form requires the user to agree.
- **Local cache only for convenience.** The source of truth for profiles and blocks is Firestore. Your browser just caches your current profile so you don’t re-enter your S# every visit.
