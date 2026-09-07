#!/usr/bin/env node
// Run through the Firestore emulator; no SDK dependencies or live credentials.
// FIREBASE_EMULATORS_PATH=/tmp/baser-firebase-emulators firebase emulators:exec \
//   --only firestore --project demo-baser-analytics --config firebase.analytics.json \
//   'node test/test-analytics-rules.mjs'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const host = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host || '', /^(127\.0\.0\.1|localhost):\d+$/, 'A local Firestore emulator is required. This test never contacts production.');
const project = 'demo-baser-analytics';
const db = `projects/${project}/databases/(default)`;
const base = `http://${host}/v1/${db}/documents`;
const counters = ['import_success', 'import_error', 'export_started', 'export_success', 'export_error', 'text_applied', 'pattern_changed'];
const visitor = 'baser-anonymous-browser';
const now = Math.floor(Date.now() / 1000);
function jwt(uid, provider = 'anonymous', extra = {}) {
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iss: `https://securetoken.google.com/${project}`, aud: project, auth_time: now, iat: now, exp: now + 3600, sub: uid, user_id: uid, firebase: { sign_in_provider: provider, identities: {} }, ...extra })}.`;
}
const anon = jwt(visitor);
const otherAnon = jwt('another-browser');
const owner = jwt('owner-google-uid', 'google.com', { email: 'maxethis@gmail.com', email_verified: true });
const emailOwner = jwt('owner-email-uid', 'password', { email: 'maxethis@gmail.com', email_verified: true });
const stranger = jwt('stranger-google-uid', 'google.com', { email: 'not-owner@example.com', email_verified: true });
function encodeFields(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k,
    Number.isInteger(v) ? { integerValue: String(v) } : typeof v === 'number' ? { doubleValue: v } : typeof v === 'string' ? { stringValue: v } : v,
  ]));
}
function session(overrides = {}) {
  return { schemaVersion: 1, visitorId: visitor, activeSeconds: 0, ...Object.fromEntries(counters.map(k => [k, 0])), ...overrides };
}
async function request(url, { method = 'GET', token, body } = {}) {
  const res = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
async function write(id, data, { token = anon, create = true, serverTime = true } = {}) {
  const doc = `${db}/documents/baserUsageSessions/${id}`;
  return request(`${base}:commit`, { method: 'POST', token, body: { writes: [{ update: { name: doc, fields: encodeFields(data) }, updateTransforms: serverTime ? [{ fieldPath: 'lastActiveAt', setToServerValue: 'REQUEST_TIME' }, ...(create ? [{ fieldPath: 'startedAt', setToServerValue: 'REQUEST_TIME' }] : [])] : [], currentDocument: { exists: !create } }] } });
}
async function allowed(label, operation) {
  const r = await operation;
  assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.data)}`);
  console.log(`PASS ${label}`);
  return r.data;
}
async function denied(label, operation) {
  const r = await operation;
  assert.equal(r.status, 403, `${label}: expected permission denied, got ${r.status}: ${JSON.stringify(r.data)}`);
  console.log(`PASS ${label}`);
}
const id = randomUUID();
await allowed('anonymous visitor creates its own session with server timestamps', write(id, session()));
const readUrl = `${base}/baserUsageSessions/${id}`;
const stored = await allowed('verified Google owner can read session', request(readUrl, { token: owner }));
await allowed('verified email-link owner can read session', request(readUrl, { token: emailOwner }));
await denied('unverified email/password owner cannot read session', request(readUrl, { token: jwt('unverified-owner', 'password', { email: 'maxethis@gmail.com', email_verified: false }) }));
await denied('verified unrelated email account cannot read session', request(readUrl, { token: jwt('verified-stranger', 'password', { email: 'stranger@example.com', email_verified: true }) }));
const startedAt = stored.fields.startedAt;
await denied('anonymous visitor cannot read even its own analytics', request(readUrl, { token: anon }));
await denied('unauthenticated visitor cannot read analytics', request(readUrl));
await denied('unrelated Google account cannot read analytics', request(readUrl, { token: stranger }));
await denied('unverified owner cannot read analytics', request(readUrl, { token: jwt('owner', 'google.com', { email: 'maxethis@gmail.com', email_verified: false }) }));
await denied('anonymous claim with owner email cannot read analytics', request(readUrl, { token: jwt(visitor, 'anonymous', { email: 'maxethis@gmail.com', email_verified: true }) }));
await allowed('owner can query by session date', request(`${base}:runQuery`, { method: 'POST', token: owner, body: { structuredQuery: { from: [{ collectionId: 'baserUsageSessions' }], where: { fieldFilter: { field: { fieldPath: 'startedAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: '2020-01-01T00:00:00Z' } } }, orderBy: [{ field: { fieldPath: 'startedAt' }, direction: 'DESCENDING' }], limit: 100 } } }));
await denied('anonymous visitor cannot list analytics', request(`${base}/baserUsageSessions`, { token: anon }));
await denied('unauthenticated visitor cannot create analytics', write(randomUUID(), session(), { token: null }));
await denied('Google auth cannot create visitor analytics', write(randomUUID(), session({ visitorId: 'owner-google-uid' }), { token: owner }));
await denied('visitor cannot spoof another visitor ID', write(randomUUID(), session({ visitorId: 'someone-else' })));
await denied('session IDs cannot contain names or filenames', write('patient-scan-stl', session()));
for (const key of ['filename', 'model', 'text', 'sNumber', 'email', 'patternName']) {
  await denied(`extra ${key} field rejected`, write(randomUUID(), session({ [key]: 'must-never-be-stored' })));
}
await denied('missing counter field rejected', write(randomUUID(), Object.fromEntries(Object.entries(session()).filter(([key]) => key !== 'export_success'))));
await denied('unsupported schema version rejected', write(randomUUID(), session({ schemaVersion: 2 })));
await denied('negative counters rejected', write(randomUUID(), session({ export_success: -1 })));
await denied('noninteger counters rejected', write(randomUUID(), session({ export_success: 1.5 })));
await denied('excessive initial counters rejected', write(randomUUID(), session({ export_success: 101 })));
await denied('client timestamps rejected', write(randomUUID(), session({ startedAt: { timestampValue: '2025-01-01T00:00:00Z' }, lastActiveAt: { timestampValue: '2025-01-01T00:00:00Z' } }), { serverTime: false }));
const updated = session({ startedAt, export_started: 2, export_success: 1, activeSeconds: 60 });
await allowed('same visitor updates counters and foreground seconds', write(id, updated, { create: false }));
await denied('another visitor cannot update the session', write(id, { ...updated, visitorId: 'another-browser', export_success: 2 }, { create: false, token: otherAnon }));
await denied('visitor cannot change session start', write(id, { ...updated, startedAt: { timestampValue: '2025-01-01T00:00:00Z' } }, { create: false }));
await denied('counters cannot decrease', write(id, { ...updated, export_success: 0 }, { create: false }));
await denied('counters cannot jump by more than 100', write(id, { ...updated, export_success: 102 }, { create: false }));
await denied('counter total bounded', write(id, { ...updated, export_success: 10001 }, { create: false }));
await denied('active seconds cannot decrease', write(id, { ...updated, activeSeconds: 59 }, { create: false }));
await denied('active seconds update bounded', write(id, { ...updated, activeSeconds: 181 }, { create: false }));
await denied('delete denied for visitor', request(readUrl, { method: 'DELETE', token: anon }));
await denied('delete denied for owner', request(readUrl, { method: 'DELETE', token: owner }));
await denied('owner cannot mutate counters', write(id, updated, { create: false, token: owner }));
for (const type of ['Perio', 'Clerkship', 'Shady Grove']) {
  await allowed(`existing app block type ${type} passes server validation`, request(`${base}/blocks?documentId=${randomUUID()}`, {
    method: 'POST', token: anon, body: { fields: encodeFields({
      date: '2026-09-07', time: 'morning', type, name: 'Emulator fixture', sNumber: 'S00000', phone: '', notes: '', createdAt: 1,
    }) },
  }));
}
console.log('Analytics rules privacy, ownership, aggregation queries, and counter validation passed.');
