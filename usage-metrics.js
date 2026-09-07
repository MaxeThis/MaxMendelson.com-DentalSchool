// The entire analytics vocabulary. Never accept free-form event properties.
export const USAGE_EVENTS = Object.freeze([
  'import_success', 'import_error', 'export_started', 'export_success',
  'export_error', 'text_applied', 'pattern_changed',
]);

export function emptyUsageCounts() {
  return Object.fromEntries(USAGE_EVENTS.map((name) => [name, 0]));
}

export function summarizeUsage(sessions, days = 30, now = Date.now()) {
  const dayMs = 86400000;
  const today = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(today + 'T00:00:00Z') - (days - 1) * dayMs;
  const daily = Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * dayMs).toISOString().slice(0, 10),
    visitors: new Set(), sessions: 0, exports: 0,
  }));
  const visitors = new Map();
  const online = new Set();
  const counts = emptyUsageCounts();
  let total = 0;
  let activeSeconds = 0;
  const millis = (v) => typeof v?.toMillis === 'function' ? v.toMillis() : Number(v);
  for (const session of sessions) {
    const started = millis(session.startedAt);
    const lastActive = millis(session.lastActiveAt);
    if (!Number.isFinite(started) || started < start || started > now || typeof session.visitorId !== 'string') continue;
    const bucket = daily[Math.floor((started - start) / dayMs)];
    if (!bucket) continue;
    total++;
    visitors.set(session.visitorId, (visitors.get(session.visitorId) || 0) + 1);
    if (lastActive >= now - 120000 && lastActive <= now) online.add(session.visitorId);
    activeSeconds += Math.max(0, Math.min(86400, Number(session.activeSeconds) || 0));
    bucket.sessions++;
    bucket.visitors.add(session.visitorId);
    for (const name of USAGE_EVENTS) counts[name] += Math.max(0, Math.min(10000, Number(session[name]) || 0));
    bucket.exports += Math.max(0, Math.min(10000, Number(session.export_success) || 0));
  }
  return {
    visitors: visitors.size,
    returningVisitors: [...visitors.values()].filter((count) => count > 1).length,
    online: online.size, sessions: total, activeSeconds, counts,
    daily: daily.map((day) => ({ ...day, visitors: day.visitors.size })),
  };
}
