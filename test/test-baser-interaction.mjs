// Local-only acceptance test for lettering pauses and legacy-pattern exports.
// Uses an isolated Chrome profile and an 81,920-triangle synthetic ellipsoid.
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
const { parseSTL } = await import('../baser/src/importers.js');
const { createBaseOutline } = await import('../baser/src/base.js');
const { measureOutline, buildEngravingCutters } = await import('../baser/src/infill.js');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8000';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use a localhost server only');
const pattern = process.env.QA_PATTERN || 'text';
assert.ok(['text', 'bars', 'wide'].includes(pattern), 'QA_PATTERN must be a legacy pattern: text, bars, or wide');
const detail = Number(process.env.QA_MODEL_DETAIL || 63);
assert.ok(Number.isInteger(detail) && detail >= 3 && detail <= 63, 'QA_MODEL_DETAIL must be an integer from 3 to 63');
const output = process.env.QA_OUTPUT || path.join(os.tmpdir(), 'baser-interaction-qa');
await mkdir(output, { recursive: true });
const geometry = new THREE.IcosahedronGeometry(1, detail);
geometry.scale(17.5, 7, 12.5);
const fixture = Buffer.from(binaryResultToBytes(createBinarySTL(new THREE.Mesh(geometry))));
const inputTriangles = fixture.readUInt32LE(80);
geometry.dispose();
const report = { pattern, inputTriangles, inputBytes: fixture.length };
const browser = await chromium.launch({ headless: true, timeout: 60000,
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: true });
const page = await context.newPage();
const requests = [], errors = [];
page.setDefaultTimeout(120000);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
await page.addInitScript(({ pattern }) => {
  localStorage.setItem('articulator-baser-settings-v2', JSON.stringify({
    width: 80, depth: 60, height: 28, wall: 3, hollow: true, clampBand: 11,
    infill: pattern, showGreeter: false, autoGrow: true
  }));
  window.__qaToasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(() => window.__qaToasts.push(document.querySelector('#toast').textContent))
      .observe(document.querySelector('#toast'), { childList: true, subtree: true });
  });
}, { pattern });

try {
  await page.goto(origin + '/baser/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ARTICULATOR_BASER__);
  await page.locator('#file-input').setInputFiles({ name: 'dense-synthetic.stl', mimeType: 'model/stl', buffer: fixture });
  await page.waitForFunction(() => window.__ARTICULATOR_BASER__.summary().filename === 'dense-synthetic.stl'
    && document.querySelector('#processing-overlay').hidden);
  await page.evaluate(() => window.__ARTICULATOR_BASER__.selectBase());
  console.log(`Imported ${inputTriangles.toLocaleString()} synthetic triangles with ${pattern} walls`);
  const beforeTyping = await page.evaluate(() => window.__ARTICULATOR_BASER__.summary());

  report.typing = await page.evaluate(async () => {
    const first = document.querySelector('#base-text-1');
    const second = document.querySelector('#base-text-2');
    const starts = new WeakMap(), durations = [], scheduledLags = [], longTasks = [];
    const capture = event => { if (event.target === first || event.target === second) starts.set(event, performance.now()); };
    const bubble = event => { if (starts.has(event)) durations.push(performance.now() - starts.get(event)); };
    document.addEventListener('input', capture, true);
    document.addEventListener('input', bubble);
    const observer = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))) : null;
    observer?.observe({ type: 'longtask', buffered: false });
    const steps = [];
    let at = 0;
    function append(field, value) {
      steps.push({ at, field, clear: true });
      for (const character of value) { at += 40; steps.push({ at, field, character }); }
    }
    append(first, 'RAPID DRAFT');
    at += 680; // Cross the former debounce boundary, then resume typing.
    append(first, 'FINAL 09');
    at += 80;
    append(second, 'UPPER');
    const began = performance.now();
    await Promise.all(steps.map(step => new Promise(resolve => setTimeout(() => {
      scheduledLags.push(performance.now() - began - step.at);
      step.field.focus();
      step.field.value = step.clear ? '' : step.field.value + step.character;
      step.field.dispatchEvent(new Event('input', { bubbles: true }));
      resolve();
    }, step.at))));
    // Keep focus in the field: simply pausing must not lock the editor.
    await new Promise(resolve => setTimeout(resolve, 750));
    const pausedLag = performance.now() - began - at - 750;
    observer?.disconnect();
    document.removeEventListener('input', capture, true);
    document.removeEventListener('input', bubble);
    const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;
    return { inputs: durations.length, maxHandlerMs: Math.max(...durations), p95ScheduledLagMs: percentile(scheduledLags, 0.95),
      maxScheduledLagMs: Math.max(...scheduledLags), pausedLagMs: pausedLag,
      maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)), longTaskCount: longTasks.length,
      first: first.value, second: second.value, focused: document.activeElement === second };
  });
  console.log('Typing measurements', JSON.stringify(report.typing));
  assert.equal(report.typing.first, 'FINAL 09', 'pausing/resuming must not overwrite typed characters');
  assert.equal(report.typing.second, 'UPPER');
  assert.equal(report.typing.focused, true);
  assert.ok(report.typing.maxHandlerMs < 100, 'input handlers must not rebuild dense geometry synchronously');
  assert.ok(report.typing.maxScheduledLagMs < 500, 'typing must not cause a half-second event-loop freeze');
  assert.ok(report.typing.pausedLagMs < 500, 'a focused-field pause must not freeze the event loop');
  const drafted = await page.evaluate(() => window.__ARTICULATOR_BASER__.summary());
  assert.equal(drafted.baseParams.textLine1, beforeTyping.baseParams.textLine1, 'typing and pauses must not rebuild applied lettering');
  assert.equal(drafted.baseParams.textLine2, beforeTyping.baseParams.textLine2, 'switching fields must preserve an unapplied draft');
  assert.ok(await page.locator('#engraving-preview rect').count() > 40, 'draft lettering must update the immediate SVG proof');
  await page.locator('#btn-settings').click();
  await page.locator('#btn-settings-close').click();
  assert.equal(await page.locator('#base-text-1').inputValue(), 'FINAL 09', 'opening settings must preserve the current draft');
  assert.equal(await page.locator('#base-text-2').inputValue(), 'UPPER');
  assert.equal(await page.evaluate(() => window.__ARTICULATOR_BASER__.summary().baseParams.textLine1), beforeTyping.baseParams.textLine1);
  await page.screenshot({ path: path.join(output, 'dense-typing.png') });

  await page.locator('#btn-apply-lettering').click();
  await page.waitForFunction(() => window.__ARTICULATOR_BASER__.summary().baseParams.textLine1 === 'FINAL 09'
    && window.__ARTICULATOR_BASER__.summary().baseParams.textLine2 === 'UPPER');
  console.log('PASS explicit Apply commits the draft after responsive typing');

  const beforeExport = await page.evaluate(() => window.__ARTICULATOR_BASER__.summary());
  const download = page.waitForEvent('download', { timeout: 120000 });
  const rejected = page.waitForFunction(() => window.__qaToasts.find(message => /could not be cut cleanly|export failed/i.test(message)), null, { timeout: 120000 })
    .then(handle => handle.jsonValue()).then(message => { throw new Error(`Export rejected: ${message}`); });
  const completion = Promise.race([download, rejected]);
  completion.catch(() => {});
  // Dispatch the final character and click in the same JavaScript turn so the
  // test cannot accidentally wait through the debounce before exporting.
  report.exportClickMs = await page.evaluate(() => {
    const first = document.querySelector('#base-text-1');
    first.value = 'FINAL 09A';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    const began = performance.now();
    document.querySelector('#btn-export').click();
    return performance.now() - began;
  });
  const saved = await completion;
  const target = path.join(output, saved.suggestedFilename());
  await saved.saveAs(target);
  const bytes = await readFile(target);
  report.exportBytes = bytes.length;
  report.exportTriangles = bytes.readUInt32LE(80);
  assert.equal(bytes.length, 84 + report.exportTriangles * 50);
  assert.ok(report.exportTriangles > inputTriangles * 0.75, 'export must retain the dense synthetic model');
  await page.waitForFunction(() => document.querySelector('#processing-overlay').hidden);
  const final = await page.evaluate(() => window.__ARTICULATOR_BASER__.summary());
  assert.equal(final.processed, true);
  assert.equal(final.baseParams.textLine1, 'FINAL 09A');
  assert.equal(final.baseParams.textLine2, 'UPPER');

  // Check the downloaded file itself, correcting the slicer-axis rotation.
  const exported = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  exported.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(exported);
  const outline = measureOutline(createBaseOutline(final.baseParams));
  const strokes = buildEngravingCutters(outline, final.baseParams, { windowsOnly: true });
  assert.ok(strokes.length > 40);
  for (const stroke of strokes) {
    const position = outline.at((stroke.from + stroke.to) / 2).position;
    const [low, high] = stroke.profile(0.5);
    const [x, y, z] = beforeExport.basePosition;
    const ray = new THREE.Raycaster(new THREE.Vector3(position.x + x, (low + high) / 2 + y, outline.chordZ + z - 10), new THREE.Vector3(0, 0, 1));
    const hit = ray.intersectObject(mesh, false)[0];
    assert.ok(hit && Math.abs(hit.point.z - outline.chordZ - z - 0.6) < 0.002, 'every final label stroke must appear in the downloaded STL');
  }
  exported.dispose(); mesh.material.dispose();
  report.verifiedExportedStrokes = strokes.length;
  await page.screenshot({ path: path.join(output, 'dense-exported.png') });

  // A replacement model and programmatic undo must clear stale fields even
  // while the text input retains focus. Use a small fixture for these checks.
  const smallGeometry = new THREE.BoxGeometry(35, 12, 25);
  const smallFixture = Buffer.from(binaryResultToBytes(createBinarySTL(new THREE.Mesh(smallGeometry))));
  smallGeometry.dispose();
  const importSmall = async name => {
    await page.locator('#file-input').setInputFiles({ name, mimeType: 'model/stl', buffer: smallFixture });
    await page.waitForFunction(name => window.__ARTICULATOR_BASER__.summary().filename === name
      && document.querySelector('#processing-overlay').hidden, name);
    await page.evaluate(() => window.__ARTICULATOR_BASER__.selectBase());
  };
  await importSmall('draft-source.stl');
  await page.evaluate(() => {
    const hooks = window.__ARTICULATOR_BASER__;
    hooks.setBaseParam('width', hooks.summary().baseParams.width + 2);
  });
  await page.locator('#base-text-1').fill('UNSAVED');
  await page.locator('#base-text-2').fill('DRAFT');
  await page.locator('#base-text-1').focus();
  await page.evaluate(() => window.__ARTICULATOR_BASER__.undo());
  assert.equal(await page.locator('#base-text-1').inputValue(), '', 'undo must refresh a still-focused text field');
  assert.equal(await page.locator('#base-text-2').inputValue(), '');
  await page.locator('#base-text-1').fill('STALE');
  await page.locator('#base-text-2').fill('DRAFT');
  await page.locator('#base-text-1').focus();
  await importSmall('replacement.stl');
  assert.equal(await page.locator('#base-text-1').inputValue(), '', 'replacement import must clear a still-focused draft');
  assert.equal(await page.locator('#base-text-2').inputValue(), '');
  const replacement = await page.evaluate(() => window.__ARTICULATOR_BASER__.summary());
  assert.equal(replacement.baseParams.textLine1, '');
  assert.equal(replacement.baseParams.textLine2, '');
  const replacementDownload = page.waitForEvent('download', { timeout: 120000 });
  replacementDownload.catch(() => {});
  await page.locator('#btn-export').click();
  const replacementSaved = await replacementDownload;
  await replacementSaved.saveAs(path.join(output, replacementSaved.suggestedFilename()));
  const replacementBytes = await readFile(path.join(output, replacementSaved.suggestedFilename()));
  const replacementGeometry = parseSTL(replacementBytes.buffer.slice(replacementBytes.byteOffset, replacementBytes.byteOffset + replacementBytes.byteLength));
  replacementGeometry.rotateX(-Math.PI / 2);
  const replacementMesh = new THREE.Mesh(replacementGeometry);
  const replacementOutline = measureOutline(createBaseOutline(replacement.baseParams));
  const staleStrokes = buildEngravingCutters(replacementOutline, { ...replacement.baseParams, textLine1: 'STALE', textLine2: 'DRAFT' }, { windowsOnly: true });
  for (const stroke of staleStrokes) {
    const position = replacementOutline.at((stroke.from + stroke.to) / 2).position;
    const [low, high] = stroke.profile(0.5);
    const [x, y, z] = replacement.basePosition;
    const hit = new THREE.Raycaster(new THREE.Vector3(position.x + x, (low + high) / 2 + y, replacementOutline.chordZ + z - 10), new THREE.Vector3(0, 0, 1))
      .intersectObject(replacementMesh, false)[0];
    assert.ok(hit && Math.abs(hit.point.z - replacementOutline.chordZ - z) < 0.002, 'replacement export must have an unengraved wall where the old draft would appear');
  }
  replacementGeometry.dispose(); replacementMesh.material.dispose();
  report.replacementExportHasNoStaleLettering = true;
  report.focusedUndoClearsDraft = true;
  console.log('PASS focused undo/replacement clear both draft fields and replacement STL has no stale lettering');
  report.moduleVersions = [...new Set(requests.filter(request => /\/baser\/src\/.*\.js/.test(request.url))
    .map(request => new URL(request.url).searchParams.get('v')))];
  assert.equal(report.moduleVersions.length, 1, 'all application modules must load the same release version');
  assert.ok(report.moduleVersions[0], 'application modules must use explicit cache versions');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(request => new URL(request.url).origin !== origin || request.method !== 'GET'), []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('PASS dense-model typing, pause/resume, final-edit legacy export, actual STL lettering and local-only requests', JSON.stringify(report));
} catch (error) {
  console.error('INTERACTION QA FAILED', error.message);
  try {
    report.failure = error.message;
    report.state = await page.evaluate(() => ({ summary: window.__ARTICULATOR_BASER__?.summary(), toasts: window.__qaToasts }));
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 10000 });
  } catch (_) { /* Preserve the original renderer/test error. */ }
  throw error;
} finally {
  await browser.close();
}
