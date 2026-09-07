#!/usr/bin/env node
// Firestore inspection/audit tool for the UMSOD Block Exchange.
//
// Reads the live database with a Firebase service-account key so the data can be
// inspected from the command line (the in-app admin sweep already corrects
// mislabeled blocks; this is for *seeing* what's there and verifying).
//
// Zero dependencies — uses Node's built-in crypto + fetch (Node 18+).
//
// Credentials (tried in order):
//   1. gcloud sign-in (recommended — no key file):
//        gcloud auth application-default login
//   2. A service-account key at secrets/firebase-admin.json (gitignored), or
//      GOOGLE_APPLICATION_CREDENTIALS. For read-only access use the "Cloud
//      Datastore Viewer" role; `--fix` needs write ("Cloud Datastore User").
// `audit`, `blocks`, and `schedules` are read-only; only `--fix` writes.
//
// Usage:
//   node tools/firestore-admin.mjs audit          # report block types + unknowns (read-only)
//   node tools/firestore-admin.mjs audit --fix     # also rewrite recoverable types (needs write)
//   node tools/firestore-admin.mjs blocks          # dump all posted blocks
//   node tools/firestore-admin.mjs schedules        # report distinct schedule descriptions

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ---- canonical maps (mirror of app.js — keep in sync) ----
 * The retired merged "Oral Surgery/Urg Care" type and its
 * "ORAL SURGERY/URG CARE BLOCK" description are deliberately absent: a record
 * stored under them could be either Oral Surgery or Urgent Care, so the audit
 * flags them as UNKNOWN for manual re-typing instead of guessing a side. */
const BLOCK_TYPES = [
  'Oral Surgery', 'Urgent Care', 'Ortho', 'Special Care', 'Peds', 'Perio', 'Emergency',
  'On-Call', 'Screening', 'Hospital', 'Pan', 'Mock Boards', 'Education/Other',
  'Shady Grove', 'Clerkship',
];
const TYPE_ALIASES = {
  'Oral Surgery (OS)': 'Oral Surgery',
};
const DESC_TO_TYPE = {
  'ORAL SURGERY BLOCK': 'Oral Surgery',
  'URGENT CARE BLOCK': 'Urgent Care',
  'ORTHO BLOCK': 'Ortho', 'SPECIAL CARE BLOCK': 'Special Care', 'PEDS BLOCK': 'Peds',
  'PERIO BLOCK': 'Perio', 'CLERKSHIP BLOCK': 'Clerkship',
  'EMERGENCY BLOCK': 'Emergency', 'ON-CALL BLOCK': 'On-Call', 'SCREENING BLOCK': 'Screening',
  'HOSPITAL BLOCK': 'Hospital', 'PAN BLOCK': 'Pan', 'MOCK BOARDS BLOCK': 'Mock Boards',
  'EDUCATION/OTHER BLOCK': 'Education/Other', 'SHADY GROVE BLOCK': 'Shady Grove',
};
function resolveType(t) {
  if (!t || typeof t !== 'string') return null;
  const aliased = TYPE_ALIASES[t.trim()] || t.trim();
  if (BLOCK_TYPES.includes(aliased)) return aliased;
  const d = DESC_TO_TYPE[t.trim().toUpperCase()];
  return d || null;
}

/* ---- auth ----
 * Two ways in, tried in order:
 *   1. gcloud CLI sign-in (recommended): `gcloud auth application-default login`.
 *      Uses YOUR Google account + short-lived tokens — no key file on disk.
 *   2. A service-account key file (GOOGLE_APPLICATION_CREDENTIALS or
 *      secrets/firebase-admin.json).
 */
const DEFAULT_PROJECT = 'maxmendelson-com-dental-school';

function gcloud(args) {
  const r = spawnSync('gcloud', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(((r.stderr || (r.error && r.error.message)) || 'gcloud failed').trim());
  return (r.stdout || '').trim();
}

function gcloudProjectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const p = gcloud(['config', 'get-value', 'project']);
    if (p && p !== '(unset)') return p;
  } catch { /* fall through */ }
  return DEFAULT_PROJECT;
}

async function resolveAuth() {
  // 1. gcloud Application Default Credentials (interactive sign-in).
  try {
    const token = gcloud(['auth', 'application-default', 'print-access-token']);
    if (token) return { token, pid: gcloudProjectId(), mode: 'gcloud sign-in (your Google account)' };
  } catch { /* not signed in / gcloud not installed — try a key file */ }

  // 2. Service-account key file.
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(process.cwd(), 'secrets', 'firebase-admin.json');
  if (fs.existsSync(keyPath)) {
    const creds = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const token = await getAccessToken(creds);
    return { token, pid: creds.project_id, mode: `service-account key (${path.basename(keyPath)})` };
  }

  console.error(
    'No credentials found. Pick one:\n' +
    '  • Sign in with the gcloud CLI (recommended):\n' +
    '        gcloud auth application-default login\n' +
    '  • Or drop a service-account key at secrets/firebase-admin.json\n'
  );
  process.exit(1);
}

function signJwt(claim, privateKey) {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const data = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify(claim))}`;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }, creds.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/* ---- Firestore REST ---- */
const BASE = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
const str = (f, k) => (f && f[k] && f[k].stringValue) || '';
const docId = (name) => name.split('/').pop();

async function listAll(pid, token, collection) {
  const out = [];
  let pageToken = '';
  do {
    const url = new URL(`${BASE(pid)}/${collection}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list ${collection} failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const d of data.documents || []) out.push(d);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function patchBlockType(pid, token, id, newType) {
  const url = `${BASE(pid)}/blocks/${id}?updateMask.fieldPaths=type`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { type: { stringValue: newType } } }),
  });
  if (!res.ok) throw new Error(`patch ${id} failed ${res.status}: ${await res.text()}`);
}

/* ---- commands ---- */
async function cmdBlocks(pid, token) {
  const blocks = await listAll(pid, token, 'blocks');
  console.log(`blocks: ${blocks.length}`);
  for (const b of blocks) {
    const f = b.fields || {};
    console.log(`  ${docId(b.name)}  ${str(f, 'date')} ${str(f, 'time')}  ${JSON.stringify(str(f, 'type'))}  ${str(f, 'sNumber')}`);
  }
}

async function cmdSchedules(pid, token) {
  const users = await listAll(pid, token, 'users');
  const counts = new Map();
  let withSchedule = 0;
  for (const u of users) {
    const vals = u.fields && u.fields.schedule && u.fields.schedule.arrayValue && u.fields.schedule.arrayValue.values;
    if (!Array.isArray(vals)) continue;
    withSchedule++;
    for (const v of vals) {
      const desc = (v.mapValue && str(v.mapValue.fields, 'description')) || '';
      counts.set(desc, (counts.get(desc) || 0) + 1);
    }
  }
  console.log(`users: ${users.length} (${withSchedule} with a synced schedule)`);
  const unmapped = [...counts.entries()].filter(([d]) => !DESC_TO_TYPE[d.toUpperCase()]).sort((a, b) => b[1] - a[1]);
  console.log(`\ndistinct schedule descriptions that don't map to a known block type (custom titles are normal):`);
  if (unmapped.length === 0) console.log('  (none)');
  for (const [d, n] of unmapped) console.log(`  ${n.toString().padStart(4)}  ${JSON.stringify(d)}`);
}

async function cmdAudit(pid, token, doFix) {
  const blocks = await listAll(pid, token, 'blocks');
  const byType = new Map();
  const toFix = [];   // { id, from, to }
  const unknown = []; // { id, type, sNumber, date }
  for (const b of blocks) {
    const f = b.fields || {};
    const type = str(f, 'type');
    byType.set(type, (byType.get(type) || 0) + 1);
    const resolved = resolveType(type);
    if (resolved === null) unknown.push({ id: docId(b.name), type, sNumber: str(f, 'sNumber'), date: str(f, 'date') });
    else if (resolved !== type) toFix.push({ id: docId(b.name), from: type, to: resolved });
  }

  console.log(`Posted blocks: ${blocks.length}\n`);
  console.log('By stored type:');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    const note = resolveType(t) === null ? '  ⚠ UNKNOWN' : (resolveType(t) !== t ? `  → ${resolveType(t)}` : '');
    console.log(`  ${n.toString().padStart(4)}  ${JSON.stringify(t)}${note}`);
  }

  console.log(`\nRecoverable (legacy/alias/description-form): ${toFix.length}`);
  for (const x of toFix) console.log(`  ${x.id}  ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`);

  console.log(`\nUnknown (need manual review — NOT auto-fixed): ${unknown.length}`);
  for (const x of unknown) console.log(`  ${x.id}  type=${JSON.stringify(x.type)}  ${x.sNumber}  ${x.date}`);

  if (doFix) {
    if (toFix.length === 0) { console.log('\n--fix: nothing recoverable to rewrite.'); return; }
    console.log(`\n--fix: rewriting ${toFix.length} block type(s)…`);
    for (const x of toFix) { await patchBlockType(pid, token, x.id, x.to); console.log(`  fixed ${x.id} → ${x.to}`); }
    console.log('Done. (Unknown types were left untouched.)');
  } else if (toFix.length) {
    console.log('\n(Read-only. Re-run with --fix to rewrite the recoverable ones — needs a write role.)');
  }
}

/* ---- main ---- */
const cmd = process.argv[2] || 'audit';
const doFix = process.argv.includes('--fix');
const { token, pid, mode } = await resolveAuth();
console.log(`Project: ${pid}   (auth: ${mode})\n`);
if (cmd === 'blocks') await cmdBlocks(pid, token);
else if (cmd === 'schedules') await cmdSchedules(pid, token);
else if (cmd === 'audit') await cmdAudit(pid, token, doFix);
else { console.error(`Unknown command: ${cmd}\nUse: audit [--fix] | blocks | schedules`); process.exit(1); }
