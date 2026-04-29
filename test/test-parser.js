#!/usr/bin/env node
/* Test the schedule parser + ICS generator against the user's actual
 * axiUm screenshot contents. Node stub shims the few browser APIs used
 * by app.js so we can require it without touching Firebase. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- browser shims ---
const stor = {};
const localStorage = {
  getItem: (k) => (k in stor ? stor[k] : null),
  setItem: (k, v) => { stor[k] = String(v); },
  removeItem: (k) => { delete stor[k]; },
};
const document = {
  getElementById: () => ({
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: {},
    dataset: {},
    value: '',
    checked: false,
  }),
  querySelectorAll: () => [],
  createElement: () => ({
    addEventListener: () => {}, appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: {}, dataset: {},
  }),
  addEventListener: () => {},
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
};
const window = {};
const firebase = { apps: [], initializeApp: () => {}, firestore: () => ({}) };

const sandbox = {
  window, document, localStorage, firebase,
  console, setTimeout, clearTimeout,
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  Blob: class {},
  crypto: require('crypto').webcrypto,
  TextEncoder,
};
sandbox.global = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const { parseScheduleText, generateIcs } = sandbox;

// --- sample: exact rows from the user's two screenshots ---
const sample = `
Description  Start       End         From       To         Weekdays  Recur
@BLK-SURGERY  04/15/2026  04/15/2026  09:00 AM  12:00 PM  W   No
@BLK-SURGERY  04/15/2026  04/15/2026  01:00 PM  04:00 PM  W   No
@BLK-SURGERY  04/22/2026  04/22/2026  01:00 PM  04:00 PM  W   Yes
@BLK-SURGERY  04/22/2026  04/22/2026  09:00 AM  12:00 PM  W   Yes
@BLK-SURGERY  04/23/2026  04/23/2026  01:00 PM  04:00 PM  Th  Yes
@BLK-SURGERY  04/24/2026  04/24/2026  01:00 PM  04:00 PM  F   Yes
@BLK-SURGERY  04/24/2026  04/24/2026  09:00 AM  12:00 PM  F   Yes
@BLK-SPC&G    04/27/2026  04/27/2026  02:00 PM  05:00 PM  M   Yes
@BLK-SPC&G    04/27/2026  04/27/2026  09:00 AM  12:00 PM  M   Yes
@BLK-ORTHO    04/29/2026  04/29/2026  01:00 PM  04:00 PM  W   Yes
@BLK-ORTHO    04/29/2026  04/29/2026  09:00 AM  12:00 PM  W   Yes
@BLK-ONCALL   05/04/2026  05/04/2026  02:00 PM  05:00 PM  M   Yes
@BLK-SURGERY  05/05/2026  05/05/2026  09:00 AM  12:00 PM  T   Yes
@BLK-SURGERY  05/05/2026  05/05/2026  01:00 PM  04:00 PM  T   Yes
@BLK-SURGERY  05/06/2026  05/06/2026  01:00 PM  04:00 PM  W   Yes
@BLK-SURGERY  05/06/2026  05/06/2026  09:00 AM  12:00 PM  W   Yes
@EDU-OTHER    05/07/2026  05/07/2026  01:00 PM  05:00 PM  Th  No
@BLK-SURGERY  05/13/2026  05/13/2026  09:00 AM  12:00 PM  W   Yes
@BLK-SURGERY  05/13/2026  05/13/2026  01:00 PM  04:00 PM  W   Yes
@BLK-SURGERY  05/18/2026  05/18/2026  02:00 PM  05:00 PM  M   Yes
@BLK-SURGERY  05/18/2026  05/18/2026  09:00 AM  12:00 PM  M   Yes
@BLK-SURGERY  05/20/2026  05/20/2026  01:00 PM  04:00 PM  W   Yes
@BLK-SURGERY  05/20/2026  05/20/2026  09:00 AM  12:00 PM  W   Yes
@CLIN-EMERG   05/26/2026  05/26/2026  09:00 AM  12:00 PM  T   Yes
@BLK-ONCALL   05/26/2026  05/26/2026  01:00 PM  04:00 PM  T   Yes
@BLK-PEDS     05/27/2026  05/27/2026  01:00 PM  04:00 PM  W   Yes
@BLK-PEDS     05/27/2026  05/27/2026  09:00 AM  12:00 PM  W   Yes
@CLIN-EMERG   05/28/2026  05/28/2026  01:00 PM  04:00 PM  Th  Yes
@BLK-SURGERY  05/29/2026  05/29/2026  01:00 PM  04:00 PM  F   Yes
@BLK-SURGERY  05/29/2026  05/29/2026  09:00 AM  12:00 PM  F   Yes
@BLK-ONCALL   06/04/2026  06/04/2026  09:00 AM  12:00 PM  Th  Yes
@BLK-SURGERY  06/05/2026  06/05/2026  01:00 PM  04:00 PM  F   Yes
@BLK-SURGERY  06/05/2026  06/05/2026  09:00 AM  12:00 PM  F   Yes
@BLK-PEDS     06/08/2026  06/08/2026  09:00 AM  12:00 PM  M   Yes
@BLK-PEDS     06/08/2026  06/08/2026  02:00 PM  05:00 PM  M   Yes
@BLK-ONCALL   06/09/2026  06/09/2026  01:00 PM  04:00 PM  T   Yes
@BLK-SPC&G    06/10/2026  06/10/2026  01:00 PM  04:00 PM  W   Yes
@BLK-SPC&G    06/10/2026  06/10/2026  09:00 AM  12:00 PM  W   Yes
@BLK-ONCALL   06/12/2026  06/12/2026  01:00 PM  04:00 PM  F   Yes
@CLIN-EMERG   06/12/2026  06/12/2026  09:00 AM  12:00 PM  F   Yes
@BLK-SURGERY  06/18/2026  06/18/2026  01:00 PM  04:00 PM  Th  Yes
@BLK-SURGERY  06/25/2026  06/25/2026  01:00 PM  04:00 PM  Th  Yes
@BLK-SURGERY  06/25/2026  06/25/2026  09:00 AM  12:00 PM  Th  Yes
@BLK-ONCALL   06/26/2026  06/26/2026  01:00 PM  04:00 PM  F   Yes
`;

const { entries, errors } = parseScheduleText(sample);

const expectedRows = 44;
console.log(`Parsed: ${entries.length} entries, ${errors.length} errors (expected ${expectedRows} entries, 0 errors)`);
if (errors.length) {
  console.log('\nERRORS:');
  errors.forEach((e) => console.log('  ', JSON.stringify(e)));
}

const fail = [];
if (entries.length !== expectedRows) fail.push(`entry count ${entries.length} != ${expectedRows}`);
if (errors.length !== 0) fail.push(`errors count ${errors.length} != 0`);

// Spot-check a few known mappings.
const first = entries[0];
const spcg = entries.find((e) => e.date === '2026-04-27' && e.startTime.startsWith('09'));
const peds = entries.find((e) => e.date === '2026-06-08' && e.startTime.startsWith('09'));
const edu = entries.find((e) => e.date === '2026-05-07');
const ortho = entries.find((e) => e.date === '2026-04-29' && e.startTime.startsWith('09'));
const oncall = entries.find((e) => e.date === '2026-05-04');
const emerg = entries.find((e) => e.date === '2026-05-26' && e.description.includes('EMERGENCY'));

function check(label, cond) {
  console.log(`  ${cond ? 'OK ' : 'FAIL'} ${label}`);
  if (!cond) fail.push(label);
}

console.log('\nSpot checks:');
check('first row: SURGERY  04/15/2026  09:00 AM → 12:00 PM',
  first && first.description === 'ORAL SURGERY BLOCK' && first.date === '2026-04-15'
  && first.startTime === '09:00 AM' && first.endTime === '12:00 PM');
check('BLK-SPC&G maps to SPECIAL CARE BLOCK', spcg && spcg.description === 'SPECIAL CARE BLOCK');
check('BLK-PEDS maps to PEDS BLOCK', peds && peds.description === 'PEDS BLOCK');
check('BLK-ORTHO maps to ORTHO BLOCK', ortho && ortho.description === 'ORTHO BLOCK');
check('BLK-ONCALL maps to ON-CALL BLOCK', oncall && oncall.description === 'ON-CALL BLOCK');
check('CLIN-EMERG maps to EMERGENCY BLOCK', emerg && emerg.description === 'EMERGENCY BLOCK');
check('EDU-OTHER passes through (no mapping)', edu && edu.description === 'EDU-OTHER');

// --- mis-scan handling: OCR artifacts the scraper should still recognize ---
const misScanSample = `
@BLK-5PC&G    07/01/2026  07/01/2026  09:00 AM  12:00 PM  W   Yes
@BLK-SPCaG    07/02/2026  07/02/2026  09:00 AM  12:00 PM  Th  Yes
@BLK-5PCAG    07/03/2026  07/03/2026  09:00 AM  12:00 PM  F   Yes
| @BLK-PAN    07/06/2026  07/06/2026  09:00 AM  12:00 PM  M   Yes
|| @BLK-PAN   07/07/2026  07/07/2026  01:00 PM  04:00 PM  T   Yes
GBLKONCALL    07/08/2026  07/08/2026  09:00 AM  12:00 PM  W   Yes
`;
const misScan = parseScheduleText(misScanSample);
console.log('\nMis-scan checks:');
console.log(`  Parsed: ${misScan.entries.length} entries, ${misScan.errors.length} errors (expected 6, 0)`);
if (misScan.errors.length) {
  misScan.errors.forEach((e) => console.log('  ERROR:', JSON.stringify(e)));
}
const ms = (d) => misScan.entries.find((e) => e.date === d);
check('BLK-5PC&G (S→5) maps to SPECIAL CARE BLOCK',
  ms('2026-07-01') && ms('2026-07-01').description === 'SPECIAL CARE BLOCK');
check('BLK-SPCaG (&→a) maps to SPECIAL CARE BLOCK',
  ms('2026-07-02') && ms('2026-07-02').description === 'SPECIAL CARE BLOCK');
check('BLK-5PCAG (S→5, &→a) maps to SPECIAL CARE BLOCK',
  ms('2026-07-03') && ms('2026-07-03').description === 'SPECIAL CARE BLOCK');
check('| @BLK-PAN maps to PAN BLOCK',
  ms('2026-07-06') && ms('2026-07-06').description === 'PAN BLOCK');
check('|| @BLK-PAN maps to PAN BLOCK',
  ms('2026-07-07') && ms('2026-07-07').description === 'PAN BLOCK');
check('GBLKONCALL maps to ON-CALL BLOCK',
  ms('2026-07-08') && ms('2026-07-08').description === 'ON-CALL BLOCK');

// --- ICS generation ---
console.log('\nICS generation:');
const ics = generateIcs(entries, 'Max Mendelson', { enabled: true, hour: 19, minute: 0 });
fs.writeFileSync(path.join(__dirname, 'sample.ics'), ics);
const lines = ics.split('\r\n');
const beginCount = lines.filter((l) => l === 'BEGIN:VEVENT').length;
const endCount = lines.filter((l) => l === 'END:VEVENT').length;
const alarmCount = lines.filter((l) => l === 'BEGIN:VALARM').length;
const hasCal = lines[0] === 'BEGIN:VCALENDAR' && lines[lines.length - 1] === 'END:VCALENDAR';
check('wrapped in BEGIN/END VCALENDAR', hasCal);
check(`VEVENT blocks count == entries count (${beginCount} == ${entries.length})`, beginCount === entries.length);
check(`VEVENT BEGIN == END (${beginCount} == ${endCount})`, beginCount === endCount);
check(`VALARM blocks count == entries count (${alarmCount} == ${entries.length})`, alarmCount === entries.length);
check('TRIGGER is -PT14H0M (14h before 9am = 7pm prior day)',
  lines.includes('TRIGGER:-PT14H0M'));

// --- ICS without reminder ---
const icsNoReminder = generateIcs(entries, 'Max', null);
check('no-reminder ICS has no VALARM',
  !icsNoReminder.split('\r\n').includes('BEGIN:VALARM'));

console.log(`\n${fail.length === 0 ? 'ALL PASS' : 'FAILURES: ' + fail.length}`);
process.exit(fail.length === 0 ? 0 : 1);
