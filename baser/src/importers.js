import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { sanitizeGeometry } from './geometry.js';

const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

export const SUPPORTED_EXTENSIONS = Object.freeze(['stl', 'obj']);

export function getFileExtension(filename) {
    return filename.split('.').pop()?.toLowerCase() ?? '';
}

export function isSupportedModelFile(file) {
    return Boolean(file?.name) && SUPPORTED_EXTENSIONS.includes(getFileExtension(file.name));
}

function readWithFileReader(file, method) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
        reader[method](file);
    });
}

async function readArrayBuffer(file) {
    return typeof file.arrayBuffer === 'function'
        ? file.arrayBuffer()
        : readWithFileReader(file, 'readAsArrayBuffer');
}

async function readText(file) {
    return typeof file.text === 'function'
        ? file.text()
        : readWithFileReader(file, 'readAsText');
}

export function parseSTL(arrayBuffer) {
    if (arrayBuffer.byteLength < 84) {
        throw new Error('The STL file contains no triangles or is incomplete.');
    }
    const header = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, 80));
    const faceCount = new DataView(arrayBuffer).getUint32(80, true);
    if (!/^\s*solid\b/i.test(header) && 84 + faceCount * 50 > arrayBuffer.byteLength) {
        throw new Error('The STL file is incomplete. Re-export it from your scan software.');
    }
    let source;
    try {
        source = stlLoader.parse(arrayBuffer);
    } catch (error) {
        throw new Error('The STL file is invalid or incomplete. Re-export it from your scan software.', { cause: error });
    }
    try {
        return sanitizeGeometry(source);
    } finally {
        source.dispose();
    }
}

export function parseOBJ(text) {
    const root = objLoader.parse(text);
    root.updateMatrixWorld(true);
    const geometries = [];

    try {
        root.traverse(child => {
            if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
            let geometry = child.geometry.clone();
            geometry.applyMatrix4(child.matrixWorld);
            for (const attribute of Object.keys(geometry.attributes)) {
                if (attribute !== 'position' && attribute !== 'normal') {
                    geometry.deleteAttribute(attribute);
                }
            }
            if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
            if (geometry.index) {
                const nonIndexed = geometry.toNonIndexed();
                geometry.dispose();
                geometry = nonIndexed;
            }
            geometries.push(geometry);
        });

        if (!geometries.length) throw new Error('OBJ contains no mesh geometry.');
        const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
        if (!merged) throw new Error('OBJ mesh parts could not be merged.');
        try {
            return sanitizeGeometry(merged);
        } finally {
            merged.dispose();
        }
    } finally {
        geometries.forEach(geometry => geometry.dispose());
        root.traverse(child => child.geometry?.dispose());
    }
}

// ============ Automatic orientation ============
// Dental arch scans arrive in arbitrary orientations. The printed side is
// a flat cut, the largest patch of coplanar surface on the mesh. Find it
// by area-weighted normal clustering, turn it to face down, then yaw the
// arch so its curve faces +Z. When no clear flat patch exists, fall back
// to the legacy convention (scan Z-up, rotate -90 degrees about X).

const FALLBACK_ROTATION_X = -Math.PI / 2;
const MIN_PLANE_AREA_FRACTION = 0.05;
const NORMAL_BIN_SCALE = 5; // ~11 degree bins

function quantizeKey(n) {
    return `${Math.round(n.x * NORMAL_BIN_SCALE)},`
        + `${Math.round(n.y * NORMAL_BIN_SCALE)},`
        + `${Math.round(n.z * NORMAL_BIN_SCALE)}`;
}

function findDominantPlane(geometry) {
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const bins = new Map();
    let totalArea = 0;

    const vertexAt = (target, triangle, corner) => {
        const i = index
            ? index.getX(triangle * 3 + corner)
            : triangle * 3 + corner;
        target.fromBufferAttribute(position, i);
    };

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        vertexAt(a, triangle, 0);
        vertexAt(b, triangle, 1);
        vertexAt(c, triangle, 2);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac);
        const area = normal.length() / 2;
        if (area < 1e-10) continue;
        totalArea += area;
        normal.normalize();

        const key = quantizeKey(normal);
        let bin = bins.get(key);
        if (!bin) {
            bin = { area: 0, direction: new THREE.Vector3(), point: new THREE.Vector3() };
            bins.set(key, bin);
        }
        bin.area += area;
        bin.direction.addScaledVector(normal, area);
        bin.point.addScaledVector(a, area);
    }

    if (!totalArea) return null;
    let best = null;
    for (const bin of bins.values()) {
        if (!best || bin.area > best.area) best = bin;
    }
    if (!best || best.area / totalArea < MIN_PLANE_AREA_FRACTION) return null;

    return {
        direction: best.direction.clone().normalize(),
        point: best.point.clone().divideScalar(best.area),
        areaFraction: best.area / totalArea
    };
}

function computeCentroid(geometry) {
    const position = geometry.getAttribute('position');
    const centroid = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
        centroid.add(vertex.fromBufferAttribute(position, i));
    }
    return centroid.divideScalar(position.count);
}

/**
 * Bake an upright orientation into the geometry: flat cut down, teeth up,
 * arch curve facing +Z. Returns 'detected' or 'fallback'.
 */
export function autoOrientGeometry(geometry) {
    const plane = findDominantPlane(geometry);

    if (!plane) {
        geometry.rotateX(FALLBACK_ROTATION_X);
        geometry.computeBoundingBox();
        return 'fallback';
    }

    // The cut's outward normal must point away from the mesh bulk.
    const centroid = computeCentroid(geometry);
    const toCentroid = centroid.clone().sub(plane.point);
    const down = plane.direction.clone();
    if (toCentroid.dot(down) > 0) down.negate();

    const quaternion = new THREE.Quaternion().setFromUnitVectors(
        down,
        new THREE.Vector3(0, -1, 0)
    );
    geometry.applyQuaternion(quaternion);
    geometry.computeBoundingBox();

    // Sanity: an arch model is wider than it is tall. A taller-than-wide
    // result means the detected plane was not the bottom cut.
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    if (size.y > Math.max(size.x, size.z) * 1.15) {
        geometry.applyQuaternion(quaternion.clone().invert());
        geometry.rotateX(FALLBACK_ROTATION_X);
        geometry.computeBoundingBox();
        return 'fallback';
    }

    // Yaw: the horseshoe's vertex mass sits toward the curve (anterior),
    // so point that direction at +Z.
    const leveledCentroid = computeCentroid(geometry);
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const anterior = new THREE.Vector2(
        leveledCentroid.x - center.x,
        leveledCentroid.z - center.z
    );
    if (anterior.length() > 1.5) {
        // rotateY(theta) advances a vector's XZ angle by theta, so undo the
        // anterior direction's angle to land it on +Z.
        geometry.rotateY(-Math.atan2(anterior.x, anterior.y));
        geometry.computeBoundingBox();
    }

    return 'detected';
}

export async function importModelFile(file) {
    if (!isSupportedModelFile(file)) {
        throw new Error('Choose a valid STL or OBJ file.');
    }

    const extension = getFileExtension(file.name);
    const geometry = extension === 'stl'
        ? parseSTL(await readArrayBuffer(file))
        : parseOBJ(await readText(file));

    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const orientation = autoOrientGeometry(geometry);
    geometry.center();
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return { geometry, extension, filename: file.name, orientation };
}
