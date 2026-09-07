import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { removeDegenerateTriangles } from './geometry.js';
import { buildInfillCutterPieces, buildEngravingCutters, buildWallLabelCutters, getBarSpec, measureOutline } from './infill.js';

/** Build the wall around its openings directly, so no decorative cell is
 * silently lost to a boolean. Each outline facet is split at every profile
 * station; neighbouring faces share the exact same boundary vertices.
 */
export function buildPatternedShell(params, outer, inner) {
    const outline = measureOutline(outer);
    const patternWindows = buildInfillCutterPieces(params, outer, { windowsOnly: true });
    const engravingWindows = buildEngravingCutters(outline, params, { windowsOnly: true });
    const clinicWindows = buildWallLabelCutters(outline, params, { windowsOnly: true });
    const windows = [...patternWindows, ...engravingWindows, ...clinicWindows];
    if (params.infill === 'bars') patternWindows.forEach(window => { window.roundPost = true; });
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
            if (!opening.roundPost) {
                quad(pointAt(from, false, bottom0), pointAt(to, false, bottom1), openingPoint(to, opening, bottom1), openingPoint(from, opening, bottom0), up);
                quad(pointAt(from, false, top0), pointAt(to, false, top1), openingPoint(to, opening, top1), openingPoint(from, opening, top0), down);
            }
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
    const bars = [];
    for (const opening of patternWindows.filter(window => window.roundPost)) {
        const [low, high] = profileAt(opening, (opening.from + opening.to) / 2);
        const edgeStations = stations.filter(s => s >= opening.from - 1e-7 && s <= opening.to + 1e-7);
        const contour = [
            ...edgeStations.map(s => pointAt(s, false, 0)),
            ...edgeStations.slice().reverse().map(s => pointAt(s, true, 0))
        ].map(p => new THREE.Vector2(p.x, p.z));
        const midpoint = (opening.from + opening.to) / 2;
        const center3 = pointAt(midpoint, false, 0).add(pointAt(midpoint, true, 0)).multiplyScalar(0.5);
        const center = new THREE.Vector2(center3.x, center3.z);
        let clearance = Infinity;
        for (let i = 0; i < contour.length; i++) {
            const a = contour[i], b = contour[(i + 1) % contour.length];
            const edge = b.clone().sub(a);
            const t = Math.max(0, Math.min(1, center.clone().sub(a).dot(edge) / edge.lengthSq()));
            clearance = Math.min(clearance, center.distanceTo(a.clone().addScaledVector(edge, t)));
        }
        const radius = Math.min(getBarSpec(params).diameter / 2, clearance - 0.15);
        if (!(radius > 0.1)) throw new Error('The selected wall is too narrow to form round posts. Increase the base size.');
        // The post shares the exact circular holes in its sill and roof.
        // Restore collinear outline stations omitted by Earcut so every
        // adjacent shell facet still meets the ledge edge vertex for vertex.
        const segments = 24;
        const circle = Array.from({ length: segments }, (_, index) => {
            const theta = index * Math.PI * 2 / segments;
            return new THREE.Vector2(center.x + radius * Math.cos(theta), center.y + radius * Math.sin(theta));
        });
        const vertices = [...contour, ...circle];
        const atY = (point, y) => new THREE.Vector3(point.x, y, point.y);
        const ledgeTriangle = (a, b, c) => {
            triangle(atY(a, low), atY(b, low), atY(c, low), up);
            triangle(atY(a, high), atY(b, high), atY(c, high), down);
        };
        const faces = THREE.ShapeUtils.triangulateShape(contour, [circle]).filter(face => {
            const [a, b, c] = face.map(index => vertices[index]);
            return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 1e-10;
        });
        const edgeCounts = new Map();
        const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
        for (const face of faces) for (let i = 0; i < 3; i++) {
            const key = edgeKey(face[i], face[(i + 1) % 3]);
            edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }
        for (const face of faces) {
            const corners = face.map(index => vertices[index]);
            const perimeter = [];
            for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
                const a = corners[edgeIndex], b = corners[(edgeIndex + 1) % 3];
                const edge = b.clone().sub(a);
                const lengthSquared = edge.lengthSq();
                perimeter.push(a);
                if (edgeCounts.get(edgeKey(face[edgeIndex], face[(edgeIndex + 1) % 3])) !== 1) continue;
                const intermediate = vertices.map(point => ({ point, t: point.clone().sub(a).dot(edge) / lengthSquared }))
                    .filter(({ point, t }) => t > 1e-7 && t < 1 - 1e-7
                        && Math.abs(edge.x * (point.y - a.y) - edge.y * (point.x - a.x)) / Math.sqrt(lengthSquared) < 1e-9)
                    .sort((a, b) => a.t - b.t);
                for (const item of intermediate) {
                    if (item.point.distanceToSquared(perimeter[perimeter.length - 1]) > 1e-14) perimeter.push(item.point);
                }
            }
            if (perimeter.length === 3) ledgeTriangle(...corners);
            else {
                const centroid = corners.reduce((sum, point) => sum.add(point), new THREE.Vector2()).divideScalar(3);
                for (let index = 0; index < perimeter.length; index++) {
                    ledgeTriangle(centroid, perimeter[index], perimeter[(index + 1) % perimeter.length]);
                }
            }
        }
        for (let index = 0; index < circle.length; index++) {
            const a = circle[index], b = circle[(index + 1) % circle.length];
            const normal = new THREE.Vector3((a.x + b.x) / 2 - center.x, 0, (a.y + b.y) / 2 - center.y);
            quad(atY(a, low), atY(b, low), atY(b, high), atY(a, high), normal);
        }
        bars.push({ center: [center.x, center.y], radius, low, high, segments });
    }
    const raw = new THREE.BufferGeometry();
    raw.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const geometry = mergeVertices(raw, 1e-4);
    raw.dispose();
    removeDegenerateTriangles(geometry);
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.engravingBuilt = true;
    geometry.userData.detailWarnings = [];
    geometry.userData.wallOpeningCount = patternWindows.length;
    geometry.userData.engravingStrokeCount = engravingWindows.length;
    geometry.userData.clinicStrokeCount = clinicWindows.length;
    geometry.userData.roundPosts = bars;
    return geometry;
}
