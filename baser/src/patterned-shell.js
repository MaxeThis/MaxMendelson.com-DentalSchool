import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { removeDegenerateTriangles } from './geometry.js';
import { buildInfillCutterPieces, buildEngravingCutters, measureOutline } from './infill.js';

/** Build the wall around its openings directly, so no decorative cell is
 * silently lost to a boolean. Each outline facet is split at every profile
 * station; neighbouring faces share the exact same boundary vertices.
 */
export function buildPatternedShell(params, outer, inner) {
    const outline = measureOutline(outer);
    const windows = [
        ...buildInfillCutterPieces(params, outer, { windowsOnly: true }),
        ...buildEngravingCutters(outline, params, { windowsOnly: true })
    ];
    const arcs = [0];
    for (let i = 0; i < outer.length; i++) arcs.push(arcs[i] + outer[i].distanceTo(outer[(i + 1) % outer.length]));
    const stops = [...arcs];
    for (const opening of windows) {
        for (const t of opening.stations) stops.push(opening.from + (opening.to - opening.from) * t);
    }
    stops.sort((a, b) => a - b);
    const stations = stops.filter((s, i) => i === 0 || s - stops[i - 1] > 1e-7);
    const positions = [];
    const deck = params.height - params.wall;
    const up = new THREE.Vector3(0, 1, 0);
    const down = new THREE.Vector3(0, -1, 0);
    const pointAt = (s, isInner, y) => {
        let start = 1, end = arcs.length - 1;
        while (start < end) {
            const mid = (start + end) >> 1;
            if (s <= arcs[mid] + 1e-8) end = mid;
            else start = mid + 1;
        }
        const segment = start - 1;
        const ring = isInner ? inner : outer;
        const t = Math.min(1, Math.max(0, (s - arcs[segment]) / (arcs[segment + 1] - arcs[segment])));
        const a = ring[segment], b = ring[(segment + 1) % ring.length];
        return new THREE.Vector3(a.x + (b.x - a.x) * t, y, a.y + (b.y - a.y) * t);
    };
    const triangle = (a, b, c, normal) => {
        const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (cross.dot(normal) < 0) [b, c] = [c, b];
        positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
    };
    const quad = (a, b, c, d, normal) => { triangle(a, b, c, normal); triangle(a, c, d, normal); };
    const recessAt = (s, y, depth) => {
        const normal = outline.at(s).normal;
        return pointAt(s, false, y).add(new THREE.Vector3(-normal.x * depth, 0, -normal.y * depth));
    };
    const openingPoint = (s, opening, y) => opening.depth == null
        ? pointAt(s, true, y) : recessAt(s, y, opening.depth);
    const profileAt = (opening, s) => opening.profile(Math.max(0, Math.min(1, (s - opening.from) / (opening.to - opening.from))));
    const stationCuts = new Map(stations.map(s => [s, windows
        .filter(w => s >= w.from - 1e-7 && s <= w.to + 1e-7)
        .flatMap(w => profileAt(w, s)).sort((a, b) => a - b)]));

    function wallFace(from, to, low0, high0, low1, high1, isInner, recessDepth = null) {
        const left = [low0, ...stationCuts.get(from).filter(y => y > low0 + 1e-7 && y < high0 - 1e-7), high0];
        const right = [low1, ...stationCuts.get(to).filter(y => y > low1 + 1e-7 && y < high1 - 1e-7), high1];
        const contour = [
            ...left.map(y => new THREE.Vector2(from, y)),
            ...right.reverse().map(y => new THREE.Vector2(to, y))
        ].filter((p, i, all) => i === 0 || p.distanceToSquared(all[i - 1]) > 1e-14);
        const normal2 = outline.at((from + to) / 2).normal;
        const normal = new THREE.Vector3(normal2.x, 0, normal2.y).multiplyScalar(isInner && params.hollow && recessDepth === null ? -1 : 1);
        for (const face of THREE.ShapeUtils.triangulateShape(contour, [])) {
            triangle(...face.map(i => recessDepth === null
                ? pointAt(contour[i].x, isInner, contour[i].y)
                : recessAt(contour[i].x, contour[i].y, recessDepth)), normal);
        }
    }

    const outerCenter = outer.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(outer.length);
    const innerCenter = inner.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(inner.length);
    for (let i = 0; i < stations.length - 1; i++) {
        const from = stations[i], to = stations[i + 1], mid = (from + to) / 2;
        const active = windows.filter(w => mid > w.from && mid < w.to)
            .sort((a, b) => profileAt(a, mid)[0] - profileAt(b, mid)[0]);
        let low0 = 0, low1 = 0;
        for (const opening of active) {
            const [bottom0, top0] = profileAt(opening, from);
            const [bottom1, top1] = profileAt(opening, to);
            wallFace(from, to, low0, bottom0, low1, bottom1, false);
            if (opening.depth != null || !params.hollow) {
                wallFace(from, to, bottom0, top0, bottom1, top1, true, opening.depth ?? null);
            }
            quad(pointAt(from, false, bottom0), pointAt(to, false, bottom1), openingPoint(to, opening, bottom1), openingPoint(from, opening, bottom0), up);
            quad(pointAt(from, false, top0), pointAt(to, false, top1), openingPoint(to, opening, top1), openingPoint(from, opening, top0), down);
            low0 = top0; low1 = top1;
        }
        wallFace(from, to, low0, params.height, low1, params.height, false);
        if (params.hollow) {
            // Only through-openings interrupt the cavity wall. Engraving
            // gets its own backing 0.6 mm behind the outer face.
            let innerLow0 = 0, innerLow1 = 0;
            for (const opening of active.filter(w => w.depth == null)) {
                const [bottom0, top0] = profileAt(opening, from);
                const [bottom1, top1] = profileAt(opening, to);
                wallFace(from, to, innerLow0, bottom0, innerLow1, bottom1, true);
                innerLow0 = top0; innerLow1 = top1;
            }
            wallFace(from, to, innerLow0, deck, innerLow1, deck, true);
            quad(pointAt(from, false, 0), pointAt(to, false, 0), pointAt(to, true, 0), pointAt(from, true, 0), down);
            triangle(new THREE.Vector3(innerCenter.x, deck, innerCenter.y), pointAt(from, true, deck), pointAt(to, true, deck), down);
        } else {
            triangle(new THREE.Vector3(outerCenter.x, 0, outerCenter.y), pointAt(from, false, 0), pointAt(to, false, 0), down);
        }
        triangle(new THREE.Vector3(outerCenter.x, params.height, outerCenter.y), pointAt(from, false, params.height), pointAt(to, false, params.height), up);
    }
    for (const opening of windows) {
        for (const [s, direction] of [[opening.from, 1], [opening.to, -1]]) {
            const [low, high] = profileAt(opening, s);
            const n = outline.at(s).normal;
            const tangent = new THREE.Vector3(-n.y, 0, n.x).multiplyScalar(direction);
            quad(pointAt(s, false, low), pointAt(s, false, high), openingPoint(s, opening, high), openingPoint(s, opening, low), tangent);
        }
    }
    const raw = new THREE.BufferGeometry();
    raw.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const geometry = mergeVertices(raw, 1e-4);
    raw.dispose();
    removeDegenerateTriangles(geometry);
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.engravingBuilt = true;
    geometry.userData.detailWarnings = [];
    return geometry;
}
