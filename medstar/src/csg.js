import * as THREE from 'three';
import { ADDITION, Brush, Evaluator } from 'three-bvh-csg';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { removeDegenerateTriangles } from './geometry.js';

export const CSG_WELD_TOLERANCE = 1e-4;

const evaluator = new Evaluator();
evaluator.useGroups = false;

function assertGeometry(geometry, name) {
    if (!geometry?.isBufferGeometry) {
        throw new TypeError(`${name} must be a THREE.BufferGeometry.`);
    }

    const position = geometry.getAttribute('position');
    if (!position || position.itemSize !== 3 || position.count < 3) {
        throw new Error(`${name} has no usable position attribute.`);
    }
}

function stripToPositions(geometry) {
    for (const attributeName of Object.keys(geometry.attributes)) {
        if (attributeName !== 'position') {
            geometry.deleteAttribute(attributeName);
        }
    }

    geometry.morphAttributes = {};
    geometry.clearGroups();
    return geometry;
}

function addRequiredAttributes(geometry) {
    geometry.computeVertexNormals();

    const positionCount = geometry.getAttribute('position').count;
    geometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(new Float32Array(positionCount * 2), 2)
    );

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function weldPositions(geometry, matrix, tolerance) {
    const working = stripToPositions(geometry.clone());

    if (matrix) {
        if (!matrix.isMatrix4) {
            working.dispose();
            throw new TypeError('A CSG transform must be a THREE.Matrix4.');
        }
        working.applyMatrix4(matrix);
    }

    const welded = BufferGeometryUtils.mergeVertices(working, tolerance);
    working.dispose();
    removeDegenerateTriangles(welded);
    return welded;
}

function edgeKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function getEdgeIncidence(geometry) {
    const index = geometry.index;
    if (!index) {
        throw new Error('Topology checks require indexed geometry.');
    }

    const edges = new Map();
    const triangleCount = Math.floor(index.count / 3);

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const offset = triangle * 3;
        const indices = [
            index.getX(offset),
            index.getX(offset + 1),
            index.getX(offset + 2)
        ];

        for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
            const from = indices[edgeIndex];
            const to = indices[(edgeIndex + 1) % 3];
            const key = edgeKey(from, to);
            let edge = edges.get(key);

            if (!edge) {
                edge = {
                    a: Math.min(from, to),
                    b: Math.max(from, to),
                    from,
                    to,
                    count: 0,
                    directionBalance: 0
                };
                edges.set(key, edge);
            }

            edge.count += 1;
            edge.directionBalance += from < to ? 1 : -1;
        }
    }

    return edges;
}

function removeDuplicateTriangles(geometry) {
    const index = geometry.index;
    if (!index) return geometry;

    const seen = new Set();
    const filtered = [];

    for (let offset = 0; offset + 2 < index.count; offset += 3) {
        const a = index.getX(offset);
        const b = index.getX(offset + 1);
        const c = index.getX(offset + 2);
        const key = [a, b, c].sort((left, right) => left - right).join(':');

        if (seen.has(key)) continue;
        seen.add(key);
        filtered.push(a, b, c);
    }

    geometry.setIndex(filtered);
    return geometry;
}

function buildPointTree(indices, position, depth = 0) {
    if (indices.length === 0) return null;

    const axis = depth % 3;
    indices.sort((left, right) => (
        position.getComponent(left, axis) - position.getComponent(right, axis)
    ));

    const middle = Math.floor(indices.length / 2);
    return {
        index: indices[middle],
        axis,
        left: buildPointTree(indices.slice(0, middle), position, depth + 1),
        right: buildPointTree(indices.slice(middle + 1), position, depth + 1)
    };
}

function queryPointTree(node, position, minimum, maximum, output) {
    if (!node) return;

    const index = node.index;
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);

    if (
        x >= minimum.x && x <= maximum.x
        && y >= minimum.y && y <= maximum.y
        && z >= minimum.z && z <= maximum.z
    ) {
        output.push(index);
    }

    const coordinate = node.axis === 0 ? x : node.axis === 1 ? y : z;
    const minCoordinate = minimum.getComponent(node.axis);
    const maxCoordinate = maximum.getComponent(node.axis);

    if (minCoordinate <= coordinate) {
        queryPointTree(node.left, position, minimum, maximum, output);
    }
    if (maxCoordinate >= coordinate) {
        queryPointTree(node.right, position, minimum, maximum, output);
    }
}

function getPointOnSegmentParameter(
    pointIndex,
    startIndex,
    endIndex,
    position,
    toleranceSquared
) {
    const startX = position.getX(startIndex);
    const startY = position.getY(startIndex);
    const startZ = position.getZ(startIndex);
    const deltaX = position.getX(endIndex) - startX;
    const deltaY = position.getY(endIndex) - startY;
    const deltaZ = position.getZ(endIndex) - startZ;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;

    if (lengthSquared === 0) return null;

    const pointDeltaX = position.getX(pointIndex) - startX;
    const pointDeltaY = position.getY(pointIndex) - startY;
    const pointDeltaZ = position.getZ(pointIndex) - startZ;
    const parameter = (
        pointDeltaX * deltaX
        + pointDeltaY * deltaY
        + pointDeltaZ * deltaZ
    ) / lengthSquared;

    if (parameter <= 1e-7 || parameter >= 1 - 1e-7) return null;

    const nearestX = startX + deltaX * parameter;
    const nearestY = startY + deltaY * parameter;
    const nearestZ = startZ + deltaZ * parameter;
    const errorX = position.getX(pointIndex) - nearestX;
    const errorY = position.getY(pointIndex) - nearestY;
    const errorZ = position.getZ(pointIndex) - nearestZ;
    const errorSquared = errorX * errorX + errorY * errorY + errorZ * errorZ;

    return errorSquared <= toleranceSquared ? parameter : null;
}

function splitTriangleAtTJunctions(
    a,
    b,
    c,
    candidates,
    position,
    toleranceSquared,
    output
) {
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const point = candidates[candidateIndex];
        if (point === a || point === b || point === c) continue;

        const remaining = candidates.filter((_, index) => index !== candidateIndex);

        if (getPointOnSegmentParameter(point, a, b, position, toleranceSquared) !== null) {
            splitTriangleAtTJunctions(
                a, point, c, remaining, position, toleranceSquared, output
            );
            splitTriangleAtTJunctions(
                point, b, c, remaining, position, toleranceSquared, output
            );
            return;
        }

        if (getPointOnSegmentParameter(point, b, c, position, toleranceSquared) !== null) {
            splitTriangleAtTJunctions(
                b, point, a, remaining, position, toleranceSquared, output
            );
            splitTriangleAtTJunctions(
                point, c, a, remaining, position, toleranceSquared, output
            );
            return;
        }

        if (getPointOnSegmentParameter(point, c, a, position, toleranceSquared) !== null) {
            splitTriangleAtTJunctions(
                c, point, b, remaining, position, toleranceSquared, output
            );
            splitTriangleAtTJunctions(
                point, a, b, remaining, position, toleranceSquared, output
            );
            return;
        }
    }

    output.push(a, b, c);
}

/**
 * three-bvh-csg 0.0.16 can leave a long triangle edge opposite several
 * shorter, collinear edges. The surface is geometrically closed, but the
 * resulting T-junctions are not a topological 2-manifold. Split the long
 * boundary edges at existing boundary vertices without moving any vertex.
 */
function repairTJunctions(
    geometry,
    tolerance,
    maximumPasses = 3,
    planeY = null
) {
    const position = geometry.getAttribute('position');
    const toleranceSquared = tolerance * tolerance;

    for (let pass = 0; pass < maximumPasses; pass += 1) {
        const incidence = getEdgeIncidence(geometry);
        const boundaryEdges = [...incidence.values()].filter((edge) => {
            if (edge.count !== 1) return false;
            if (!Number.isFinite(planeY)) return true;
            return Math.abs(position.getY(edge.a) - planeY) <= tolerance
                && Math.abs(position.getY(edge.b) - planeY) <= tolerance;
        });
        if (boundaryEdges.length === 0) break;

        const boundaryVertices = [...new Set(
            boundaryEdges.flatMap((edge) => [edge.a, edge.b])
        )];
        const pointTree = buildPointTree([...boundaryVertices], position);
        const splitPointsByEdge = new Map();
        const minimum = new THREE.Vector3();
        const maximum = new THREE.Vector3();

        for (const edge of boundaryEdges) {
            minimum.set(
                Math.min(position.getX(edge.a), position.getX(edge.b)) - tolerance,
                Math.min(position.getY(edge.a), position.getY(edge.b)) - tolerance,
                Math.min(position.getZ(edge.a), position.getZ(edge.b)) - tolerance
            );
            maximum.set(
                Math.max(position.getX(edge.a), position.getX(edge.b)) + tolerance,
                Math.max(position.getY(edge.a), position.getY(edge.b)) + tolerance,
                Math.max(position.getZ(edge.a), position.getZ(edge.b)) + tolerance
            );

            const candidates = [];
            queryPointTree(pointTree, position, minimum, maximum, candidates);

            const points = candidates
                .filter((point) => point !== edge.a && point !== edge.b)
                .map((point) => ({
                    point,
                    parameter: getPointOnSegmentParameter(
                        point,
                        edge.a,
                        edge.b,
                        position,
                        toleranceSquared
                    )
                }))
                .filter(({ parameter }) => parameter !== null)
                .sort((left, right) => left.parameter - right.parameter)
                .map(({ point }) => point);

            if (points.length > 0) {
                splitPointsByEdge.set(edgeKey(edge.a, edge.b), points);
            }
        }

        if (splitPointsByEdge.size === 0) break;

        const sourceIndex = geometry.index;
        const repairedIndex = [];
        for (let offset = 0; offset + 2 < sourceIndex.count; offset += 3) {
            const a = sourceIndex.getX(offset);
            const b = sourceIndex.getX(offset + 1);
            const c = sourceIndex.getX(offset + 2);
            const candidates = new Set([
                ...(splitPointsByEdge.get(edgeKey(a, b)) ?? []),
                ...(splitPointsByEdge.get(edgeKey(b, c)) ?? []),
                ...(splitPointsByEdge.get(edgeKey(c, a)) ?? [])
            ]);

            splitTriangleAtTJunctions(
                a,
                b,
                c,
                [...candidates],
                position,
                toleranceSquared,
                repairedIndex
            );
        }

        geometry.setIndex(repairedIndex);
        removeDegenerateTriangles(geometry);
        removeDuplicateTriangles(geometry);
    }

    return geometry;
}

function getLoopArea(loop, position) {
    let area = 0;
    for (let index = 0; index < loop.length; index += 1) {
        const current = loop[index];
        const next = loop[(index + 1) % loop.length];
        area += position.getX(current) * position.getZ(next)
            - position.getX(next) * position.getZ(current);
    }
    return area / 2;
}

function pointIsInsideLoop(x, z, loop, position) {
    let inside = false;

    for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
        const currentX = position.getX(loop[index]);
        const currentZ = position.getZ(loop[index]);
        const previousX = position.getX(loop[previous]);
        const previousZ = position.getZ(loop[previous]);
        const crosses = (currentZ > z) !== (previousZ > z)
            && x < (previousX - currentX) * (z - currentZ)
                / (previousZ - currentZ) + currentX;
        if (crosses) inside = !inside;
    }

    return inside;
}

function rebuildHorizontalPlanarSeam(geometry, planeY, tolerance) {
    const position = geometry.getAttribute('position');
    const sourceIndex = geometry.index;
    const originalIndices = Array.from(sourceIndex.array);
    const topologyBefore = getEdgeTopologyStats(geometry);
    const nonPlanarIndices = [];
    let removedTriangles = 0;

    for (let offset = 0; offset + 2 < sourceIndex.count; offset += 3) {
        const a = sourceIndex.getX(offset);
        const b = sourceIndex.getX(offset + 1);
        const c = sourceIndex.getX(offset + 2);
        const isOnPlane = Math.abs(position.getY(a) - planeY) <= tolerance
            && Math.abs(position.getY(b) - planeY) <= tolerance
            && Math.abs(position.getY(c) - planeY) <= tolerance;

        if (isOnPlane) {
            removedTriangles += 1;
        } else {
            nonPlanarIndices.push(a, b, c);
        }
    }

    if (removedTriangles === 0) return null;
    geometry.setIndex(nonPlanarIndices);

    const incidence = getEdgeIncidence(geometry);
    const boundaryEdges = [...incidence.values()].filter((edge) => (
        edge.count === 1
        && Math.abs(position.getY(edge.from) - planeY) <= tolerance
        && Math.abs(position.getY(edge.to) - planeY) <= tolerance
    ));
    const outgoing = new Map();
    const incomingCounts = new Map();

    for (const edge of boundaryEdges) {
        if (outgoing.has(edge.from)) {
            geometry.setIndex(originalIndices);
            return null;
        }

        outgoing.set(edge.from, edge.to);
        incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
    }

    if (
        boundaryEdges.length < 3
        || [...incomingCounts.values()].some((count) => count !== 1)
        || outgoing.size !== incomingCounts.size
    ) {
        geometry.setIndex(originalIndices);
        return null;
    }

    const visited = new Set();
    const loops = [];

    for (const start of outgoing.keys()) {
        if (visited.has(start)) continue;

        const loop = [];
        let current = start;
        while (!visited.has(current)) {
            visited.add(current);
            loop.push(current);
            current = outgoing.get(current);
            if (current === undefined) break;
        }

        if (current !== start || loop.length < 3) {
            geometry.setIndex(originalIndices);
            return null;
        }
        loops.push(loop);
    }

    const loopData = loops.map((loop) => ({
        loop,
        area: getLoopArea(loop, position),
        parent: -1,
        depth: 0,
        children: []
    }));

    for (let childIndex = 0; childIndex < loopData.length; childIndex += 1) {
        const child = loopData[childIndex];
        const pointIndex = child.loop[0];
        const pointX = position.getX(pointIndex);
        const pointZ = position.getZ(pointIndex);
        let parentArea = Infinity;

        for (let candidateIndex = 0; candidateIndex < loopData.length; candidateIndex += 1) {
            if (candidateIndex === childIndex) continue;
            const candidate = loopData[candidateIndex];
            const absoluteArea = Math.abs(candidate.area);
            if (
                absoluteArea <= Math.abs(child.area)
                || absoluteArea >= parentArea
                || !pointIsInsideLoop(pointX, pointZ, candidate.loop, position)
            ) {
                continue;
            }

            child.parent = candidateIndex;
            parentArea = absoluteArea;
        }
    }

    const getDepth = (index) => {
        const parent = loopData[index].parent;
        return parent === -1 ? 0 : getDepth(parent) + 1;
    };

    for (let index = 0; index < loopData.length; index += 1) {
        const data = loopData[index];
        data.depth = getDepth(index);
        if (data.parent !== -1) {
            loopData[data.parent].children.push(index);
        }
    }

    const rebuiltIndices = [...nonPlanarIndices];

    for (let index = 0; index < loopData.length; index += 1) {
        const outer = loopData[index];
        if (outer.depth % 2 !== 0) continue;

        const makePoint = (vertexIndex) => {
            const point = new THREE.Vector2(
                position.getX(vertexIndex),
                position.getZ(vertexIndex)
            );
            point.sourceIndex = vertexIndex;
            return point;
        };
        const contour = outer.loop.map(makePoint);
        const holes = outer.children.map((childIndex) => (
            loopData[childIndex].loop.map(makePoint)
        ));
        const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
        const flattened = contour.concat(...holes);
        const desiredNormalY = Math.sign(outer.area) || 1;

        for (const face of faces) {
            let a = flattened[face[0]].sourceIndex;
            let b = flattened[face[1]].sourceIndex;
            let c = flattened[face[2]].sourceIndex;
            const abX = position.getX(b) - position.getX(a);
            const abZ = position.getZ(b) - position.getZ(a);
            const acX = position.getX(c) - position.getX(a);
            const acZ = position.getZ(c) - position.getZ(a);
            const normalY = abZ * acX - abX * acZ;

            if (normalY * desiredNormalY < 0) {
                [b, c] = [c, b];
            }
            rebuiltIndices.push(a, b, c);
        }
    }

    geometry.setIndex(rebuiltIndices);
    removeDegenerateTriangles(geometry);
    removeDuplicateTriangles(geometry);
    repairTJunctions(geometry, tolerance, 3, planeY);

    const topologyAfter = getEdgeTopologyStats(geometry);
    const defectsBefore = topologyBefore.boundaryEdges
        + topologyBefore.nonManifoldEdges
        + topologyBefore.inconsistentWindingEdges;
    const defectsAfter = topologyAfter.boundaryEdges
        + topologyAfter.nonManifoldEdges
        + topologyAfter.inconsistentWindingEdges;

    // Some valid unions expose more than one horizontal cap (for example a
    // model bottom that protrudes beyond the base). Keep a sound partial
    // repair when it reduces defects; cleanupCSGGeometry will rebuild the
    // next plane before considering the generic fallback.
    if (!topologyAfter.isTwoManifold && defectsAfter >= defectsBefore) {
        geometry.setIndex(originalIndices);
        return null;
    }

    return topologyAfter;
}

function getHorizontalProblemPlanes(geometry, tolerance, excludedPlanes) {
    const position = geometry.getAttribute('position');
    const incidence = getEdgeIncidence(geometry);
    const planes = new Map();

    for (const edge of incidence.values()) {
        const hasIncidenceProblem = edge.count !== 2
            || (edge.count === 2 && edge.directionBalance !== 0);
        if (!hasIncidenceProblem) continue;

        const yA = position.getY(edge.a);
        const yB = position.getY(edge.b);
        if (Math.abs(yA - yB) > tolerance) continue;

        const y = (yA + yB) / 2;
        if (excludedPlanes.some((excluded) => Math.abs(excluded - y) <= tolerance)) {
            continue;
        }

        const key = Math.round(y / tolerance);
        const plane = planes.get(key) ?? { y, defects: 0 };
        plane.defects += 1;
        planes.set(key, plane);
    }

    return [...planes.values()].sort((left, right) => right.defects - left.defects);
}

export function getEdgeTopologyStats(geometry) {
    const edges = getEdgeIncidence(geometry);
    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    let inconsistentWindingEdges = 0;

    for (const edge of edges.values()) {
        if (edge.count === 1) boundaryEdges += 1;
        if (edge.count > 2) nonManifoldEdges += 1;
        if (edge.count === 2 && edge.directionBalance !== 0) {
            inconsistentWindingEdges += 1;
        }
    }

    return {
        edges: edges.size,
        boundaryEdges,
        nonManifoldEdges,
        inconsistentWindingEdges,
        isTwoManifold: boundaryEdges === 0
            && nonManifoldEdges === 0
            && inconsistentWindingEdges === 0
    };
}

/**
 * Clone, bake, and normalize a geometry for three-bvh-csg.
 *
 * Only positions are retained before welding. This prevents normals, UVs,
 * colors, or loader-specific attributes from stopping coincident vertices
 * from being merged. Fresh normals and the UV attribute required by
 * three-bvh-csg are added afterward.
 */
export function prepareGeometryForCSG(
    geometry,
    {
        matrix = null,
        name = 'Geometry',
        tolerance = CSG_WELD_TOLERANCE
    } = {}
) {
    assertGeometry(geometry, name);

    const prepared = weldPositions(geometry, matrix, tolerance);
    assertGeometry(prepared, name);
    return addRequiredAttributes(prepared);
}

/**
 * Weld and normalize a CSG result without changing the supplied geometry.
 */
export function cleanupCSGGeometry(
    geometry,
    {
        name = 'CSG result',
        tolerance = CSG_WELD_TOLERANCE,
        planarSeamY = null,
        repairTopology = true
    } = {}
) {
    assertGeometry(geometry, name);

    const cleaned = weldPositions(geometry, null, tolerance);
    removeDuplicateTriangles(cleaned);
    if (repairTopology) {
        const repairedPlanes = [];
        let rebuiltPlanarSeam = false;
        let planarTopology = null;

        if (Number.isFinite(planarSeamY)) {
            repairedPlanes.push(planarSeamY);
            planarTopology = rebuildHorizontalPlanarSeam(
                cleaned,
                planarSeamY,
                tolerance
            );
            rebuiltPlanarSeam = Boolean(planarTopology);
        }

        // Repair additional horizontal caps one at a time. Each candidate is
        // accepted only if its own retriangulation lowers the global defect
        // count, and the loop is bounded to avoid pathological retry cycles.
        for (let pass = 0; pass < 3; pass += 1) {
            if (planarTopology?.isTwoManifold) break;
            const candidates = getHorizontalProblemPlanes(
                cleaned,
                tolerance,
                repairedPlanes
            );
            if (candidates.length === 0) break;

            let repairedCandidate = false;
            for (const candidate of candidates) {
                repairedPlanes.push(candidate.y);
                const candidateTopology = rebuildHorizontalPlanarSeam(
                    cleaned,
                    candidate.y,
                    tolerance
                );
                if (candidateTopology) {
                    rebuiltPlanarSeam = true;
                    planarTopology = candidateTopology;
                    repairedCandidate = true;
                    break;
                }
            }
            if (!repairedCandidate) break;
        }

        if (!rebuiltPlanarSeam || !planarTopology?.isTwoManifold) {
            repairTJunctions(cleaned, tolerance);
        }
    }
    assertGeometry(cleaned, name);
    return addRequiredAttributes(cleaned);
}

/**
 * Union two geometries. Optional matrices are baked into cloned vertices,
 * so both Brushes use identity transforms during evaluation.
 */
export function unionGeometries(
    firstGeometry,
    secondGeometry,
    {
        firstMatrix = null,
        secondMatrix = null,
        firstName = 'First geometry',
        secondName = 'Second geometry',
        tolerance = CSG_WELD_TOLERANCE,
        planarSeamY = null,
        repairTopology = true
    } = {}
) {
    let firstPrepared;
    let secondPrepared;
    let resultGeometry;

    try {
        firstPrepared = prepareGeometryForCSG(firstGeometry, {
            matrix: firstMatrix,
            name: firstName,
            tolerance
        });
        secondPrepared = prepareGeometryForCSG(secondGeometry, {
            matrix: secondMatrix,
            name: secondName,
            tolerance
        });

        const firstBrush = new Brush(firstPrepared);
        const secondBrush = new Brush(secondPrepared);
        firstBrush.updateMatrixWorld(true);
        secondBrush.updateMatrixWorld(true);

        const resultBrush = evaluator.evaluate(firstBrush, secondBrush, ADDITION);
        resultGeometry = resultBrush.geometry;

        return cleanupCSGGeometry(resultGeometry, {
            name: `${firstName} + ${secondName}`,
            tolerance,
            planarSeamY,
            repairTopology
        });
    } finally {
        firstPrepared?.dispose();
        secondPrepared?.dispose();
        resultGeometry?.dispose();
    }
}

/**
 * Bake a Mesh's complete world transform into a standalone geometry.
 */
export function bakeMeshGeometry(
    mesh,
    { name = mesh?.name || 'Mesh', tolerance = CSG_WELD_TOLERANCE } = {}
) {
    if (!mesh?.isMesh || !mesh.geometry) {
        throw new TypeError(`${name} must be a THREE.Mesh with geometry.`);
    }

    mesh.updateWorldMatrix(true, false);
    return prepareGeometryForCSG(mesh.geometry, {
        matrix: mesh.matrixWorld,
        name,
        tolerance
    });
}

/**
 * The app's single processing operation: model + visible base.
 */
export function unionModelAndBase(
    modelMesh,
    baseMesh,
    { tolerance = CSG_WELD_TOLERANCE } = {}
) {
    if (!modelMesh?.isMesh || !modelMesh.geometry) {
        throw new TypeError('Model must be a THREE.Mesh with geometry.');
    }
    if (!baseMesh?.isMesh || !baseMesh.geometry) {
        throw new TypeError('Base must be a THREE.Mesh with geometry.');
    }

    modelMesh.updateWorldMatrix(true, false);
    baseMesh.updateWorldMatrix(true, false);
    const baseBounds = new THREE.Box3().setFromObject(baseMesh);

    return unionGeometries(modelMesh.geometry, baseMesh.geometry, {
        firstMatrix: modelMesh.matrixWorld,
        secondMatrix: baseMesh.matrixWorld,
        firstName: modelMesh.name || 'Dental model',
        secondName: baseMesh.name || 'Procedural base',
        tolerance,
        planarSeamY: baseBounds.max.y
    });
}

/**
 * Lightweight, side-effect-free geometry measurements for tests/status UI.
 */
export function getGeometryStats(geometry) {
    assertGeometry(geometry, 'Geometry');

    if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
    }

    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    const positionCount = geometry.getAttribute('position').count;
    const indexCount = geometry.index?.count ?? 0;

    return {
        vertices: positionCount,
        triangles: (indexCount || positionCount) / 3,
        indexed: Boolean(geometry.index),
        size
    };
}
