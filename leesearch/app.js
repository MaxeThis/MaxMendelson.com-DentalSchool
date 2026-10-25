// Leesearch: Max and Dr. Lee's private manuscript workspace.
(function () {
  'use strict';
  const DB = window.LDB;
  const D = DB.DELETE;

  const USERS = {
    max: { short: 'Max', name: 'Max Mendelson', email: 'max@leesearch.maxmendelson.com', initials: 'MM', color: 'var(--max)' },
    lee: { short: 'Dr. Lee', name: 'Dr. Cameron Lee', email: 'lee@leesearch.maxmendelson.com', initials: 'CL', color: 'var(--lee)' },
    claude: { short: 'Claude', name: 'Claude (via Max)', email: '', initials: 'AI', color: 'var(--claude)' },
  };
  const PEOPLE = ['max', 'lee'];
  const ROOT = 'leesearch_papers';
  const PRIV = 'leesearch_private/max';     // Max-only: his source verdicts, his Claude notes key, Lee Review state
  const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
  const TAB = Math.random().toString(36).slice(2, 10);   // tells this tab's own saves apart from other tabs
  const EDITABLE = new Set(['p', 'h1', 'h2', 'ref']);

  const S = {
    me: null, uid: null, key: null, maxKey: null, maxIds: new Set(), leeSeen: null,
    manifest: [], papers: [],
    data: {},            // pid -> {blocks, suggestions, notes, done, edits, activity}
    presence: {},
    route: { view: 'home' },
    mode: localStorage.getItem('ls-mode') || 'suggest',
    tool: null,          // 'highlight' | 'done' | null
    editing: null,       // {pid, blockId, startHtml, startVersion, el}
    filter: 'open',
    unsubs: [],
    fileCache: new Map(),
  };

  // ---------- small helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const other = () => (S.me === 'max' ? 'lee' : 'max');
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function ago(t) {
    if (!t) return '';
    const s = (now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  function chip(u) { const x = USERS[u] || USERS.claude; return `<span class="who" style="--c:${x.color}">${esc(x.short)}</span>`; }
  function avatar(u) { const x = USERS[u] || USERS.claude; return `<span class="av" style="--c:${x.color}" title="${esc(x.name)}">${x.initials}</span>`; }
  function toast(msg, kind = '') {
    const el = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
    $('#toast-root').appendChild(el);
    const ms = kind === 'bad' ? 9000 : 3200;
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 600);
  }
  const why = (er) => String((er && (er.message || er.code)) || 'unknown error').replace(/[.\s]+$/, '');
  function plain(html) { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent; }
  function hash(s) { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); }
  function sanitize(html) {
    let s = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['i', 'b', 'em', 'strong', 'sup', 'sub', 'br'], ALLOWED_ATTR: [] });
    s = s.replace(/<(\/?)em>/g, '<$1i>').replace(/<(\/?)strong>/g, '<$1b>').replace(/(<br>\s*)+$/g, '').replace(/&nbsp;/g, ' ');
    s = s.replace(/<(i|b|sup|sub)><\/\1>/g, '');
    return s.trim();
  }

  // ---------- crypto (vault) ----------
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  // The vault key lives in Firestore (leesearch_secrets/vault), readable only by the two signed-in accounts,
  // so the encrypted files on GitHub can't be attacked offline by guessing a password.
  async function remoteKey() {
    const d = await DB.get('leesearch_secrets/vault').catch(() => null);
    if (!d || !d.key) return null;
    const k = await crypto.subtle.importKey('raw', b64d(d.key), 'AES-GCM', false, ['decrypt']);
    await keyStore('put', k);
    return k;
  }
  // Max's own key for the Max-only files (Claude's chat and notes, source log); Dr. Lee's account can't read it.
  async function remoteMaxKey() {
    const d = await DB.get(PRIV).catch(() => null);
    return d && d.key ? crypto.subtle.importKey('raw', b64d(d.key), 'AES-GCM', false, ['decrypt']) : null;
  }
  async function decryptBytes(buf, key = S.key) {
    const u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
  }
  async function fetchFile(id) {
    if (S.fileCache.has(id)) return S.fileCache.get(id);
    const p = (async () => {
      const r = await fetch(`vault/f/${id}.bin`);
      if (!r.ok) throw new Error('missing file');
      return decryptBytes(await r.arrayBuffer(), S.maxIds.has(id) ? S.maxKey : S.key);
    })();
    S.fileCache.set(id, p);
    return p;
  }
  // Remember the (non-extractable) vault key on this device in IndexedDB.
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('leesearch', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function keyStore(op, val) {
    try {
      const db = await idb();
      return await new Promise((res, rej) => {
        const t = db.transaction('k', op === 'get' ? 'readonly' : 'readwrite').objectStore('k');
        const r = op === 'get' ? t.get('vault') : op === 'put' ? t.put(val, 'vault') : t.delete('vault');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { return null; }
  }

  // ---------- diffs ----------
  const dmp = new diff_match_patch();
  dmp.Diff_Timeout = 1;
  const tokenize = (s) => s.match(/<[^>]+>|&[a-z#0-9]+;|[A-Za-z0-9À-ɏ]+|\s+|[^\sA-Za-z0-9<&]/g) || [];
  function diffTokens(a, b) {
    const map = new Map(); const list = [];
    const enc = (toks) => toks.map((t) => {
      if (!map.has(t)) { let c = 0x100 + list.length; if (c >= 0xD800) c += 0x800; map.set(t, String.fromCharCode(c)); list.push(t); }
      return map.get(t);
    }).join('');
    const dec = (s) => [...s].map((ch) => { let c = ch.charCodeAt(0); if (c >= 0xE000) c -= 0x800; return list[c - 0x100]; });
    const d = dmp.diff_main(enc(tokenize(a)), enc(tokenize(b)), false);
    dmp.diff_cleanupSemantic(d);
    return d.map(([op, s]) => [op, dec(s)]);
  }
  function renderDiff(a, b, insCls = '', title = '') {
    let out = '';
    for (const [op, toks] of diffTokens(a, b)) {
      if (op === 0) { out += toks.join(''); continue; }
      let buf = '';
      const flush = () => { if (buf) { out += op === 1 ? `<ins class="${insCls}" title="${esc(title)}">${buf}</ins>` : `<del title="${esc(title)}">${buf}</del>`; buf = ''; } };
      for (const t of toks) {
        if (t.startsWith('<')) { flush(); if (op === 1) out += t; } else buf += t;
      }
      flush();
    }
    return out;
  }
  function merge3(base, mine, current) {
    if (current === base) return mine;
    const [res, ok] = dmp.patch_apply(dmp.patch_make(base, mine), current);
    return ok.every(Boolean) ? res : null;
  }

  // ---------- data ----------
  const P = (pid) => `${ROOT}/${pid}`;
  const D_ = (pid) => S.data[pid] || (S.data[pid] = { blocks: [], suggestions: [], notes: [], done: [], edits: [], activity: [] });
  function blocksOf(pid) { return D_(pid).blocks.filter((b) => !b.deleted).sort((a, b) => a.order - b.order); }
  function blockById(pid, id) { return D_(pid).blocks.find((b) => b.id === id); }
  function doneMap(pid) { const m = {}; for (const d of D_(pid).done) m[d.id] = d; return m; }

  async function log(pid, type, blockId, summary, extra = {}) {
    try { await DB.add(`${P(pid)}/activity`, { type, blockId: blockId || null, summary, author: S.me, at: now(), ...extra }); } catch (e) { console.warn(e); }
  }
  function blockLabel(pid, id) {
    const bl = blocksOf(pid); const i = bl.findIndex((b) => b.id === id);
    if (i < 0) return 'a removed paragraph';
    let sec = '', n = 0;
    for (let j = i; j >= 0; j--) { if (bl[j].type === 'h1' || bl[j].type === 'h2') { sec = plain(bl[j].html); break; } n++; }
    const b = bl[i];
    if (b.type === 'h1' || b.type === 'h2') return `heading “${plain(b.html)}”`;
    return `${sec || 'Top'} ¶${n}`;
  }

  function subscribeAll() {
    S.unsubs.forEach((u) => u()); S.unsubs = [];
    S.unsubs.push(DB.listen(ROOT, (docs) => { S.papers = docs.sort((a, b) => (a.order || 0) - (b.order || 0)); subscribePapers(); render(); }, permError));
    S.unsubs.push(DB.listen('leesearch_presence', (docs) => { S.presence = Object.fromEntries(docs.map((d) => [d.id, d])); renderPresence(); }));
    if (S.me === 'max') S.unsubs.push(DB.listen(`${PRIV}/state`, (docs) => { const d = docs.find((x) => x.id === 'leeReview'); S.leeSeen = (d && d.seen) || 0; renderLeeBubble(); }));
  }
  const paperSubs = new Map();
  function subscribePapers() {
    for (const p of S.papers) {
      if (paperSubs.has(p.id)) continue;
      const subs = [];
      for (const col of ['blocks', 'suggestions', 'notes', 'done', 'edits', 'activity']) {
        subs.push(DB.listen(`${P(p.id)}/${col}`, (docs) => {
          const changed = JSON.stringify(D_(p.id)[col]) !== JSON.stringify(docs);
          D_(p.id)[col] = docs;
          if (!changed) return;
          scheduleRender(p.id, col);
          if (col === 'activity') renderLeeBubble();
          if (['blocks', 'suggestions', 'notes', 'done'].includes(col)) localSnapshot();
        }));
      }
      paperSubs.set(p.id, subs);
      S.unsubs.push(() => { subs.forEach((u) => u()); paperSubs.delete(p.id); });
    }
  }
  let renderTimer = null;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 30); }
  function permError(e) {
    if (String(e && e.code).includes('permission')) { $('#app').innerHTML = `<div class="boot">This account is not allowed in. <button class="btn" id="so">Sign out</button></div>`; $('#so').onclick = signOut; }
  }

  // presence + last seen
  let presTimer = null;
  function heartbeat(extra = {}) {
    if (!S.uid) return;
    const r = S.route;
    DB.set(`leesearch_presence/${S.me}`, { user: S.me, at: now(), paper: r.pid || null, view: r.view, editing: S.editing ? S.editing.blockId : null, ...extra }, true).catch(() => {});
  }
  function startPresence() { clearInterval(presTimer); heartbeat(); presTimer = setInterval(heartbeat, 30000); }
  function online(u) { const p = S.presence[u]; return p && now() - p.at < 75000 ? p : null; }
  function lastSeen(pid) { const p = S.presence[S.me]; return (p && p.seen && p.seen[pid]) || 0; }

  // ---------- auth ----------
  async function signOut() {
    if (DB.kind === 'mock') { sessionStorage.setItem('leesearch-mock-next', other()); S.me = null; return DB.signOut(); }
    await keyStore('del'); S.key = null; S.me = null;
    await DB.signOut();
  }
  function renderLogin(err = '') {
    let pick = localStorage.getItem('ls-last-user') || '';
    $('#app').innerHTML = `
      <div class="login">
        <div class="login-card">
          <div class="brand"><span class="brand-mark">L</span><div><b>Leesearch</b><small>Mendelson · Lee manuscripts</small></div></div>
          <p class="login-lead">Who's signing in?</p>
          <div class="pick">
            ${PEOPLE.map((u) => `<button type="button" class="pick-btn ${pick === u ? 'on' : ''}" data-u="${u}" style="--c:${USERS[u].color}">${avatar(u)}<span>${USERS[u].name}</span></button>`).join('')}
          </div>
          <form id="lf">
            <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">
            <button class="btn primary wide" id="go" type="submit">Sign in</button>
            <p class="err">${esc(err)}</p>
          </form>
          <p class="fine">Private workspace. Files are encrypted; only your password opens them.</p>
        </div>
      </div>`;
    document.querySelectorAll('.pick-btn').forEach((b) => b.onclick = () => {
      pick = b.dataset.u; document.querySelectorAll('.pick-btn').forEach((x) => x.classList.toggle('on', x === b)); $('#pw').focus();
    });
    $('#pw').focus();
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('#pw').value;
      if (!pick) { $('.err').textContent = 'Pick your name first.'; return; }
      if (!pw) return;
      $('#go').disabled = true; $('#go').textContent = 'Unlocking…'; $('.err').textContent = '';
      try {
        localStorage.setItem('ls-last-user', pick);
        await DB.signIn(USERS[pick].email, pw).catch((er) => {
          const c = er.code || er.message;
          throw new Error(/password|credential/i.test(c) ? 'Wrong password.' : /too-many/i.test(c) ? 'Too many tries. Wait a few minutes.' : 'Sign-in failed: ' + c);
        });
      } catch (er) {
        $('#go').disabled = false; $('#go').textContent = 'Sign in'; $('.err').textContent = er.message;
      }
    };
  }

  // ---------- routing ----------
  function go(route) {
    if (S.editing && !confirm('Discard the edit you are making?')) return;
    S.editing = null;
    S.route = route;
    const hash = route.view === 'home' ? '' : `#${route.pid}/${route.view}`;
    if (location.hash !== hash) history.pushState(null, '', hash || location.pathname);
    window.scrollTo(0, 0);
    render(true);
    heartbeat();
    if (route.pid) markSeen(route.pid);
  }
  function fromHash() {
    const m = location.hash.match(/^#([\w-]+)\/(\w+)/);
    S.route = m ? { view: m[2], pid: m[1] } : { view: 'home' };
  }
  window.addEventListener('popstate', () => { S.editing = null; fromHash(); render(true); });
  function markSeen(pid) { DB.set(`leesearch_presence/${S.me}`, { user: S.me, seen: { [pid]: now() } }, true).catch(() => {}); }

  // ---------- render root ----------
  function render(force) {
    if (!S.me || !S.key) return;
    const r = S.route;
    let root = $('#shell');
    if (!root || force === true || root.dataset.view !== r.view + (r.pid || '')) {
      $('#app').innerHTML = shell();
      root = $('#shell'); root.dataset.view = r.view + (r.pid || '');
      bindShell();
    }
    renderPresence();
    if (r.view === 'home') renderHome();
    else if (r.view === 'doc') renderDoc();
    else if (r.view === 'files') renderFiles();
    else if (r.view === 'activity') renderActivity();
    else if (r.view === 'sources') renderSources();
  }
  function shell() {
    const r = S.route; const p = S.papers.find((x) => x.id === r.pid);
    const tabs = p ? `<nav class="tabs">
        ${p.hasManuscript ? `<a href="#${p.id}/doc" class="${r.view === 'doc' ? 'on' : ''}" data-v="doc">Manuscript</a>` : ''}
        ${p.hasSources ? `<a href="#${p.id}/sources" class="${r.view === 'sources' ? 'on' : ''}" data-v="sources">Sources</a>` : ''}
        <a href="#${p.id}/files" class="${r.view === 'files' ? 'on' : ''}" data-v="files">Files</a>
        <a href="#${p.id}/activity" class="${r.view === 'activity' ? 'on' : ''}" data-v="activity">Activity <span class="badge" id="act-badge"></span></a>
      </nav>` : '';
    return `<div id="shell">
      <header class="top">
        <a class="brand small" href="#" id="home-link"><span class="brand-mark">L</span><b>Leesearch</b></a>
        ${p ? `<span class="crumb">/</span><span class="crumb-title">${esc(p.short || p.title)}</span>` : ''}
        ${tabs}
        <div class="top-right"><span id="presence"></span>${LOCAL && DB.kind !== 'mock' ? '<span id="websync" class="websync"></span>' : ''}
          ${S.me === 'max' ? '<button class="lee-review" id="leerev" title="What Dr. Lee changed, commented and noted">Lee Review<span class="bubble" id="leebubble"></span></button>' : ''}
          <span class="me">${avatar(S.me)}<button class="link" id="signout">${DB.kind === 'mock' ? `Local preview · view as ${USERS[other()].short}` : 'Sign out'}</button></span></div>
      </header>
      <main id="main"></main>
    </div>`;
  }
  function bindShell() {
    $('#home-link').onclick = (e) => { e.preventDefault(); go({ view: 'home' }); };
    $('#signout').onclick = signOut;
    if ($('#leerev')) $('#leerev').onclick = openLeeReview;
    document.querySelectorAll('.tabs a').forEach((a) => a.onclick = (e) => { e.preventDefault(); go({ view: a.dataset.v, pid: S.route.pid }); });
  }
  function renderPresence() {
    const el = $('#presence'); if (!el) return;
    const o = other(); const p = online(o);
    let where = '';
    if (p) {
      const pp = S.papers.find((x) => x.id === p.paper);
      where = p.editing && pp ? `editing ${esc(blockLabel(pp.id, p.editing))}` : pp ? `in ${esc(pp.short || pp.title)}` : 'on the home page';
    }
    el.innerHTML = p ? `<span class="online"><i></i>${esc(USERS[o].short)} is here · ${where}</span>`
      : `<span class="offline">${esc(USERS[o].short)} ${S.presence[o] ? 'was here ' + ago(S.presence[o].at) : 'has not signed in yet'}</span>`;
    renderLeeBubble();
    // activity badge
    const b = $('#act-badge');
    if (b && S.route.pid) { const n = D_(S.route.pid).activity.filter((a) => a.author !== S.me && a.at > lastSeen(S.route.pid)).length; b.textContent = n ? n : ''; }
    // soft lock: show who is editing which block
    document.querySelectorAll('.blk.other-editing').forEach((x) => x.classList.remove('other-editing'));
    if (p && p.editing && p.paper === S.route.pid) { const be = document.querySelector(`.blk[data-id="${p.editing}"]`); be && be.classList.add('other-editing'); }
  }

  // ---------- Lee Review (Max only): everything Dr. Lee did, newest first; the bubble counts what's new ----------
  const leeActs = () => S.papers.flatMap((p) => D_(p.id).activity.filter((a) => a.author === 'lee').map((a) => ({ ...a, pid: p.id })))
    .sort((a, b) => b.at - a.at);
  function renderLeeBubble() {
    const el = $('#leebubble'); if (!el || S.leeSeen === null) return;
    const n = leeActs().filter((a) => a.at > S.leeSeen).length;
    el.textContent = n ? (n > 99 ? '99+' : n) : '';
  }
  function openLeeReview() {
    const seen = S.leeSeen || 0, acts = leeActs().slice(0, 200);
    modal(`<h2>Dr. Lee's changes</h2>
      <p class="muted">His edits, suggestions, comments and done marks in the manuscript, and his calls and notes on the sources. New since you last looked are highlighted.</p>
      <ul class="feed lee-feed">${acts.map((a, i) => `<li class="${a.at > seen ? 'new' : ''}">${avatar('lee')}<div>${esc(a.summary)}
        ${a.detail ? `<div class="lee-detail">${esc(a.detail)}</div>` : ''}
        <small class="muted">${esc((S.papers.find((p) => p.id === a.pid) || {}).short || '')} · ${when(a.at)}</small></div>
        ${a.sourceKey || (a.blockId && blockById(a.pid, a.blockId) && !blockById(a.pid, a.blockId).deleted) ? `<button class="btn small" data-i="${i}">View</button>` : ''}</li>`).join('')
        || '<li class="muted">Dr. Lee hasn\'t changed anything yet.</li>'}</ul>
      <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`, (m) => {
      m.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => {
        const a = acts[+b.dataset.i]; closeModal();
        if (a.sourceKey) {
          try { localStorage.setItem('jump', JSON.stringify({ b: a.sourceKey, id: (a.cards || [])[0] })); } catch {}
          const f = $('#main .sources-frame'); if (f) f.remove();
          go({ view: 'sources', pid: a.pid });
        } else {
          go({ view: 'doc', pid: a.pid });
          setTimeout(() => { const el = document.querySelector(`.blk[data-id="${a.blockId}"]`); el && (el.scrollIntoView({ block: 'center' }), el.classList.add('flash')); }, 250);
        }
      });
    }, 'leerev');
    S.leeSeen = now(); renderLeeBubble();
    DB.set(`${PRIV}/state/leeReview`, { seen: S.leeSeen }, true).catch((e) => console.warn(e));
  }

  // ---------- home ----------
  function paperStats(pid) {
    const d = D_(pid); const bl = blocksOf(pid).filter((b) => EDITABLE.has(b.type) || b.type === 'table' || b.type === 'figure');
    const dm = doneMap(pid);
    let both = 0, one = 0;
    for (const b of bl) { const x = dm[b.id]; if (!x) continue; const n = PEOPLE.filter((u) => x[u]).length; if (n === 2) both++; else if (n === 1) one++; }
    return {
      total: bl.length, both, one,
      openNotes: d.notes.filter((n) => n.status !== 'closed' && n.kind === 'comment').length,
      pending: d.suggestions.filter((s) => s.status === 'pending').length,
      files: S.manifest.filter((f) => f.paper === pid && f.category !== '_inline').length,
      last: d.activity.reduce((m, a) => (a.at > (m ? m.at : 0) ? a : m), null),
      unseen: d.activity.filter((a) => a.author !== S.me && a.at > lastSeen(pid)).length,
    };
  }
  function renderHome() {
    const main = $('#main');
    const tiles = S.papers.filter((p) => !p.hidden).map((p) => {
      const st = paperStats(p.id);
      const pb = st.total ? Math.round((st.both / st.total) * 100) : 0;
      const po = st.total ? Math.round((st.one / st.total) * 100) : 0;
      return `<article class="tile" data-p="${p.id}" tabindex="0" style="--hue:${p.hue || 150}">
        <div class="tile-art"><span>${esc(p.mark || 'P')}</span>${st.unseen ? `<em class="new">${st.unseen} new</em>` : ''}</div>
        <div class="tile-body">
          <small class="tile-kicker">${esc(p.status || '')}</small>
          <h2>${esc(p.title)}</h2>
          <p class="tile-sub">${esc(p.subtitle || '')}</p>
          ${p.hasManuscript ? `<div class="prog" title="${st.both} done & checked by both, ${st.one} done by one of you, of ${st.total} parts">
            <i class="both" style="width:${pb}%"></i><i class="one" style="width:${po}%"></i></div>
            <p class="prog-label"><b>${pb}%</b> done &amp; checked by both · ${st.one} waiting for a check</p>` : ''}
          <div class="tile-meta">
            ${p.hasManuscript ? `<span>💬 ${st.openNotes} open</span><span>✎ ${st.pending} suggestions</span>` : ''}
            <span>📄 ${st.files} files</span>
          </div>
          ${st.last ? `<p class="tile-last">${avatar(st.last.author)} ${esc(st.last.summary)} · ${ago(st.last.at)}</p>` : ''}
        </div>
      </article>`;
    }).join('');
    main.innerHTML = `<section class="home">
      <div class="home-head"><h1>Papers</h1><p>Welcome back, ${esc(USERS[S.me].short)}. Pick a paper to read, edit, review and sign off.</p></div>
      <div class="tiles">${tiles || '<p class="muted">No papers yet.</p>'}</div>
    </section>`;
    main.querySelectorAll('.tile').forEach((t) => {
      const open = () => { const p = S.papers.find((x) => x.id === t.dataset.p); go({ view: p.hasManuscript ? 'doc' : 'files', pid: p.id }); };
      t.onclick = open; t.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    });
  }

  // ---------- manuscript ----------
  function renderDoc() {
    const pid = S.route.pid; const main = $('#main');
    let wrap = $('#doc-wrap');
    if (!wrap) {
      main.innerHTML = `<div id="doc-wrap" class="doc-wrap">
        <div class="toolbar" id="toolbar"></div>
        <div class="doc-grid">
          <article class="paper" id="paper"></article>
          <aside class="side" id="side"></aside>
        </div>
      </div>`;
      wrap = $('#doc-wrap');
      bindPaperEvents();
    }
    renderToolbar();
    renderBlocks(pid);
    renderSide(pid);
  }

  function renderToolbar() {
    const pid = S.route.pid; const st = paperStats(pid);
    const unseenEdits = D_(pid).edits.filter((e) => e.author !== S.me && !(e.seenBy || {})[S.me]).length;
    $('#toolbar').innerHTML = `
      <div class="seg" role="group" aria-label="Edit mode">
        <button data-mode="direct" class="${S.mode === 'direct' ? 'on' : ''}" title="Your edits go straight into the text (the other person still sees what changed)">✎ Edit directly</button>
        <button data-mode="suggest" class="${S.mode === 'suggest' ? 'on' : ''}" title="Your edits wait for the other person to accept or reject them">💡 Suggest</button>
      </div>
      <div class="tools">
        <button data-tool="highlight" class="tool hl ${S.tool === 'highlight' ? 'on' : ''}" title="Highlighter: select text to highlight it">🖍 Highlight</button>
        <button data-tool="comment" class="tool cm ${S.tool === 'comment' ? 'on' : ''}" title="Select text, then write a comment">💬 Comment</button>
        <button data-tool="done" class="tool dn ${S.tool === 'done' ? 'on' : ''}" title="Green highlighter: click or select paragraphs to mark them done. The other person then checks them.">✓ Done</button>
      </div>
      <div class="tb-right">
        ${unseenEdits ? `<button class="btn small" id="seen-all">Mark ${unseenEdits} edit${unseenEdits > 1 ? 's' : ''} seen</button>` : ''}
        <span class="tb-stat" title="Done and checked by both / all parts">✓✓ ${st.both}/${st.total}</span>
      </div>
      <p class="mode-hint">${S.mode === 'direct' ? 'Direct mode: click any paragraph to edit. Changes save into the paper and show up for the other person as marked edits.' : 'Suggest mode: click any paragraph to propose a change. It stays pending until the other person accepts it.'}${S.tool === 'done' ? ' <b>Done pen on:</b> click a paragraph (or a heading’s ✓ for its whole section).' : ''}</p>`;
    $('#toolbar').querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { S.mode = b.dataset.mode; localStorage.setItem('ls-mode', S.mode); renderToolbar(); if (S.editing) updateEditorBar(); });
    $('#toolbar').querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => { S.tool = S.tool === b.dataset.tool ? null : b.dataset.tool; renderToolbar(); $('#paper').dataset.tool = S.tool || ''; });
    const sa = $('#seen-all'); if (sa) sa.onclick = () => markEditsSeen(pid, null);
    $('#paper') && ($('#paper').dataset.tool = S.tool || '');
  }

  function sectionOf(pid, blockId) {
    const bl = blocksOf(pid); const i = bl.findIndex((b) => b.id === blockId); const head = bl[i];
    const lvl = head.type === 'h1' ? 1 : 2; const out = [head.id];
    for (let j = i + 1; j < bl.length; j++) { const t = bl[j].type; if (t === 'h1' || (lvl === 2 && t === 'h2')) break; out.push(bl[j].id); }
    return out;
  }

  function renderBlocks(pid) {
    const paper = $('#paper'); if (!paper) return;
    const bl = blocksOf(pid); const dm = doneMap(pid); const d = D_(pid);
    const editingId = S.editing && S.editing.pid === pid ? S.editing.blockId : null;
    const keep = editingId ? paper.querySelector(`.blk[data-id="${editingId}"]`) : null;
    const frag = document.createDocumentFragment();
    let afterHead = false;
    for (const b of bl) {
      if (b.id === editingId && keep) { frag.appendChild(keep); continue; }
      frag.appendChild(blockEl(pid, b, dm[b.id], d));
      afterHead = b.type === 'h1';
    }
    // Moving the editor node drops focus and selection; keep both.
    let saved = null;
    const sel = window.getSelection();
    if (keep && sel.rangeCount && keep.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); saved = [r.startContainer, r.startOffset, r.endContainer, r.endOffset]; }
    else if (keep && S.editing && S.editing.sel) saved = S.editing.sel;
    const sx = window.scrollX, sy = window.scrollY;
    paper.replaceChildren(frag);
    if (keep) {
      const ed = keep.querySelector('.ed');
      if (ed && (saved || document.activeElement === document.body)) {
        ed.focus({ preventScroll: true });
        if (saved) { try { const r = document.createRange(); r.setStart(saved[0], saved[1]); r.setEnd(saved[2], saved[3]); sel.removeAllRanges(); sel.addRange(r); } catch { /* node gone */ } }
      }
    }
    window.scrollTo(sx, sy);
    // pending inserts (suggested new paragraphs) go after their anchor
    for (const s of d.suggestions.filter((x) => x.status === 'pending' && x.kind === 'insert')) {
      const anchor = paper.querySelector(`.blk[data-id="${s.afterId}"]`);
      const el = h(`<div class="blk ghost" data-sug="${s.id}"><div class="gut"></div><div class="content">${s.type === 'table' ? `<div class="tbl tbl-ins" title="Suggested by ${esc(USERS[s.author]?.short)}">${s.newHtml}</div>` : `<ins class="sug" title="Suggested by ${esc(USERS[s.author]?.short)}">${s.newHtml}</ins>`}</div></div>`);
      el.querySelector('.content').appendChild(sugActions(pid, s));
      if (anchor) anchor.after(el); else paper.prepend(el);
    }
    renderPresence();
  }

  function sugActions(pid, s) {
    const mine = s.author === S.me;
    const el = h(`<span class="sug-act">${chip(s.author)} ${s.kind === 'insert' ? (s.type === 'table' ? 'suggests a new table' : 'suggests a new paragraph') : s.kind === 'delete' ? 'suggests deleting this' : 'suggests'} · ${ago(s.createdAt)}
      ${!mine ? '<button class="mini ok" data-a="accept">Accept</button><button class="mini no" data-a="reject">Reject</button>' : '<button class="mini" data-a="withdraw">Withdraw</button>'}
      ${mine && s.author !== 'claude' ? '' : ''}</span>`);
    el.querySelectorAll('button').forEach((b) => b.onclick = (e) => { e.stopPropagation(); resolveSuggestion(pid, s, b.dataset.a); });
    return el;
  }

  function blockEl(pid, b, done, d) {
    const pend = d.suggestions.filter((s) => s.status === 'pending' && s.blockId === b.id && s.kind !== 'insert').sort((a, c) => a.createdAt - c.createdAt);
    const unseen = d.edits.filter((e) => e.blockId === b.id && e.author !== S.me && !(e.seenBy || {})[S.me]).sort((a, c) => a.at - c.at);
    let body = b.html;
    let state = '';
    if (pend.length) {
      const s = pend[0];
      body = s.kind === 'delete' ? `<del title="Suggested deletion">${b.html}</del>` : renderDiff(b.html, mergeOrBase(b, s), 'sug', `Suggested by ${USERS[s.author]?.short}`);
      state = 'has-sug';
    } else if (unseen.length) {
      body = renderDiff(unseen[0].beforeHtml, b.html, 'edit', `Edited by ${USERS[unseen[0].author]?.short} ${ago(unseen[unseen.length - 1].at)}`);
      state = 'has-edit';
    }
    const tag = b.type === 'h1' ? 'h2' : b.type === 'h2' ? 'h3' : 'div';
    let inner;
    if (b.type === 'figure') inner = `<figure class="fig" data-file="fig-${(b.file || '').replace(/\.\w+$/, '')}"><div class="fig-load">Decrypting figure…</div></figure>`;
    else if (b.type === 'table') inner = `<div class="tbl${pend.length && pend[0].kind === 'delete' ? ' tbl-del' : ''}">${b.html}</div>`;   // a suggested table deletion shows struck through
    else inner = `<${tag} class="txt t-${b.type}">${body}</${tag}>`;
    const doneN = done ? PEOPLE.filter((u) => done[u]).length : 0;
    const stale = done && PEOPLE.some((u) => done[u] && done[u].hash && done[u].hash !== hash(b.html));
    const el = h(`<div class="blk b-${b.type} ${state} ${doneN === 2 ? 'done-both' : doneN === 1 ? 'done-one' : ''}" data-id="${b.id}">
      <div class="gut">${doneBadge(done, doneN, stale)}</div>
      <div class="content">${inner}</div>
      <div class="blk-tools">
        ${b.type === 'h1' || b.type === 'h2' ? `<button class="mini" data-act="section-done" title="Mark this whole section done">✓ section</button>` : ''}
        <button class="mini" data-act="note" title="Comment on this whole block">💬</button>
        ${EDITABLE.has(b.type) ? `<button class="mini" data-act="add-below" title="Add a paragraph below">＋¶</button><button class="mini" data-act="delete" title="Delete this paragraph">🗑</button>` : ''}
      </div>
    </div>`);
    if (pend.length) {
      const bar = h(`<div class="blk-note"></div>`);
      bar.appendChild(sugActions(pid, pend[0]));
      if (pend.length > 1) bar.appendChild(h(`<span class="more">+${pend.length - 1} more pending (see sidebar)</span>`));
      el.querySelector('.content').appendChild(bar);
    } else if (unseen.length) {
      const by = [...new Set(unseen.map((e) => e.author))];
      const bar = h(`<div class="blk-note edit-note">${by.map(chip).join(' ')} edited this ${ago(unseen[unseen.length - 1].at)}${unseen.some((e) => e.viaSuggestion) ? ' (accepted suggestion)' : ''}
        <button class="mini" data-act="seen">Got it</button><button class="mini" data-act="revert" title="Put back the text from before these edits">Undo</button></div>`);
      el.querySelector('.content').appendChild(bar);
    }
    if (b.type === 'figure') loadFigure(el.querySelector('figure'));
    applyNotes(pid, b, el);
    return el;
  }
  function mergeOrBase(b, s) { return s.baseHtml === b.html ? s.newHtml : (merge3(s.baseHtml, s.newHtml, b.html) ?? s.newHtml); }
  function doneBadge(done, n, stale) {
    if (!n) return '<span class="dn-empty" title="Not marked done"></span>';
    const who = PEOPLE.filter((u) => done[u]);
    const t = who.map((u) => `${USERS[u].short} ✓ ${when(done[u].at)}`).join('\n') + (stale ? '\nText changed after it was checked.' : '');
    return `<button class="dn-badge ${n === 2 ? 'both' : 'one'} ${stale ? 'stale' : ''}" data-act="done-pop" title="${esc(t)}">${n === 2 ? '✓✓' : '✓'}<span>${who.map((u) => USERS[u].initials).join(' ')}</span>${stale ? '<b>!</b>' : ''}</button>`;
  }
  async function loadFigure(fig) {
    const id = fig.dataset.file;
    try {
      const buf = await fetchFile(id);
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
      fig.innerHTML = `<img src="${url}" alt="">`;
    } catch { fig.innerHTML = '<div class="fig-load">Figure file missing.</div>'; }
  }

  // ---- notes (highlights & comments) anchoring ----
  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('del, .blk-note, .sug-act') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function locate(text, n) {
    if (!n.quote) return null;
    const hits = []; let i = text.indexOf(n.quote);
    while (i >= 0) { hits.push(i); i = text.indexOf(n.quote, i + 1); }
    if (!hits.length) return null;
    let best = hits[0], score = -1;
    for (const x of hits) {
      const pre = text.slice(Math.max(0, x - (n.prefix || '').length), x);
      let sc = 0; for (let k = 1; k <= pre.length && pre[pre.length - k] === n.prefix[n.prefix.length - k]; k++) sc++;
      sc -= Math.abs(x - (n.start || 0)) / 10000;
      if (sc > score) { score = sc; best = x; }
    }
    return [best, best + n.quote.length];
  }
  function wrapRange(root, s, e, make) {
    let pos = 0;
    for (const node of textNodes(root)) {
      const len = node.nodeValue.length; const a = Math.max(s, pos), z = Math.min(e, pos + len);
      if (a < z) {
        let n = node;
        if (a > pos) n = n.splitText(a - pos);
        if (z < pos + len) n.splitText(z - a);
        const m = make(); n.parentNode.insertBefore(m, n); m.appendChild(n);
      }
      pos += len;
    }
  }
  function applyNotes(pid, b, el) {
    const target = el.querySelector('.txt, .tbl'); if (!target) return;
    const notes = D_(pid).notes.filter((n) => n.blockId === b.id && n.quote && (n.status !== 'closed' || S.filter === 'all'));
    const text = textNodes(target).map((t) => t.nodeValue).join('');
    for (const n of notes) {
      const r = locate(text, n);
      n._orphan = !r;
      if (!r) continue;
      wrapRange(target, r[0], r[1], () => {
        const m = document.createElement('mark');
        m.className = `${n.kind === 'comment' ? 'cmt' : 'hl'} ${n.status === 'closed' ? 'closed' : ''}`;
        m.dataset.note = n.id; m.style.setProperty('--c', USERS[n.author]?.color || 'var(--claude)');
        return m;
      });
    }
  }
  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startBlk = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('.blk');
    const endBlk = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement).closest('.blk');
    if (!startBlk || !endBlk || !$('#paper').contains(startBlk)) return null;
    const ids = []; let on = false;
    for (const b of $('#paper').querySelectorAll('.blk[data-id]')) { if (b === startBlk) on = true; if (on) ids.push(b.dataset.id); if (b === endBlk) break; }
    const target = startBlk.querySelector('.txt, .tbl');
    let start = null, quote = '';
    if (target && startBlk === endBlk) {
      let pos = 0;
      for (const node of textNodes(target)) {
        if (node === range.startContainer) start = pos + range.startOffset;
        if (node === range.endContainer && start !== null) { quote = (textNodes(target).map((t) => t.nodeValue).join('')).slice(start, pos + range.endOffset); break; }
        pos += node.nodeValue.length;
      }
      if (start === null) { quote = sel.toString(); const t = textNodes(target).map((x) => x.nodeValue).join(''); start = t.indexOf(quote); }
    }
    const full = target ? textNodes(target).map((t) => t.nodeValue).join('') : '';
    return { ids, blockId: startBlk.dataset.id, single: startBlk === endBlk, quote: quote.trim() ? quote : '', start, prefix: start != null ? full.slice(Math.max(0, start - 24), start) : '', rect: range.getBoundingClientRect() };
  }

  // ---- paper interaction ----
  function bindPaperEvents() {
    const paper = $('#paper');
    paper.addEventListener('mouseup', () => setTimeout(onSelect, 0));
    paper.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      const blk = e.target.closest('.blk[data-id]');
      const mark = e.target.closest('mark[data-note]');
      const pid = S.route.pid;
      if (act && blk) { e.stopPropagation(); return blockAction(pid, blk.dataset.id, act.dataset.act, act); }
      if (e.target.closest('.blk-note, .sug-act, .editor-bar')) return;
      if (mark && !S.tool) { focusThread(mark.dataset.note); return; }
      if (!blk || (window.getSelection() && !window.getSelection().isCollapsed)) return;
      if (blk.classList.contains('editing')) return;
      if (S.tool === 'done') { toggleDone(pid, [blk.dataset.id]); return; }
      if (S.tool) return;
      const b = blockById(pid, blk.dataset.id);
      // the click-off handler may have just redrawn the paper, so find the live paragraph again
      const live = blk.isConnected ? blk : $(`#paper .blk[data-id="${blk.dataset.id}"]`);
      if (b && live && EDITABLE.has(b.type) && !S.editing) startEdit(pid, b, live, false, { x: e.clientX, y: e.clientY });
    });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('.selpop')) hideSelPop(); });
    // clicking off the paragraph being edited ends the edit, like Esc; clicking another paragraph opens that one
    document.addEventListener('click', (e) => {
      if (!S.editing || e.target.closest('.blk.editing, .modal-bg, .selpop, #toolbar')) return;
      const ed = $('.blk.editing .ed');
      if (ed && sanitize(ed.innerHTML) !== S.editing.initHtml && !confirm('Discard your changes to this paragraph?')) {
        e.preventDefault(); e.stopPropagation(); ed.focus(); return;
      }
      cancelEdit();
    }, true);
  }
  function hideSelPop() { const p = $('.selpop'); p && p.remove(); }
  function onSelect() {
    if (S.editing) return;
    const info = selectionInfo(); hideSelPop();
    if (!info) return;
    const pid = S.route.pid;
    if (S.tool === 'done') { toggleDone(pid, info.ids, true); window.getSelection().removeAllRanges(); return; }
    if (S.tool === 'highlight' && info.single && info.quote) { addNote(pid, info, 'highlight', ''); window.getSelection().removeAllRanges(); return; }
    if (S.tool === 'comment' && info.single && info.quote) { commentPrompt(pid, info); return; }
    const pop = h(`<div class="selpop">
      ${info.single && info.quote ? '<button data-k="highlight">🖍 Highlight</button><button data-k="comment">💬 Comment</button>' : ''}
      <button data-k="done">✓ Done</button></div>`);
    pop.style.top = (window.scrollY + info.rect.top - 44) + 'px';
    pop.style.left = (window.scrollX + info.rect.left + info.rect.width / 2) + 'px';
    document.body.appendChild(pop);
    pop.querySelectorAll('button').forEach((b) => b.onmousedown = (e) => {
      e.preventDefault(); hideSelPop();
      if (b.dataset.k === 'highlight') addNote(pid, info, 'highlight', '');
      if (b.dataset.k === 'comment') commentPrompt(pid, info);
      if (b.dataset.k === 'done') toggleDone(pid, info.ids, true);
      window.getSelection().removeAllRanges();
    });
  }
  function commentPrompt(pid, info) {
    modal(`<h3>Comment</h3>${info.quote ? `<blockquote>${esc(info.quote.slice(0, 300))}</blockquote>` : ''}
      <textarea id="ctext" rows="4" placeholder="Write a comment…"></textarea>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="csave">Comment</button></div>`, (m) => {
      const ta = m.querySelector('#ctext'); ta.focus();
      const btn = m.querySelector('#csave');
      const save = async () => {
        const t = ta.value.trim(); if (!t || btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Saving…';
        try { await addNote(pid, info, 'comment', t); closeModal(); }
        catch (er) { console.error(er); btn.disabled = false; btn.textContent = 'Comment'; toast('Could not save the comment: ' + why(er) + '. Your text is still here; try again.', 'bad'); }
      };
      m.querySelector('#csave').onclick = save;
      ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); };
    });
  }
  async function addNote(pid, info, kind, text) {
    const data = { kind, blockId: info.blockId, quote: info.quote || '', prefix: info.prefix || '', start: info.start || 0, text, author: S.me, createdAt: now(), status: 'open', replies: [] };
    await DB.add(`${P(pid)}/notes`, data);
    log(pid, kind, info.blockId, kind === 'comment' ? `commented on ${blockLabel(pid, info.blockId)}` : `highlighted text in ${blockLabel(pid, info.blockId)}`);
  }

  async function blockAction(pid, id, act, btn) {
    const b = blockById(pid, id);
    if (act === 'seen') return markEditsSeen(pid, id);
    if (act === 'revert') {
      const ed = D_(pid).edits.filter((e) => e.blockId === id && e.author !== S.me && !(e.seenBy || {})[S.me]).sort((a, c) => a.at - c.at);
      if (!ed.length || !confirm('Put back the text from before these edits? (This is saved as your own edit.)')) return;
      await saveDirect(pid, b, b.html, ed[0].beforeHtml, b.version || 0, 'undid edits in');
      return markEditsSeen(pid, id);
    }
    if (act === 'note') return commentPrompt(pid, { blockId: id, quote: '', prefix: '', start: 0 });
    if (act === 'section-done') return toggleDone(pid, sectionOf(pid, id), true);
    if (act === 'done-pop') return donePop(pid, id, btn);
    if (act === 'add-below') return addParagraph(pid, b);
    if (act === 'delete') {
      if (S.mode === 'suggest') {
        await DB.add(`${P(pid)}/suggestions`, { kind: 'delete', blockId: id, baseHtml: b.html, newHtml: '', author: S.me, createdAt: now(), status: 'pending' });
        log(pid, 'suggest', id, `suggested deleting ${blockLabel(pid, id)}`);
      } else if (confirm('Delete this paragraph? (It can be restored from Activity.)')) {
        await DB.batch([{ op: 'update', path: `${P(pid)}/blocks/${id}`, data: { deleted: true, updatedBy: S.me, updatedAt: now() } }]);
        await DB.add(`${P(pid)}/edits`, { blockId: id, beforeHtml: b.html, afterHtml: '', deleted: true, author: S.me, at: now(), seenBy: { [S.me]: now() } });
        log(pid, 'delete', id, `deleted a paragraph: “${plain(b.html).slice(0, 60)}…”`, { restorable: id });
      }
    }
  }

  // ---- done marks ----
  async function toggleDone(pid, ids, forceOn = false) {
    const dm = doneMap(pid);
    const all = ids.filter((id) => { const b = blockById(pid, id); return b; });
    const mineAll = all.every((id) => dm[id] && dm[id][S.me]);
    const turnOn = forceOn ? !mineAll : !mineAll;
    const ops = all.map((id) => ({ op: 'set', merge: true, path: `${P(pid)}/done/${id}`, data: { [S.me]: turnOn ? { at: now(), hash: hash(blockById(pid, id).html) } : D } }));
    await DB.batch(ops);
    const both = turnOn && all.every((id) => dm[id] && dm[id][other()]);
    const what = all.length > 1 ? `${all.length} parts (${blockLabel(pid, all[0])} …)` : blockLabel(pid, all[0]);
    log(pid, 'done', all[0], turnOn ? (both ? `checked ${what}: done by both ✓✓` : `marked ${what} done`) : `unmarked ${what}`);
    toast(turnOn ? (both ? 'Done & checked by both ✓✓' : `Marked done. ${USERS[other()].short} will see it to check.`) : 'Done mark removed');
  }
  function donePop(pid, id, btn) {
    const d = doneMap(pid)[id] || {}; const b = blockById(pid, id);
    const rows = PEOPLE.map((u) => `<li>${avatar(u)} ${d[u] ? `✓ ${when(d[u].at)}${d[u].hash && d[u].hash !== hash(b.html) ? ' <em class="warn">text changed since</em>' : ''}` : '<span class="muted">not yet</span>'}</li>`).join('');
    modal(`<h3>Done status</h3><p class="muted">${esc(blockLabel(pid, id))}</p><ul class="done-list">${rows}</ul>
      <div class="modal-actions"><button class="btn" data-close>Close</button>
      <button class="btn primary" id="dtoggle">${d[S.me] ? (d[S.me].hash !== hash(b.html) ? 'Re-check (text changed)' : 'Remove my check') : 'Check it ✓'}</button></div>`, (m) => {
      m.querySelector('#dtoggle').onclick = async () => {
        if (d[S.me] && d[S.me].hash !== hash(b.html)) await DB.set(`${P(pid)}/done/${id}`, { [S.me]: { at: now(), hash: hash(b.html) } }, true).then(() => log(pid, 'done', id, `re-checked ${blockLabel(pid, id)}`));
        else await toggleDone(pid, [id]);
        closeModal();
      };
    });
  }

  // ---- editing ----
  function startEdit(pid, b, blk, isNew = false, pt = null) {
    const p = online(other());
    if (p && p.editing === b.id && !confirm(`${USERS[other()].short} is editing this paragraph right now. Edit anyway?`)) return;
    // edit the paper text, or a pending suggestion's text if it's mine
    const myPend = D_(pid).suggestions.find((s) => s.status === 'pending' && s.blockId === b.id && s.author === S.me && s.kind === 'edit');
    const start = myPend ? myPend.newHtml : b.html;
    S.editing = { pid, blockId: b.id, startHtml: b.html, startVersion: b.version || 0, mySug: myPend ? myPend.id : null, isNew };
    blk.classList.add('editing');
    const content = blk.querySelector('.content');
    content.innerHTML = '';
    const ed = h(`<div class="txt t-${b.type} ed" contenteditable="true" spellcheck="true"></div>`);
    ed.innerHTML = start;
    S.editing.initHtml = sanitize(ed.innerHTML);
    content.appendChild(ed);
    content.appendChild(h(`<div class="editor-bar"></div>`));
    updateEditorBar();
    ed.focus();
    let r = pt && document.caretRangeFromPoint ? document.caretRangeFromPoint(pt.x, pt.y) : null;
    if (!r || !ed.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); }
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    ed.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
      else if ((e.metaKey || e.ctrlKey) && ['i', 'b'].includes(e.key.toLowerCase())) { e.preventDefault(); document.execCommand(e.key.toLowerCase() === 'i' ? 'italic' : 'bold'); }
    });
    ed.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ')); });
    heartbeat();
  }
  function updateEditorBar() {
    const bar = $('.editor-bar'); if (!bar || !S.editing) return;
    bar.innerHTML = `<span class="ed-mode ${S.mode}">${S.mode === 'direct' ? '✎ Editing directly' : '💡 Suggesting'}${S.editing.mySug ? ' (updating your pending suggestion)' : ''}</span>
      <button class="mini" data-f="italic" title="Italic (Ctrl+I)"><i>I</i></button><button class="mini" data-f="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button class="mini" data-f="superscript" title="Superscript (citations)">x²</button>
      <span class="sp"></span><button class="btn small" data-x="cancel">Cancel (Esc)</button>
      <button class="btn small primary" data-x="save">${S.mode === 'direct' ? 'Save' : 'Suggest'} (Enter)</button>`;
    bar.querySelectorAll('[data-f]').forEach((b) => b.onmousedown = (e) => { e.preventDefault(); document.execCommand(b.dataset.f); });
    bar.querySelector('[data-x=cancel]').onclick = cancelEdit;
    bar.querySelector('[data-x=save]').onclick = commitEdit;
  }
  async function cancelEdit() {
    const e = S.editing; S.editing = null;
    if (e && e.isNew) { const b = blockById(e.pid, e.blockId); if (b && !plain(b.html).trim()) await DB.del(`${P(e.pid)}/blocks/${e.blockId}`); }
    renderBlocks(S.route.pid); heartbeat();
  }
  async function commitEdit() {
    const e = S.editing; if (!e) return;
    const ed = $('.blk.editing .ed'); const html = sanitize(ed.innerHTML);
    const pid = e.pid; const b = blockById(pid, e.blockId);
    S.editing = null;
    try {
      if (e.isNew && S.mode === 'direct') { await saveDirect(pid, b, e.startHtml, html, e.startVersion, 'added'); }
      else if (e.isNew) { /* new paragraph in suggest mode was created as ghost by addParagraph */ }
      else if (html === (e.mySug ? D_(pid).suggestions.find((s) => s.id === e.mySug).newHtml : e.startHtml)) { /* unchanged */ }
      else if (S.mode === 'direct') await saveDirect(pid, b, e.startHtml, html, e.startVersion, 'edited');
      else {
        if (e.mySug) {
          if (html === b.html) { await DB.update(`${P(pid)}/suggestions/${e.mySug}`, { status: 'withdrawn', resolvedAt: now(), resolvedBy: S.me }); }
          else await DB.update(`${P(pid)}/suggestions/${e.mySug}`, { newHtml: html, baseHtml: b.html, updatedAt: now() });
          log(pid, 'suggest', b.id, `updated a suggestion in ${blockLabel(pid, b.id)}`);
        } else {
          await DB.add(`${P(pid)}/suggestions`, { kind: 'edit', blockId: b.id, baseHtml: e.startHtml, newHtml: html, author: S.me, createdAt: now(), status: 'pending' });
          log(pid, 'suggest', b.id, `suggested an edit in ${blockLabel(pid, b.id)}`);
          toast(`Suggestion sent. ${USERS[other()].short} can accept or reject it.`);
        }
      }
    } catch (er) {
      console.error(er);
      renderBlocks(pid);
      const blk = document.querySelector(`.blk[data-id="${b.id}"]`);
      if (blk) { startEdit(pid, b, blk, e.isNew); Object.assign(S.editing, { startHtml: e.startHtml, startVersion: e.startVersion, mySug: e.mySug }); const ed2 = blk.querySelector('.ed'); if (ed2) ed2.innerHTML = html; }
      toast('Could not save: ' + why(er) + '. Your text is still in the box; press Enter to try again.', 'bad');
      return heartbeat();
    }
    renderBlocks(pid); heartbeat();
  }
  async function saveDirect(pid, b, baseHtml, html, baseVersion, verb, extra = {}) {
    const path = `${P(pid)}/blocks/${b.id}`;
    const result = await DB.tx(path, (cur) => {
      if (!cur) throw new Error('paragraph is gone');
      let next = html;
      if ((cur.version || 0) !== baseVersion || cur.html !== baseHtml) {
        next = merge3(baseHtml, html, cur.html);
        if (next === null) return { value: { conflict: true, current: cur.html } };
      }
      return { data: { html: next, version: (cur.version || 0) + 1, updatedBy: extra.author || S.me, updatedAt: now(), deleted: false }, merge: true, value: { before: cur.html, after: next } };
    });
    if (result && result.conflict && extra.viaSuggestion) {
      toast('The paragraph changed too much since this suggestion. Edit it by hand, then reject the suggestion.', 'bad');
      return false;
    }
    if (result && result.conflict) {
      await DB.add(`${P(pid)}/suggestions`, { kind: 'edit', blockId: b.id, baseHtml: result.current, newHtml: html, author: S.me, createdAt: now(), status: 'pending', note: 'conflict' });
      toast(`${USERS[other()].short} changed this paragraph at the same time. Your version was saved as a suggestion instead.`, 'bad');
      return false;
    }
    await DB.add(`${P(pid)}/edits`, { blockId: b.id, beforeHtml: result.before, afterHtml: result.after, author: extra.author || S.me, at: now(), seenBy: { [S.me]: now() }, viaSuggestion: extra.viaSuggestion || null });
    log(pid, 'edit', b.id, `${verb} ${blockLabel(pid, b.id)}`);
    return true;
  }
  async function addParagraph(pid, after) {
    const bl = blocksOf(pid); const i = bl.findIndex((x) => x.id === after.id);
    const nextOrder = bl[i + 1] ? bl[i + 1].order : after.order + 2000;
    if (S.mode === 'suggest') {
      modal(`<h3>Suggest a new paragraph</h3><p class="muted">After ${esc(blockLabel(pid, after.id))}</p><textarea id="ptext" rows="6" placeholder="Paragraph text…"></textarea>
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="psave">Suggest</button></div>`, (m) => {
        m.querySelector('#ptext').focus();
        m.querySelector('#psave').onclick = async () => {
          const t = m.querySelector('#ptext').value.trim(); if (!t) return;
          await DB.add(`${P(pid)}/suggestions`, { kind: 'insert', afterId: after.id, order: (after.order + nextOrder) / 2, type: after.type === 'ref' ? 'ref' : 'p', baseHtml: '', newHtml: esc(t), author: S.me, createdAt: now(), status: 'pending' });
          log(pid, 'suggest', after.id, `suggested a new paragraph after ${blockLabel(pid, after.id)}`);
          closeModal();
        };
      });
      return;
    }
    const id = 'n' + DB.newId(`${P(pid)}/blocks`).slice(0, 10);
    await DB.set(`${P(pid)}/blocks/${id}`, { type: after.type === 'ref' ? 'ref' : 'p', html: '', order: (after.order + nextOrder) / 2, version: 0, createdBy: S.me, updatedAt: now(), deleted: false });
    setTimeout(() => { const el = document.querySelector(`.blk[data-id="${id}"]`); const b = blockById(pid, id); if (el && b) startEdit(pid, b, el, true); }, 120);
  }
  async function markEditsSeen(pid, blockId) {
    const ops = D_(pid).edits.filter((e) => (!blockId || e.blockId === blockId) && e.author !== S.me && !(e.seenBy || {})[S.me])
      .map((e) => ({ op: 'update', path: `${P(pid)}/edits/${e.id}`, data: { [`seenBy.${S.me}`]: now() } }));
    if (ops.length) await DB.batch(ops);
  }
  async function resolveSuggestion(pid, s, action) {
    const path = `${P(pid)}/suggestions/${s.id}`;
    if (action === 'withdraw') { await DB.update(path, { status: 'withdrawn', resolvedBy: S.me, resolvedAt: now() }); return log(pid, 'suggest', s.blockId || s.afterId, `withdrew a suggestion`); }
    if (action === 'reject') { await DB.update(path, { status: 'rejected', resolvedBy: S.me, resolvedAt: now() }); return log(pid, 'reject', s.blockId || s.afterId, `rejected ${USERS[s.author]?.short}'s suggestion in ${blockLabel(pid, s.blockId || s.afterId)}`); }
    // accept
    if (s.kind === 'insert') {
      const id = 'n' + s.id.slice(0, 10);
      await DB.batch([
        { op: 'set', path: `${P(pid)}/blocks/${id}`, data: { type: s.type || 'p', html: s.newHtml, order: s.order, version: 1, createdBy: s.author, updatedAt: now(), deleted: false } },
        { op: 'update', path, data: { status: 'accepted', resolvedBy: S.me, resolvedAt: now() } },
      ]);
      await DB.add(`${P(pid)}/edits`, { blockId: id, beforeHtml: '', afterHtml: s.newHtml, author: s.author, at: now(), seenBy: { [S.me]: now() }, viaSuggestion: s.id });
      return log(pid, 'accept', id, `accepted ${USERS[s.author]?.short}'s new paragraph`);
    }
    const b = blockById(pid, s.blockId);
    if (s.kind === 'delete') {
      await DB.batch([{ op: 'update', path: `${P(pid)}/blocks/${b.id}`, data: { deleted: true, updatedAt: now(), updatedBy: S.me } }, { op: 'update', path, data: { status: 'accepted', resolvedBy: S.me, resolvedAt: now() } }]);
      return log(pid, 'accept', b.id, `accepted deleting a paragraph: “${plain(b.html).slice(0, 50)}…”`, { restorable: b.id });
    }
    const ok = await saveDirect(pid, b, s.baseHtml, s.newHtml, s.baseHtml === b.html ? (b.version || 0) : -1, `accepted ${USERS[s.author]?.short}'s suggestion in`, { author: s.author, viaSuggestion: s.id });
    if (ok) await DB.update(path, { status: 'accepted', resolvedBy: S.me, resolvedAt: now() });
  }

  // ---- side panel ----
  function renderSide(pid) {
    const side = $('#side'); if (!side) return;
    const d = D_(pid); const order = Object.fromEntries(blocksOf(pid).map((b, i) => [b.id, i]));
    const items = [];
    for (const n of d.notes) if (S.filter === 'all' || (S.filter === 'open' ? n.status !== 'closed' : n.status === 'closed')) items.push({ t: 'note', o: order[n.blockId] ?? 9999, x: n });
    for (const s of d.suggestions) if ((S.filter === 'open' && s.status === 'pending') || S.filter === 'all' || (S.filter === 'closed' && s.status !== 'pending')) items.push({ t: 'sug', o: order[s.blockId || s.afterId] ?? 9999, x: s });
    items.sort((a, b) => a.o - b.o || (a.x.createdAt - b.x.createdAt));
    const focus = side.dataset.focus;
    side.innerHTML = `<div class="side-head"><h3>Review</h3>
      <div class="seg small">${['open', 'closed', 'all'].map((f) => `<button data-f="${f}" class="${S.filter === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div></div>
      <div class="threads">${items.map((it) => (it.t === 'note' ? noteCard(pid, it.x) : sugCard(pid, it.x))).join('') || '<p class="muted pad">Nothing here. Select text to highlight or comment; click a paragraph to edit.</p>'}</div>`;
    side.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; renderBlocks(pid); renderSide(pid); });
    side.querySelectorAll('.card').forEach((c) => bindCard(pid, c));
    if (focus) { const c = side.querySelector(`[data-nid="${focus}"]`); c && c.classList.add('focus'); }
  }
  function noteCard(pid, n) {
    const label = blockLabel(pid, n.blockId);
    return `<div class="card ${n.kind} ${n.status === 'closed' ? 'closed' : ''}" data-nid="${n.id}" data-block="${n.blockId}" style="--c:${USERS[n.author]?.color}">
      <div class="card-head">${avatar(n.author)} <b>${esc(USERS[n.author]?.short || n.author)}</b> <span class="muted">${n.kind === 'highlight' ? 'highlighted' : 'commented'} · ${ago(n.createdAt)}</span>
        ${n.status === 'closed' ? `<span class="pill">closed${n.closedBy ? ' by ' + esc(USERS[n.closedBy]?.short) : ''}</span>` : ''}</div>
      <a class="card-where" href="#">${esc(label)}</a>
      ${n.quote ? `<blockquote class="${n._orphan ? 'orphan' : ''}">${esc(n.quote.slice(0, 220))}${n._orphan ? '<small> (text has since changed)</small>' : ''}</blockquote>` : ''}
      ${n.text ? `<div class="card-text" data-edit="${n.author === S.me ? 1 : ''}">${esc(n.text)}</div>` : ''}
      ${(n.replies || []).map((r) => `<div class="reply" data-rid="${r.id}">${avatar(r.author)} <div><b>${esc(USERS[r.author]?.short)}</b> <span class="muted">${ago(r.at)}</span><p>${esc(r.text)}</p></div><button class="x" data-a="del-reply" title="Delete reply">×</button></div>`).join('')}
      <div class="reply-box"><input placeholder="${n.kind === 'highlight' && !n.text ? 'Add a comment…' : 'Reply…'}" data-a="reply-input"></div>
      <div class="card-actions">
        ${n.status === 'closed' ? '<button class="mini" data-a="reopen">Reopen</button>' : '<button class="mini ok" data-a="close">✓ Close</button>'}
        ${n.author === S.me && n.text ? '<button class="mini" data-a="edit">Edit</button>' : ''}
        <button class="mini no" data-a="delete">Delete</button>
      </div></div>`;
  }
  function sugCard(pid, s) {
    const b = s.blockId ? blockById(pid, s.blockId) : null;
    const preview = s.kind === 'insert' ? `<ins class="sug">${s.newHtml}</ins>` : s.kind === 'delete' ? `<del>${b ? b.html : ''}</del>` : renderDiff(s.baseHtml, s.newHtml, 'sug');
    const mine = s.author === S.me;
    const st = s.status === 'pending' ? '' : `<span class="pill ${s.status}">${s.status}${s.resolvedBy ? ' by ' + esc(USERS[s.resolvedBy]?.short) : ''}</span>`;
    return `<div class="card sugcard ${s.status}" data-sid="${s.id}" data-block="${s.blockId || s.afterId}" style="--c:${USERS[s.author]?.color}">
      <div class="card-head">${avatar(s.author)} <b>${esc(USERS[s.author]?.short)}</b> <span class="muted">suggested ${s.kind === 'insert' ? 'a new paragraph' : s.kind === 'delete' ? 'a deletion' : 'an edit'} · ${ago(s.createdAt)}</span> ${st}</div>
      <a class="card-where" href="#">${esc(blockLabel(pid, s.blockId || s.afterId))}</a>
      ${s.note === 'conflict' ? '<p class="warn small">Saved as a suggestion because both of you edited this paragraph at once.</p>' : ''}
      <div class="diff">${preview}</div>
      ${s.status === 'pending' ? `<div class="card-actions">${mine ? '<button class="mini" data-a="withdraw">Withdraw</button>' : '<button class="mini ok" data-a="accept">Accept</button><button class="mini no" data-a="reject">Reject</button>'}</div>` : ''}
    </div>`;
  }
  function bindCard(pid, c) {
    const where = c.querySelector('.card-where');
    where && (where.onclick = (e) => { e.preventDefault(); const el = document.querySelector(`.blk[data-id="${c.dataset.block}"]`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } });
    if (c.dataset.sid) {
      const s = D_(pid).suggestions.find((x) => x.id === c.dataset.sid);
      c.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => resolveSuggestion(pid, s, b.dataset.a));
      return;
    }
    const n = D_(pid).notes.find((x) => x.id === c.dataset.nid); const path = `${P(pid)}/notes/${n.id}`;
    c.querySelectorAll('[data-a]').forEach((b) => {
      const a = b.dataset.a;
      if (a === 'reply-input') {
        b.onkeydown = async (e) => {
          if (e.key !== 'Enter' || !b.value.trim()) return;
          const t = b.value.trim(); b.disabled = true;
          try {
            if (n.kind === 'highlight' && !n.text) await DB.update(path, { text: t, kind: 'comment', author: n.author === S.me ? n.author : n.author });
            else await DB.update(path, { replies: [...(n.replies || []), { id: Math.random().toString(36).slice(2, 9), author: S.me, text: t, at: now() }], status: 'open' });
          } catch (er) { console.error(er); b.disabled = false; return toast('Could not save the reply: ' + why(er) + '. Your text is still here; press Enter to retry.', 'bad'); }
          b.value = ''; b.disabled = false;
          log(pid, 'reply', n.blockId, `replied on ${blockLabel(pid, n.blockId)}`);
        };
        return;
      }
      b.onclick = async () => {
        if (a === 'close') { await DB.update(path, { status: 'closed', closedBy: S.me, closedAt: now() }); log(pid, 'close', n.blockId, `closed a ${n.kind} on ${blockLabel(pid, n.blockId)}`); }
        if (a === 'reopen') { await DB.update(path, { status: 'open', closedBy: D }); log(pid, 'reopen', n.blockId, `reopened a ${n.kind}`); }
        if (a === 'delete' && confirm(`Delete this ${n.kind}${(n.replies || []).length ? ' and its replies' : ''}?`)) { await DB.del(path); log(pid, 'delete-note', n.blockId, `deleted a ${n.kind} on ${blockLabel(pid, n.blockId)}`); }
        if (a === 'del-reply') { const rid = b.closest('.reply').dataset.rid; await DB.update(path, { replies: (n.replies || []).filter((r) => r.id !== rid) }); }
        if (a === 'edit') {
          const t = prompt('Edit your comment', n.text); if (t != null && t.trim()) await DB.update(path, { text: t.trim(), editedAt: now() });
        }
      };
    });
  }
  function focusThread(nid) {
    const side = $('#side'); side.dataset.focus = nid;
    side.querySelectorAll('.card').forEach((c) => c.classList.toggle('focus', c.dataset.nid === nid));
    const c = side.querySelector(`[data-nid="${nid}"]`);
    if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); const i = c.querySelector('input'); i && i.focus({ preventScroll: true }); }
  }

  // ---------- files ----------
  const ICON = (f) => (f.mime === 'application/pdf' ? 'PDF' : /word/.test(f.mime) ? 'DOC' : /image/.test(f.mime) ? 'IMG' : /csv/.test(f.mime) || f.name.endsWith('.csv') ? 'CSV' : /markdown/.test(f.mime) || f.name.endsWith('.md') ? 'MD' : 'FILE');
  const size = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
  function renderFiles() {
    const pid = S.route.pid; const main = $('#main');
    const files = S.manifest.filter((f) => f.paper === pid && f.category !== '_inline');
    const q = (S.fileQuery || '').toLowerCase();
    const cats = [...new Set(files.map((f) => f.category))];
    main.innerHTML = `<section class="files">
      <div class="files-head"><h1>Files</h1><input id="fq" placeholder="Search ${files.length} files…" value="${esc(S.fileQuery || '')}"></div>
      ${cats.map((c) => {
        const fs = files.filter((f) => f.category === c && (!q || f.name.toLowerCase().includes(q)));
        if (!fs.length) return '';
        return `<h2>${esc(c)} <span class="muted">${fs.length}</span></h2><div class="file-grid">${fs.map((f) => `
          <button class="file" data-id="${f.id}"><span class="ficon i-${ICON(f)}">${ICON(f)}</span><span class="fname">${esc(f.name)}</span><span class="fmeta">${size(f.size)} · ${new Date(f.modified * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></button>`).join('')}</div>`;
      }).join('')}
    </section>`;
    const fq = $('#fq'); fq.oninput = () => { S.fileQuery = fq.value; const pos = fq.selectionStart; renderFiles(); const n = $('#fq'); n.focus(); n.setSelectionRange(pos, pos); };
    main.querySelectorAll('.file').forEach((b) => b.onclick = () => openFile(S.manifest.find((f) => f.id === b.dataset.id)));
  }
  async function openFile(f) {
    modal(`<div class="viewer"><div class="viewer-head"><b>${esc(f.name)}</b><span class="sp"></span><button class="btn small" id="dl">Download</button><button class="btn small" data-close>Close</button></div><div class="viewer-body" id="vb"><p class="muted pad">Decrypting…</p></div></div>`, null, 'wide');
    try {
      const buf = await fetchFile(f.id);
      const blob = new Blob([buf], { type: f.mime });
      const url = URL.createObjectURL(blob);
      $('#dl').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = f.name.split('/').pop(); a.click(); };
      const vb = $('#vb'); const kind = ICON(f);
      if (kind === 'PDF') vb.innerHTML = `<iframe src="${url}" title="${esc(f.name)}"></iframe>`;
      else if (kind === 'IMG') vb.innerHTML = `<img src="${url}" alt="">`;
      else if (kind === 'MD') vb.innerHTML = `<div class="md">${DOMPurify.sanitize(marked.parse(new TextDecoder().decode(buf)))}</div>`;
      else if (kind === 'CSV') vb.innerHTML = `<div class="tbl csv">${csvTable(new TextDecoder().decode(buf))}</div>`;
      else if (kind === 'DOC') { const r = await mammoth.convertToHtml({ arrayBuffer: buf }); vb.innerHTML = `<p class="muted pad small">Preview (layout simplified; tracked changes and comments only show in Word). Download for the real file.</p><div class="md docx">${DOMPurify.sanitize(r.value)}</div>`; }
      else vb.innerHTML = `<pre class="pad">${esc(new TextDecoder().decode(buf).slice(0, 200000))}</pre>`;
    } catch (e) { $('#vb').innerHTML = `<p class="err pad">Could not open: ${esc(e.message)}</p>`; }
  }
  function csvTable(t) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return `<table>${rows.slice(0, 2000).map((r, i) => `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</table>`;
  }

  // ---------- activity ----------
  function renderActivity() {
    const pid = S.route.pid; const main = $('#main');
    const acts = [...D_(pid).activity].sort((a, b) => b.at - a.at).slice(0, 400);
    const seen = lastSeen(pid);
    main.innerHTML = `<section class="activity"><h1>Activity</h1>
      <ul class="feed">${acts.map((a) => `<li class="${a.author !== S.me && a.at > seen ? 'new' : ''}">${avatar(a.author)}<div><b>${esc(USERS[a.author]?.short || a.author)}</b> ${esc(a.summary)}
        ${a.restorable ? `<button class="mini" data-restore="${a.restorable}">Restore</button>` : ''}
        ${a.blockId && blockById(pid, a.blockId) && !blockById(pid, a.blockId).deleted ? `<a href="#" data-goto="${a.blockId}">view</a>` : ''}
        <small class="muted">${when(a.at)}</small></div></li>`).join('') || '<li class="muted">No activity yet.</li>'}</ul></section>`;
    main.querySelectorAll('[data-restore]').forEach((b) => b.onclick = async () => {
      await DB.update(`${P(pid)}/blocks/${b.dataset.restore}`, { deleted: false, updatedAt: now(), updatedBy: S.me });
      log(pid, 'restore', b.dataset.restore, `restored a deleted paragraph`); toast('Restored');
    });
    main.querySelectorAll('[data-goto]').forEach((a) => a.onclick = (e) => {
      e.preventDefault(); go({ view: 'doc', pid });
      setTimeout(() => { const el = document.querySelector(`.blk[data-id="${a.dataset.goto}"]`); el && (el.scrollIntoView({ block: 'center' }), el.classList.add('flash')); }, 200);
    });
    markSeen(pid);
  }

  // ---------- sources (the source-review page, in a frame) ----------
  function renderSources() {
    if ($('#main .sources-frame')) return;
    document.documentElement.style.setProperty('--top-h', ($('.top').offsetHeight || 58) + 'px');
    $('#main').innerHTML = `<iframe class="sources-frame" src="sources/index.html?v=2" title="Source review"></iframe>`;
  }
  // Each person keeps their own review of each source packet, one field per review card:
  //   Max:     leesearch_private/max/source_verdicts/<packet>   (only Max's account can read it)
  //   Dr. Lee: leesearch_papers/<paper>/lee_verdicts/<packet>    (both can read it; Max sees it on each card)
  const vLast = {};
  const bundleListeners = new Set();
  const docKey = (key) => key.replace(/\//g, '__');
  const leePath = (key) => `${P(S.sources.paper_of[key])}/lee_verdicts/${docKey(key)}`;
  const vPath = (key) => (S.me === 'max' ? `${PRIV}/source_verdicts/${docKey(key)}` : leePath(key));
  const stripV = (d) => { const V = {}; for (const [k, v] of Object.entries(d || {})) if (k !== 'id' && !k.startsWith('_')) V[k] = v; return V; };
  async function sourcesBundle() {
    if (!S.sources) {
      const r = await fetch('vault/sources.bin', { cache: 'no-store' });
      S.sources = JSON.parse(new TextDecoder().decode(await decryptBytes(await r.arrayBuffer())));
      // Max only: put back Claude's back-and-forth and side notes, which are in the Max-only file
      if (S.me === 'max' && S.maxKey) {
        try {
          const rm = await fetch('vault/sources_max.bin', { cache: 'no-store' });
          const mine = JSON.parse(new TextDecoder().decode(await decryptBytes(await rm.arrayBuffer(), S.maxKey)));
          for (const [key, th] of Object.entries(mine.threads || {})) {
            const c = S.sources.data[key] && (S.sources.data[key].claude ||= {});
            if (c) for (const [id, t] of Object.entries(th)) (c[id] ||= {}).thread = t;
          }
          for (const [key, notes] of Object.entries(mine.side_notes || {})) if (S.sources.drafts[key]) S.sources.drafts[key].notes = notes;
        } catch (e) { console.warn('Max-only notes not loaded', e); }
      }
    }
    return JSON.parse(JSON.stringify(S.sources));
  }
  window.LeesearchBridge = {
    get me() { return S.me; },
    name: (u) => (USERS[u] ? USERS[u].short : u),
    decrypt: (fid) => fetchFile(fid),
    sourcesBundle,
    onUpdate(cb) { bundleListeners.add(cb); },
    async loadLee(key) { return S.me === 'max' ? stripV(await DB.get(leePath(key)).catch(() => null)) : {}; },
    async loadVerdicts(key) {
      const V = stripV(await DB.get(vPath(key)));
      vLast[key] = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, JSON.stringify(v)]));
      return V;
    },
    async saveVerdicts(key, V) {
      const last = vLast[key] || {}; const changed = {};
      const prev = {};
      for (const [id, v] of Object.entries(V)) { const j = JSON.stringify(v); if (last[id] !== j) { prev[id] = last[id] ? JSON.parse(last[id]) : {}; changed[id] = { ...v, _at: now() }; last[id] = j; } }
      vLast[key] = last;
      if (!Object.keys(changed).length) return;
      changed._key = key; changed._updatedBy = S.me; changed._updatedAt = now(); changed._tab = TAB;
      try {
        try { await DB.update(vPath(key), changed); } catch (e1) { if (e1 && e1.code && e1.code !== 'not-found') throw e1; await DB.set(vPath(key), changed, true); }
      } catch (er) {
        console.error(er);
        for (const id of Object.keys(prev)) { if (prev[id] && Object.keys(prev[id]).length) last[id] = JSON.stringify(prev[id]); else delete last[id]; }
        toast('Could not save your source review: ' + why(er) + '. It is kept on this page and will be sent with your next change.', 'bad');
        throw er;
      }
      // the local files stay in step with Max's review (Claude and Gemini read verdicts.json)
      if (LOCAL && S.me === 'max') fetch('/__verdicts', { method: 'POST', body: JSON.stringify({ key, verdicts: V }) }).catch(() => {});
      // Max's review is private, so only Dr. Lee's shows up in the shared activity (and in Max's Lee Review)
      if (S.me !== 'lee') return;
      const pid = S.sources.paper_of[key], ids = Object.keys(changed).filter((k) => !k.startsWith('_'));
      const CALLS = { use: 'Use', maybe: 'Maybe', drop: "Don't use", reword: 'Maybe', valid: 'Use', partly: 'Maybe', reject: "Don't use" };
      const parts = ids.map((id) => {
        const a = prev[id] || {}, b = changed[id], bits = [];
        const ca = a.call || a.verdict || '', cb = b.call || b.verdict || '';
        if (ca !== cb) bits.push(cb ? `call: ${CALLS[cb] || cb}` : 'cleared his call');
        if ((a.note || '') !== (b.note || '')) bits.push(b.note ? `note: “${b.note.slice(0, 160)}”` : 'removed his note');
        if (JSON.stringify(a.passage_notes || {}) !== JSON.stringify(b.passage_notes || {})) bits.push('comment on a passage');
        if (JSON.stringify(a.page_notes || []) !== JSON.stringify(b.page_notes || [])) bits.push('page note');
        if (JSON.stringify(a.ratings || {}) !== JSON.stringify(b.ratings || {})) bits.push('ratings');
        if ((a.choice || 'current') !== (b.choice || 'current')) bits.push('picked a different source');
        return bits.length ? `${id}: ${bits.join(', ')}` : '';
      });
      const real = ids.filter((id, i) => parts[i]);      // cards he actually changed (a first save also stores untouched ones)
      if (!real.length) return;
      log(pid, 'source', null, `reviewed ${real.join(', ')} in Sources (${key.split('/')[1]})`, { sourceKey: key, cards: real, detail: parts.filter(Boolean).join(' · ') });
    },
    // Calls cb(key, V, who) when a review changes elsewhere: your own in another tab or window (who = you),
    // or, for Max, Dr. Lee's (who = 'lee').
    watchVerdicts(cb) {
      const pids = [...new Set(Object.values(S.sources.paper_of))];
      const own = (docs) => {
        for (const d of docs) {
          const key = d._key; if (!key || d._tab === TAB) continue;
          const V = stripV(d); const last = vLast[key] || {};
          const differs = Object.entries(V).some(([k, v]) => last[k] !== JSON.stringify(v));
          if (!differs) continue;
          vLast[key] = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, JSON.stringify(v)]));
          cb(key, V, S.me);
        }
      };
      const lees = {};
      const lee = (docs) => {
        for (const d of docs) {
          const key = d._key; if (!key) continue;
          const j = JSON.stringify(stripV(d)); if (lees[key] === j) continue;
          const first = !(key in lees); lees[key] = j;
          if (!first) cb(key, stripV(d), 'lee');
        }
      };
      if (S.me === 'max') {
        S.unsubs.push(DB.listen(`${PRIV}/source_verdicts`, own));
        for (const pid of pids) S.unsubs.push(DB.listen(`${P(pid)}/lee_verdicts`, lee));
      } else for (const pid of pids) S.unsubs.push(DB.listen(`${P(pid)}/lee_verdicts`, own));
    },
  };

  // ---------- modal ----------
  function modal(html, bind, cls = '') {
    closeModal();
    const m = h(`<div class="modal-bg"><div class="modal ${cls}" role="dialog">${html}</div></div>`);
    $('#modal-root').appendChild(m);
    m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(); });
    m.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModal);
    document.addEventListener('keydown', escClose);
    bind && bind(m);
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() { $('#modal-root').innerHTML = ''; document.removeEventListener('keydown', escClose); }

  // ---------- boot ----------
  async function loadManifest() {
    const r = await fetch('vault/manifest.bin', { cache: 'no-store' });
    S.manifest = JSON.parse(new TextDecoder().decode(await decryptBytes(await r.arrayBuffer())));
    if (S.me === 'max' && S.maxKey) {
      try {
        const rm = await fetch('vault/manifest_max.bin', { cache: 'no-store' });
        const mine = JSON.parse(new TextDecoder().decode(await decryptBytes(await rm.arrayBuffer(), S.maxKey)));
        S.maxIds = new Set(mine.map((f) => f.id));
        S.manifest = S.manifest.concat(mine.map((f) => ({ ...f, name: f.name + ' (only you)' })));
      } catch (e) { console.warn('Max-only files not loaded', e); }
    }
  }
  // Local preview: load the files' current state (mock-seed.json, rebuilt by publish.sh) into the test backend.
  // A paragraph or verdict card is refreshed from the files only if it changed in the files since the last
  // load and was not edited here in the meantime, so local edits are never overwritten.
  async function mockSync() {
    if (DB.kind !== 'mock') return;
    const seed = await fetch('mock-seed.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (!seed) return;
    const AK = 'leesearch-mock-seed-applied';
    let prev = null; try { prev = JSON.parse(localStorage.getItem(AK)); } catch {}
    if (prev && prev.stamp === seed.stamp) return;
    const ops = []; let kept = 0, refreshed = 0;
    for (const p of seed.papers) ops.push({ op: 'set', merge: true, path: `${ROOT}/${p.id}`, data: p });
    for (const b of seed.blocks) {
      const path = `${ROOT}/aaoms/blocks/${b.id}`; const cur = await DB.get(path);
      const was = prev && prev.blocks ? prev.blocks[b.id] : undefined;
      if (!cur) { ops.push({ op: 'set', path, data: { ...b, version: 0, deleted: false } }); continue; }
      if (cur.html === b.html || was === b.html) continue;
      if (!cur.version || cur.html === was) { ops.push({ op: 'set', merge: true, path, data: { html: b.html } }); refreshed++; } else kept++;
    }
    for (const [key, V] of Object.entries(seed.verdicts || {})) {
      const path = `${PRIV}/source_verdicts/${key.replace(/\//g, '__')}`; const cur = await DB.get(path);
      const was = (prev && prev.verdicts && prev.verdicts[key]) || {}; const data = { _key: key, _updatedBy: 'files', _updatedAt: now() };
      for (const [id, v] of Object.entries(V)) { const j = JSON.stringify(v); if (!cur || was[id] !== j) data[id] = v; }
      if (Object.keys(data).length > 3) ops.push({ op: 'set', merge: true, path, data });
    }
    if (ops.length) await DB.batch(ops);
    const applied = { stamp: seed.stamp, blocks: Object.fromEntries(seed.blocks.map((b) => [b.id, b.html])), verdicts: Object.fromEntries(Object.entries(seed.verdicts || {}).map(([k, V]) => [k, Object.fromEntries(Object.entries(V).map(([id, v]) => [id, JSON.stringify(v)]))])) };
    localStorage.setItem(AK, JSON.stringify(applied));
    if (prev) setTimeout(() => toast(`Loaded the latest files${refreshed ? ` (${refreshed} paragraph${refreshed > 1 ? 's' : ''} updated)` : ''}${kept ? `; kept ${kept} paragraph${kept > 1 ? 's' : ''} you edited here` : ''}.`), 800);
  }
  async function localKey(which = 'key') {
    const k = await fetch('local-key.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    return k && k[which] ? crypto.subtle.importKey('raw', b64d(k[which]), 'AES-GCM', false, ['decrypt']) : null;
  }
  // Local preview: the local server rebuilds when files change; pick that up without a reload, and write the
  // preview's manuscript state back to Lee/leesearch/pull/<paper>/manuscript_local.md for Gemini and Claude.
  let localStamp = null, snapTimer = null;
  function renderWebSync(st) {
    const el = $('#websync'); if (!el || !st) return;
    const w = st.web || {};
    el.className = 'websync ' + (w.state || '');
    el.textContent = w.state === 'publishing' ? 'Website: updating…' : w.state === 'waiting' ? 'Website: updates soon' : w.state === 'error' ? 'Website: update failed' : w.at ? `Website: up to date · ${ago(w.at * 1000)}` : 'Website';
    el.title = w.state === 'error' ? w.error || '' : 'Local work is uploaded to maxmendelson.com/leesearch automatically. Click to upload now.';
    el.onclick = () => fetch('/__publish', { method: 'POST', body: '{}' }).then(() => { el.textContent = 'Website: updating…'; }).catch(() => {});
  }
  async function localPoll() {
    if (!LOCAL || !S.me) return;
    const st = await fetch('/__status', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    renderWebSync(st);
    if (!st || !st.stamp) return;
    if (localStamp === null) { localStamp = st.stamp; return; }
    if (st.stamp === localStamp) return;
    localStamp = st.stamp;
    S.sources = null; S.fileCache.clear();
    try { await loadManifest(); } catch (e) { console.warn(e); }
    await mockSync();
    if (S.route.view !== 'sources') render();
    bundleListeners.forEach((cb) => { try { cb(st.changed || []); } catch (e) { console.warn(e); } });
    if (!(st.changed || []).length) return;
    toast('Updated from files: ' + st.changed.slice(0, 3).join(', ') + (st.changed.length > 3 ? ` +${st.changed.length - 3} more` : ''));
  }
  setInterval(localPoll, 3000);
  function localSnapshot() {
    if (!LOCAL || S.me !== 'max') return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      for (const p of S.papers.filter((x) => x.hasManuscript)) {
        const d = D_(p.id);
        fetch('/__snapshot', { method: 'POST', body: JSON.stringify({ paper: p.id, data: { blocks: d.blocks, suggestions: d.suggestions, notes: d.notes, done: d.done } }) }).catch(() => {});
      }
    }, 2000);
  }

  DB.onAuth(async (u) => {
    if (!u) {
      S.unsubs.forEach((x) => x()); S.unsubs = []; S.me = null; clearInterval(presTimer);
      // Local preview skips sign-in until launch: open as Max (or ?as=lee), using the local key.
      if (DB.kind === 'mock') {
        const want = sessionStorage.getItem('leesearch-mock-next') || (new URLSearchParams(location.search).get('as') === 'lee' ? 'lee' : 'max');
        sessionStorage.removeItem('leesearch-mock-next');
        S.key = S.key || await localKey();
        if (S.key) return DB.signIn(USERS[want].email, '');
      }
      return renderLogin();
    }
    const me = PEOPLE.find((k) => USERS[k].email === u.email);
    if (!me) { await DB.signOut(); return renderLogin('This account is not part of Leesearch.'); }
    S.me = me; S.uid = u.uid;
    S.maxKey = me !== 'max' ? null : DB.kind === 'mock' ? await localKey('maxKey') : await remoteMaxKey();
    if (!S.key) S.key = await keyStore('get');
    if (!S.key && DB.kind === 'mock') S.key = await localKey();
    if (!S.key && DB.kind !== 'mock') S.key = await remoteKey();
    if (!S.key) { await DB.signOut(); return renderLogin('Could not get the file key. Sign in again.'); }
    try { await loadManifest(); } catch (e) {
      // A key saved on this device before the key was changed: fetch the current one once.
      const k = DB.kind === 'mock' ? null : await remoteKey();
      try { if (!k) throw e; S.key = k; S.fileCache.clear(); await loadManifest(); } catch (e2) {
        console.error(e2); await keyStore('del'); S.key = null; await DB.signOut(); return renderLogin('Could not unlock the files. Sign in again.');
      }
    }
    await mockSync();
    fromHash();
    $('#app').innerHTML = '';
    subscribeAll(); startPresence(); render(true);
  });
  document.addEventListener('selectionchange', () => {
    if (!S.editing) return;
    const ed = document.querySelector('.blk.editing .ed'); const sel = window.getSelection();
    if (ed && sel.rangeCount && ed.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); S.editing.sel = [r.startContainer, r.startOffset, r.endContainer, r.endOffset]; }
  });
  window.addEventListener('beforeunload', (e) => { if (S.editing || DB.pending()) { e.preventDefault(); e.returnValue = ''; } });
  // any other save that fails (done marks, closing a thread, accepting a suggestion…) says so instead of failing silently
  window.addEventListener('unhandledrejection', (e) => { const er = e.reason; if (er && er.code) toast('Could not save: ' + (er.message || er.code), 'bad'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
  setInterval(() => { if (S.route.view === 'home') renderHome(); renderPresence(); }, 60000);
})();
