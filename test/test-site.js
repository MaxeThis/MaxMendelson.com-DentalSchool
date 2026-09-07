#!/usr/bin/env node
// Focused regressions for browser data boundaries and delayed Firestore work.
// No network, Firebase credentials, or browser dependencies are needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const profile = (sNumber = 'S12345') => ({ sNumber, name: 'Test Student', phone: '' });
const entry = (id = 'one') => ({
  id, date: '2026-09-08', dateDisplay: '09/08/2026',
  description: 'ORAL SURGERY BLOCK', startTime: '09:00 AM', endTime: '12:00 PM',
});
const snapshot = (data) => ({ exists: true, data: () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element(tag = 'div') {
  const events = {};
  return {
    tag, children: [], events, innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { events[name] = fn; },
    querySelector() { return element(); },
    setAttribute() {}, focus() {}, select() {}, reset() {},
  };
}

function app() {
  const stored = new Map();
  const nodes = new Map();
  const intervals = new Map();
  let timer = 0;
  const context = vm.createContext({
    window: {}, console: { log() {}, warn() {}, error() {} },
    crypto: require('node:crypto').webcrypto, TextEncoder,
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      createElement: element, createTextNode: (text) => ({ textContent: text }),
      querySelectorAll: () => [], addEventListener() {},
      body: element('body'), head: element('head'), visibilityState: 'visible',
    },
    navigator: { userAgent: 'regression test' },
    location: { origin: 'https://example.test', pathname: '/', href: 'https://example.test/?adminkey=PRIVATE#fragment' },
    setTimeout: () => 1, clearTimeout() {},
    setInterval(fn) { intervals.set(++timer, fn); return timer; },
    clearInterval(id) { intervals.delete(id); },
    confirm: () => true,
  });
  vm.runInContext(source, context);
  const state = vm.runInContext('state', context);
  state.firestoreReady = true;
  state.view = 'profile';
  context.cacheProfile(profile());
  return {
    context, state, stored, nodes, intervals,
    get key() { return context.scheduleKey(); },
    db(value) { context.database = value; vm.runInContext('db = database', context); },
  };
}

test('untrusted phone values are escaped in both contact cards', () => {
  const a = app();
  const phone = '<svg/onload=alert(123456789012)>';
  const block = { ...profile(), date: '2026-09-08', time: 'morning', type: 'Ortho', phone };
  for (const card of [
    a.context.renderBlockCard(block, { showContact: true }),
    a.context.renderAssistCard({ ...block, time: '7am', procedure: 'Endo' }, { showContact: true }),
  ]) {
    const contact = card.children.find((child) => child.className === 'contact');
    assert.ok(contact.innerHTML.includes('&lt;svg/'));
    assert.ok(!contact.innerHTML.includes('<svg/'));
  }
});

test('parser rejects impossible dates without rolling them into another month', () => {
  const a = app();
  assert.equal(a.context.parseMmDdYyyy('02/29/2026'), null);
  assert.equal(a.context.parseMmDdYyyy('04/31/2026'), null);
  assert.equal(a.context.parseMmDdYyyy('02/29/2028').ymd, '2028-02-29');
  assert.equal(a.context.isWeekday('2026-02-31'), false);
  const parsed = a.context.parseScheduleText('@BLK-OS 02/30/2026 02/30/2026 09:00 AM 12:00 PM');
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.errors.length, 1);
});

test('an intentionally cleared cloud schedule clears a stale device cache', async () => {
  const a = app();
  let writes = 0;
  a.stored.set(a.key, JSON.stringify([entry()]));
  a.db({ collection: () => ({ doc: () => ({
    get: async () => snapshot({ schedule: [] }), update: async () => { writes++; },
  }) }) });
  await a.context.loadSchedule();
  assert.equal(a.state.schedule.length, 0);
  assert.equal(a.stored.get(a.key), '[]');
  assert.equal(writes, 0, 'old local entries must not be pushed back to Firestore');
});

test('a late cloud load cannot overwrite an edit made while it was loading', async () => {
  const a = app();
  const pending = deferred();
  a.db({ collection: () => ({ doc: () => ({
    get: () => pending.promise, update: async () => {},
  }) }) });
  const loading = a.context.loadSchedule();
  a.state.schedule = [entry('new-edit')];
  await a.context.saveSchedule();
  pending.resolve(snapshot({ schedule: [entry('old-cloud')] }));
  await loading;
  assert.equal(a.state.schedule[0].id, 'new-edit');
});

test('pending schedule loads do not cross account boundaries', async () => {
  const a = app();
  const pending = deferred();
  a.db({ collection: () => ({ doc: () => ({ get: () => pending.promise }) }) });
  const loading = a.context.loadSchedule();
  a.context.clearLocalProfile();
  a.context.cacheProfile(profile('S54321'));
  a.state.schedule = [entry('second-account')];
  pending.resolve(snapshot({ schedule: [entry('first-account')] }));
  await loading;
  assert.equal(a.state.schedule[0].id, 'second-account');
});

test('failed cloud saves retain local edits and retry before loading stale data', async () => {
  const a = app();
  let offline = true;
  let reads = 0;
  const writes = [];
  a.db({ collection: () => ({ doc: () => ({
    get: async () => { reads++; return snapshot({ schedule: [] }); },
    update: async (data) => { if (offline) throw new Error('offline'); writes.push(data); },
  }) }) });
  a.state.schedule = [entry('unsynced')];
  assert.equal(await a.context.saveSchedule(), false);
  assert.ok(a.stored.has(a.key + ':pending'));
  offline = false;
  a.state.schedule = [];
  a.context.loadSchedule();
  await flush();
  assert.equal(reads, 0);
  assert.equal(writes[0].schedule[0].id, 'unsynced');
  assert.ok(!a.stored.has(a.key + ':pending'));
});

test('older completed saves cannot clear a newer pending edit', async () => {
  const a = app();
  const first = deferred(), second = deferred();
  let writes = 0;
  a.db({ collection: () => ({ doc: () => ({ update: () => (++writes === 1 ? first : second).promise }) }) });
  a.state.schedule = [entry('first')];
  const firstSave = a.context.saveSchedule();
  a.state.schedule = [entry('second')];
  const secondSave = a.context.saveSchedule();
  const marker = a.stored.get(a.key + ':pending');
  first.resolve();
  await firstSave;
  assert.equal(a.stored.get(a.key + ':pending'), marker);
  second.resolve();
  await secondSave;
  assert.ok(!a.stored.has(a.key + ':pending'));
});

test('cloud schedules repaint My Blocks and tolerate a malformed local cache', async () => {
  const a = app();
  let renders = 0;
  a.state.view = 'my-blocks';
  a.context.renderMyBlocksView = () => { renders++; };
  a.stored.set(a.key, '{}');
  a.db({ collection: () => ({ doc: () => ({ get: async () => snapshot({ schedule: [entry()] }) }) }) });
  await a.context.loadSchedule();
  assert.equal(a.state.schedule.length, 1);
  assert.equal(renders, 1);
});

test('late session creation does not restart heartbeats after signing out', async () => {
  const a = app();
  const pending = deferred();
  a.db({ collection: () => ({ doc: () => ({ id: 'session-1', set: () => pending.promise, update: async () => {} }) }) });
  const starting = a.context.startSession();
  await a.context.endSession();
  a.context.clearLocalProfile();
  pending.resolve();
  await starting;
  assert.equal(a.state.sessionId, null);
  assert.equal(a.intervals.size, 0);
});

test('ending an old session cannot clear a newer session after its final write', async () => {
  const a = app();
  const pending = deferred();
  a.state.sessionId = 'old';
  a.db({ collection: () => ({ doc: (id) => ({ update: () => { assert.equal(id, 'old'); return pending.promise; } }) }) });
  const ending = a.context.endSession();
  assert.equal(a.state.sessionId, null, 'detach the old ID before awaiting network');
  a.state.sessionId = 'new';
  pending.resolve();
  await ending;
  assert.equal(a.state.sessionId, 'new');
});

test('contact changes reach assists when the Assist cache is empty and batches stay bounded', async () => {
  const a = app();
  const batches = [];
  a.state.assists = [];
  a.db({
    collection(name) {
      assert.equal(name, 'assists');
      return { where(field, comparison, owner) {
        assert.equal(field, 'sNumber'); assert.equal(comparison, '=='); assert.equal(owner, 'S12345');
        return { get: async () => ({ forEach(fn) {
          for (let i = 0; i < 451; i++) fn({ ref: `assist-${i}`, data: () => ({ date: '2099-01-01' }) });
          fn({ ref: 'expired', data: () => ({ date: '2000-01-01' }) });
        } }) };
      } };
    },
    batch() {
      const updates = [];
      return { update: (ref, data) => updates.push({ ref, data }), commit: async () => batches.push(updates) };
    },
  });
  await a.context.propagateProfileToAssists({ ...profile(), phone: '5555555555' });
  assert.deepEqual(batches.map((batch) => batch.length), [450, 1]);
  assert.equal(batches[1][0].data.phone, '5555555555');
});

test('PIN requests completed after Back do not silently sign the user in', async () => {
  const a = app();
  const pending = deferred();
  a.context.clearLocalProfile();
  a.state.pendingSNumber = 'S12345';
  a.context.document.getElementById('pin-input').value = '1234';
  a.context.hashPin = async () => 'hash';
  a.context.fetchUserDoc = () => pending.promise;
  const submitting = a.context.handlePinSubmit({ preventDefault() {} });
  a.context.handlePinBack();
  pending.resolve({ ...profile(), pinHash: 'hash' });
  await submitting;
  assert.equal(a.state.profile, null);
});

test('profile saves completed after sign-out do not restore the old account', async () => {
  const a = app();
  const pending = deferred();
  a.context.updateUserDoc = () => pending.promise;
  a.context.propagateProfileToBlocks = async () => {};
  a.context.propagateProfileToAssists = async () => {};
  a.context.document.getElementById('edit-name').value = 'New Name';
  a.context.document.getElementById('edit-phone').value = '';
  const saving = a.context.handleProfileEditSubmit({ preventDefault() {}, target: element() });
  a.context.clearLocalProfile();
  pending.resolve();
  await saving;
  assert.equal(a.state.profile, null);
});

test('existing accounts cannot be overwritten by stale registration forms', async () => {
  const a = app();
  let writes = 0;
  a.db({ collection: () => ({ doc: () => ({}) }), runTransaction: async (fn) => fn({
    get: async () => snapshot(profile()), set: () => { writes++; },
  }) });
  await assert.rejects(a.context.createUserDoc({ ...profile(), pinHash: 'new' }), { code: 'account-exists' });
  assert.equal(writes, 0);
});

test('client error reports omit query strings and fragments', async () => {
  const a = app();
  const logs = [];
  a.db({ collection: () => ({ add: async (data) => logs.push(data) }) });
  await a.context.logClientError('test', new Error('example'));
  assert.equal(logs[0].url, 'https://example.test/');
});

test('sign-out clears cached admin data and late admin loads cannot refill it', async () => {
  const a = app();
  const pending = deferred();
  let analyticsSignOuts = 0;
  a.context.window.BaserAdminAnalytics = { signOut() { analyticsSignOuts++; } };
  a.state.isAdmin = true;
  a.state.admin.users = [profile()];
  a.state.admin.sessions = [{}];
  a.state.admin.allBlocks = [{}];
  a.state.admin.loaded = true;
  a.db({ collection: () => ({ get: () => pending.promise, where: () => ({ get: () => pending.promise }) }) });
  const loading = a.context.loadAdminData();
  a.context.clearLocalProfile();
  pending.resolve({ forEach(fn) { fn({ id: 'private', data: () => profile() }); } });
  await loading;
  assert.equal(a.state.isAdmin, false);
  assert.equal(a.state.admin.users.length, 0);
  assert.equal(a.state.admin.sessions.length, 0);
  assert.equal(a.state.admin.allBlocks.length, 0);
  assert.equal(a.state.admin.loaded, false);
  assert.equal(analyticsSignOuts, 1);
});

test('blocked browser storage does not prevent sign-in or schedule cloud saving', async () => {
  const a = app();
  a.context.localStorage.setItem = () => { throw new Error('blocked'); };
  a.context.localStorage.getItem = () => { throw new Error('blocked'); };
  a.context.localStorage.removeItem = () => { throw new Error('blocked'); };
  a.context.clearLocalProfile();
  a.context.cacheProfile(profile());
  a.context.refreshAdminState();
  const writes = [];
  a.db({ collection: () => ({ doc: () => ({ update: async (data) => writes.push(data) }) }) });
  a.state.schedule = [entry()];
  assert.equal(await a.context.saveSchedule(), true);
  assert.equal(writes.length, 1);
});

test('a pre-existing named analytics app does not prevent default Firebase startup', () => {
  const a = app();
  const apps = [{ name: 'baser-admin' }];
  a.context.window.FIREBASE_CONFIG = { apiKey: 'fixture-key', projectId: 'fixture-project' };
  a.context.firebase = {
    apps,
    initializeApp() { apps.push({ name: '[DEFAULT]' }); },
    firestore() {
      assert.ok(apps.some((item) => item.name === '[DEFAULT]'));
      return {};
    },
  };
  a.state.firestoreReady = false;
  assert.equal(a.context.initFirestore(), true);
  assert.equal(a.state.firestoreReady, true);
  assert.equal(apps.length, 2);
});
