# Baser usage analytics

Baser stores one record per usage session in `baserUsageSessions`, separate from ScheduleMaxer profiles. A named Firebase app uses anonymous Authentication so its random browser identifier is not the ScheduleMaxer login or student number. Unique visitors are approximate: clearing browser storage or using another browser creates another identifier.

Each record contains only:

- Schema version, random visitor ID, random session document ID, and server timestamps.
- Foreground activity duration, capped at 24 hours per session.
- Counts of successful/failed imports, export attempts/successes/failures, applying text, and changing filler patterns.

The client sends no model contents, model metadata, filenames, label text, student numbers, names, email addresses, URLs, or device information. Firestore rules enforce the exact field allowlist and reject all additional fields. No models are uploaded by this feature. Counters are cumulative, bounded, and monotonic. As with any client-reported analytics, these are usage estimates and can be affected by blocked requests, offline browsers, or modified clients.

Analytics reads require Firebase Authentication with the verified owner email `maxethis@gmail.com`, checked by Firestore rules. The admin panel sends a sign-in link only when the owner clicks its sign-in button. Following that link verifies mailbox ownership. Verified Google sign-in is also accepted by the rules if that provider is configured later. The existing admin panel password only opens the panel; it does not grant access to these records. Admin Authentication uses a separate named Firebase app so signing in does not replace the site's anonymous session.

## Deployment

`firestore.rules` includes the previous live ScheduleMaxer rules plus a clearly marked Baser section. The only other change adds the existing app block types Perio, Clerkship, and Shady Grove to the accepted enum. Do not replace unrelated existing rules with the older README example. The deployment helper permits only these three enum additions and the analytics section; it refuses to deploy when unrelated live rules differ from the checked-in copy. It reads rule configuration only, never user records.

Prerequisites: Node 18+, Firebase CLI (`firebase login`), Java for the local emulator. Email-link authentication is configured with the supported Identity Platform configuration API. The helper below enables email sign-in and passwordless links while verifying all other authentication settings are preserved. It never sends email or creates users. Anonymous sign-in and the production domains must remain enabled.

```sh
node tools/analytics-auth.mjs check
node tools/analytics-auth.mjs enable-email-link
```

Firebase email-link authentication also enables email/password authentication; server rules still require the verified owner's exact email. Unverified accounts and other verified email addresses cannot read usage. Firebase's no-cost Spark plan currently allows five sign-in emails per day; a remembered admin session avoids requesting a new email for each visit. No billing plan changes are required for this setup. See [email-link authentication](https://firebase.google.com/docs/auth/web/email-link-auth) and [Firebase Auth limits](https://firebase.google.com/docs/auth/limits).

Run the privacy and permissions tests:

```sh
FIREBASE_EMULATORS_PATH=/tmp/baser-firebase-emulators CI=1 firebase emulators:exec \
  --only firestore --project demo-baser-analytics --config firebase.analytics.json \
  'node test/test-analytics-rules.mjs'
```

The test script refuses to run without a local emulator address and uses only a demo project. It tests allowed session writes, owner reads and date queries, denied public/anonymous reads, visitor isolation, forbidden content fields, immutable session identity, server timestamps, and bounded counters.

Review and deploy:

```sh
node tools/analytics-rules.mjs check
node tools/analytics-rules.mjs deploy
```

The helper compiles the updated source, checks that the live release has not changed, publishes it, and verifies the release. It prints the previous ruleset name for rollback. It uses the existing Firebase CLI login without printing credentials. If Firebase Tools is not installed globally, set `FIREBASE_TOOLS_PATH` to its package directory.

The admin dashboard queries the `startedAt` field, which uses Firestore's default single-field index; no composite index or Cloudflare Worker deployment is required. Historical Baser usage before this feature cannot be reconstructed.
