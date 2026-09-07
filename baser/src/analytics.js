import { USAGE_EVENTS, emptyUsageCounts } from '../../usage-metrics.js';

const PREFERENCE_KEY = 'baser-anonymous-usage-v1';
const IDLE_MS = 30 * 60 * 1000;
const ACTIVE_MS = 2 * 60 * 1000;
const allowedEvents = new Set(USAGE_EVENTS);

// Dependency-injected core is tested without Firebase or any model data.
export function createUsageTracker({ write, now = Date.now, uuid = () => crypto.randomUUID(), initiallyEnabled = true }) {
  let enabled = initiallyEnabled;
  let session = null;
  let lastInteraction = now();
  let lastTick = now();
  let writing = null;
  const pending = new Set();
  function freshSession() {
    session = { id: uuid(), began: now(), counts: emptyUsageCounts(), activeSeconds: 0, saved: null };
    pending.add(session);
    // Never retain an unbounded offline history.
    if (pending.size > 3) pending.delete(pending.values().next().value);
    return session;
  }
  function interact() {
    if (!enabled) return;
    if (!session || now() - lastInteraction >= IDLE_MS || now() - session.began >= 86400000) freshSession();
    lastInteraction = now();
  }
  function tick(visible = true) {
    const current = now();
    const elapsed = Math.min(30, Math.max(0, (current - lastTick) / 1000));
    if (enabled && visible && session && current - lastInteraction < ACTIVE_MS) {
      session.activeSeconds = Math.min(86400, session.activeSeconds + elapsed);
    }
    lastTick = current;
  }
  function track(name) {
    if (!enabled || !allowedEvents.has(name)) return false;
    interact();
    if (session.counts[name] >= 10000) freshSession();
    session.counts[name]++;
    return true;
  }
  let flushAgain = false;
  async function flush() {
    if (!enabled) return;
    if (writing) { flushAgain = true; return writing; }
    flushAgain = false;
    let failed = false;
    writing = (async () => {
      for (const item of pending) {
        if (!enabled) break;
        const saved = item.saved || { ...emptyUsageCounts(), activeSeconds: 0 };
        const payload = { activeSeconds: Math.min(Math.floor(item.activeSeconds), saved.activeSeconds + 120) };
        for (const name of USAGE_EVENTS) payload[name] = Math.min(item.counts[name], saved[name] + 100);
        if (item.saved && Object.keys(payload).every((key) => payload[key] === saved[key])) continue;
        try {
          await write(item.id, payload, !item.saved);
          item.saved = payload;
          if (item !== session && item.activeSeconds < payload.activeSeconds + 1 && USAGE_EVENTS.every((name) => payload[name] === item.counts[name])) pending.delete(item);
        } catch {
          // Best effort. Buffered counts retry on a later tick; never interrupt CAD.
          failed = true;
          break;
        }
      }
    })();
    try { await writing; } finally { writing = null; }
    if (flushAgain && !failed && enabled) await flush();
  }
  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) { pending.clear(); session = null; }
    else { lastTick = now(); interact(); }
  }
  interact();
  return { track, interact, tick, flush, setEnabled };
}

let tracker;
let initialized = false;
let enabled = false;
let backendPromise;
let firebaseDB;
let firebaseUser;
let firebaseAPI;
let sessionPreference = null;

function preferenceAllowed() {
  if (navigator.globalPrivacyControl || navigator.doNotTrack === '1' || window.doNotTrack === '1') return false;
  if (sessionPreference !== null) return sessionPreference;
  try { return localStorage.getItem(PREFERENCE_KEY) !== 'off'; } catch { return true; }
}

async function connect() {
  if (firebaseDB) return;
  if (!backendPromise) backendPromise = (async () => {
    await import('../../firebase-config.js');
    const root = 'https://www.gstatic.com/firebasejs/10.12.2/';
    const [appAPI, authAPI, storeAPI] = await Promise.all([
      import(root + 'firebase-app.js'), import(root + 'firebase-auth.js'), import(root + 'firebase-firestore.js'),
    ]);
    if (!enabled) return;
    const app = appAPI.getApps().find((a) => a.name === 'baser-usage') || appAPI.initializeApp(window.FIREBASE_CONFIG, 'baser-usage');
    if (window.RECAPTCHA_V3_SITE_KEY) {
      const check = await import(root + 'firebase-app-check.js');
      // Only initialized once; retries reuse the same app and App Check provider.
      try { check.initializeAppCheck(app, { provider: new check.ReCaptchaV3Provider(window.RECAPTCHA_V3_SITE_KEY), isTokenAutoRefreshEnabled: true }); }
      catch (error) { if (error.code !== 'appCheck/already-initialized') throw error; }
    }
    const auth = authAPI.getAuth(app);
    await auth.authStateReady();
    firebaseUser = auth.currentUser || (await authAPI.signInAnonymously(auth)).user;
    firebaseAPI = storeAPI;
    firebaseDB = storeAPI.getFirestore(app);
  })().finally(() => { backendPromise = null; });
  return backendPromise;
}

export function initUsageAnalytics() {
  if (initialized) return;
  initialized = true;
  const isProduction = /^(www\.)?maxmendelson\.com$/.test(location.hostname) || location.hostname === 'maxethis.github.io';
  enabled = isProduction && preferenceAllowed();
  tracker = createUsageTracker({ initiallyEnabled: enabled, write: async (id, counts, create) => {
    if (!enabled) return;
    await connect();
    if (!enabled || !firebaseDB) return;
    const { doc, setDoc, updateDoc, serverTimestamp } = firebaseAPI;
    const ref = doc(firebaseDB, 'baserUsageSessions', id);
    const data = { ...counts, lastActiveAt: serverTimestamp() };
    if (create) await setDoc(ref, { ...data, schemaVersion: 1, visitorId: firebaseUser.uid, startedAt: serverTimestamp() });
    else await updateDoc(ref, data);
  } });
  tracker.setEnabled(enabled);
  window.addEventListener('storage', (event) => {
    if (event.key !== PREFERENCE_KEY && event.key !== null) return;
    sessionPreference = null;
    enabled = isProduction && preferenceAllowed();
    tracker.setEnabled(enabled);
    if (checkbox) checkbox.checked = preferenceAllowed();
    if (enabled) void tracker.flush();
  });
  const checkbox = document.getElementById('usage-analytics-enabled');
  if (checkbox) {
    checkbox.checked = preferenceAllowed();
    const browserOptOut = navigator.globalPrivacyControl || navigator.doNotTrack === '1' || window.doNotTrack === '1';
    checkbox.disabled = !!browserOptOut;
    if (browserOptOut) checkbox.title = 'Your browser privacy preference has disabled usage counts.';
    checkbox.addEventListener('change', () => {
      // The choice applies immediately even when private browsing blocks storage.
      sessionPreference = checkbox.checked;
      try { localStorage.setItem(PREFERENCE_KEY, checkbox.checked ? 'on' : 'off'); } catch { /* private browsing */ }
      enabled = isProduction && preferenceAllowed();
      tracker.setEnabled(enabled);
      if (enabled) void tracker.flush();
    });
  }
  let lastActivityNotice = 0;
  const activity = () => {
    if (Date.now() - lastActivityNotice < 1000) return;
    lastActivityNotice = Date.now();
    tracker.interact();
  };
  for (const event of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(event, activity, { passive: true });
  let ticks = 0;
  setInterval(() => {
    tracker.tick(document.visibilityState === 'visible');
    if (++ticks % 4 === 0 && document.visibilityState === 'visible') void tracker.flush();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    // Count only the interval that ended in the foreground.
    tracker.tick(document.visibilityState === 'hidden');
    void tracker.flush();
  });
  window.addEventListener('pagehide', () => { tracker.tick(document.visibilityState === 'visible'); void tracker.flush(); });
  void tracker.flush();
}

export function trackUsage(eventName) {
  if (tracker?.track(eventName)) void tracker.flush();
}
