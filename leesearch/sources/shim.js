// Stands in for review_app.py on the Leesearch site. The source-review page's code is unchanged except for
// a few marked swaps (see leesearch/tools/build_vault.py); its /api calls are answered here from the
// encrypted bundle, and verdicts are saved to Firestore through the parent Leesearch window.
window.LS = (function () {
  const bridge = window.parent && window.parent !== window ? window.parent.LeesearchBridge : null;
  if (!bridge) { document.addEventListener('DOMContentLoaded', () => { document.body.innerHTML = '<p style="padding:40px">Open this from Leesearch.</p>'; }); }
  const realFetch = window.fetch.bind(window);
  let bundle = null;
  const blobUrls = {};
  const json = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });
  async function loadBundle() {
    const b = await bridge.sourcesBundle();
    for (const ex of b.exhibits) {
      if (String(ex.url).startsWith('vault:')) {
        const buf = await bridge.decrypt(ex.url.slice(6));
        ex.url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
      }
    }
    return b;
  }
  // When the files change (local preview), drafts refresh through the page's own 3-second poll; changed
  // cards or packets need the page reloaded, which waits until nothing is being typed.
  const sig = (b) => JSON.stringify([b.data, b.batches, b.extras, b.files]);
  function reloadWhenIdle() {
    const a = document.activeElement;
    if (a && /TEXTAREA|INPUT|SELECT/.test(a.tagName)) return setTimeout(reloadWhenIdle, 2000);
    location.reload();
  }
  const ready = (async () => {
    bundle = await loadBundle();
    if (bridge.onUpdate) bridge.onUpdate(async (changed) => {
      const nb = await loadBundle();
      const reload = sig(nb) !== sig(bundle) || (changed || []).includes('review_page.html');
      bundle = nb;
      if (reload) reloadWhenIdle();
    });
    const who = document.getElementById('lsuser');
    if (who) who.textContent = 'Signed in as ' + bridge.name(bridge.me);
    bridge.watchVerdicts((key, V) => window.LS_remote && window.LS_remote(key, V));
  })();

  function fileKey(url) {
    const p = decodeURIComponent(String(url).replace(/^https?:\/\/[^/]+/, '')).replace(/^\/api\//, '');
    if (p.startsWith('ref/')) return 'ref:' + p.slice(4);
    const m = p.match(/^([^/]+\/[^/]+)\/file\/(.+)$/);
    return m ? `file:${m[1]}/${m[2]}` : null;
  }
  async function bytesFor(url) {
    const fid = bundle.files[fileKey(url)];
    if (!fid) throw new Error('This PDF is not in the Leesearch library: ' + url);
    // A fresh copy each time: pdf.js transfers the buffer to its worker, which would empty the shared cache.
    return new Uint8Array((await bridge.decrypt(fid)).slice(0));
  }

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    await ready;
    const parts = url.split('?')[0].replace(/^\/api\//, '').split('/').map(decodeURIComponent);
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' && parts.length === 3 && parts[2] === 'verdicts') {
      try { await bridge.saveVerdicts(parts[0] + '/' + parts[1], JSON.parse(init.body || '{}')); return json({ ok: true }); }
      catch (e) { console.error(e); return json({ ok: false }, 500); }
    }
    if (parts[0] === 'batches') return json({ batches: bundle.batches, uses: bundle.uses });
    if (parts[0] === 'packets') return json(Object.keys(bundle.data));
    if (parts[0] === 'extras') return json(bundle.extras);
    if (parts[0] === 'exhibits') return json(bundle.exhibits);
    if (parts.length === 3) {
      const key = parts[0] + '/' + parts[1];
      if (parts[2] === 'data' && bundle.data[key]) return json({ ...bundle.data[key], verdicts: await bridge.loadVerdicts(key) });
      if (parts[2] === 'draft' && bundle.drafts[key]) return json(bundle.drafts[key]);
    }
    return json({}, 404);
  };

  // "Open PDF" links point at /api/...: open the decrypted file in a new tab instead.
  document.addEventListener('click', async (e) => {
    const a = e.target.closest && e.target.closest('a[href^="/api/"]');
    if (!a) return;
    e.preventDefault();
    const w = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(new Blob([await bytesFor(a.getAttribute('href'))], { type: 'application/pdf' }));
      if (w) w.location = url; else location.href = url;
    } catch (err) { if (w) w.close(); alert(err.message); }
  }, true);

  return {
    ready,
    get me() { return bridge.me; },
    name: (by) => bridge.name(by || 'max'),
    pdf: async (url) => ({ data: await bytesFor(url) }),
  };
})();
