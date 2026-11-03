import { summarizeLinks } from './link-metrics.js';

// Admin → Link clicks. Shares the owner sign-in with Baser usage (same named
// Firebase app), so signing in on either tab unlocks both.
const $ = (id) => document.getElementById(id);
const OWNER_EMAIL = 'maxethis@gmail.com';
const PAGES = { links: '/links/', housemaxer: '/links/housemaxer/' };
let app;
let auth;
let store;
let labels;
let generation = 0;
let initialized = false;

function status(message) { $('link-usage-status').textContent = message; }
function isOwner(user) {
  return !!user && user.emailVerified && user.email === OWNER_EMAIL && user.providerData.some((provider) => ['google.com', 'password'].includes(provider.providerId));
}
function clear() {
  for (const element of document.querySelectorAll('[data-link-metric]')) element.textContent = '—';
  for (const id of ['link-usage-links', 'link-usage-pages', 'link-usage-sources', 'link-usage-devices', 'link-usage-daily']) $(id).replaceChildren();
  $('link-usage-empty').hidden = true;
}

function initialize() {
  if (initialized) return;
  initialized = true;
  // Baser usage creates the shared app and activates App Check once; reuse it.
  window.BaserAdminAnalytics?.enter();
  app = firebase.apps.find((item) => item.name === 'baser-admin');
  if (!app) {
    app = firebase.initializeApp(window.FIREBASE_CONFIG, 'baser-admin');
    if (window.RECAPTCHA_V3_SITE_KEY) app.appCheck().activate(window.RECAPTCHA_V3_SITE_KEY, true);
  }
  auth = app.auth();
  store = app.firestore();
  $('link-usage-signin').addEventListener('click', async () => {
    const button = $('link-usage-signin');
    button.disabled = true;
    try {
      await auth.sendSignInLinkToEmail(OWNER_EMAIL, { url: new URL('./?baserUsage=1', location.href).href, handleCodeInApp: true });
      status('Sign-in link sent to the owner’s email. Open it in this browser, then come back to Link clicks.');
    } catch {
      status('Could not send the sign-in link. Please try again.');
    } finally { button.disabled = false; }
  });
  $('link-usage-days').addEventListener('change', () => void refresh());
  auth.onAuthStateChanged((user) => {
    generation++;
    clear();
    $('link-usage-signin').hidden = isOwner(user);
    if (isOwner(user)) void refresh();
    else status('Verify the owner’s email to view link clicks.');
  });
}

// Link names come from the live pages themselves, so they never drift.
async function loadLabels() {
  if (labels) return labels;
  labels = {};
  await Promise.all(Object.entries(PAGES).map(async ([page, path]) => {
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(path)).text(), 'text/html');
      for (const a of doc.querySelectorAll('a[data-link]')) {
        labels[`${page}:${a.dataset.link}`] = (a.querySelector('.title')?.firstChild?.textContent || a.textContent).trim();
      }
    } catch {}
  }));
  return labels;
}

async function refresh() {
  initialize();
  if (!isOwner(auth.currentUser)) return;
  const current = ++generation;
  const days = Number($('link-usage-days').value) || 30;
  const now = Date.now();
  const start = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z') - (days - 1) * 86400000;
  status('Loading link clicks…');
  clear();
  try {
    const events = [];
    let cursor;
    // Explicitly paginate; never silently truncate counts at a query limit.
    while (current === generation) {
      let query = store.collection('linkEvents')
        .where('at', '>=', firebase.firestore.Timestamp.fromMillis(start))
        .orderBy('at', 'asc').limit(500);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (current !== generation) return;
      page.forEach((doc) => events.push(doc.data()));
      if (page.size < 500) break;
      cursor = page.docs[page.docs.length - 1];
    }
    const names = await loadLabels();
    if (current !== generation || !isOwner(auth.currentUser)) return;
    render(summarizeLinks(events, days, now), names);
    status('Updated ' + new Date().toLocaleTimeString() + ' · dates in UTC');
  } catch (error) {
    if (current !== generation) return;
    status(error.code === 'permission-denied' ? 'Access denied. Verify the site owner’s email.' : 'Could not load link clicks. Check your connection and refresh.');
  }
}

function rows(id, items) {
  const body = $(id);
  for (const values of items) {
    const row = document.createElement('tr');
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? value.toLocaleString() : value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
}

function render(summary, names) {
  const pageName = { links: 'Links', housemaxer: 'HouseMaxer' };
  const metrics = {
    opens: summary.opens, visitors: summary.visitors, clicks: summary.clicks,
    rate: summary.opens ? Math.round(100 * summary.clicks / summary.opens) + '%' : '—',
  };
  for (const element of document.querySelectorAll('[data-link-metric]')) {
    const value = metrics[element.dataset.linkMetric];
    element.textContent = typeof value === 'number' ? value.toLocaleString() : value ?? '—';
  }
  $('link-usage-empty').hidden = summary.opens + summary.clicks !== 0;
  rows('link-usage-links', summary.links.map((l) => [names[`${l.page}:${l.link}`] || l.link, pageName[l.page] || l.page, l.clicks, l.visitors]));
  rows('link-usage-pages', summary.pages.map((p) => [pageName[p.page] || p.page, p.opens, p.visitors]));
  rows('link-usage-sources', summary.sources.map((s) => [s.name, s.count]));
  rows('link-usage-devices', summary.devices.map((d) => [d.name, d.count]));
  rows('link-usage-daily', [...summary.daily].reverse().filter((d) => d.opens || d.clicks).map((d) => [d.date, d.opens, d.clicks]));
}

window.LinkAdminAnalytics = {
  enter() { try { initialize(); } catch { status('Link tools could not start. Refresh the page to try again.'); } },
  refresh,
};
