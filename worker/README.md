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
button (which rotates the token and kills the old URL).

It's free: Cloudflare's Workers free plan (100k requests/day) and Firestore's
free tier both comfortably cover this.

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
buttons. Until this is set, that panel shows a "not set up yet" note.

## Test it

After deploying, enable the feed for yourself on the site (which writes your
`calendarToken`), then open the URL it shows — you should get `.ics` text. Or:

```bash
curl "https://<your-worker>.workers.dev/calendar?u=S12345&k=<token>"
```

## Notes

- **Refresh latency** is controlled by the calendar client, not the Worker:
  Apple polls every few hours, Google ~24h. There's no way to force a faster
  push with subscribed calendars.
- **Security:** anyone with the link can read that student's schedule, so it's
  treated like a secret. Resetting the link on the site rotates the token.
- The feed's events use the **same deterministic UIDs** as the downloaded
  `.ics`, so subscribing and downloading won't double up the same blocks.
