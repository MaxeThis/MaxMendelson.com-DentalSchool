// Leesearch data layer. Two backends with the same small API:
//   Firebase (the live site) and Mock (localhost ?mock=1: localStorage shared
//   between tabs, so two tabs can play Max and Dr. Lee).
// Paths are slash strings: 'leesearch_papers/aaoms/blocks/b001'.
(function () {
  const DELETE = { __delete: true };

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

  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  // localhost uses the real database too (sign in once as Max), so work done locally is saved for both of you.
  // ?mock gives the old browser-only test backend, where two tabs can play Max and Dr. Lee.
  const mock = local && new URLSearchParams(location.search).has('mock');
  window.LDB = mock ? mockBackend() : firebaseBackend();
  window.LDB.DELETE = DELETE;
  // Count writes the server hasn't confirmed yet, so the page can warn before it is closed mid-save.
  let pending = 0;
  for (const m of ['set', 'update', 'add', 'del', 'tx', 'batch']) {
    const fn = window.LDB[m];
    window.LDB[m] = (...a) => { pending++; return Promise.resolve().then(() => fn(...a)).finally(() => { pending--; }); };
  }
  window.LDB.pending = () => pending;
})();
