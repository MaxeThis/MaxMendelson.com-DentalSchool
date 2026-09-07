import * as THREE from 'three';

/** Exact vertex bounds, cached until the mesh or its transform changes.
 * Text-only base edits must not walk a large, unchanged scan repeatedly.
 * Return a copy because callers may intersect or expand their result.
 */
export function createWorldBoundsReader() {
    const cache = new WeakMap();
    const vertex = new THREE.Vector3();
    return function meshWorldBounds(mesh) {
        mesh.updateMatrixWorld(true);
        const geometry = mesh.geometry;
        const position = geometry.getAttribute('position');
        const previous = cache.get(mesh);
        if (previous?.geometry === geometry && previous.position === position
            && previous.version === position.version && previous.count === position.count
            && previous.matrix.equals(mesh.matrixWorld)) {
            return previous.bounds.clone();
        }
        const bounds = new THREE.Box3();
        for (let i = 0; i < position.count; i++) {
            vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
            bounds.expandByPoint(vertex);
        }
        cache.set(mesh, { geometry, position, version: position.version, count: position.count,
            matrix: mesh.matrixWorld.clone(), bounds });
        return bounds.clone();
    };
}
