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

// axiUm / schedule code → display name. Match is case-insensitive; '@' is stripped.
const SCHEDULE_NAME_MAP = {
  'BLK-SURGERY': 'ORAL SURGERY BLOCK',
  'BLK-ORTHO':   'ORTHO BLOCK',
  'BLK-SPC&G':   'SPECIAL CARE BLOCK',
  'BLK-PEDS':    'PEDS BLOCK',
  'CLIN-EMERG':  'EMERGENCY BLOCK',
  'BLK-ONCALL':  'ON-CALL BLOCK',
  'BLK-SCR':     'SCREENING BLOCK',
};

// Display name → swap-listing block type.
const DESC_TO_TYPE = {
  'ORAL SURGERY BLOCK': 'Oral Surgery',
  'ORTHO BLOCK':        'Ortho',
  'SPECIAL CARE BLOCK': 'Special Care',
  'PEDS BLOCK':         'Peds',
  'EMERGENCY BLOCK':    'Emergency',
  'ON-CALL BLOCK':      'On-Call',
  'SCREENING BLOCK':    'Screening',
};

const PROFILE_KEY = 'umsod_be_profile_v1';
const SCHEDULE_KEY_PREFIX = 'umsod_be_schedule_v1:';

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
  schedule: [],         // user's imported schedule (local-only, per-device)
  importTab: 'paste',
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
  $('view-schedule').classList.toggle('hidden', view !== 'schedule');
  $('view-post').classList.toggle('hidden', view !== 'post');
  $('view-profile').classList.toggle('hidden', view !== 'profile');
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'calendar') renderCalendar();
  else if (state.view === 'my-blocks') renderMyBlocks();
  else if (state.view === 'schedule') renderSchedule();
  else if (state.view === 'profile') fillProfileEditForm();
}

function showApp() {
  setGate(null);
  $('periomaxer-ad').classList.remove('hidden');
  loadSchedule();
  handleReminderToggle();
  setView(state.view || 'calendar');
}

function showSignIn() {
  setGate('signin');
  $('periomaxer-ad').classList.add('hidden');
  ['view-calendar', 'view-my-blocks', 'view-schedule', 'view-post', 'view-profile'].forEach((id) => {
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

/* ----------------------------- schedule: parsing ----------------------------- */

function parseTime12(str) {
  const m = (str || '').trim().match(/^(\d{1,2}):(\d{2})\s*([APap][Mm])\.?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  if (h === 12) h = 0;
  if (ampm === 'PM') h += 12;
  return { h, min, display: `${pad2(parseInt(m[1],10))}:${pad2(min)} ${ampm}` };
}

function parseMmDdYyyy(str) {
  const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yyyy = parseInt(m[3], 10);
  if (yyyy < 100) yyyy += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { yyyy, mm, dd, ymd: `${yyyy}-${pad2(mm)}-${pad2(dd)}`, display: `${pad2(mm)}/${pad2(dd)}/${yyyy}` };
}

function cleanDescription(raw) {
  const stripped = (raw || '').trim().replace(/^@/, '');
  const hit = SCHEDULE_NAME_MAP[stripped.toUpperCase()];
  return hit || stripped;
}

/* Accept either "desc, date, start, end" lines OR OCR-style lines with
 * whitespace separating the fields. Best effort — unparseable lines go
 * to the error list for the UI to show. */
function parseScheduleText(text) {
  const entries = [];
  const errors = [];
  const lines = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^(description|desc|block|name|event)\b/.test(lower)) continue;

    let parts = line.split(/\s*,\s*/).filter(Boolean);
    if (parts.length < 4) {
      // Whitespace fallback: "@CODE  MM/DD/YYYY  HH:MM AM  HH:MM PM"
      const m = line.match(/^(@?\S+(?:\s+[A-Za-z&]+)*?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[APap][Mm])\s+(\d{1,2}:\d{2}\s*[APap][Mm])\s*$/);
      if (!m) { errors.push(line); continue; }
      parts = [m[1], m[2], m[3], m[4]];
    }

    const [rawDesc, dateStr, startStr, endStr] = parts;
    const date = parseMmDdYyyy(dateStr);
    const start = parseTime12(startStr);
    const end = parseTime12(endStr);
    if (!date || !start || !end) { errors.push(line); continue; }
    if ((end.h * 60 + end.min) <= (start.h * 60 + start.min)) { errors.push(line); continue; }

    entries.push({
      id: 'sch_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      description: cleanDescription(rawDesc),
      date: date.ymd,
      dateDisplay: date.display,
      startTime: start.display,
      endTime: end.display,
    });
  }

  return { entries, errors };
}

function startTimeToPeriod(startDisplay) {
  const t = parseTime12(startDisplay);
  if (!t) return null;
  return t.h < 12 ? 'morning' : 'afternoon';
}

/* ----------------------------- schedule: storage ----------------------------- */

function scheduleKey() {
  if (!state.profile) return null;
  return SCHEDULE_KEY_PREFIX + state.profile.sNumber;
}

function loadSchedule() {
  const key = scheduleKey();
  if (!key) { state.schedule = []; return; }
  try {
    const raw = localStorage.getItem(key);
    state.schedule = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.schedule = [];
  }
}

function saveSchedule() {
  const key = scheduleKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(state.schedule));
}

function mergeScheduleEntries(newEntries) {
  const dedupKey = (e) => `${e.date}|${e.startTime}|${e.endTime}|${e.description}`;
  const seen = new Set(state.schedule.map(dedupKey));
  let added = 0;
  for (const e of newEntries) {
    if (seen.has(dedupKey(e))) continue;
    seen.add(dedupKey(e));
    state.schedule.push(e);
    added++;
  }
  state.schedule.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.startTime || '').localeCompare(b.startTime || '');
  });
  saveSchedule();
  return added;
}

/* ----------------------------- schedule: OCR ----------------------------- */

let _tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractPromise) return _tesseractPromise;
  _tesseractPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.async = true;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { _tesseractPromise = null; reject(new Error('Could not load OCR library.')); };
    document.head.appendChild(s);
  });
  return _tesseractPromise;
}

async function ocrImage(file) {
  const Tesseract = await loadTesseract();
  const res = await Tesseract.recognize(file, 'eng');
  return (res && res.data && res.data.text) || '';
}

/* ----------------------------- schedule: ICS ----------------------------- */

function icsEscape(s) {
  return (s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function combineDateTime(ymdStr, timeDisplay) {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const t = parseTime12(timeDisplay);
  if (!t) return null;
  return new Date(y, m - 1, d, t.h, t.min, 0);
}

function icsDateTime(dt) {
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;
}

function icsDateTimeUtc(dt) {
  return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`;
}

function uuidLike() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateIcs(events, personName, reminder) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UMSOD Block Exchange//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(personName)} Block Schedule`,
  ];

  const dtstamp = icsDateTimeUtc(new Date());
  const sorted = events.slice().sort((a, b) => {
    const da = combineDateTime(a.date, a.startTime);
    const db = combineDateTime(b.date, b.startTime);
    return da - db;
  });

  for (const ev of sorted) {
    const dtstart = combineDateTime(ev.date, ev.startTime);
    const dtend = combineDateTime(ev.date, ev.endTime);
    if (!dtstart || !dtend) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uuidLike()}@umsod-block-exchange`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${icsDateTime(dtstart)}`);
    lines.push(`DTEND:${icsDateTime(dtend)}`);
    lines.push(`SUMMARY:${icsEscape(ev.description)}`);
    lines.push(`DESCRIPTION:${icsEscape(ev.description + ' - ' + personName)}`);
    lines.push('STATUS:CONFIRMED');

    if (reminder && reminder.enabled) {
      const nightBefore = new Date(dtstart);
      nightBefore.setDate(nightBefore.getDate() - 1);
      nightBefore.setHours(reminder.hour, reminder.minute, 0, 0);
      const offsetSec = Math.max(0, Math.floor((dtstart - nightBefore) / 1000));
      const hours = Math.floor(offsetSec / 3600);
      const mins = Math.floor((offsetSec % 3600) / 60);
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${icsEscape('Reminder: ' + ev.description + ' tomorrow')}`);
      lines.push(`TRIGGER:-PT${hours}H${mins}M`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/* ----------------------------- schedule: view ----------------------------- */

function renderSchedule() {
  const listEl = $('schedule-list');
  listEl.innerHTML = '';
  const summary = $('schedule-summary');

  if (state.schedule.length === 0) {
    summary.textContent = 'Nothing imported yet.';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Import your schedule above to see your blocks here.';
    listEl.appendChild(empty);
    return;
  }
  summary.textContent = `${state.schedule.length} block${state.schedule.length === 1 ? '' : 's'} imported.`;

  for (const entry of state.schedule) {
    listEl.appendChild(renderScheduleRow(entry));
  }
}

function renderScheduleRow(entry) {
  const row = document.createElement('div');
  row.className = 'schedule-row';

  const period = startTimeToPeriod(entry.startTime);
  const type = DESC_TO_TYPE[entry.description.toUpperCase()] || null;
  const postedBlock = state.blocks.find((b) =>
    state.profile && b.sNumber === state.profile.sNumber &&
    b.date === entry.date && b.time === period
  );
  if (postedBlock) row.classList.add('posted');

  const dateEl = document.createElement('div');
  dateEl.className = 'sched-date';
  dateEl.textContent = prettyDate(entry.date).split(',').slice(0, 2).join(',');
  row.appendChild(dateEl);

  const timeEl = document.createElement('div');
  timeEl.className = 'sched-time';
  timeEl.textContent = `${entry.startTime} – ${entry.endTime}`;
  row.appendChild(timeEl);

  const descEl = document.createElement('div');
  descEl.className = 'sched-desc';
  descEl.textContent = entry.description;
  row.appendChild(descEl);

  const statusEl = document.createElement('div');
  if (postedBlock) {
    const badge = document.createElement('span');
    badge.className = 'posted-badge';
    badge.textContent = 'Posted';
    statusEl.appendChild(badge);
  }
  row.appendChild(statusEl);

  const actions = document.createElement('div');
  actions.className = 'sched-actions';

  if (type && period) {
    if (postedBlock) {
      const unpost = document.createElement('button');
      unpost.type = 'button';
      unpost.className = 'text-btn danger';
      unpost.textContent = 'Unpost';
      unpost.addEventListener('click', async () => {
        if (!confirm('Remove this block from the public calendar?')) return;
        try {
          await deleteBlockDoc(postedBlock.id);
          toast('Block unposted.');
        } catch (e) {
          console.error(e);
          toast('Could not unpost.');
        }
      });
      actions.appendChild(unpost);
    } else {
      const post = document.createElement('button');
      post.type = 'button';
      post.className = 'text-btn';
      post.textContent = 'Post for swap';
      post.addEventListener('click', () => postScheduleEntry(entry, type, period, post));
      actions.appendChild(post);
    }
  } else {
    const note = document.createElement('span');
    note.className = 'small muted';
    note.textContent = 'Unknown block type';
    actions.appendChild(note);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-btn';
  remove.textContent = 'Remove';
  remove.title = 'Remove from your schedule (doesn’t affect anything on the calendar)';
  remove.addEventListener('click', () => {
    state.schedule = state.schedule.filter((x) => x.id !== entry.id);
    saveSchedule();
    renderSchedule();
  });
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

async function postScheduleEntry(entry, type, period, btn) {
  if (!state.profile) { toast('Sign in first.'); return; }
  if (!rateLimitOk('post')) { toast('Too many posts — try again in a minute.'); return; }
  if (!isWeekday(entry.date)) { toast('Blocks are Monday–Friday only.'); return; }

  const block = {
    date: entry.date,
    time: period,
    type,
    notes: `${entry.startTime} – ${entry.endTime}`,
    name: state.profile.name,
    sNumber: state.profile.sNumber,
    phone: state.profile.phone,
    createdAt: Date.now(),
  };

  btn.disabled = true;
  try {
    await postBlockDoc(block);
    toast(`Posted: ${entry.description} on ${entry.dateDisplay}.`);
  } catch (err) {
    console.error(err);
    toast('Could not post. Check your connection.');
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------- schedule: import handlers ----------------------------- */

function setImportTab(tab) {
  state.importTab = tab;
  document.querySelectorAll('.import-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.importTab === tab);
  });
  $('import-pane-paste').classList.toggle('hidden', tab !== 'paste');
  $('import-pane-screenshot').classList.toggle('hidden', tab !== 'screenshot');
  $('import-status').textContent = '';
}

async function handleScreenshotUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const status = $('ocr-status');
  const ta = $('ocr-textarea');
  status.textContent = 'Loading OCR engine (first time only, ~10 MB)…';
  try {
    const text = await ocrImage(file);
    ta.value = text.trim();
    status.textContent = 'Done. Review and fix any mistakes above before parsing.';
  } catch (err) {
    console.error(err);
    status.textContent = 'OCR failed. Try pasting the schedule as text instead.';
  }
}

function handleImportParse() {
  const src = state.importTab === 'screenshot' ? $('ocr-textarea') : $('import-textarea');
  const text = src.value;
  if (!text.trim()) { toast('Paste or upload a schedule first.'); return; }
  const { entries, errors } = parseScheduleText(text);
  if (entries.length === 0) {
    $('import-status').textContent = 'No valid rows found. Check formatting.';
    return;
  }
  const added = mergeScheduleEntries(entries);
  const skipped = entries.length - added;
  const parts = [`Added ${added} block${added === 1 ? '' : 's'}.`];
  if (skipped) parts.push(`${skipped} already in your schedule.`);
  if (errors.length) parts.push(`${errors.length} line${errors.length === 1 ? '' : 's'} couldn’t be parsed.`);
  $('import-status').textContent = parts.join(' ');
  src.value = '';
  renderSchedule();
}

function handleScheduleClear() {
  if (state.schedule.length === 0) return;
  if (!confirm('Clear your entire imported schedule? This only affects this device.')) return;
  state.schedule = [];
  saveSchedule();
  renderSchedule();
  toast('Schedule cleared.');
}

function handleReminderToggle() {
  const enabled = $('reminder-enabled').checked;
  $('reminder-time-label').style.opacity = enabled ? '1' : '0.4';
  $('reminder-time').disabled = !enabled;
}

function handleDownloadIcs() {
  if (!state.profile) { toast('Sign in first.'); return; }
  if (state.schedule.length === 0) { toast('Nothing to download — import a schedule first.'); return; }
  const enabled = $('reminder-enabled').checked;
  let reminder = null;
  if (enabled) {
    const v = ($('reminder-time').value || '19:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!v) { toast('Invalid reminder time.'); return; }
    const hour = parseInt(v[1], 10);
    const minute = parseInt(v[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) { toast('Invalid reminder time.'); return; }
    reminder = { enabled: true, hour, minute };
  }
  const ics = generateIcs(state.schedule, state.profile.name, reminder);
  const safeName = state.profile.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'blocks';
  downloadBlob(`${safeName}_Blocks.ics`, ics, 'text/calendar');
  toast('Calendar file downloaded.');
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

  // Schedule / import tabs
  document.querySelectorAll('.import-tab').forEach((b) => {
    b.addEventListener('click', () => setImportTab(b.dataset.importTab));
  });
  $('import-file').addEventListener('change', handleScreenshotUpload);
  $('import-parse').addEventListener('click', handleImportParse);
  $('schedule-clear').addEventListener('click', handleScheduleClear);
  $('reminder-enabled').addEventListener('change', handleReminderToggle);
  $('download-ics').addEventListener('click', handleDownloadIcs);
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
