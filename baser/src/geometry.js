import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const DEFAULT_WELD_TOLERANCE = 1e-4;
const DEFAULT_AREA_EPSILON_SQUARED = 1e-14;

export function keepPositionOnly(geometry) {
    for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position') geometry.deleteAttribute(name);
    }
    geometry.morphAttributes = {};
    geometry.clearGroups();
    return geometry;
}

export function removeDegenerateTriangles(
    geometry,
    areaEpsilonSquared = DEFAULT_AREA_EPSILON_SQUARED
) {
    const position = geometry.getAttribute('position');
    if (!position) throw new Error('Geometry has no position attribute.');

    const sourceIndex = geometry.index;
    const triangleCount = sourceIndex
        ? Math.floor(sourceIndex.count / 3)
        : Math.floor(position.count / 3);
    const filtered = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const offset = triangle * 3;
        const ai = sourceIndex ? sourceIndex.getX(offset) : offset;
        const bi = sourceIndex ? sourceIndex.getX(offset + 1) : offset + 1;
        const ci = sourceIndex ? sourceIndex.getX(offset + 2) : offset + 2;

        if (ai === bi || bi === ci || ci === ai) continue;

        a.fromBufferAttribute(position, ai);
        b.fromBufferAttribute(position, bi);
        c.fromBufferAttribute(position, ci);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        if (ab.cross(ac).lengthSq() <= areaEpsilonSquared) continue;

        filtered.push(ai, bi, ci);
    }

    geometry.setIndex(filtered);
    return geometry;
}

export function sanitizeGeometry(
    source,
    { weldTolerance = DEFAULT_WELD_TOLERANCE } = {}
) {
    const position = source.getAttribute('position');
    if (!position || position.count < 3) throw new Error('The file contains no triangles.');
    for (let index = 0; index < position.array.length; index += 1) {
        if (!Number.isFinite(position.array[index])) {
            throw new Error('The file contains invalid coordinates. Re-export it from your scan software.');
        }
    }
    const working = keepPositionOnly(source.clone());
    let geometry;
    try {
        geometry = BufferGeometryUtils.mergeVertices(working, weldTolerance);
    } finally {
        working.dispose();
    }
    removeDegenerateTriangles(geometry);
    if (!geometry.index?.count) {
        geometry.dispose();
        throw new Error('The file contains no usable triangles.');
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

export function addEmptyUVs(geometry) {
    if (!geometry.getAttribute('uv')) {
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    return geometry;
}

export function getGeometryStats(geometry) {
    const position = geometry.getAttribute('position');
    const triangles = geometry.index
        ? Math.floor(geometry.index.count / 3)
        : Math.floor((position?.count ?? 0) / 3);
    return {
        vertices: position?.count ?? 0,
        triangles,
        indexed: Boolean(geometry.index)
    };
}
