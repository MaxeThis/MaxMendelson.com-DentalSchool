// Isolated browser acceptance checks. Never uses a personal browser profile.
// Run a local HTTP server first, then set PLAYWRIGHT_MODULE and CHROME_BIN if
// Playwright/the Chromium binary are not installed in their standard locations.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
register('./baser-module-loader.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const THREE = await import('three');
const { createBinarySTL, binaryResultToBytes } = await import('../baser/src/exporter.js');
const { INFILL_PATTERNS } = await import('../baser/src/base.js');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8000';
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new Error('Browser QA requires a localhost test server.');
const output = process.env.QA_OUTPUT || path.join(os.tmpdir(), 'baser-browser-qa');
await mkdir(output, { recursive: true });
const model = new THREE.Mesh(new THREE.BoxGeometry(35, 12, 25));
const fixture = Buffer.from(binaryResultToBytes(createBinarySTL(model)));
model.geometry.dispose();
const results = [];
const scope = process.env.QA_PART || 'all';
assert.ok(['all', 'site', 'lettering'].includes(scope), 'QA_PART must be all, site, or lettering');
const report = (message, details = {}) => { results.push({ message, ...details }); console.log('PASS', message, Object.keys(details).length ? JSON.stringify(details) : ''); };
console.log('QA launching isolated Chrome');
const browser = await chromium.launch({
  headless: true,
  timeout: 60000,
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
console.log('QA Chrome launched');

try {
  if (scope !== 'site') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error('BASER PAGE ERROR', error.message); });
    page.on('console', (message) => { if (message.type() === 'error') console.error('BASER CONSOLE', message.text()); });
    await page.addInitScript(() => {
      window.__qaToasts = [];
      document.addEventListener('DOMContentLoaded', () => {
        const toast = document.querySelector('#toast');
        if (toast) new MutationObserver(() => window.__qaToasts.push(toast.textContent)).observe(toast, { childList: true, subtree: true });
      });
    });
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin + '/baser/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__ARTICULATOR_BASER__);
    await page.screenshot({ path: path.join(output, 'baser-empty.png') });
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-qa.stl', mimeType: 'model/stl', buffer: fixture });
    await page.waitForFunction(() => window.__ARTICULATOR_BASER__.summary().filename === 'synthetic-qa.stl' && document.querySelector('#processing-overlay').hidden);
    assert.ok(await page.locator('#action-bar').isVisible());
    const summary = () => page.evaluate(() => window.__ARTICULATOR_BASER__.summary());
    assert.ok((await summary()).geometry.triangles > 0);
    report('Synthetic STL import and 3D viewport initialize');

    await page.locator('#btn-settings').click();
    for (const pattern of INFILL_PATTERNS.filter((item) => item.fresh && (scope !== 'lettering' || item.id === 'honeycomb'))) {
      await page.locator(`[data-pattern="${pattern.id}"]`).click();
      await page.waitForFunction((id) => window.__ARTICULATOR_BASER__.summary().baseParams.infill === id, pattern.id);
      const current = await summary();
      assert.equal(current.settings.infill, pattern.id);
      assert.equal(await page.locator(`[data-pattern="${pattern.id}"]`).getAttribute('aria-pressed'), 'true');
      assert.ok(current.baseParams.height - current.baseParams.clampBand - current.baseParams.wall >= pattern.band - 0.001);
      await page.screenshot({ path: path.join(output, `baser-${pattern.id}.png`) });
      report(`New ${pattern.label} pattern selects and preserves a usable wall band`, { height: current.baseParams.height });
    }
    await page.locator('#btn-settings-close').click();
    await page.evaluate(() => window.__ARTICULATOR_BASER__.selectBase());
    await page.locator('#base-text-1').fill('DEMO 01');
    await page.locator('#base-text-2').fill('UPPER');
    await page.locator('#base-text-size').selectOption('3.7');
    for (const alignment of (scope === 'lettering' ? ['center'] : ['left', 'center', 'right'])) {
      await page.locator('#base-text-align').selectOption(alignment);
      await page.locator('#btn-apply-lettering').click();
      await page.waitForFunction((value) => window.__ARTICULATOR_BASER__.summary().baseParams.textAlign === value, alignment);
      assert.ok(await page.locator('#engraving-preview rect').count() > 1);
    }
    await page.locator('#base-text-align').selectOption('center');
    if (scope !== 'lettering') await page.locator('#btn-apply-lettering').click();
    assert.equal((await summary()).baseParams.textSize, 3.7);
    assert.equal(await page.locator('#engraving-hint').textContent(), '');
    await page.locator('#btn-view-lettering').click();
    await page.evaluate(async () => {
      const imports = JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports;
      const url = new URL(imports['./src/tween.js'] || './src/tween.js', location.href);
      const { TWEEN } = await import(url.href);
      while (TWEEN.tweens.length) await new Promise(requestAnimationFrame);
      // Let the settled camera reach the WebGL framebuffer before capture.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await page.screenshot({ path: path.join(output, 'baser-engraving-desktop.png') });
    report(scope === 'lettering' ? 'Engraving preview, medium size, and center alignment work' : 'Engraving preview, medium size, and left/center/right alignment work');

    if (scope !== 'lettering') {
      const before = (await summary()).baseParams.width;
      await page.evaluate((width) => window.__ARTICULATOR_BASER__.setBaseParam('width', width + 2), before);
      assert.equal((await summary()).baseParams.width, before + 2);
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction((width) => window.__ARTICULATOR_BASER__.summary().baseParams.width === width, before);
      report('Keyboard undo restores the previous base dimensions');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.__ARTICULATOR_BASER__.selectBase());
      const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(mobileOverflow, false, 'mobile viewport must not overflow horizontally');
      await page.screenshot({ path: path.join(output, 'baser-mobile-inspector.png') });
      await page.locator('#btn-wall-design').click();
      await page.locator('[data-pattern="honeycomb"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'baser-mobile-patterns.png') });
      assert.ok(await page.locator('[data-pattern="honeycomb"]').isVisible());
      await page.locator('#btn-settings-close').click();
      report('Mobile inspector and pattern gallery remain usable at 390 px');
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.__ARTICULATOR_BASER__.selectBase());
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    // Surface a rejected export promptly instead of reporting it as a mysterious
    // missing download. The page has not emitted any earlier export errors here.
    const exportFailure = page.waitForFunction(() => window.__qaToasts.find((message) => /could not be cut cleanly|export failed/i.test(message)), null, { timeout: 60000 })
      .then((handle) => handle.jsonValue()).then((message) => { throw new Error(`Export rejected: ${message}`); });
    const exportResult = Promise.race([downloadPromise, exportFailure]);
    // Attach a rejection handler before a slow rendering/click step can finish.
    exportResult.catch(() => {});
    // Type the last edit immediately before a real browser click on Export.
    // The click/blur must commit the pending lettering before serialization.
    await page.evaluate(() => {
      const text = document.querySelector('#base-text-1');
      text.value = 'FINAL 09';
      text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#btn-export').click();
    const download = await exportResult;
    const target = path.join(output, download.suggestedFilename());
    await download.saveAs(target);
    const bytes = await readFile(target);
    assert.ok(bytes.byteLength > 84);
    assert.equal(bytes.byteLength, 84 + bytes.readUInt32LE(80) * 50);
    await page.waitForFunction(() => document.querySelector('#processing-overlay').hidden);
    const exported = await summary();
    assert.equal(exported.processed, true);
    assert.equal(exported.baseParams.textLine1, 'FINAL 09');
    await page.screenshot({ path: path.join(output, 'baser-exported.png') });
    report('Last typed text flushes before exporting a nonempty binary STL', { bytes: bytes.byteLength, triangles: bytes.readUInt32LE(80) });

    await page.locator('#btn-reset').click();
    await page.waitForFunction(() => !window.__ARTICULATOR_BASER__.summary().geometry);
    assert.ok(await page.locator('#btn-browse').isVisible());
    assert.equal(await page.locator('#action-bar').isVisible(), false);
    report('Reset returns to the file import screen');
    assert.deepEqual(errors, [], 'Baser must have no uncaught browser exceptions');
    assert.deepEqual(requests.filter((request) => new URL(request.url).origin !== origin), [], 'localhost must not contact analytics/third parties');
    assert.deepEqual(requests.filter((request) => request.method !== 'GET'), [], 'model/label actions must not upload content');
    report('Localhost CAD produces no analytics/model uploads or uncaught errors');
    await context.close();
  }

  // All Firebase scripts and data for root-site QA are local fixtures. No real
  // student data is read and no production session/event can be written.
  if (scope !== 'lettering') {
    async function siteContext(admin) {
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await isolated.addInitScript(({ admin }) => {
        const now = Date.now();
        const fixtureProfile = { sNumber: 'S42585', name: 'QA Synthetic Admin', phone: '', createdAt: now - 86400000, updatedAt: now, schedule: [] };
        const usage = [
          { visitorId: 'fake-a', startedAt: now - 7200000, lastActiveAt: now, activeSeconds: 120, import_success: 2, export_started: 3, export_success: 2, export_error: 1, pattern_changed: 4, text_applied: 2 },
          { visitorId: 'fake-a', startedAt: now - 3600000, lastActiveAt: now, activeSeconds: 60, import_success: 1, export_started: 1, export_success: 1 },
          { visitorId: 'fake-b', startedAt: now - 1800000, lastActiveAt: now, activeSeconds: 180, import_success: 1, export_started: 2, export_success: 2 },
        ];
        window.__qaWrites = [];
        const docs = (name) => name === 'users' ? [fixtureProfile] : name === 'baserUsageSessions' ? usage : [];
        const snapshot = (name) => {
          const records = docs(name).map((data, i) => ({ id: `fixture-${i}`, data: () => data }));
          return { size: records.length, docs: records, forEach: (fn) => records.forEach(fn) };
        };
        const store = { collection(name) {
          const query = {
            where() { return this; }, orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
            get: async () => snapshot(name),
            onSnapshot(fn) { queueMicrotask(() => fn(snapshot(name))); return () => {}; },
            doc(id = 'fixture-session') { return {
              id,
              get: async () => ({ exists: name === 'users', data: () => fixtureProfile }),
              set: async (data) => window.__qaWrites.push({ name, id, data }),
              update: async (data) => window.__qaWrites.push({ name, id, data }),
            }; },
            add: async (data) => { window.__qaWrites.push({ name, data }); return { id: 'fixture-write' }; },
          };
          return query;
        }, batch: () => ({ update() {}, commit: async () => {} }) };
        const anon = { uid: 'fixture-anonymous' };
        const owner = { uid: 'fixture-owner', email: 'maxethis@gmail.com', emailVerified: true, providerData: [{ providerId: 'password' }] };
        const defaultAuth = { currentUser: anon, signInAnonymously: async () => ({ user: anon }), onAuthStateChanged(fn) { queueMicrotask(() => fn(this.currentUser)); return () => {}; } };
        const ownerAuth = { ...defaultAuth, currentUser: owner, isSignInWithEmailLink: () => false,
          signOut: async function() { this.currentUser = null; },
          sendSignInLinkToEmail: async () => { throw new Error('No real email is permitted in QA'); },
        };
        const firestore = () => store;
        firestore.Timestamp = { fromMillis: (value) => value };
        window.firebase = { apps: [], firestore, auth: () => defaultAuth, appCheck: () => ({ activate() {} }),
          initializeApp(config, name = '[DEFAULT]') { const app = { name, auth: () => name === 'baser-admin' ? ownerAuth : defaultAuth, firestore: () => store, appCheck: () => ({ activate() {} }) }; this.apps.push(app); return app; },
        };
        if (admin) {
          localStorage.setItem('umsod_be_profile_v1', JSON.stringify(fixtureProfile));
          localStorage.setItem('umsod-admin-enabled-v1', '1');
        }
      }, { admin });
      const external = [];
      await isolated.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === 'www.gstatic.com' && url.pathname.includes('firebase')) return route.fulfill({ contentType: 'application/javascript', body: '/* Firebase mocked by isolated QA fixture. */' });
        external.push(url.href);
        return route.abort();
      });
      const view = await isolated.newPage();
      const uncaught = [];
      view.on('pageerror', (error) => uncaught.push(error.message));
      await view.goto(origin + '/', { waitUntil: 'networkidle' });
      return { isolated, view, external, uncaught };
    }
    const guest = await siteContext(false);
    assert.ok(await guest.view.locator('#signin-gate').isVisible());
    await guest.view.locator('.nav-btn[data-view="apps"]').click();
    assert.ok(await guest.view.locator('#view-apps').isVisible());
    assert.equal((await guest.view.evaluate(() => window.__qaWrites)).length, 0);
    assert.deepEqual(guest.uncaught, []);
    assert.deepEqual(guest.external, []);
    report('Root guest boot and public Apps tab work with zero data writes');
    await guest.isolated.close();

    const admin = await siteContext(true);
    await admin.view.locator('.nav-btn[data-view="admin"]').click();
    await admin.view.locator('[data-admin-tab="baser"]').click();
    await admin.view.waitForFunction(() => document.querySelector('[data-usage-metric="exports"]').textContent === '5');
    assert.equal(await admin.view.locator('[data-usage-metric="visitors"]').textContent(), '2');
    assert.equal(await admin.view.locator('[data-usage-metric="sessions"]').textContent(), '3');
    assert.equal(await admin.view.locator('[data-usage-metric="success"]').textContent(), '83%');
    assert.equal(await admin.view.locator('#baser-usage-chart .usage-chart-day').count(), 30);
    await admin.view.screenshot({ path: path.join(output, 'admin-usage-desktop.png'), fullPage: true });
    await admin.view.locator('#baser-usage-days').selectOption('7');
    await admin.view.waitForFunction(() => document.querySelectorAll('#baser-usage-chart .usage-chart-day').length === 7);
    await admin.view.setViewportSize({ width: 390, height: 844 });
    assert.equal(await admin.view.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await admin.view.screenshot({ path: path.join(output, 'admin-usage-mobile.png'), fullPage: true });
    assert.deepEqual(admin.uncaught, []);
    assert.deepEqual(admin.external, []);
    report('Admin usage fixture shows 2 browsers, 3 sessions, 5 exports; period and mobile layout work');
    await admin.isolated.close();
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`All isolated browser checks passed. Artifacts: ${output}`);
} catch (error) {
  console.error('QA FAILED', error.message);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    try {
      console.error('QA STATE', await page.evaluate(() => ({ url: location.href, toasts: window.__qaToasts,
        summary: window.__ARTICULATOR_BASER__?.summary(), processing: document.querySelector('#processing-status')?.textContent,
        errors: document.querySelector('#baser-usage-status')?.textContent })));
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 10000 });
    } catch (_) { /* Preserve the original failure if the renderer has stopped. */ }
  }
  throw error;
} finally {
  await browser.close();
}
