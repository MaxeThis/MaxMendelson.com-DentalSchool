import assert from 'node:assert/strict';
import { createUsageTracker } from '../baser/src/analytics.js';
import { summarizeUsage, USAGE_EVENTS, emptyUsageCounts } from '../usage-metrics.js';

let clock = Date.parse('2026-09-07T12:00:00Z');
let sequence = 0;
const writes = [];
const tracker = createUsageTracker({
  now: () => clock, uuid: () => 'session-' + (++sequence),
  write: async (id, counts, create) => writes.push({ id, ...counts, create }),
});
await tracker.flush();
assert.equal(writes.length, 1, 'opening a page starts one session');
await tracker.flush();
assert.equal(writes.length, 1, 'unchanged sessions do not create extra writes');
assert.equal(tracker.track('Patient name.stl'), false);
tracker.track('export_started');
tracker.track('export_error');
await tracker.flush();
assert.equal(writes.at(-1).export_success, 0, 'failed export is never a successful export');
tracker.track('export_success', { filename: 'sensitive.stl', text: 'Private label' });
clock += 15000;
tracker.tick(true);
await tracker.flush();
assert.equal(writes.at(-1).export_success, 1);
assert.equal(writes.at(-1).activeSeconds, 15);
assert(!JSON.stringify(writes).includes('sensitive'));
assert.deepEqual(Object.keys(writes.at(-1)).sort(), ['id', 'create', 'activeSeconds', ...USAGE_EVENTS].sort());
clock += 15000;
tracker.tick(false);
await tracker.flush();
assert.equal(writes.at(-1).activeSeconds, 15, 'hidden time excluded');
clock += 10 * 60000;
tracker.tick(true);
await tracker.flush();
assert.equal(writes.at(-1).activeSeconds, 15, 'idle time excluded');
clock += 31 * 60000;
tracker.track('import_success');
await tracker.flush();
assert.equal(sequence, 2, 'returning after idle starts a session');
tracker.setEnabled(false);
tracker.track('export_success');
await tracker.flush();
assert.equal(writes.at(-1).export_success, 0, 'opt-out stops events');

let failures = 1;
const retried = [];
const retry = createUsageTracker({ now: () => clock, uuid: () => 'retry', write: async (id, counts) => {
  if (failures > 0) { failures--; throw new Error('offline'); }
  retried.push(counts);
} });
retry.track('export_success');
await retry.flush();
await retry.flush();
assert.equal(retried.length, 1);
assert.equal(retried[0].export_success, 1, 'retries preserve counts');
for (let i = 0; i < 250; i++) retry.track('pattern_changed');
await retry.flush();
assert.equal(retried.at(-1).pattern_changed, 100, 'write deltas respect database cap');
await retry.flush();
await retry.flush();
assert.equal(retried.at(-1).pattern_changed, 250, 'buffered counts drain without loss');

const now = Date.parse('2026-09-07T12:00:00Z');
const session = (id, date, values = {}) => ({ visitorId: id, startedAt: Date.parse(date), lastActiveAt: now - 1000, activeSeconds: 60, ...emptyUsageCounts(), ...values });
const summary = summarizeUsage([
  session('browser-a', '2026-09-07T10:00:00Z', { export_started: 3, export_success: 2, export_error: 1 }),
  session('browser-a', '2026-09-06T10:00:00Z', { export_success: 1 }),
  session('browser-b', '2026-09-05T10:00:00Z'),
  session('old', '2026-08-01T10:00:00Z'),
  session('future', '2026-09-08T10:00:00Z'),
], 7, now);
assert.equal(summary.visitors, 2);
assert.equal(summary.returningVisitors, 1);
assert.equal(summary.sessions, 3);
assert.equal(summary.online, 2);
assert.equal(summary.counts.export_success, 3);
assert.equal(summary.counts.export_error, 1);
assert.equal(summary.activeSeconds, 180);
assert.equal(summary.daily.length, 7);
assert.equal(summary.daily.at(-1).exports, 2);
assert.equal(summary.daily[0].sessions, 0);
console.log('Usage tests passed: payload privacy, failures/retries, sessions, opt-out, active time, bounds, and aggregation.');
