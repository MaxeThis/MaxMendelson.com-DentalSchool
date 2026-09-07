#!/usr/bin/env node
// Calendar Worker unit checks with isolated, mocked upstream services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { timingSafeEqual } = require('node:crypto');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');
const token = 'abcdef0123456789abcdef0123456789';
const endpoint = `https://calendar.example.test/calendar?u=S12345&k=${token}`;
const entry = (changes = {}) => ({ date: '2026-09-08', startTime: '09:00 AM', endTime: '12:00 PM', description: 'Ortho', ...changes });
const doc = (key = token, schedule = [entry()]) => ({ fields: {
  calendarToken: { stringValue: key }, name: { stringValue: 'Test Student' },
  schedule: { arrayValue: { values: schedule.map((value) => ({ mapValue: {
    fields: Object.fromEntries(Object.entries(value).map(([field, text]) => [field, { stringValue: text }])),
  } })) } },
} });

function worker() {
  const context = vm.createContext({
    URL, URLSearchParams, Request, Response, TextEncoder,
    crypto: { subtle: { timingSafeEqual } },
  });
  vm.runInContext(source.replace('export default', 'globalThis.worker ='), context);
  context.getAccessToken = async () => 'mock-service-token';
  context.getUserDoc = async () => doc();
  return context;
}

test('calendar responses prohibit shared storage and expose valid ICS', async () => {
  const context = worker();
  const response = await context.worker.fetch(new Request(endpoint), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match(response.headers.get('Content-Type'), /^text\/calendar/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const body = await response.text();
  assert.ok(body.includes('DTSTART:20260908T090000'));
  assert.ok(body.includes('DTEND:20260908T120000'));
});

test('invalid token shapes are rejected before an upstream read', async () => {
  const context = worker();
  let calls = 0;
  context.getAccessToken = async () => { calls++; };
  for (const key of ['', 'short', 'x'.repeat(1000)]) {
    const response = await context.worker.fetch(new Request(`https://calendar.example.test/calendar?u=S12345&k=${key}`), {});
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal(calls, 0);
});

test('missing users and incorrect keys have the same response', async () => {
  const context = worker();
  context.getUserDoc = async () => null;
  const missing = await context.worker.fetch(new Request(endpoint), {});
  context.getUserDoc = async () => doc('1'.repeat(32));
  const wrong = await context.worker.fetch(new Request(endpoint), {});
  assert.equal(missing.status, 403);
  assert.equal(wrong.status, 403);
  assert.equal(await missing.text(), await wrong.text());
});

test('rotating a token invalidates the old URL on its next request', async () => {
  const context = worker();
  let key = token;
  let reads = 0;
  context.getUserDoc = async () => { reads++; return doc(key); };
  assert.equal((await context.worker.fetch(new Request(endpoint), {})).status, 200);
  key = '0'.repeat(32);
  assert.equal((await context.worker.fetch(new Request(endpoint), {})).status, 403);
  assert.equal(reads, 2);
});

test('upstream exception details are not returned to calendar clients', async () => {
  const context = worker();
  context.getAccessToken = async () => { throw new Error('PRIVATE KEY / internal service details'); };
  const response = await context.worker.fetch(new Request(endpoint), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await response.text(), 'Calendar temporarily unavailable. Please retry later.');
});

test('route/method errors and preflight use consistent private response headers', async () => {
  const context = worker();
  for (const [request, status] of [
    [new Request('https://calendar.example.test/unknown'), 404],
    [new Request(endpoint, { method: 'POST' }), 405],
    [new Request(endpoint, { method: 'OPTIONS' }), 204],
  ]) {
    const response = await context.worker.fetch(request, {});
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('invalid dates, times, and reversed ranges are omitted from calendar exports', () => {
  const context = worker();
  const invalid = [null,
    entry({ date: '2026-02-29' }), entry({ date: '2026-04-31' }),
    entry({ date: '2026-09-08\rBEGIN:VEVENT' }),
    entry({ startTime: '00:30 AM' }), entry({ endTime: '13:00 PM' }),
    entry({ startTime: '09:99 AM' }), entry({ endTime: '08:00 AM' }),
    entry({ endTime: '09:00 AM' }),
  ];
  const text = context.buildIcs('Test', [entry(), ...invalid], '19:00');
  assert.equal(text.split('\r\n').filter((line) => line === 'BEGIN:VEVENT').length, 1);
  assert.ok(text.includes('TRIGGER:-PT14H0M'));
  assert.equal(context.validDate('2028-02-29'), true);
});

test('carriage returns in names and descriptions cannot inject ICS properties', () => {
  const context = worker();
  const text = context.buildIcs('Test\rBEGIN:VEVENT', [entry({ description: 'Ortho\rSUMMARY:Injected\nHello' })], 'off');
  assert.equal(text.split('\r\n').filter((line) => line === 'BEGIN:VEVENT').length, 1);
  assert.ok(text.includes('SUMMARY:Ortho\\nSUMMARY:Injected\\nHello'));
});

test('malformed Firestore schedule values are ignored', () => {
  const context = worker();
  const good = doc().fields.schedule.arrayValue.values[0];
  const entries = context.parseSchedule({ arrayValue: { values: [null, {}, { mapValue: {} }, good] } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-09-08');
});
