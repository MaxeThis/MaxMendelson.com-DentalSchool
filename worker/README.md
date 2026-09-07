# Live calendar feed (Cloudflare Worker)

Serves each student's block schedule as a **live** `text/calendar` feed so they
can *subscribe* once and have their calendar auto-update, instead of
re-downloading an `.ics` every time.

```
GET https://<your-worker>.workers.dev/calendar?u=S12345&k=<token>[&reminder=HH:MM]
```

The Worker reads `users/{u}.schedule` from Firestore with a Google **service
account** (server-to-server, so it bypasses security rules and App Check) and
gates access on the per-user `calendarToken` the site writes to the user doc.
The site shows each student their personal subscribe link and a "reset link"
button (which rotates the token and rejects the old URL on subsequent requests).

This service is optional and stays disabled while `CALENDAR_FEED_BASE` is
empty. Check your Cloudflare and Firebase plans/quotas before enabling it.

## One-time setup

You need [Node.js](https://nodejs.org) and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

### 1. Create a Firebase service account key

1. [Firebase console](https://console.firebase.google.com/) → your project →
   **Project settings** (gear) → **Service accounts**.
2. Click **Generate new private key** → it downloads a JSON file containing
   `client_email` and `private_key`. Keep it secret (don't commit it).

### 2. Install Wrangler and log in

```bash
cd worker
npm install -g wrangler
wrangler login
```

### 3. Set the secrets

`GCP_PROJECT_ID` is already in `wrangler.toml`. Set the two sensitive values
from the service-account JSON:

```bash
wrangler secret put GCP_CLIENT_EMAIL
# paste the "client_email" value, press Enter

# Pipe the private key straight from the JSON so the multi-line PEM is preserved:
node -e "process.stdout.write(require('./service-account.json').private_key)" | wrangler secret put GCP_PRIVATE_KEY
```

(Replace `./service-account.json` with the path to the file you downloaded. If
you'd rather paste it by hand, the Worker also accepts a single-line key with
literal `\n` escapes.)

### 4. Deploy

```bash
wrangler deploy
```

Wrangler prints your URL, e.g. `https://umsod-calendar.<your-subdomain>.workers.dev`.

### 5. Point the site at the Worker

In **`firebase-config.js`** set:

```js
window.CALENDAR_FEED_BASE = "https://umsod-calendar.<your-subdomain>.workers.dev";
```

Commit and push. The "Live calendar subscription" panel under **My Blocks →
Edit schedule** now shows each student their subscribe link and Apple/Google
buttons. Until this is set, that panel stays hidden.

## Test it

Run `node test/test-calendar-worker.js` from the repository root for local
regressions covering authorization responses, token rotation, cache headers,
malformed schedule entries, and ICS property escaping. These tests mock
upstream services and do not deploy the Worker or access real schedules.

After deploying, enable the feed for yourself on the site (which writes your
`calendarToken`), then open the URL it shows — you should get `.ics` text. Or:

```bash
curl "https://<your-worker>.workers.dev/calendar?u=S12345&k=<token>"
```

## Notes

- **Refresh latency** is controlled by the calendar client. Calendar changes
  appear after the client's next poll; this feed does not push updates.
- **Security:** anyone with the link can read that student's schedule, so it's
  treated like a secret. Resetting the link rotates the token. Responses use
  `Cache-Control: private, no-store` so shared caches should not serve old
  content after rotation. A calendar client can retain events already read.
- **Legacy Firestore access:** the link token itself lives in a user document
  that the legacy ScheduleMaxer rules make readable to anonymous Firebase
  sessions. Enable this feed only after private profile/token reads are
  restricted using verified ownership; the bearer URL alone does not fix that
  separate access path. Use a read-only service account for the Worker.
- The feed's events use the **same deterministic UIDs** as the downloaded
  `.ics`, so subscribing and downloading won't double up the same blocks.
