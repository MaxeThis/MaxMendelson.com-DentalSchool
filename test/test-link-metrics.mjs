import assert from 'node:assert/strict';
import { summarizeLinks } from '../link-metrics.js';

const now = Date.parse('2026-11-03T15:00:00Z');
const at = (iso) => ({ toMillis: () => Date.parse(iso) });
const events = [
  { kind: 'view', page: 'links', link: '', visitorId: 'a', device: 'phone', source: 'instagram', at: at('2026-11-03T10:00:00Z') },
  { kind: 'view', page: 'links', link: '', visitorId: 'a', device: 'phone', source: 'instagram', at: at('2026-11-02T10:00:00Z') },
  { kind: 'view', page: 'housemaxer', link: '', visitorId: 'b', device: 'desktop', source: 'site', at: at('2026-11-03T11:00:00Z') },
  { kind: 'click', page: 'links', link: 'housemaxer', visitorId: 'a', at: at('2026-11-03T10:01:00Z') },
  { kind: 'click', page: 'housemaxer', link: 'esp32', visitorId: 'b', at: at('2026-11-03T11:01:00Z') },
  { kind: 'click', page: 'housemaxer', link: 'esp32', visitorId: 'a', at: at('2026-11-03T11:02:00Z') },
  { kind: 'click', page: 'housemaxer', link: 'esp32', visitorId: 'a', at: at('2026-11-03T11:03:00Z') },
  // Outside the 7-day window, in the future, or malformed: ignored.
  { kind: 'view', page: 'links', link: '', visitorId: 'c', device: 'phone', source: 'direct', at: at('2026-10-01T10:00:00Z') },
  { kind: 'view', page: 'links', link: '', visitorId: 'c', device: 'phone', source: 'direct', at: at('2026-11-04T10:00:00Z') },
  { kind: 'click', page: 'links', link: 'x', visitorId: 7, at: at('2026-11-03T10:00:00Z') },
];
const s = summarizeLinks(events, 7, now);
assert.equal(s.opens, 3);
assert.equal(s.clicks, 4);
assert.equal(s.visitors, 2);
assert.deepEqual(s.links[0], { page: 'housemaxer', link: 'esp32', clicks: 3, visitors: 2 });
assert.deepEqual(s.links[1], { page: 'links', link: 'housemaxer', clicks: 1, visitors: 1 });
assert.deepEqual(s.pages, [{ page: 'links', opens: 2, visitors: 1 }, { page: 'housemaxer', opens: 1, visitors: 1 }]);
assert.deepEqual(s.sources, [{ name: 'instagram', count: 2 }, { name: 'site', count: 1 }]);
assert.deepEqual(s.devices, [{ name: 'phone', count: 2 }, { name: 'desktop', count: 1 }]);
assert.equal(s.daily.length, 7);
assert.deepEqual(s.daily.at(-1), { date: '2026-11-03', opens: 2, clicks: 4 });
assert.deepEqual(s.daily.at(-2), { date: '2026-11-02', opens: 1, clicks: 0 });
assert.equal(summarizeLinks([], 30, now).opens, 0);
console.log('link metrics tests passed');
