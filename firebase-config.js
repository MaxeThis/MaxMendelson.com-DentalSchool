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
