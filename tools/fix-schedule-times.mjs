#!/usr/bin/env node
// One-time repair of garbled schedule START times across all users' schedules.
// The scanner read "09:00 AM" as "03:00 AM"/"05:00 AM"; the end (12:00 PM) is
// reliable, so we realign the start to the matching slot. Mirrors app.js
// alignStartTime() — the app self-heals this on load too; this just fixes every
// user's stored data at once.
//
// Auth: gcloud Application Default Credentials (same as firestore-admin.mjs).
//   node tools/fix-schedule-times.mjs           # dry run (read-only)
//   node tools/fix-schedule-times.mjs --fix      # write the corrections

import { spawnSync } from 'node:child_process';

const PID = process.env.GOOGLE_CLOUD_PROJECT || 'maxmendelson-com-dental-school';
const DO_FIX = process.argv.includes('--fix');

const VALID_STARTS = new Set(['08:00 AM', '09:00 AM', '10:00 AM', '01:00 PM', '02:00 PM']);
const END_TO_START = { '12:00 PM': '09:00 AM', '10:00 AM': '08:00 AM', '04:00 PM': '01:00 PM' };
const alignStart = (s, e) => (VALID_STARTS.has(s) ? s : (END_TO_START[e] || s));

function gcloud(args) {
  const r = spawnSync('gcloud', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(((r.stderr || (r.error && r.error.message)) || 'gcloud failed').trim());
  return (r.stdout || '').trim();
}
const token = gcloud(['auth', 'application-default', 'print-access-token']);
const BASE = `https://firestore.googleapis.com/v1/projects/${PID}/databases/(default)/documents`;
const str = (f, k) => (f && f[k] && f[k].stringValue) || '';
const docId = (name) => name.split('/').pop();

async function listUsers() {
  const out = [];
  let pageToken = '';
  do {
    const url = new URL(`${BASE}/users`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list users failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const d of data.documents || []) out.push(d);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function patchSchedule(id, scheduleValue) {
  // scheduleValue is the full typed field value, i.e. { arrayValue: { values: [...] } }.
  const url = `${BASE}/users/${id}?updateMask.fieldPaths=schedule`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { schedule: scheduleValue } }),
  });
  if (!res.ok) throw new Error(`patch ${id} failed ${res.status}: ${await res.text()}`);
}

console.log(`Project: ${PID}   mode: ${DO_FIX ? 'FIX (writing)' : 'dry run'}\n`);
const users = await listUsers();
let totalFixed = 0;
let usersTouched = 0;

for (const u of users) {
  const sched = u.fields && u.fields.schedule;
  const vals = sched && sched.arrayValue && sched.arrayValue.values;
  if (!Array.isArray(vals)) continue;
  let userChanges = 0;
  for (const v of vals) {
    const f = v.mapValue && v.mapValue.fields;
    if (!f || !f.startTime) continue;
    const s = str(f, 'startTime');
    const e = str(f, 'endTime');
    const fixed = alignStart(s, e);
    if (fixed !== s) {
      console.log(`  ${str(u.fields, 'sNumber')}  ${str(f, 'date')}  ${JSON.stringify(str(f, 'description'))}  ${s} -> ${fixed}  (end ${e})`);
      f.startTime.stringValue = fixed; // mutate the typed value in place
      userChanges++;
    }
  }
  if (userChanges > 0) {
    totalFixed += userChanges;
    usersTouched++;
    if (DO_FIX) await patchSchedule(docId(u.name), sched);
  }
}

console.log(`\n${DO_FIX ? 'Fixed' : 'Would fix'} ${totalFixed} entr${totalFixed === 1 ? 'y' : 'ies'} across ${usersTouched} user(s).`);
if (!DO_FIX && totalFixed) console.log('Re-run with --fix to apply.');
