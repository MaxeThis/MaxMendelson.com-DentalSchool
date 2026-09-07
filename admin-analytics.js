import { summarizeUsage } from './usage-metrics.js';

const $ = (id) => document.getElementById(id);
const OWNER_EMAIL = 'maxethis@gmail.com';
let app;
let auth;
let store;
let generation = 0;
let authAttempt = 0;
let initialized = false;

function status(message) { $('baser-usage-status').textContent = message; }
function clearMetrics() {
  for (const element of document.querySelectorAll('[data-usage-metric]')) element.textContent = '—';
  $('baser-usage-daily').replaceChildren();
  $('baser-usage-chart').replaceChildren();
  $('baser-usage-empty').hidden = true;
}

function isOwner(user) {
  return !!user && user.emailVerified && user.email === OWNER_EMAIL && user.providerData.some((provider) => ['google.com', 'password'].includes(provider.providerId));
}

async function signOutUsage() {
  authAttempt++;
  generation++;
  clearMetrics();
  if (auth) await auth.signOut().catch(() => status('Could not sign out. Please try again.'));
}

function initialize() {
  if (initialized) return;
  initialized = true;
  app = firebase.apps.find((item) => item.name === 'baser-admin') || firebase.initializeApp(window.FIREBASE_CONFIG, 'baser-admin');
  if (window.RECAPTCHA_V3_SITE_KEY) app.appCheck().activate(window.RECAPTCHA_V3_SITE_KEY, true);
  auth = app.auth();
  store = app.firestore();
  $('baser-usage-signin').addEventListener('click', async () => {
    const button = $('baser-usage-signin');
    button.disabled = true;
    try {
      await auth.sendSignInLinkToEmail(OWNER_EMAIL, {
        url: new URL('./?baserUsage=1', location.href).href,
        handleCodeInApp: true,
      });
      status('Sign-in link sent to the owner’s email. Open it in this browser, then return to Baser usage.');
    } catch (error) {
      status(error.code === 'auth/too-many-requests' || error.code === 'auth/quota-exceeded' ?
        'The sign-in email limit has been reached. Use an existing signed-in browser or try again later.' :
        'Could not send the sign-in link. Please try again.');
    } finally { button.disabled = false; }
  });
  $('baser-usage-signout').addEventListener('click', () => { void signOutUsage(); });
  $('baser-usage-days').addEventListener('change', () => void refresh());
  auth.onAuthStateChanged((user) => {
    generation++;
    clearMetrics();
    const owner = isOwner(user);
    $('baser-usage-signin').hidden = owner;
    $('baser-usage-signout').hidden = !owner;
    if (owner) void refresh();
    else status('Verify the owner’s email to view private usage counts.');
  });
  const signInLink = window.BASER_USAGE_SIGNIN_LINK;
  delete window.BASER_USAGE_SIGNIN_LINK;
  if (signInLink && auth.isSignInWithEmailLink(signInLink)) {
    const attempt = ++authAttempt;
    status('Verifying the sign-in link…');
    void auth.signInWithEmailLink(OWNER_EMAIL, signInLink).then(async () => {
      // Forgetting admin access while verification is pending must stay signed out.
      if (attempt !== authAttempt) { await auth.signOut(); return; }
      window.dispatchEvent(new Event('baser-usage-signed-in'));
    }).catch(() => {
      if (attempt !== authAttempt) return;
      status('This sign-in link expired or was already used. Request a new link.');
      if (typeof window.toast === 'function') window.toast('Usage sign-in link expired. Request another from Admin → Baser usage.');
    });
  }
}

async function refresh() {
  initialize();
  if (!isOwner(auth.currentUser)) return;
  const current = ++generation;
  const days = Number($('baser-usage-days').value) || 30;
  const now = Date.now();
  const start = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z') - (days - 1) * 86400000;
  status('Loading usage…');
  clearMetrics();
  try {
    const sessions = [];
    let cursor;
    // Explicitly paginate; never silently truncate counts at a query limit.
    while (current === generation) {
      let query = store.collection('baserUsageSessions')
        .where('startedAt', '>=', firebase.firestore.Timestamp.fromMillis(start))
        .orderBy('startedAt', 'asc').limit(500);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (current !== generation) return;
      page.forEach((doc) => sessions.push(doc.data()));
      if (page.size < 500) break;
      cursor = page.docs[page.docs.length - 1];
    }
    if (current !== generation || !isOwner(auth.currentUser)) return;
    render(summarizeUsage(sessions, days, now));
    status('Updated ' + new Date().toLocaleTimeString() + ' · dates in UTC');
  } catch (error) {
    if (current !== generation) return;
    status(error.code === 'permission-denied' ? 'Usage access denied. Verify the site owner’s email.' : 'Could not load usage. Check your connection and refresh.');
  }
}

function render(summary) {
  const counts = summary.counts;
  const settled = counts.export_success + counts.export_error;
  const metrics = {
    visitors: summary.visitors.toLocaleString(), sessions: summary.sessions.toLocaleString(),
    exports: counts.export_success.toLocaleString(), online: summary.online.toLocaleString(),
    returning: summary.returningVisitors.toLocaleString(),
    frequency: summary.visitors ? (summary.sessions / summary.visitors).toFixed(1) : '0',
    active: Math.round(summary.activeSeconds / 60).toLocaleString() + ' min',
    success: settled ? Math.round(100 * counts.export_success / settled) + '%' : '—',
    imports: counts.import_success.toLocaleString(), importErrors: counts.import_error.toLocaleString(),
    attempts: counts.export_started.toLocaleString(), exportErrors: counts.export_error.toLocaleString(),
    text: counts.text_applied.toLocaleString(), patterns: counts.pattern_changed.toLocaleString(),
  };
  for (const element of document.querySelectorAll('[data-usage-metric]')) element.textContent = metrics[element.dataset.usageMetric] ?? '—';
  $('baser-usage-empty').hidden = summary.sessions !== 0;
  const chart = $('baser-usage-chart');
  const max = Math.max(1, ...summary.daily.map((day) => Math.max(day.sessions, day.exports)));
  chart.setAttribute('aria-label', 'Daily sessions and exports. Exact counts are in the table below.');
  for (const day of summary.daily) {
    const pair = document.createElement('div');
    pair.className = 'usage-chart-day';
    pair.title = `${day.date}: ${day.sessions} sessions, ${day.exports} exports`;
    for (const [key, label] of [['sessions', 'sessions'], ['exports', 'exports']]) {
      const bar = document.createElement('span');
      bar.className = 'usage-bar usage-bar-' + key;
      bar.style.height = Math.max(day[key] ? 3 : 0, day[key] / max * 100) + '%';
      bar.setAttribute('aria-hidden', 'true');
      pair.appendChild(bar);
    }
    chart.appendChild(pair);
  }
  const body = $('baser-usage-daily');
  for (const day of [...summary.daily].reverse()) {
    const row = document.createElement('tr');
    for (const value of [day.date, day.visitors, day.sessions, day.exports]) {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? value.toLocaleString() : value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
}

window.BaserAdminAnalytics = {
  enter() { try { initialize(); } catch { status('Usage tools could not start. Refresh the page to try again.'); } },
  refresh,
  signOut: signOutUsage,
};
window.dispatchEvent(new Event('baser-admin-ready'));
if (window.BASER_USAGE_SIGNIN_LINK) window.BaserAdminAnalytics.enter();
