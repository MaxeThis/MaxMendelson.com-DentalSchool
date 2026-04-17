/* UMSOD Block Exchange — client logic.
 * Profiles live in Firestore (users/{sNumber}) so any device can sign in
 * with just an S#. Blocks live in Firestore (blocks/*) and are visible to
 * all signed-in users. A local cache of the current profile speeds things up. */

const BLOCK_TYPES = [
  'Oral Surgery',
  'Ortho',
  'Special Care',
  'Peds',
  'Emergency',
  'On-Call',
  'Screening',
];

const PROFILE_KEY = 'umsod_be_profile_v1';

const state = {
  profile: null,        // { name, sNumber, phone }
  pendingSNumber: null, // set while we're showing the "complete profile" form
  blocks: [],
  filterType: '',
  filterTime: '',
  calMonth: null,
  selectedDate: null,
  view: 'calendar',
  firestoreReady: false,
};

let db = null;
let blocksUnsub = null;

/* Simple per-session rate limiter. Prevents accidental rapid-fire and
 * makes casual abuse annoying. Server-side protection is Firestore rules
 * + App Check (see README). */
const rateLimits = {
  signIn: { max: 8, windowMs: 60 * 1000, times: [] },
  post:   { max: 6, windowMs: 60 * 1000, times: [] },
};
function rateLimitOk(key) {
  const cfg = rateLimits[key];
  const now = Date.now();
  cfg.times = cfg.times.filter((t) => now - t < cfg.windowMs);
  if (cfg.times.length >= cfg.max) return false;
  cfg.times.push(now);
  return true;
}

/* ----------------------------- utilities ----------------------------- */

function $(id) { return document.getElementById(id); }

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseYmd(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function prettyDate(str) {
  const d = parseYmd(str);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function telHref(raw) { return `tel:${(raw || '').replace(/\D/g, '')}`; }
function smsHref(raw) { return `sms:${(raw || '').replace(/\D/g, '')}`; }

function isWeekday(dateStr) {
  const d = parseYmd(dateStr).getDay();
  return d >= 1 && d <= 5;
}

function validSNumber(s) { return /^S\d{5}$/.test(s); }
function validPhone(p) { return (p || '').replace(/\D/g, '').length >= 10; }
function validName(n) { return typeof n === 'string' && n.trim().length > 0; }
function validPin(p) { return /^\d{4,6}$/.test(p || ''); }
function profileValid(p) {
  return p && validName(p.name) && validSNumber(p.sNumber) && validPhone(p.phone);
}

/* ----------------------------- PIN hashing ----------------------------- */

/* PBKDF2 via Web Crypto. Salted with the S# so identical PINs for different
 * users produce different hashes. 200k iterations ≈ 150-400ms on modern
 * devices — fast enough for login, slow enough to make casual brute force
 * of a 4-6 digit PIN annoying if the users collection is ever scraped. */
async function hashPin(sNumber, pin) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Web Crypto not available in this browser.');
  }
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('umsod-be:' + sNumber), iterations: 200000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ----------------------------- local cache ----------------------------- */

function loadLocalProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) state.profile = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

function cacheProfile(p) {
  state.profile = p;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

function clearLocalProfile() {
  state.profile = null;
  localStorage.removeItem(PROFILE_KEY);
}

/* ----------------------------- firestore ----------------------------- */

function initFirestore() {
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    console.warn('Firebase not configured — data will not sync between users.');
    return false;
  }
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg.apiKey || cfg.apiKey.startsWith('REPLACE_')) {
    console.warn('Firebase config has placeholder values. Fill in firebase-config.js.');
    showSetupWarning();
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);

    // Optional: Firebase App Check with reCAPTCHA v3. When enabled it
    // blocks writes that don't come from the real site (the #1 spam
    // defense). Activated only if the site key is set in
    // firebase-config.js and the App Check compat SDK loaded.
    if (window.RECAPTCHA_V3_SITE_KEY && firebase.appCheck) {
      try {
        self.FIREBASE_APPCHECK_DEBUG_TOKEN =
          self.FIREBASE_APPCHECK_DEBUG_TOKEN || false;
        firebase.appCheck().activate(window.RECAPTCHA_V3_SITE_KEY, true);
      } catch (e) {
        console.warn('App Check activation failed:', e);
      }
    }

    db = firebase.firestore();
    state.firestoreReady = true;
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

function subscribeBlocks() {
  if (!state.firestoreReady) return;
  if (blocksUnsub) blocksUnsub();

  // Only listen to blocks whose date is today or later (minus a 1-day grace
  // window so "today morning" shows after midnight passes). This caps the
  // number of reads each client makes and keeps the Firestore free tier safe
  // as old blocks accumulate.
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 1);
  const startStr = ymd(windowStart);

  blocksUnsub = db.collection('blocks')
    .where('date', '>=', startStr)
    .onSnapshot(
      (snap) => {
        state.blocks = [];
        snap.forEach((doc) => {
          state.blocks.push({ id: doc.id, ...doc.data() });
        });
        state.blocks.sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return (a.time || '').localeCompare(b.time || '');
        });
        renderCurrentView();
      },
      (err) => {
        console.error('Firestore subscription error:', err);
        toast('Could not load blocks. Check Firestore rules.');
      }
    );
}

async function fetchUserDoc(sNumber) {
  if (!state.firestoreReady) return null;
  const snap = await db.collection('users').doc(sNumber).get();
  return snap.exists ? snap.data() : null;
}

async function createUserDoc(user) {
  const now = Date.now();
  await db.collection('users').doc(user.sNumber).set({
    sNumber: user.sNumber,
    name: user.name,
    phone: user.phone,
    pinHash: user.pinHash,
    createdAt: now,
    updatedAt: now,
  });
}

async function updateUserDoc(profile) {
  await db.collection('users').doc(profile.sNumber).update({
    name: profile.name,
    phone: profile.phone,
    updatedAt: Date.now(),
  });
}

async function propagateProfileToBlocks(profile) {
  // Update name + phone on blocks the user has already posted, so contact
  // info stays current. Date/time/type/sNumber stay the same.
  if (!state.firestoreReady) return;
  const mine = state.blocks.filter((b) => b.sNumber === profile.sNumber);
  if (mine.length === 0) return;
  const batch = db.batch();
  for (const b of mine) {
    batch.update(db.collection('blocks').doc(b.id), {
      name: profile.name,
      phone: profile.phone,
    });
  }
  await batch.commit();
}

async function postBlockDoc(block) {
  if (!state.firestoreReady) { toast('Data storage is not configured yet.'); return false; }
  await db.collection('blocks').add(block);
  return true;
}

async function deleteBlockDoc(id) {
  if (!state.firestoreReady) return false;
  await db.collection('blocks').doc(id).delete();
  return true;
}

function showSetupWarning() {
  const gate = $('signin-gate');
  if (!gate) return;
  const warn = document.createElement('div');
  warn.className = 'empty-state';
  warn.style.marginBottom = '14px';
  warn.innerHTML =
    '<strong>Setup needed:</strong> this site needs a free Firebase project to share blocks between students. ' +
    'See <code>firebase-config.js</code> and the README for a 5-minute setup.';
  gate.prepend(warn);
}

/* ----------------------------- gate + views ----------------------------- */

function setGate(which) {
  // which: 'signin' | 'pin' | 'setup' | null
  $('signin-gate').classList.toggle('hidden', which !== 'signin');
  $('pin-gate').classList.toggle('hidden', which !== 'pin');
  $('setup-gate').classList.toggle('hidden', which !== 'setup');
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  $('view-calendar').classList.toggle('hidden', view !== 'calendar');
  $('view-my-blocks').classList.toggle('hidden', view !== 'my-blocks');
  $('view-post').classList.toggle('hidden', view !== 'post');
  $('view-profile').classList.toggle('hidden', view !== 'profile');
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'calendar') renderCalendar();
  else if (state.view === 'my-blocks') renderMyBlocks();
  else if (state.view === 'profile') fillProfileEditForm();
}

function showApp() {
  setGate(null);
  $('periomaxer-ad').classList.remove('hidden');
  setView(state.view || 'calendar');
}

function showSignIn() {
  setGate('signin');
  $('periomaxer-ad').classList.add('hidden');
  ['view-calendar', 'view-my-blocks', 'view-post', 'view-profile'].forEach((id) => {
    $(id).classList.add('hidden');
  });
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  $('signin-snum').value = '';
  setTimeout(() => $('signin-snum').focus(), 50);
}

function showSetup(sNumber) {
  state.pendingSNumber = sNumber;
  setGate('setup');
  $('periomaxer-ad').classList.add('hidden');
  $('setup-snum-label').textContent = sNumber;
  $('setup-form').reset();
  setTimeout(() => $('setup-name').focus(), 50);
}

function showPinPrompt(sNumber) {
  state.pendingSNumber = sNumber;
  setGate('pin');
  $('periomaxer-ad').classList.add('hidden');
  $('pin-snum-label').textContent = sNumber;
  $('pin-form').reset();
  setTimeout(() => $('pin-input').focus(), 50);
}

/* ----------------------------- sign-in / setup ----------------------------- */

async function handleSignInSubmit(e) {
  e.preventDefault();
  if (!rateLimitOk('signIn')) { toast('Slow down — try again in a minute.'); return; }
  const snum = $('signin-snum').value.trim();
  if (!/^\d{5}$/.test(snum)) { toast('S# must be 5 digits.'); return; }
  const sNumber = 'S' + snum;

  if (!state.firestoreReady) {
    toast('Data storage is not configured yet. See README.');
    return;
  }

  const btn = $('signin-submit');
  btn.disabled = true;
  try {
    const user = await fetchUserDoc(sNumber);
    if (user && validName(user.name) && validPhone(user.phone) && user.pinHash) {
      showPinPrompt(sNumber);
    } else {
      showSetup(sNumber);
    }
  } catch (err) {
    console.error(err);
    toast('Sign in failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

async function handlePinSubmit(e) {
  e.preventDefault();
  if (!rateLimitOk('signIn')) { toast('Slow down — try again in a minute.'); return; }
  const pin = $('pin-input').value;
  if (!validPin(pin)) { toast('PIN must be 4–6 digits.'); return; }
  const sNumber = state.pendingSNumber;
  if (!sNumber) { showSignIn(); return; }

  const btn = $('pin-submit');
  btn.disabled = true;
  try {
    const [user, hash] = await Promise.all([
      fetchUserDoc(sNumber),
      hashPin(sNumber, pin),
    ]);
    if (!user || !user.pinHash || user.pinHash !== hash) {
      toast('Incorrect PIN.');
      $('pin-input').select();
      return;
    }
    cacheProfile({ name: user.name, sNumber, phone: user.phone });
    toast('Welcome back, ' + user.name.split(' ')[0] + '.');
    state.pendingSNumber = null;
    showApp();
  } catch (err) {
    console.error(err);
    toast('Sign in failed. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

function handlePinBack() {
  state.pendingSNumber = null;
  showSignIn();
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  if (!$('setup-agree').checked) { toast('Please agree to the privacy policy.'); return; }
  const name = $('setup-name').value.trim();
  const phone = $('setup-phone').value.trim();
  const pin = $('setup-pin').value;
  const pin2 = $('setup-pin2').value;
  if (!validName(name)) { toast('Enter your full name.'); return; }
  if (!validPhone(phone)) { toast('Enter a valid 10-digit phone number.'); return; }
  if (!validPin(pin)) { toast('PIN must be 4–6 digits.'); return; }
  if (pin !== pin2) { toast('PINs don’t match.'); return; }

  const sNumber = state.pendingSNumber;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const pinHash = await hashPin(sNumber, pin);
    const profile = { name, sNumber, phone };
    await createUserDoc({ ...profile, pinHash });
    cacheProfile(profile);
    toast('Account created — welcome, ' + name.split(' ')[0] + '.');
    state.pendingSNumber = null;
    showApp();
  } catch (err) {
    console.error(err);
    toast('Could not create account. Check Firestore rules.');
  } finally {
    btn.disabled = false;
  }
}

function handleSetupBack() {
  state.pendingSNumber = null;
  showSignIn();
}

/* ----------------------------- calendar ----------------------------- */

function matchesFilters(block) {
  if (state.filterType && block.type !== state.filterType) return false;
  if (state.filterTime && block.time !== state.filterTime) return false;
  return true;
}

function blocksByDate() {
  const map = new Map();
  for (const b of state.blocks) {
    if (!matchesFilters(b)) continue;
    if (!map.has(b.date)) map.set(b.date, []);
    map.get(b.date).push(b);
  }
  return map;
}

function renderCalendar() {
  const root = $('calendar');
  root.innerHTML = '';
  const month = state.calMonth;
  $('cal-label').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDate = blocksByDate();
  const todayStr = ymd(new Date());

  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  const firstDow = firstOfMonth.getDay();
  let leadingEmpties = 0;
  if (firstDow === 0 || firstDow === 6) leadingEmpties = 5;
  else leadingEmpties = firstDow - 1;

  for (let i = 0; i < leadingEmpties; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    root.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue;

    const dstr = ymd(date);
    const list = byDate.get(dstr) || [];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day' + (list.length === 0 ? ' has-none' : '') + (dstr === todayStr ? ' today' : '');
    btn.dataset.date = dstr;

    const headRow = document.createElement('div');
    headRow.style.display = 'flex';
    headRow.style.justifyContent = 'space-between';
    headRow.style.alignItems = 'center';

    const num = document.createElement('span');
    num.className = 'date-num';
    num.textContent = String(d);
    headRow.appendChild(num);

    if (list.length > 0) {
      const pill = document.createElement('span');
      pill.className = 'count-pill';
      pill.textContent = list.length + (list.length === 1 ? ' block' : ' blocks');
      headRow.appendChild(pill);
    }
    btn.appendChild(headRow);

    if (list.length > 0) {
      const tagRow = document.createElement('div');
      tagRow.className = 'tag-row';
      if (list.some((b) => b.time === 'morning')) {
        const t = document.createElement('span'); t.className = 'tag morning'; t.textContent = 'AM'; tagRow.appendChild(t);
      }
      if (list.some((b) => b.time === 'afternoon')) {
        const t = document.createElement('span'); t.className = 'tag afternoon'; t.textContent = 'PM'; tagRow.appendChild(t);
      }
      btn.appendChild(tagRow);
    }

    btn.addEventListener('click', () => openDayDetail(dstr));
    root.appendChild(btn);
  }

  if (state.selectedDate) openDayDetail(state.selectedDate, { keepOpen: true });
}

function openDayDetail(dstr, opts = {}) {
  state.selectedDate = dstr;
  const list = (blocksByDate().get(dstr) || []).slice();
  list.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  $('day-detail').classList.remove('hidden');
  $('day-detail-title').textContent = `Blocks on ${prettyDate(dstr)}`;
  const listEl = $('day-detail-list');
  listEl.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No blocks posted for this day with your current filters.';
    listEl.appendChild(empty);
    return;
  }

  for (const b of list) {
    listEl.appendChild(renderBlockCard(b, { showContact: true }));
  }

  if (!opts.keepOpen) {
    $('day-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function closeDayDetail() {
  state.selectedDate = null;
  $('day-detail').classList.add('hidden');
}

function renderBlockCard(b, opts = {}) {
  const card = document.createElement('div');
  card.className = 'block-card';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${b.type} — ${b.time === 'morning' ? 'Morning' : 'Afternoon'}`;
  meta.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${prettyDate(b.date)} • Posted by ${b.name} (${b.sNumber})`;
  meta.appendChild(sub);
  card.appendChild(meta);

  if (opts.showContact) {
    const contact = document.createElement('div');
    contact.className = 'contact';
    const phone = formatPhone(b.phone);
    contact.innerHTML = `<div>Contact:</div>
      <div><a href="${telHref(b.phone)}">${phone}</a></div>
      <div><a href="${smsHref(b.phone)}">Send text</a></div>`;
    card.appendChild(contact);
  }

  if (opts.mine) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.className = 'text-btn danger';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      if (!confirm('Remove this block from the calendar?')) return;
      try {
        await deleteBlockDoc(b.id);
        toast('Block removed.');
      } catch (e) {
        console.error(e);
        toast('Could not remove block.');
      }
    });
    actions.appendChild(del);
    card.appendChild(actions);
  }

  if (b.notes) {
    const n = document.createElement('div');
    n.className = 'notes';
    n.textContent = b.notes;
    card.appendChild(n);
  }

  return card;
}

/* ----------------------------- my blocks ----------------------------- */

function renderMyBlocks() {
  const listEl = $('my-blocks-list');
  listEl.innerHTML = '';
  if (!state.profile) return;

  const mine = state.blocks.filter((b) => b.sNumber === state.profile.sNumber);
  if (mine.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'You haven’t posted any blocks yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const b of mine) {
    listEl.appendChild(renderBlockCard(b, { mine: true }));
  }
}

/* ----------------------------- post form ----------------------------- */

function populateBlockTypeSelects() {
  const filterSel = $('filter-type');
  const postSel = $('post-type');
  for (const t of BLOCK_TYPES) {
    const o1 = document.createElement('option'); o1.value = t; o1.textContent = t; filterSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = t; o2.textContent = t; postSel.appendChild(o2);
  }
}

async function handlePostBlock(e) {
  e.preventDefault();
  if (!state.profile) { toast('Sign in first.'); return; }
  if (!rateLimitOk('post')) { toast('Too many posts — try again in a minute.'); return; }
  const date = $('post-date').value;
  const time = $('post-time').value;
  const type = $('post-type').value;
  const notes = $('post-notes').value.trim().slice(0, 200);

  if (!date || !time || !type) { toast('Please fill in every field.'); return; }
  if (!isWeekday(date)) { toast('Blocks are Monday–Friday only.'); return; }
  if (!BLOCK_TYPES.includes(type)) { toast('Unknown block type.'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Invalid date.'); return; }

  // Reject posts more than 1 year in the past or 1 year in the future.
  const d = parseYmd(date);
  const today = new Date(); today.setHours(0,0,0,0);
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  if (Math.abs(d - today) > yearMs) { toast('Pick a date within a year.'); return; }

  const dup = state.blocks.some((b) =>
    b.sNumber === state.profile.sNumber && b.date === date && b.time === time
  );
  if (dup) { toast('You already posted that block.'); return; }

  const block = {
    date,
    time,
    type,
    notes: notes || null,
    name: state.profile.name,
    sNumber: state.profile.sNumber,
    phone: state.profile.phone,
    createdAt: Date.now(),
  };

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await postBlockDoc(block);
    $('post-form').reset();
    toast('Block posted.');
    setView('calendar');
  } catch (err) {
    console.error(err);
    toast('Could not post block. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- account edit ----------------------------- */

function fillProfileEditForm() {
  if (!state.profile) return;
  $('account-snum-label').textContent = state.profile.sNumber;
  $('edit-name').value = state.profile.name;
  $('edit-phone').value = state.profile.phone;
}

async function handleProfileEditSubmit(e) {
  e.preventDefault();
  const name = $('edit-name').value.trim();
  const phone = $('edit-phone').value.trim();
  if (!validName(name)) { toast('Enter your full name.'); return; }
  if (!validPhone(phone)) { toast('Enter a valid 10-digit phone number.'); return; }

  const profile = { name, sNumber: state.profile.sNumber, phone };
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await updateUserDoc(profile);
    await propagateProfileToBlocks(profile).catch((err) => {
      console.warn('Could not propagate profile changes to existing blocks:', err);
    });
    cacheProfile(profile);
    toast('Account updated.');
  } catch (err) {
    console.error(err);
    toast('Could not save changes.');
  } finally {
    btn.disabled = false;
  }
}

function handleSignOut() {
  if (!confirm('Sign out? Your posted blocks stay on the calendar.')) return;
  clearLocalProfile();
  showSignIn();
}

/* ----------------------------- wiring ----------------------------- */

function wireEvents() {
  $('signin-form').addEventListener('submit', handleSignInSubmit);
  $('pin-form').addEventListener('submit', handlePinSubmit);
  $('pin-back').addEventListener('click', handlePinBack);
  $('setup-form').addEventListener('submit', handleSetupSubmit);
  $('setup-back').addEventListener('click', handleSetupBack);

  $('profile-edit-form').addEventListener('submit', handleProfileEditSubmit);
  $('profile-signout').addEventListener('click', handleSignOut);

  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  $('filter-type').addEventListener('change', (e) => {
    state.filterType = e.target.value;
    renderCalendar();
  });
  $('filter-time').addEventListener('change', (e) => {
    state.filterTime = e.target.value;
    renderCalendar();
  });

  $('cal-prev').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    closeDayDetail();
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    closeDayDetail();
    renderCalendar();
  });

  $('day-detail-close').addEventListener('click', closeDayDetail);

  $('post-form').addEventListener('submit', handlePostBlock);
}

/* ----------------------------- boot ----------------------------- */

async function boot() {
  $('year').textContent = new Date().getFullYear();
  state.calMonth = new Date();
  state.calMonth.setDate(1);

  populateBlockTypeSelects();
  wireEvents();
  loadLocalProfile();
  initFirestore();
  subscribeBlocks();

  if (profileValid(state.profile) && state.firestoreReady) {
    // Refresh from Firestore in case name/phone changed elsewhere.
    showApp();
    try {
      const fresh = await fetchUserDoc(state.profile.sNumber);
      if (fresh && validName(fresh.name) && validPhone(fresh.phone)) {
        cacheProfile({ name: fresh.name, sNumber: state.profile.sNumber, phone: fresh.phone });
        if (state.view === 'profile') fillProfileEditForm();
      }
    } catch (e) { /* ignore */ }
  } else {
    showSignIn();
  }
}

document.addEventListener('DOMContentLoaded', boot);
