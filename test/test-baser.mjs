// Run with: node test/test-baser.mjs (Node 20.6+). No npm install required.
// --legacy also sweeps existing CSG-based designs; thin Round bars can be slow.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
register('./baser-module-loader.mjs', import.meta.url);
const THREE = await import('three');
const { DEFAULT_BASE_PARAMS, INFILL_PATTERNS, normalizeBaseParams, buildBaseGeometry,
    createBaseOutline, cleanEngravedText } = await import('../baser/src/base.js');
const { getEdgeTopologyStats, unionGeometries } = await import('../baser/src/csg.js');
const { buildInfillCutterPieces, buildEngravingCutters, measureOutline,
    engravingIssue, engravingBandNeeded } = await import('../baser/src/infill.js');
const { sanitizeGeometry } = await import('../baser/src/geometry.js');
const { parseSTL, parseOBJ, importModelFile } = await import('../baser/src/importers.js');
const { createBinarySTL, binaryResultToBytes, exportSTL } = await import('../baser/src/exporter.js');

function volume(geometry) {
    const p = geometry.getAttribute('position');
    const index = geometry.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let result = 0;
    for (let i = 0, count = index?.count ?? p.count; i < count; i += 3) {
        a.fromBufferAttribute(p, index ? index.getX(i) : i);
        b.fromBufferAttribute(p, index ? index.getX(i + 1) : i + 1);
        c.fromBufferAttribute(p, index ? index.getX(i + 2) : i + 2);
        result += a.dot(b.cross(c)) / 6;
    }
    return Math.abs(result);
}
function assertMesh(geometry, label) {
    assert.ok(getEdgeTopologyStats(geometry).isTwoManifold, `${label}: mesh must be closed`);
    assert.ok(volume(geometry) > 0, `${label}: mesh must contain material`);
    assert.ok([...geometry.getAttribute('position').array].every(Number.isFinite), `${label}: finite coordinates`);
}

const fresh = INFILL_PATTERNS.filter(pattern => pattern.fresh);
assert.equal(fresh.length, 4);
for (const dimensions of [{ width: 80, depth: 60, wall: 3 }, { width: 50, depth: 40, wall: 1.5 }]) {
    const params = normalizeBaseParams({ ...DEFAULT_BASE_PARAMS, ...dimensions, height: 23 });
    const signatures = new Set();
    for (const pattern of INFILL_PATTERNS.filter(p => p.fresh || (process.argv.includes('--legacy') && p.id !== 'solid'))) {
        const choices = { ...params, infill: pattern.id,
            height: params.clampBand + params.wall + pattern.band };
        const plain = buildBaseGeometry({ ...choices, infill: 'solid' });
        const plainVolume = volume(plain);
        plain.dispose();
        const pieces = buildInfillCutterPieces(choices, createBaseOutline(choices));
        if (pattern.fresh) {
            assert.ok(pieces.length > 8, `${pattern.id}: repeat around the wall`);
            for (const piece of pieces) {
                piece.computeBoundingBox();
                assert.ok(piece.boundingBox.min.y > params.clampBand, 'pattern must preserve clamp band');
                assert.ok(piece.boundingBox.max.y < choices.height - choices.wall, 'pattern must preserve deck');
            }
        }
        pieces.forEach(piece => piece.dispose());
        const geometry = buildBaseGeometry(choices);
        assertMesh(geometry, `${pattern.id} at ${params.width} mm`);
        assert.ok(volume(geometry) < plainVolume - 1, `${pattern.id}: must actually remove material`);
        const bytes = binaryResultToBytes(createBinarySTL(new THREE.Mesh(geometry)));
        if (pattern.fresh) signatures.add(createHash('sha256').update(bytes).digest('hex'));
        assert.equal(bytes.byteLength, 84 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true) * 50);
        const roundTrip = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        assertMesh(roundTrip, `${pattern.id}: STL round trip`);
        roundTrip.dispose(); geometry.dispose();
        console.log(`PASS ${pattern.label}, ${params.width} mm base and binary STL`);
    }
    assert.equal(signatures.size, fresh.length, 'new designs have distinct geometry');
}

assert.equal(cleanEngravedText('José 😀 / lower'), 'JOSE / LOWER');
const labelParams = normalizeBaseParams({ width: 80, height: 23, infill: 'honeycomb', textLine1: 'DEMO 01', textLine2: 'UPPER', textAlign: 'left', textSize: 3.7 });
const outline = measureOutline(createBaseOutline(labelParams));
assert.equal(engravingIssue(labelParams, outline), '');
const label = buildBaseGeometry(labelParams);
assertMesh(label, 'two-line honeycomb engraving');
assert.deepEqual(label.userData.detailWarnings, [], 'every requested letter stroke must be present');
const scan = new THREE.BoxGeometry(20, 10, 15);
scan.translate(0, labelParams.height + 4.5, 2);
const fused = unionGeometries(label, scan, { planarSeamY: labelParams.height });
assertMesh(fused, 'patterned and engraved base merged with a scan');
scan.dispose(); fused.dispose();
for (const align of ['left', 'center', 'right']) {
    const cutters = buildEngravingCutters(outline, { ...labelParams, textAlign: align });
    assert.ok(cutters.length > 20, 'engraving has real letter strokes');
    for (const cutter of cutters) {
        cutter.computeBoundingBox();
        assert.ok(cutter.boundingBox.max.y < labelParams.clampBand);
        assert.ok(cutter.boundingBox.max.z <= outline.chordZ + 0.60001, 'shallow engraving preserves wall thickness');
        if (align === labelParams.textAlign) {
            const center = cutter.boundingBox.getCenter(new THREE.Vector3());
            const ray = new THREE.Raycaster(new THREE.Vector3(center.x, center.y, outline.chordZ - 10), new THREE.Vector3(0, 0, 1));
            const hits = ray.intersectObject(new THREE.Mesh(label), false);
            assert.ok(hits.length > 0, 'engraving has a closed backing face');
            assert.ok(Math.abs(hits[0].point.z - outline.chordZ - 0.6) < 0.001, 'every visible stroke is actually recessed into the mesh');
        }
        cutter.dispose();
    }
}
const narrow = normalizeBaseParams({ width: 25, textLine1: 'OK', textLine2: 'THIS LINE IS TOO LONG' });
assert.match(engravingIssue(narrow, measureOutline(createBaseOutline(narrow))), /characters/);
const tight = normalizeBaseParams({ clampBand: 8, textLine1: 'ONE', textLine2: 'TWO' });
assert.match(engravingIssue(tight, measureOutline(createBaseOutline(tight))), /clamp band/);
assert.equal(Math.ceil(engravingBandNeeded(2)), 10, 'minimum must account for printable column pitch');
label.dispose();
console.log('PASS engraving fit, size, alignment, and shallow recess');

// Browser regression: these ordinary labels used to omit three strokes
// and block export. Require every requested recess, not merely a closed mesh.
for (const infill of ['solid', 'wave', 'honeycomb']) {
  for (const [textSize, textAlign] of [[3.7, 'center'], [3.2, 'left'], [4.2, 'right']]) {
    const params = normalizeBaseParams({ width: 80, depth: 60, height: 22, clampBand: 10,
        wall: 3, infill, textLine1: 'FINAL 09', textLine2: 'UPPER', textAlign, textSize });
    const geometry = buildBaseGeometry(params);
    const outline = measureOutline(createBaseOutline(params));
    const mesh = new THREE.Mesh(geometry);
    const cutters = buildEngravingCutters(outline, params);
    assertMesh(geometry, `${infill}: FINAL 09 / UPPER`);
    assert.deepEqual(geometry.userData.detailWarnings, [], `${infill}: no omitted lettering`);
    assert.equal(cutters.length, 53);
    for (const cutter of cutters) {
        cutter.computeBoundingBox();
        const center = cutter.boundingBox.getCenter(new THREE.Vector3());
        const size = cutter.boundingBox.getSize(new THREE.Vector3());
        for (const [x, y] of [[0, 0], [-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25]]) {
            const ray = new THREE.Raycaster(new THREE.Vector3(center.x + x * size.x, center.y + y * size.y, outline.chordZ - 10), new THREE.Vector3(0, 0, 1));
            const hit = ray.intersectObject(mesh, false)[0];
            assert.ok(hit && Math.abs(hit.point.z - outline.chordZ - 0.6) < 0.001,
                `${infill}: all 53 requested strokes must have their 0.6 mm recess`);
        }
        cutter.dispose();
    }
    geometry.dispose(); mesh.material.dispose();
    console.log(`PASS ${infill}: FINAL 09 / UPPER, ${textSize} mm ${textAlign}, every stroke recessed and mesh closed`);
  }
}

for (const pattern of fresh) {
    for (const cornerRadius of [0, 4]) {
        const solid = buildBaseGeometry({ ...DEFAULT_BASE_PARAMS, height: 23, infill: pattern.id, hollow: false, cornerRadius });
        assertMesh(solid, `${pattern.id}: solid base with blind recesses`);
        solid.dispose();
    }
}
console.log('PASS solid patterned bases and sharp/rounded corners');

assert.throws(() => parseOBJ('v 0 0 0\n'), /no mesh/);
assert.throws(() => parseSTL(new TextEncoder().encode('solid empty\nendsolid empty').buffer), /no triangles/);
const bad = new THREE.BufferGeometry();
bad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, NaN, 0, 0, 0, 1, 0], 3));
assert.throws(() => sanitizeGeometry(bad), /invalid coordinates/);
bad.getAttribute('position').array.fill(0);
assert.throws(() => sanitizeGeometry(bad), /no usable triangles/);
bad.dispose();
await assert.rejects(importModelFile({ name: 'scan.exe' }), /valid STL or OBJ/);
const obj = parseOBJ('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n');
assert.equal(obj.index.count, 3); obj.dispose();
console.log('PASS valid OBJ import; empty, invalid, and degenerate file rejection');

let downloads = 0;
globalThis.window = { setTimeout: fn => { fn(); return 1; } };
globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() { downloads++; }, remove() {} }) };
const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 6));
const exported = await exportSTL(mesh, { oneClick: true, suggestedName: 'test.stl' });
assert.equal(exported.method, 'download'); assert.equal(downloads, 1);
globalThis.window.__TAURI__ = { dialog: { save: async () => null }, fs: {} };
assert.equal((await exportSTL(mesh, { oneClick: true })).method, 'cancelled');
assert.equal(downloads, 1, 'cancellation must not download');
mesh.geometry.dispose();
console.log('PASS actual download and cancellation behavior');
console.log('All baser regressions passed.');
