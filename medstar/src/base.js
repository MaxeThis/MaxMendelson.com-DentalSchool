import * as THREE from 'three';
import { subtractGeometries } from './csg.js';
import { buildInfillCutterGeometry } from './infill.js';

// Flip between 0 and Math.PI if a future scan convention reverses the arch.
export const BASE_ROTATION_Y = Math.PI;

export const BASE_EMBED = 0.5;
export const BASE_AUTOFIT_PADDING = 1.05;
export const BASE_REBUILD_DELAY = 30;
export const BASE_CURVE_SEGMENTS = 96;

export const BASE_LIMITS = Object.freeze({
    width: Object.freeze({ min: 20, max: 120 }),
    depth: Object.freeze({ min: 10, max: 80 }),
    height: Object.freeze({ min: 2, max: 30 }),
    wall: Object.freeze({ min: 1, max: 5 }),
    cornerRadius: Object.freeze({ min: 0, max: 15 }),
    clampBand: Object.freeze({ min: 0, max: 25 }),
    posX: Object.freeze({ min: -30, max: 30 }),
    posZ: Object.freeze({ min: -30, max: 30 })
});

/**
 * Wall infill patterns. Everything below `clampBand` stays solid so the
 * articulator's screw clamp always bites undisturbed material; the
 * pattern only opens the wall above that line.
 */
export const INFILL_PATTERNS = Object.freeze([
    { id: 'solid', label: 'Solid wall' },
    { id: 'bars', label: 'Bars' },
    { id: 'windows', label: 'Windows' },
    { id: 'text', label: 'MedStar OMFS' }
]);

const INFILL_IDS = INFILL_PATTERNS.map(pattern => pattern.id);

/** Open wall a pattern needs above the clamp band, in millimeters. */
export const MIN_PATTERN_BAND = 5;

// Defaults follow articulator practice: trimmed-cast bases run ~13-15 mm
// tall (height is the binding limit in Galetti-style screw-clamp
// articulators, not width), and 3 mm hollow walls are the printing
// consensus (exocad plateless preset, Formlabs hollow-model guidance) for
// a shell rigid enough to take clamp pressure while saving resin.
export const DEFAULT_BASE_PARAMS = Object.freeze({
    width: 80,
    depth: 60,
    height: 15,
    wall: 3,
    hollow: true,
    // Posterior corners are filleted by this radius, in millimeters, so
    // stretching the base never distorts the rounding.
    cornerRadius: 4,
    infill: 'solid',
    // The clamp grips the lower part of the base; keep it solid.
    clampBand: 10,
    posX: 0,
    posZ: 0
});

const MIN_CAVITY_SIZE = 0.1;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clampParam(value, fallback, limits) {
    return clamp(finiteNumber(value, fallback), limits.min, limits.max);
}

/**
 * Clamp UI/user values and keep enough room for a genuinely open cavity.
 */
export function normalizeBaseParams(params = {}) {
    const width = clampParam(
        params.width,
        DEFAULT_BASE_PARAMS.width,
        BASE_LIMITS.width
    );
    const depth = clampParam(
        params.depth,
        DEFAULT_BASE_PARAMS.depth,
        BASE_LIMITS.depth
    );
    const height = clampParam(
        params.height,
        DEFAULT_BASE_PARAMS.height,
        BASE_LIMITS.height
    );

    const requestedWall = clampParam(
        params.wall,
        DEFAULT_BASE_PARAMS.wall,
        BASE_LIMITS.wall
    );
    const maximumUsableWall = Math.max(
        BASE_LIMITS.wall.min,
        Math.min(
            BASE_LIMITS.wall.max,
            height - MIN_CAVITY_SIZE,
            width / 2 - MIN_CAVITY_SIZE,
            (depth - MIN_CAVITY_SIZE) / 2
        )
    );

    const wall = Math.min(requestedWall, maximumUsableWall);

    return {
        width,
        depth,
        height,
        wall,
        hollow: params.hollow ?? DEFAULT_BASE_PARAMS.hollow,
        cornerRadius: clampParam(
            params.cornerRadius,
            DEFAULT_BASE_PARAMS.cornerRadius,
            BASE_LIMITS.cornerRadius
        ),
        infill: INFILL_IDS.includes(params.infill)
            ? params.infill
            : DEFAULT_BASE_PARAMS.infill,
        // The clamp band is a safety value: the wall the articulator screw
        // bites on. It is never trimmed to make room for a pattern. If the
        // base is too short to fit both, the pattern is the thing that
        // gives way (buildInfillCutterGeometry returns nothing).
        clampBand: clampParam(
            params.clampBand,
            DEFAULT_BASE_PARAMS.clampBand,
            BASE_LIMITS.clampBand
        ),
        posX: clampParam(params.posX, DEFAULT_BASE_PARAMS.posX, BASE_LIMITS.posX),
        posZ: clampParam(params.posZ, DEFAULT_BASE_PARAMS.posZ, BASE_LIMITS.posZ)
    };
}

// Points added per posterior fillet. The outline's total point count is a
// pure function of these constants, so the outer and inner rings always
// pair up index for index in the stitched builder.
const FILLET_SEGMENTS = 10;
const OUTLINE_ARC_SEGMENTS = BASE_CURVE_SEGMENTS * 2;

/**
 * The D outline, walking from the left chord corner to the right, around
 * the anterior arc, and back. The two posterior corners are replaced by a
 * true circular fillet of `cornerRadius` millimeters.
 *
 * The fillet ends exactly on the vertical tangent (x = radiusX), and the
 * ellipse's x is scaled so it starts on that same point. So the corner
 * rounds without ever narrowing the footprint: the bounding box stays
 * width by spanZ, and the radius stays a real millimeter value at any
 * width or depth, which is what keeps a stretched base looking right.
 */
function createHalfDiscPoints(
    radiusX,
    spanZ,
    chordZ,
    cornerRadius,
    arcSegments = OUTLINE_ARC_SEGMENTS
) {
    const radius = Math.max(0, Math.min(
        cornerRadius,
        radiusX * 0.45,
        spanZ * 0.45
    ));
    const points = [];

    if (radius <= 1e-6) {
        // A footprint too small to fillet falls back to sharp corners, at
        // the same point count so the rings still stitch index for index.
        const sharpSegments = arcSegments + 2 * FILLET_SEGMENTS;
        points.push(new THREE.Vector2(-radiusX, chordZ));
        for (let segment = 0; segment < sharpSegments; segment += 1) {
            const angle = Math.PI * segment / sharpSegments;
            points.push(new THREE.Vector2(
                radiusX * Math.cos(angle),
                chordZ + spanZ * Math.sin(angle)
            ));
        }
        return points;
    }

    const theta0 = Math.asin(Math.min(1, radius / spanZ));
    const xScale = 1 / Math.cos(theta0);

    // Chord, from the left fillet's end to the right fillet's start.
    points.push(new THREE.Vector2(-(radiusX - radius), chordZ));
    points.push(new THREE.Vector2(radiusX - radius, chordZ));

    // Right fillet: tangent to the chord, then to the vertical at x = radiusX.
    for (let segment = 1; segment <= FILLET_SEGMENTS; segment += 1) {
        const angle = -Math.PI / 2 + (Math.PI / 2) * (segment / FILLET_SEGMENTS);
        points.push(new THREE.Vector2(
            radiusX - radius + radius * Math.cos(angle),
            chordZ + radius + radius * Math.sin(angle)
        ));
    }

    // Anterior arc, starting exactly where the fillet left off.
    for (let segment = 1; segment <= arcSegments; segment += 1) {
        const angle = theta0
            + (Math.PI - 2 * theta0) * (segment / arcSegments);
        points.push(new THREE.Vector2(
            radiusX * xScale * Math.cos(angle),
            chordZ + spanZ * Math.sin(angle)
        ));
    }

    // Left fillet, stopping before the start point so the ring stays open.
    for (let segment = 1; segment < FILLET_SEGMENTS; segment += 1) {
        const angle = Math.PI + (Math.PI / 2) * (segment / FILLET_SEGMENTS);
        points.push(new THREE.Vector2(
            -(radiusX - radius) + radius * Math.cos(angle),
            chordZ + radius + radius * Math.sin(angle)
        ));
    }

    return points;
}

/** Outer footprint outline in shape space (chord at y = 0). */
export function createBaseOutlinePoints(params) {
    return createHalfDiscPoints(
        params.width / 2,
        params.depth,
        0,
        params.cornerRadius
    );
}

function createOuterHalfDisc(width, depth, cornerRadius) {
    return new THREE.Shape().setFromPoints(
        createHalfDiscPoints(width / 2, depth, 0, cornerRadius)
    );
}

// The inner half-disc is inscribed in the outer half-disc's bounding
// rectangle after that rectangle is inset by `wall` on every side. Its
// straight chord is therefore wall millimeters in from the outer chord,
// and its fillet is tighter by the same amount so the wall stays even
// around the corner.
function innerHalfDiscPoints(width, depth, wall, cornerRadius) {
    return createHalfDiscPoints(
        width / 2 - wall,
        depth - wall * 2,
        wall,
        cornerRadius - wall
    );
}

function traceInnerHalfDisc(path, width, depth, wall, cornerRadius) {
    return path.setFromPoints(
        innerHalfDiscPoints(width, depth, wall, cornerRadius)
    );
}

function createHalfDiscWallShape(width, depth, wall, cornerRadius) {
    const shape = createOuterHalfDisc(width, depth, cornerRadius);
    shape.holes.push(
        traceInnerHalfDisc(new THREE.Path(), width, depth, wall, cornerRadius)
    );
    return shape;
}

function extrudeBaseShape(
    shape,
    extrusionHeight,
    footprintDepth,
    curveSegments = BASE_CURVE_SEGMENTS
) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: extrusionHeight,
        steps: 1,
        bevelEnabled: false,
        curveSegments
    });

    // Center the X/Z footprint first, then map the extrusion axis to +Y.
    // With BASE_ROTATION_Y=Math.PI the chord is posterior (-Z) and the arc
    // wraps toward the anterior (+Z), matching the ECAR.1 scan convention.
    geometry.translate(0, -footprintDepth / 2, 0);
    geometry.rotateX(-Math.PI / 2);
    geometry.rotateY(BASE_ROTATION_Y);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return geometry;
}

function buildSolidBaseGeometry(params) {
    return extrudeBaseShape(
        createOuterHalfDisc(params.width, params.depth, params.cornerRadius),
        params.height,
        params.depth
    );
}

/**
 * The shell is stitched directly rather than unioned from a wall and a
 * deck. The pinned three-bvh-csg leaves coplanar T-junctions along that
 * seam, so the union result was never manifold and was always discarded;
 * building the boundary representation outright is exact and far cheaper,
 * which keeps slider drags responsive.
 */
function buildHollowBaseGeometry(params) {
    return buildStitchedHollowGeometry(params);
}

/**
 * The base's outer footprint outline in final X/Z coordinates, which is
 * the curve the wall patterns ride along.
 */
export function createBaseOutline(params) {
    const normalized = normalizeBaseParams(params);
    return createHalfDiscPerimeter(
        normalized.width / 2,
        normalized.depth,
        0,
        normalized.cornerRadius
    );
}

/** The same outline as the extruded path, in final X/Z coordinates. */
function createHalfDiscPerimeter(radiusX, depth, inset, cornerRadius) {
    return createHalfDiscPoints(
        radiusX,
        depth - inset * 2,
        -depth / 2 + inset,
        cornerRadius - inset
    );
}

function buildStitchedHollowGeometry(params) {
    const outer = createHalfDiscPerimeter(
        params.width / 2,
        params.depth,
        0,
        params.cornerRadius
    );
    const inner = createHalfDiscPerimeter(
        params.width / 2 - params.wall,
        params.depth,
        params.wall,
        params.cornerRadius
    );
    const ringSize = outer.length;
    const vertices = [];
    const indices = [];

    const addRing = (points, y) => {
        const start = vertices.length / 3;
        for (const point of points) {
            vertices.push(point.x, y, point.y);
        }
        return Array.from({ length: ringSize }, (_, index) => start + index);
    };

    const outerBottom = addRing(outer, 0);
    const outerTop = addRing(outer, params.height);
    const innerBottom = addRing(inner, 0);
    const innerDeck = addRing(inner, params.height - params.wall);

    for (let index = 0; index < ringSize; index += 1) {
        const next = (index + 1) % ringSize;

        // Exterior wall.
        indices.push(
            outerBottom[index], outerTop[index], outerTop[next],
            outerBottom[index], outerTop[next], outerBottom[next]
        );

        // Cavity wall (opposite winding to the exterior wall).
        indices.push(
            innerBottom[index], innerDeck[next], innerDeck[index],
            innerBottom[index], innerBottom[next], innerDeck[next]
        );

        // Bottom annulus. The inner half-disc remains open for drainage.
        indices.push(
            outerBottom[index], outerBottom[next], innerBottom[next],
            outerBottom[index], innerBottom[next], innerBottom[index]
        );
    }

    // Full top deck and the downward-facing underside over the cavity.
    for (let index = 1; index < ringSize - 1; index += 1) {
        indices.push(
            outerTop[0], outerTop[index + 1], outerTop[index],
            innerDeck[0], innerDeck[index], innerDeck[index + 1]
        );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setIndex(indices);

    // The stitched coordinates above describe the Math.PI convention used
    // for ECAR.1. Preserve BASE_ROTATION_Y as the one-line orientation flip.
    geometry.rotateY(BASE_ROTATION_Y - Math.PI);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

/**
 * Build a horizontally centered base whose local bottom is Y=0 and whose
 * local top is Y=height. Width/depth changes regenerate vertices; no mesh
 * scale is involved, so wall and deck thickness remain constant in mm.
 */
export function buildBaseGeometry(params = DEFAULT_BASE_PARAMS) {
    const normalized = normalizeBaseParams(params);
    let geometry = normalized.hollow
        ? buildHollowBaseGeometry(normalized)
        : buildSolidBaseGeometry(normalized);

    // The wall pattern is cut here so the shape on screen and the shape in
    // the exported file can never drift apart.
    const cutter = buildInfillCutterGeometry(
        normalized,
        createHalfDiscPerimeter(normalized.width / 2, normalized.depth, 0,
            normalized.cornerRadius)
    );
    if (cutter) {
        try {
            const patterned = subtractGeometries(geometry, cutter, {
                firstName: 'Base',
                secondName: 'Wall pattern'
            });
            geometry.dispose();
            geometry = patterned;
        } finally {
            cutter.dispose();
        }
    }

    geometry.name = normalized.hollow ? 'HollowBaseGeometry' : 'SolidBaseGeometry';
    geometry.userData.baseParams = { ...normalized };
    return geometry;
}

/**
 * The hollow base's cavity as a solid cutter, in the same local frame as
 * the base geometry (bottom of the base at Y = 0). It spans from below the
 * base's underside up to the deck's underside, so subtracting it from
 * (model UNION solid base) carves the hollow and trims whatever part of a
 * sunken model would dangle inside it. The overshoot keeps the cutter's
 * bottom face in open space, away from any coplanar seam.
 */
export function buildCavityCutterGeometry(params, { overshoot = 10 } = {}) {
    const normalized = normalizeBaseParams(params);
    const shape = traceInnerHalfDisc(
        new THREE.Shape(),
        normalized.width,
        normalized.depth,
        normalized.wall,
        normalized.cornerRadius
    );

    const cutterHeight = normalized.height - normalized.wall + overshoot;
    const geometry = extrudeBaseShape(shape, cutterHeight, normalized.depth);
    geometry.translate(0, -overshoot, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.name = 'CavityCutterGeometry';
    return geometry;
}

/**
 * Atomically replace and dispose a base Mesh's geometry while preserving its
 * material and Object3D transform (including any TransformControls target).
 */
export function rebuildBaseMesh(baseMesh, params) {
    if (!baseMesh?.isMesh) {
        throw new TypeError('rebuildBaseMesh requires a THREE.Mesh.');
    }

    const nextGeometry = buildBaseGeometry(params);
    const previousGeometry = baseMesh.geometry;

    baseMesh.geometry = nextGeometry;
    baseMesh.userData.baseParams = {
        ...nextGeometry.userData.baseParams
    };
    previousGeometry?.dispose();

    return { ...baseMesh.userData.baseParams };
}

function getBounds(modelOrBounds) {
    if (modelOrBounds?.isBox3) {
        if (modelOrBounds.isEmpty()) {
            throw new Error('Cannot fit a base to an empty bounding box.');
        }
        return modelOrBounds.clone();
    }

    if (!modelOrBounds?.isObject3D) {
        throw new TypeError('Expected a THREE.Object3D or THREE.Box3.');
    }

    modelOrBounds.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(modelOrBounds);
    if (bounds.isEmpty()) {
        throw new Error('Cannot fit a base to a model with empty bounds.');
    }
    return bounds;
}

/**
 * Recalculate footprint parameters from a model's current world bounds.
 * Height, wall, and hollow mode are preserved; offsets reset by default.
 */
export function getAutoBaseParams(
    modelOrBounds,
    currentParams = DEFAULT_BASE_PARAMS,
    { padding = BASE_AUTOFIT_PADDING, resetOffsets = true } = {}
) {
    const bounds = getBounds(modelOrBounds);
    const size = bounds.getSize(new THREE.Vector3());
    const safePadding = Math.max(1, finiteNumber(padding, BASE_AUTOFIT_PADDING));

    return normalizeBaseParams({
        ...currentParams,
        width: size.x * safePadding,
        depth: size.z * safePadding,
        posX: resetOffsets ? 0 : currentParams.posX,
        posZ: resetOffsets ? 0 : currentParams.posZ
    });
}

/**
 * Return the world position that centers a base under the model and places
 * its top at modelBounds.min.y + embed, guaranteeing a slight CSG overlap.
 */
export function getAutoBasePlacement(
    modelOrBounds,
    params = DEFAULT_BASE_PARAMS,
    { embed = BASE_EMBED } = {}
) {
    const bounds = getBounds(modelOrBounds);
    const center = bounds.getCenter(new THREE.Vector3());
    const normalized = normalizeBaseParams(params);
    const safeEmbed = finiteNumber(embed, BASE_EMBED);

    return new THREE.Vector3(
        center.x + normalized.posX,
        bounds.min.y + safeEmbed - normalized.height,
        center.z + normalized.posZ
    );
}

/**
 * Combined API used after import and by the "Fit to Model" action.
 */
export function fitBaseToModel(
    modelOrBounds,
    currentParams = DEFAULT_BASE_PARAMS,
    options = {}
) {
    const bounds = getBounds(modelOrBounds);
    const params = getAutoBaseParams(bounds, currentParams, options);
    const position = getAutoBasePlacement(bounds, params, options);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const embed = finiteNumber(options.embed, BASE_EMBED);

    return {
        params,
        position,
        bounds,
        size,
        center,
        topY: bounds.min.y + embed
    };
}

/**
 * Small debounce with cancel/flush hooks for parameter-driven rebuilds.
 */
export function debounce(callback, delay = BASE_REBUILD_DELAY) {
    if (typeof callback !== 'function') {
        throw new TypeError('debounce requires a function.');
    }

    const wait = Math.max(0, finiteNumber(delay, BASE_REBUILD_DELAY));
    let timeoutId = null;
    let pendingArgs;
    let pendingThis;

    const invoke = () => {
        timeoutId = null;
        const args = pendingArgs;
        const thisArg = pendingThis;
        pendingArgs = undefined;
        pendingThis = undefined;
        return callback.apply(thisArg, args);
    };

    function debounced(...args) {
        pendingArgs = args;
        pendingThis = this;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(invoke, wait);
    }

    debounced.cancel = () => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        timeoutId = null;
        pendingArgs = undefined;
        pendingThis = undefined;
    };

    debounced.flush = () => {
        if (timeoutId === null) return undefined;
        clearTimeout(timeoutId);
        return invoke();
    };

    debounced.pending = () => timeoutId !== null;
    return debounced;
}
