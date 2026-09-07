// Cloudflare Worker — live ICS feed for the UMSOD Block Exchange.
//
//   GET /calendar?u=S12345&k=<token>[&reminder=HH:MM]
//
// Reads users/{u}.schedule from Firestore using a Google service account
// (server-to-server, so it bypasses security rules and App Check) and returns a
// live `text/calendar` feed. Calendar apps poll the URL automatically — Apple
// every few hours, Google ~daily — so edits on the site flow through without
// re-downloading. The per-user secret token (stored on the user doc) gates
// access; resetting it on the site invalidates the old link.
//
// Secrets / vars (see worker/README.md):
//   GCP_PROJECT_ID    (var)    e.g. maxmendelson-com-dental-school
//   GCP_CLIENT_EMAIL  (secret) service-account email
//   GCP_PRIVATE_KEY   (secret) service-account private key (PEM)

let cachedToken = null; // { value, exp } — reused across requests in this isolate

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return feedResponse(null, 204);
    }
    if (request.method !== 'GET') {
      return feedResponse('Method not allowed', 405, { Allow: 'GET, OPTIONS' });
    }
    const url = new URL(request.url);
    if (!/^\/calendar(\.ics)?$/.test(url.pathname)) {
      return feedResponse('Not found', 404);
    }

    const u = (url.searchParams.get('u') || '').toUpperCase();
    const k = url.searchParams.get('k') || '';
    const reminder = url.searchParams.get('reminder') || '';
    if (!/^S\d{5}$/.test(u) || !/^[a-f0-9]{32}$/.test(k)) {
      return feedResponse('Bad request — use ?u=S##### & k=<token>', 400);
    }

    try {
      const accessToken = await getAccessToken(env);
      const doc = await getUserDoc(env, accessToken, u);
      const fields = (doc && doc.fields) || {};
      const token = fields.calendarToken && fields.calendarToken.stringValue;
      if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)
          || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(token), new TextEncoder().encode(k))) {
        // A missing account and an incorrect key have the same response.
        return feedResponse('Invalid or missing key', 403);
      }

      const name = (fields.name && fields.name.stringValue) || 'Block';
      const schedule = parseSchedule(fields.schedule);
      const ics = buildIcs(name, schedule, reminder);
      return feedResponse(ics, 200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="umsod-blocks.ics"',
      });
    } catch (_) {
      return feedResponse('Calendar temporarily unavailable. Please retry later.', 503);
    }
  },
};

function feedResponse(body, status, headers = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    // Shared caching could keep a revoked calendar URL working after reset.
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    ...headers,
  } });
}

/* ----------------------------- Google auth ----------------------------- */

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;

  const jwt = await signJwt({
    iss: env.GCP_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, env.GCP_PRIVATE_KEY);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error('OAuth token exchange failed (' + res.status + ')');
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.value;
}

function b64url(input) {
  const bin = typeof input === 'string'
    ? input
    : String.fromCharCode(...new Uint8Array(input));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(claim, privateKeyPem) {
  const enc = new TextEncoder();
  const data = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function importPrivateKey(pem) {
  const body = (pem || '')
    .replace(/\\n/g, '\n')                       // tolerate single-line secrets with escaped newlines
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/* ----------------------------- Firestore ----------------------------- */

async function getUserDoc(env, accessToken, sNumber) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}` +
    `/databases/(default)/documents/users/${encodeURIComponent(sNumber)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read failed (' + res.status + ')');
  return res.json();
}

function parseSchedule(scheduleField) {
  const values = scheduleField && scheduleField.arrayValue && scheduleField.arrayValue.values;
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const v of values) {
    const f = v && v.mapValue && v.mapValue.fields;
    if (!f) continue;
    const get = (key) => (f[key] && typeof f[key].stringValue === 'string' && f[key].stringValue) || '';
    const date = get('date');
    const startTime = get('startTime');
    const endTime = get('endTime');
    if (date && startTime && endTime) {
      out.push({ date, startTime, endTime, description: get('description') });
    }
  }
  return out;
}

/* ----------------------------- ICS (mirrors app.js generateIcs) ----------------------------- */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function parseTime12(t) {
  if (typeof t !== 'string') return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])[Mm]?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 1 || h > 12 || min < 0 || min > 59) return null;
  const ap = m[3].toUpperCase();
  if (h === 12) h = 0;
  if (ap === 'P') h += 12;
  return { h, min };
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === mo - 1 && parsed.getUTCDate() === d;
}

// Floating local time (no Z / no TZID), exactly like app.js icsDateTime().
function localStamp(date, t) {
  const [y, mo, d] = date.split('-').map(Number);
  return `${y}${pad2(mo)}${pad2(d)}T${pad2(t.h)}${pad2(t.min)}00`;
}

function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

// Deterministic UID identical to app.js icsUid() so the live feed and the
// downloaded file address the same events.
function icsUid(name, ev) {
  const seed = `${name || ''}|${ev.date}|${ev.startTime}|${ev.endTime}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${seed}@umsod-block-exchange`;
}

function parseReminder(p) {
  if (!p || p === 'off' || p === '0') return null;
  const m = p.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = +m[1];
  const minute = +m[2];
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function buildIcs(name, schedule, reminderParam) {
  const reminder = parseReminder(reminderParam);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ScheduleMaxer//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)} Block Schedule`,
  ];
  const dtstamp = utcStamp(new Date());

  const items = (Array.isArray(schedule) ? schedule : [])
    .map((ev) => {
      if (!ev || !validDate(ev.date)) return null;
      const s = parseTime12(ev.startTime);
      const e = parseTime12(ev.endTime);
      return s && e && e.h * 60 + e.min > s.h * 60 + s.min ? { ev, s, e } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.ev.date !== b.ev.date) return a.ev.date < b.ev.date ? -1 : 1;
      return (a.s.h * 60 + a.s.min) - (b.s.h * 60 + b.s.min);
    });

  for (const { ev, s, e } of items) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsUid(name, ev)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${localStamp(ev.date, s)}`);
    lines.push(`DTEND:${localStamp(ev.date, e)}`);
    lines.push(`SUMMARY:${icsEscape(ev.description)}`);
    lines.push(`DESCRIPTION:${icsEscape(ev.description + ' - ' + name)}`);
    lines.push('STATUS:CONFIRMED');
    if (reminder) {
      const [y, mo, d] = ev.date.split('-').map(Number);
      const start = new Date(Date.UTC(y, mo - 1, d, s.h, s.min, 0));
      const night = new Date(start);
      night.setUTCDate(night.getUTCDate() - 1);
      night.setUTCHours(reminder.hour, reminder.minute, 0, 0);
      const offsetSec = Math.max(0, Math.floor((start - night) / 1000));
      const hh = Math.floor(offsetSec / 3600);
      const mm = Math.floor((offsetSec % 3600) / 60);
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${icsEscape('Reminder: ' + ev.description + ' tomorrow')}`);
      lines.push(`TRIGGER:-PT${hh}H${mm}M`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
