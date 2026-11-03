// Counts page opens and link clicks on /links. See privacy.html#link-clicks.
//
// Each event is one Firestore document: page, link id, kind (view or click),
// a coarse device class and where the visitor came from. No URLs, referrers
// or user agents leave the browser. This talks to Firebase's REST APIs
// directly so the page stays light: an anonymous Auth user (the random
// visitor id), an App Check token from reCAPTCHA v3, then one Firestore write.
//
// Mark a page with <body data-page="links"> and each counted link with
// data-link="some_id". Global Privacy Control and Do Not Track turn it off.
(() => {
  const config = {
    apiKey: 'AIzaSyDnNw8OLwcDEhGr0cWPiB5ld-zcA-u54Qk',
    projectId: 'maxmendelson-com-dental-school',
    appId: '1:44601534820:web:42febc109238a799b5b271',
    recaptchaKey: '6LchQr4sAAAAAL34gOfS1b-kr2tPPb7GlK5wJ6Ap',
  };
  const page = document.body.dataset.page;
  if (!page || navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;

  const AUTH_KEY = 'linkTracker.auth';
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };

  async function post(url, body, form = false) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Anonymous Firebase Auth user, kept across visits so repeat visitors count once.
  async function signIn() {
    const saved = store.get(AUTH_KEY);
    if (saved?.idToken && saved.expires > Date.now() + 60000) return saved;
    let fresh;
    if (saved?.refreshToken) {
      try {
        const r = await post(`https://securetoken.googleapis.com/v1/token?key=${config.apiKey}`,
          { grant_type: 'refresh_token', refresh_token: saved.refreshToken }, true);
        fresh = { uid: r.user_id, idToken: r.id_token, refreshToken: r.refresh_token, expires: Date.now() + r.expires_in * 1000 };
      } catch {}
    }
    if (!fresh) {
      const r = await post(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`, { returnSecureToken: true });
      fresh = { uid: r.localId, idToken: r.idToken, refreshToken: r.refreshToken, expires: Date.now() + r.expiresIn * 1000 };
    }
    store.set(AUTH_KEY, fresh);
    return fresh;
  }

  // Firestore enforces App Check, so prove this is the real page with reCAPTCHA v3.
  function recaptcha() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${config.recaptchaKey}`;
      script.async = true;
      script.onerror = reject;
      script.onload = () => grecaptcha.ready(() =>
        grecaptcha.execute(config.recaptchaKey, { action: 'fire_app_check' }).then(resolve, reject));
      document.head.appendChild(script);
    });
  }
  async function appCheck() {
    const project = config.appId.split(':')[1];
    const r = await post(`https://firebaseappcheck.googleapis.com/v1/projects/${project}/apps/${config.appId}:exchangeRecaptchaV3Token?key=${config.apiKey}`,
      { recaptchaV3Token: await recaptcha() });
    return r.token;
  }

  function device() {
    const ua = navigator.userAgent;
    if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
    return /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'desktop';
  }
  function source() {
    const ua = navigator.userAgent;
    if (/Instagram/i.test(ua)) return 'instagram';
    if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
    if (/TikTok|musical_ly|Bytedance/i.test(ua)) return 'tiktok';
    if (/LinkedInApp/i.test(ua)) return 'linkedin';
    let host = '';
    try { host = new URL(document.referrer).hostname; } catch {}
    if (!host) return 'direct';
    if (host === location.hostname) return 'site';
    for (const name of ['instagram', 'facebook', 'tiktok', 'linkedin', 'github']) {
      if (host === `${name}.com` || host.endsWith(`.${name}.com`) || (name === 'linkedin' && host === 'lnkd.in')) return name;
    }
    return 'other';
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const context = { device: device(), source: source() };
  const ready = Promise.all([signIn(), appCheck()]);
  ready.catch(() => {});

  async function send(kind, link = '') {
    const [user, check] = await ready;
    const db = `projects/${config.projectId}/databases/(default)`;
    const str = (v) => ({ stringValue: v });
    const fields = {
      schemaVersion: { integerValue: '1' }, visitorId: str(user.uid), page: str(page),
      kind: str(kind), link: str(link), device: str(context.device), source: str(context.source),
    };
    // keepalive lets the write finish after the browser leaves the page.
    await fetch(`https://firestore.googleapis.com/v1/${db}/documents:commit`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.idToken}`, 'X-Firebase-AppCheck': check },
      body: JSON.stringify({ writes: [{
        update: { name: `${db}/documents/linkEvents/${uuid()}`, fields },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      }] }),
    });
  }

  send('view').catch(() => {});

  document.addEventListener('click', (event) => {
    const a = event.target.closest('a[data-link]');
    if (!a || event.defaultPrevented || event.button !== 0) return;
    const sent = send('click', a.dataset.link).catch(() => {});
    // A new tab keeps this page alive, so only same-tab links wait for the write.
    if (a.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    Promise.race([sent, new Promise((r) => setTimeout(r, 500))]).then(() => { location.href = a.href; });
  });
})();
