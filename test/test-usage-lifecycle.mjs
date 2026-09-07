import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUsageTracker } from '../baser/src/analytics.js';
import { USAGE_EVENTS, emptyUsageCounts } from '../usage-metrics.js';

let release;
let id = 0;
const writes = [];
const deferred = new Promise(resolve => { release = resolve; });
const tracker = createUsageTracker({ uuid: () => `session-${++id}`, write: async (sessionId, counts, create) => {
  writes.push({ sessionId, counts: { ...counts }, create });
  if (writes.length === 1) await deferred;
} });
const initialFlush = tracker.flush();
tracker.track('export_started');
void tracker.flush();
tracker.track('export_success');
void tracker.flush();
release();
await initialFlush;
assert.equal(writes.length, 2, 'events arriving during initial SDK/auth connection drain automatically');
assert.equal(writes[1].create, false, 'the second write updates the created session');
assert.equal(writes[1].counts.export_started, 1);
assert.equal(writes[1].counts.export_success, 1);

let finishOld;
let nextId = 0;
const toggledWrites = [];
const oldRequest = new Promise(resolve => { finishOld = resolve; });
const toggled = createUsageTracker({ uuid: () => `toggle-${++nextId}`, write: async (sessionId, counts, create) => {
  toggledWrites.push({ sessionId, counts: { ...counts }, create });
  if (toggledWrites.length === 1) await oldRequest;
} });
const oldFlush = toggled.flush();
toggled.setEnabled(false);
assert.equal(toggled.track('export_success'), false);
toggled.setEnabled(true);
toggled.track('import_success');
void toggled.flush();
finishOld();
await oldFlush;
assert.equal(toggledWrites.length, 2);
assert.notEqual(toggledWrites[0].sessionId, toggledWrites[1].sessionId);
assert.equal(toggledWrites[1].create, true);
assert.equal(toggledWrites[1].counts.import_success, 1);
assert.equal(toggledWrites[1].counts.export_success, 0);

// Exercise the real DOM event wiring with storage writes deliberately blocked.
const handlers = new Map();
const checkbox = { checked: true, disabled: false, addEventListener: (event, fn) => handlers.set(`checkbox:${event}`, fn) };
const browserWrites = [];
const context = vm.createContext({
  USAGE_EVENTS, emptyUsageCounts, console, Date, Set, Math, Promise,
  crypto: { randomUUID: () => 'browser-session' },
  navigator: {}, location: { hostname: 'maxmendelson.com' },
  localStorage: { getItem: () => 'on', setItem: () => { throw new Error('Storage is read-only'); } },
  window: { addEventListener: (event, fn) => handlers.set(`window:${event}`, fn) },
  document: { visibilityState: 'visible', getElementById: () => checkbox, addEventListener: (event, fn) => handlers.set(`document:${event}`, fn) },
  setInterval() {}, browserWrites,
});
const source = fs.readFileSync(new URL('../baser/src/analytics.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '').replaceAll('export function ', 'function ');
vm.runInContext(source, context);
// Replace only the external transport; retain the actual preference/DOM logic.
vm.runInContext(`connect = async () => {
  firebaseDB = {}; firebaseUser = { uid: 'isolated-anonymous-browser' };
  firebaseAPI = {
    doc: (_db, collection, id) => ({collection, id}),
    serverTimestamp: () => 'serverTimestamp',
    setDoc: async (ref, data) => browserWrites.push({ref, data}),
    updateDoc: async (ref, data) => browserWrites.push({ref, data})
  };
}; initUsageAnalytics();`, context);
await vm.runInContext('tracker.flush()', context);
assert.equal(browserWrites.length, 1);
checkbox.checked = false;
handlers.get('checkbox:change')();
vm.runInContext("trackUsage('export_success')", context);
await vm.runInContext('tracker.flush()', context);
assert.equal(browserWrites.length, 1, 'opting out stops requests even when browser storage is read-only');
assert.equal(checkbox.checked, false);
console.log('Usage lifecycle tests passed: in-flight events, opt-out races, and storage-failure privacy.');
