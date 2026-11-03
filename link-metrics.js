// Summaries of /links page opens and clicks (linkEvents) for the admin panel.

export function summarizeLinks(events, days = 30, now = Date.now()) {
  const dayMs = 86400000;
  const today = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(today + 'T00:00:00Z') - (days - 1) * dayMs;
  const daily = Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * dayMs).toISOString().slice(0, 10), opens: 0, clicks: 0,
  }));
  const millis = (v) => typeof v?.toMillis === 'function' ? v.toMillis() : Number(v);
  const pages = new Map();
  const links = new Map();
  const sources = new Map();
  const devices = new Map();
  const visitors = new Set();
  let opens = 0;
  let clicks = 0;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const e of events) {
    const at = millis(e.at);
    if (!Number.isFinite(at) || at < start || at > now || typeof e.visitorId !== 'string') continue;
    const day = daily[Math.floor((at - start) / dayMs)];
    if (!day) continue;
    visitors.add(e.visitorId);
    if (e.kind === 'view') {
      opens++;
      day.opens++;
      if (!pages.has(e.page)) pages.set(e.page, { page: e.page, opens: 0, visitors: new Set() });
      const p = pages.get(e.page);
      p.opens++;
      p.visitors.add(e.visitorId);
      bump(sources, e.source);
      bump(devices, e.device);
    } else if (e.kind === 'click' && e.link) {
      clicks++;
      day.clicks++;
      const key = `${e.page}:${e.link}`;
      if (!links.has(key)) links.set(key, { page: e.page, link: e.link, clicks: 0, visitors: new Set() });
      const l = links.get(key);
      l.clicks++;
      l.visitors.add(e.visitorId);
    }
  }
  const counted = (map) => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    opens, clicks, visitors: visitors.size,
    pages: [...pages.values()].map((p) => ({ page: p.page, opens: p.opens, visitors: p.visitors.size })).sort((a, b) => b.opens - a.opens),
    links: [...links.values()].map((l) => ({ page: l.page, link: l.link, clicks: l.clicks, visitors: l.visitors.size }))
      .sort((a, b) => b.clicks - a.clicks || a.link.localeCompare(b.link)),
    sources: counted(sources), devices: counted(devices), daily,
  };
}
