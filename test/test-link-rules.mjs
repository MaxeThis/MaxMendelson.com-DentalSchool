#!/usr/bin/env node
// Firestore rules for linkEvents (the /links tracker). Emulator only.
// FIREBASE_EMULATORS_PATH=/tmp/baser-firebase-emulators firebase emulators:exec \
//   --only firestore --project demo-baser-analytics --config firebase.analytics.json \
//   'node test/test-link-rules.mjs'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const host = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(host || '', /^(127\.0\.0\.1|localhost):\d+$/, 'A local Firestore emulator is required. This test never contacts production.');
const project = 'demo-baser-analytics';
const db = `projects/${project}/databases/(default)`;
const base = `http://${host}/v1/${db}/documents`;
const now = Math.floor(Date.now() / 1000);
function jwt(uid, provider = 'anonymous', extra = {}) {
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iss: `https://securetoken.google.com/${project}`, aud: project, auth_time: now, iat: now, exp: now + 3600, sub: uid, user_id: uid, firebase: { sign_in_provider: provider, identities: {} }, ...extra })}.`;
}
const visitor = 'links-anonymous-browser';
const anon = jwt(visitor);
const owner = jwt('owner-google-uid', 'google.com', { email: 'maxethis@gmail.com', email_verified: true });
const stranger = jwt('stranger', 'google.com', { email: 'not-owner@example.com', email_verified: true });

function event(overrides = {}) {
  return { schemaVersion: 1, visitorId: visitor, page: 'links', kind: 'click', link: 'periomaxer', device: 'phone', source: 'instagram', ...overrides };
}
function fields(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Number.isInteger(v) ? { integerValue: String(v) } : { stringValue: v }]));
}
async function request(url, { method = 'GET', token, body } = {}) {
  const res = await fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: await res.json() };
}
function write(id, data, { token = anon, serverTime = true, exists = false } = {}) {
  return request(`${base}:commit`, { method: 'POST', token, body: { writes: [{
    update: { name: `${db}/documents/linkEvents/${id}`, fields: fields(data) },
    updateTransforms: serverTime ? [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] : [],
    currentDocument: { exists },
  }] } });
}
async function allowed(label, operation) {
  const r = await operation;
  assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.data)}`);
  console.log(`PASS ${label}`);
}
async function denied(label, operation) {
  const r = await operation;
  assert.equal(r.status, 403, `${label}: expected permission denied, got ${r.status}: ${JSON.stringify(r.data)}`);
  console.log(`PASS ${label}`);
}

const id = randomUUID();
await allowed('anonymous visitor records a link click', write(id, event()));
await allowed('anonymous visitor records a page open', write(randomUUID(), event({ kind: 'view', link: '', page: 'housemaxer', source: 'direct', device: 'desktop' })));
await allowed('part keys are valid link ids', write(randomUUID(), event({ page: 'housemaxer', link: 'roborock_qrevo_plus' })));
await allowed('verified owner can read events', request(`${base}/linkEvents/${id}`, { token: owner }));
await denied('visitor cannot read events', request(`${base}/linkEvents/${id}`, { token: anon }));
await denied('other verified account cannot read events', request(`${base}/linkEvents/${id}`, { token: stranger }));
await denied('signed-out request cannot write', write(randomUUID(), event(), { token: null }));
await denied('non-anonymous account cannot write', write(randomUUID(), event({ visitorId: 'stranger' }), { token: stranger }));
await denied('visitor cannot write as another visitor', write(randomUUID(), event({ visitorId: 'someone-else' })));
await denied('events cannot be updated', write(id, event({ link: 'readymaxer' }), { exists: true }));
await denied('events cannot be deleted', request(`${base}/linkEvents/${id}`, { method: 'DELETE', token: anon }));
await denied('client time is rejected', write(randomUUID(), { ...event(), at: 'now' }, { serverTime: false }));
await denied('event id must be a UUID', write('not-a-uuid', event()));
await denied('extra fields are rejected', write(randomUUID(), { ...event(), url: 'https://example.com' }));
await denied('unknown page is rejected', write(randomUUID(), event({ page: 'admin' })));
await denied('unknown kind is rejected', write(randomUUID(), event({ kind: 'purchase' })));
await denied('click needs a link id', write(randomUUID(), event({ link: '' })));
await denied('page open carries no link id', write(randomUUID(), event({ kind: 'view' })));
await denied('link id must be a short slug', write(randomUUID(), event({ link: 'https://amazon.com/x' })));
await denied('device must be a known class', write(randomUUID(), event({ device: 'Mozilla/5.0 (iPhone)' })));
await denied('source must be a known category', write(randomUUID(), event({ source: 'https://l.instagram.com/?u=x' })));
await denied('schema version is fixed', write(randomUUID(), event({ schemaVersion: 2 })));
console.log('All link rules tests passed.');
