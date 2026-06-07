// Firebase configuration for ScheduleMaxer.
//
// 1. Go to https://console.firebase.google.com/ and create a new project (free).
// 2. Add a Web app (the </> icon). Copy the config snippet it shows you.
// 3. Paste the values below, replacing the REPLACE_ME_ strings.
// 4. In the Firebase console, open "Build → Firestore Database" and click
//    "Create database" → Start in production mode. Pick a region close to you.
// 5. Open the "Rules" tab and paste the rules from README.md, then Publish.
//
// The values below are PUBLIC by design — it's fine to commit them. Security
// is enforced by your Firestore rules, not by hiding these keys.

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyDnNw8OLwcDEhGr0cWPiB5ld-zcA-u54Qk",
  authDomain: "maxmendelson-com-dental-school.firebaseapp.com",
  projectId: "maxmendelson-com-dental-school",
  storageBucket: "maxmendelson-com-dental-school.firebasestorage.app",
  messagingSenderId: "44601534820",
  appId: "1:44601534820:web:42febc109238a799b5b271",
};

// OPTIONAL but STRONGLY RECOMMENDED: Firebase App Check + reCAPTCHA v3.
// This blocks bots/curl/scripts from writing to your Firestore and is the
// best defense against spam burning through the free-tier quota.
//
// Set up once:
//   1. In the Firebase console → Build → App Check → register your web app,
//      pick "reCAPTCHA v3", and accept the default. Copy the site key it gives.
//   2. Paste that key below in place of the empty string.
//   3. Back in the App Check console, open each service (Firestore in our
//      case) and switch enforcement to "Enforced".
// Leaving this blank disables App Check (site still works).
window.RECAPTCHA_V3_SITE_KEY = "6LchQr4sAAAAAL34gOfS1b-kr2tPPb7GlK5wJ6Ap";

// OPTIONAL: live calendar subscription feed (Cloudflare Worker — see
// worker/README.md). Set this to your deployed Worker's base URL to enable the
// "Live calendar subscription" panel under My Blocks → Edit schedule. Leave it
// blank to hide that panel and keep only the .ics download.
//   e.g. "https://umsod-calendar.your-subdomain.workers.dev"
window.CALENDAR_FEED_BASE = "";
