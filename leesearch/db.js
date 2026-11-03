// Leesearch data layer. Three backends with the same small API:
//   Firebase (the live site, and localhost ?live), Local (localhost: one JSON file on this PC,
//   kept by local_server.py), and Mock (localhost ?mock=1: localStorage shared between tabs,
//   so two tabs can play Max and Dr. Lee).
// Paths are slash strings: 'leesearch_papers/aaoms/blocks/b001'.
(function () {
  const DELETE = { __delete: true };
  const parent = (p) => p.split('/').slice(0, -1).join('/');
  const apply = (old, data, merge) => {
    const out = merge || old === undefined ? { ...(old || {}) } : {};
    if (!merge && old !== undefined) Object.assign(out, {});
    for (const [k, v] of Object.entries(data)) {
      if (k.includes('.')) {
        const [a, b] = k.split('.');
        out[a] = { ...(out[a] || {}) };
        if (v === DELETE) delete out[a][b]; else out[a][b] = v;
      } else if (v === DELETE) delete out[k];
      else out[k] = v;
    }
    return out;
  };
  const rid = () => Math.random().toString(36).slice(2, 12);

  function firebaseBackend() {
    const app = firebase.apps.find((a) => a.name === 'leesearch') || firebase.initializeApp(window.FIREBASE_CONFIG, 'leesearch');
    if (window.RECAPTCHA_V3_SITE_KEY && app.appCheck) {
      try { app.appCheck().activate(window.RECAPTCHA_V3_SITE_KEY, true); } catch (e) { console.warn('App Check', e); }
    }
    const auth = app.auth();
    const fs = app.firestore();
    const FV = firebase.firestore.FieldValue;
    const conv = (data) => {
      const out = {};
      for (const [k, v] of Object.entries(data)) out[k] = v === DELETE ? FV.delete() : v;
      return out;
    };
    const ref = (p) => fs.doc(p);
    return {
      kind: 'firebase',
      onAuth: (cb) => auth.onAuthStateChanged((u) => cb(u ? { uid: u.uid, email: u.email } : null)),
      signIn: (email, pw) => auth.signInWithEmailAndPassword(email, pw),
      signOut: () => auth.signOut(),
      listen(colPath, cb, onErr) {
        return fs.collection(colPath).onSnapshot((snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
          (e) => { console.error(colPath, e); onErr && onErr(e); });
      },
      async get(p) { const s = await ref(p).get(); return s.exists ? { id: s.id, ...s.data() } : null; },
      set: (p, data, merge = false) => ref(p).set(conv(data), { merge }),
      update: (p, data) => ref(p).update(conv(data)),
      async add(colPath, data) { const r = await fs.collection(colPath).add(conv(data)); return r.id; },
      newId: (colPath) => fs.collection(colPath).doc().id,
      del: (p) => ref(p).delete(),
      // fn(current|null) returns {data, merge} or throws
      tx: (p, fn) => fs.runTransaction(async (t) => {
        const s = await t.get(ref(p));
        const res = fn(s.exists ? { id: s.id, ...s.data() } : null);
        if (res && res.data) t.set(ref(p), conv(res.data), { merge: !!res.merge });
        return res && res.value;
      }),
      async batch(ops) {
        const b = fs.batch();
        for (const o of ops) {
          if (o.op === 'set') b.set(ref(o.path), conv(o.data), { merge: !!o.merge });
          else if (o.op === 'update') b.update(ref(o.path), conv(o.data));
          else if (o.op === 'del') b.delete(ref(o.path));
        }
        await b.commit();
      },
    };
  }

  function mockBackend() {
    const KEY = 'leesearch-mock-db';
    const ch = new BroadcastChannel('leesearch-mock');
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
    const save = (db) => { localStorage.setItem(KEY, JSON.stringify(db)); ch.postMessage('x'); fire(); };
    const listeners = new Set();
    function fire() { for (const l of listeners) l(); }
    ch.onmessage = fire;
    let authCb = null;
    const user = () => { try { return JSON.parse(sessionStorage.getItem('leesearch-mock-user')); } catch { return null; } };
    return {
      kind: 'mock',
      onAuth(cb) { authCb = cb; setTimeout(() => cb(user()), 0); },
      async signIn(email) { const u = { uid: 'mock-' + email.split('@')[0], email }; sessionStorage.setItem('leesearch-mock-user', JSON.stringify(u)); authCb && authCb(u); },
      async signOut() { sessionStorage.removeItem('leesearch-mock-user'); authCb && authCb(null); },
      listen(colPath, cb) {
        const run = () => {
          const db = load();
          cb(Object.entries(db).filter(([p]) => parent(p) === colPath).map(([p, d]) => ({ id: p.split('/').pop(), ...d })));
        };
        listeners.add(run); setTimeout(run, 0);
        return () => listeners.delete(run);
      },
      async get(p) { const d = load()[p]; return d ? { id: p.split('/').pop(), ...d } : null; },
      async set(p, data, merge = false) { const db = load(); db[p] = merge ? apply(db[p], data, true) : apply(undefined, data, false); save(db); },
      async update(p, data) { const db = load(); if (!db[p]) throw new Error('no doc ' + p); db[p] = apply(db[p], data, true); save(db); },
      async add(colPath, data) { const id = rid(); const db = load(); db[colPath + '/' + id] = apply(undefined, data); save(db); return id; },
      newId: () => rid(),
      async del(p) { const db = load(); delete db[p]; save(db); },
      async tx(p, fn) {
        const db = load(); const cur = db[p] ? { id: p.split('/').pop(), ...db[p] } : null;
        const res = fn(cur);
        if (res && res.data) { db[p] = apply(res.merge ? db[p] : undefined, res.data, !!res.merge); save(db); }
        return res && res.value;
      },
      async batch(ops) {
        const db = load();
        for (const o of ops) {
          if (o.op === 'set') db[o.path] = apply(o.merge ? db[o.path] : undefined, o.data, !!o.merge);
          else if (o.op === 'update') db[o.path] = apply(db[o.path], o.data, true);
          else if (o.op === 'del') delete db[o.path];
        }
        save(db);
      },
    };
  }

  // Local only (Max, 1 Nov 2026: "keep this local, we will sync it later"): the whole database is one JSON file on
  // this PC (Lee/leesearch/local/db.json), read and written through local_server.py's /__db, and nothing reaches
  // Firebase until it is synced. Presence stays in the page. Changes made to the file from outside (Claude's
  // suggestions) show up within 3 s.
  function fileBackend() {
    let docs = {}; let rev = -1; let busy = 0; let gen = 0;
    const listeners = new Set();
    const fire = () => { for (const l of listeners) l(); };
    const keep = (p) => !p.startsWith('leesearch_presence');
    async function pull() {
      const g = gen;
      const j = await fetch('/__db', { cache: 'no-store' }).then((r) => r.json());
      if (g !== gen || busy) return;          // a save started meanwhile; the next poll brings the newer copy
      const mine = Object.fromEntries(Object.entries(docs).filter(([p]) => !keep(p)));
      docs = { ...j.docs, ...mine }; rev = j.rev; fire();
    }
    const ready = pull();
    setInterval(async () => {
      if (busy) return;
      const j = await fetch('/__db?rev', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
      if (j && j.rev !== rev && !busy) pull().catch(() => {});
    }, 3000);
    async function save(put, del = []) {
      gen++;
      for (const [p, d] of Object.entries(put)) docs[p] = d;
      for (const p of del) delete docs[p];
      fire();
      const body = { put: Object.fromEntries(Object.entries(put).filter(([p]) => keep(p))), del: del.filter(keep) };
      if (!Object.keys(body.put).length && !body.del.length) return;
      busy++;
      try {
        const r = await fetch('/__db', { method: 'POST', body: JSON.stringify(body) });
        if (!r.ok) throw new Error('Could not save on this PC (' + r.status + ')');
      } finally { busy--; }
    }
    const one = (p) => (docs[p] ? { id: p.split('/').pop(), ...docs[p] } : null);
    let authCb = null;
    const user = () => { try { return JSON.parse(sessionStorage.getItem('leesearch-local-user')); } catch { return null; } };
    return {
      kind: 'local',
      onAuth(cb) { authCb = cb; ready.finally(() => cb(user())); },
      async signIn(email) { const u = { uid: 'local-' + email.split('@')[0], email }; sessionStorage.setItem('leesearch-local-user', JSON.stringify(u)); authCb && authCb(u); },
      async signOut() { sessionStorage.removeItem('leesearch-local-user'); authCb && authCb(null); },
      listen(colPath, cb) {
        const run = () => cb(Object.entries(docs).filter(([p]) => parent(p) === colPath).map(([p, d]) => ({ id: p.split('/').pop(), ...d })));
        listeners.add(run); ready.then(run, () => {});
        return () => listeners.delete(run);
      },
      async get(p) { await ready; return one(p); },
      set: (p, data, merge = false) => save({ [p]: apply(merge ? docs[p] : undefined, data, merge) }),
      async update(p, data) { await ready; if (!docs[p]) throw new Error('no doc ' + p); return save({ [p]: apply(docs[p], data, true) }); },
      async add(colPath, data) { const id = rid(); await save({ [colPath + '/' + id]: apply(undefined, data) }); return id; },
      newId: () => rid(),
      del: (p) => save({}, [p]),
      async tx(p, fn) {
        await ready;
        const res = fn(one(p));
        if (res && res.data) await save({ [p]: apply(res.merge ? docs[p] : undefined, res.data, !!res.merge) });
        return res && res.value;
      },
      async batch(ops) {
        await ready;
        const put = {}; const del = [];
        const cur = (p) => (p in put ? put[p] : del.includes(p) ? undefined : docs[p]);
        for (const o of ops) {
          if (o.op === 'del') { delete put[o.path]; if (!del.includes(o.path)) del.push(o.path); continue; }
          const was = cur(o.path);
          if (o.op === 'set') put[o.path] = apply(o.merge ? was : undefined, o.data, !!o.merge);
          else if (o.op === 'update') put[o.path] = apply(was, o.data, true);
          if (del.includes(o.path)) del.splice(del.indexOf(o.path), 1);
        }
        return save(put, del);
      },
    };
  }

  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  // localhost keeps everything on this PC (fileBackend). ?live signs in to the real database like the website;
  // ?mock gives the old browser-only test backend, where two tabs can play Max and Dr. Lee.
  const q = new URLSearchParams(location.search);
  const mock = local && q.has('mock');
  window.LDB = mock ? mockBackend() : local && !q.has('live') ? fileBackend() : firebaseBackend();
  window.LDB.DELETE = DELETE;
  // Count writes the server hasn't confirmed yet, so the page can warn before it is closed mid-save.
  let pending = 0;
  for (const m of ['set', 'update', 'add', 'del', 'tx', 'batch']) {
    const fn = window.LDB[m];
    window.LDB[m] = (...a) => { pending++; return Promise.resolve().then(() => fn(...a)).finally(() => { pending--; }); };
  }
  window.LDB.pending = () => pending;
})();
