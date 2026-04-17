// Firebase configuration for the UMSOD Block Exchange.
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
  apiKey: "REPLACE_ME_API_KEY",
  authDomain: "REPLACE_ME_PROJECT_ID.firebaseapp.com",
  projectId: "REPLACE_ME_PROJECT_ID",
  storageBucket: "REPLACE_ME_PROJECT_ID.appspot.com",
  messagingSenderId: "REPLACE_ME_SENDER_ID",
  appId: "REPLACE_ME_APP_ID",
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
window.RECAPTCHA_V3_SITE_KEY = "";
