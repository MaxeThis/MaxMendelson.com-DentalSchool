/* UMSOD Block Exchange — client logic.
 * Multi-user data via Firebase Firestore (see firebase-config.js).
 * Profile stored locally in localStorage; phone is shared on posted blocks. */

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
  profile: null,
  blocks: [],
  filterType: '',
  filterTime: '',
  calMonth: null, // Date set to first of month
  selectedDate: null, // YYYY-MM-DD
  view: 'calendar',
  firestoreReady: false,
};

let db = null;
let blocksUnsub = null;

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

function telHref(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  return `tel:${digits}`;
}

function smsHref(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  return `sms:${digits}`;
}

function isWeekday(dateStr) {
  const d = parseYmd(dateStr).getDay();
  return d >= 1 && d <= 5;
}

/* ----------------------------- profile ----------------------------- */

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) state.profile = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}

function saveProfile(p) {
  state.profile = p;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

function clearProfile() {
  state.profile = null;
  localStorage.removeItem(PROFILE_KEY);
}

function profileValid(p) {
  return p && p.name && /^S\d{5}$/.test(p.sNumber) && (p.phone || '').replace(/\D/g, '').length >= 10;
}

/* ----------------------------- firestore ----------------------------- */

function initFirestore() {
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    console.warn('Firebase not configured — data will not sync between users. See firebase-config.js.');
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
  blocksUnsub = db.collection('blocks').onSnapshot(
    (snap) => {
      state.blocks = [];
      snap.forEach((doc) => {
        const data = doc.data();
        state.blocks.push({ id: doc.id, ...data });
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

async function postBlockDoc(block) {
  if (!state.firestoreReady) {
    toast('Data storage is not configured yet.');
    return false;
  }
  await db.collection('blocks').add(block);
  return true;
}

async function deleteBlockDoc(id) {
  if (!state.firestoreReady) return false;
  await db.collection('blocks').doc(id).delete();
  return true;
}

function showSetupWarning() {
  const gate = $('profile-gate');
  if (!gate) return;
  const warn = document.createElement('div');
  warn.className = 'empty-state';
  warn.style.marginBottom = '14px';
  warn.innerHTML =
    '<strong>Setup needed:</strong> this site needs a free Firebase project to share blocks between students. ' +
    'See <code>firebase-config.js</code> and the README for a 5-minute setup.';
  gate.prepend(warn);
}

/* ----------------------------- views ----------------------------- */

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
  $('profile-gate').classList.add('hidden');
  $('periomaxer-ad').classList.remove('hidden');
  setView(state.view || 'calendar');
}

function showGate() {
  $('profile-gate').classList.remove('hidden');
  $('periomaxer-ad').classList.add('hidden');
  ['view-calendar', 'view-my-blocks', 'view-post', 'view-profile'].forEach((id) => {
    $(id).classList.add('hidden');
  });
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
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

  // Start grid on Monday. JS getDay: 0=Sun..6=Sat. We want Mon=0..Fri=4.
  const firstDow = firstOfMonth.getDay(); // 0..6
  let leadingEmpties = 0;
  if (firstDow === 0) leadingEmpties = 5; // Sun -> skip to next week start (really render nothing on weekend)
  else if (firstDow === 6) leadingEmpties = 5;
  else leadingEmpties = firstDow - 1; // Mon=0, Tue=1, ...

  // We only render weekdays, so skip empties if they go past Friday
  for (let i = 0; i < leadingEmpties; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    root.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends entirely

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
      const hasMorning = list.some((b) => b.time === 'morning');
      const hasAfternoon = list.some((b) => b.time === 'afternoon');
      if (hasMorning) {
        const t = document.createElement('span'); t.className = 'tag morning'; t.textContent = 'AM'; tagRow.appendChild(t);
      }
      if (hasAfternoon) {
        const t = document.createElement('span'); t.className = 'tag afternoon'; t.textContent = 'PM'; tagRow.appendChild(t);
      }
      btn.appendChild(tagRow);
    }

    btn.addEventListener('click', () => openDayDetail(dstr));
    root.appendChild(btn);
  }

  // keep detail view consistent if open
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
  if (!state.profile) { toast('Set up your profile first.'); return; }
  const date = $('post-date').value;
  const time = $('post-time').value;
  const type = $('post-type').value;
  const notes = $('post-notes').value.trim();

  if (!date || !time || !type) { toast('Please fill in every field.'); return; }
  if (!isWeekday(date)) { toast('Blocks are Monday–Friday only.'); return; }

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

/* ----------------------------- profile forms ----------------------------- */

function readProfileFromForm(prefix) {
  const name = $(prefix + 'name').value.trim();
  const snum = $(prefix + 'snum').value.trim();
  const phone = $(prefix + 'phone').value.trim();
  return {
    name,
    sNumber: 'S' + snum,
    phone,
  };
}

function handleProfileSubmit(e) {
  e.preventDefault();
  if (!$('profile-agree').checked) { toast('Please agree to the privacy policy.'); return; }
  const p = readProfileFromForm('profile-');
  if (!profileValid(p)) { toast('Check your name, 5-digit S#, and phone number.'); return; }
  saveProfile(p);
  toast('Welcome, ' + p.name.split(' ')[0] + '.');
  showApp();
}

function handleProfileEditSubmit(e) {
  e.preventDefault();
  const p = readProfileFromForm('edit-');
  if (!profileValid(p)) { toast('Check your name, 5-digit S#, and phone number.'); return; }
  saveProfile(p);
  toast('Profile updated.');
  // Note: existing posted blocks keep their old phone/name; user can remove and repost if needed.
}

function fillProfileEditForm() {
  if (!state.profile) return;
  $('edit-name').value = state.profile.name;
  $('edit-snum').value = state.profile.sNumber.replace(/^S/, '');
  $('edit-phone').value = state.profile.phone;
}

function handleSignOut() {
  if (!confirm('Sign out of this device? Your posted blocks stay on the calendar.')) return;
  clearProfile();
  showGate();
}

/* ----------------------------- wiring ----------------------------- */

function wireEvents() {
  $('profile-form').addEventListener('submit', handleProfileSubmit);
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

function boot() {
  $('year').textContent = new Date().getFullYear();
  state.calMonth = new Date();
  state.calMonth.setDate(1);

  populateBlockTypeSelects();
  wireEvents();
  loadProfile();
  initFirestore();
  subscribeBlocks();

  if (profileValid(state.profile)) {
    showApp();
  } else {
    showGate();
  }
}

document.addEventListener('DOMContentLoaded', boot);
