import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { ViewCube } from './ViewCube.js';
import { createScene } from './scene.js';
import { createCameraManager } from './cameras.js';
import { createTransformManager } from './transforms.js';
import { createInteractionManager } from './interactions.js';
import { TWEEN, Tween, Easing } from './tween.js';
import { createUndoManager } from './undo.js';
import { importModelFile } from './importers.js';
import { exportSTL, createBinarySTL, binaryResultToBytes } from './exporter.js';
import {
    BASE_AUTOFIT_PADDING,
    BASE_EMBED,
    BASE_LIMITS,
    MIN_PATTERN_BAND,
    cleanEngravedText,
    createBaseOutline,
    buildBaseGeometry,
    buildCavityCutterGeometry,
    rebuildBaseMesh,
    normalizeBaseParams,
    debounce
} from './base.js';
import {
    bakeMeshGeometry,
    prepareGeometryForCSG,
    unionGeometries,
    subtractGeometries,
    getGeometryStats,
    getEdgeTopologyStats
} from './csg.js';
import {
    TEXT_MIN_BAND,
    hasEngraving,
    measureOutline,
    getInfillBand,
    buildEngravingCutters,
    maxLineCharacters
} from './infill.js';
import { createUI } from './ui.js';
import { createCharacter } from './character.js';
import { loadSettings, saveSettings, resetSettings } from './settings.js';
import { error as debugError, log } from './debug.js';

// Orientation is baked into the geometry at import (see autoOrientGeometry),
// so the mesh starts at identity and the rotation controls read absolute.
export const MODEL_ROTATION_OFFSET = Object.freeze({ x: 0, y: 0, z: 0 });

// ============ State ============

const state = {
    model: null,
    base: null,
    preparedModel: null,       // CSG-welded copy, built once at import
    baseParams: null,          // normalized params + posX/posZ offsets
    baseAnchor: { centerX: 0, centerZ: 0, topY: 0 },
    sizeOverride: false,       // user set an explicit size this session
    previewPlain: false,       // mid-drag: skip the costly wall detail
    // The base can never be smaller than the scan standing on it.
    minFootprint: { width: 0, depth: 0 },
    sink: BASE_EMBED,          // how deep the model sits into the base (mm)
    meshHasSeams: false,       // deep-sink merges can leave slicer-repairable seams
    processed: false,
    exported: false,
    busy: false,
    filename: '',
    settings: loadSettings()
};

let importSequence = 0;

// ============ Scene / camera / controls ============

const canvas = document.getElementById('canvas');
const sceneContext = createScene(canvas);
const cameraManager = createCameraManager({
    canvas,
    renderer: sceneContext.renderer,
    scene: sceneContext.scene
});

const transformManager = createTransformManager({
    camera: cameraManager.activeCamera,
    canvas,
    scene: sceneContext.scene,
    orbitControls: cameraManager.controls,
    onDragStart: () => {
        interactions.setGizmoDragging(true);
    },
    onDragEnd: () => {
        interactions.setGizmoDragging(false);
        // A base drag changes its offset from the model; a model drag keeps
        // the base where it stands so the relative move is preserved.
        if (interactions.selected === state.base && state.base) {
            state.baseParams.posX = clampOffset(
                state.base.position.x - state.baseAnchor.centerX, BASE_LIMITS.posX
            );
            state.baseParams.posZ = clampOffset(
                state.base.position.z - state.baseAnchor.centerZ, BASE_LIMITS.posZ
            );
        }
        settleLayout({ preserveBaseWorld: interactions.selected === state.model });
        undoManager.commit();
    }
});
transformManager.setEnabled(false);
cameraManager.setTransformControls(transformManager.controls);

const viewCube = new ViewCube(
    document.getElementById('view-cube-canvas'),
    cameraManager.perspectiveCamera,
    cameraManager.controls,
    view => cameraManager.setCameraView(view)
);

// ============ Geometry helpers ============

/**
 * Exact world-space bounds from the mesh's own vertices. Children (like
 * the transform gizmo) never pollute the result, and unlike transforming
 * the local bounding box, rotation cannot inflate it — the embed math
 * depends on a true min.y or a tilted model would float above its base.
 */
const boundsScratch = new THREE.Vector3();
function meshWorldBounds(mesh) {
    mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
        boundsScratch.fromBufferAttribute(position, i)
            .applyMatrix4(mesh.matrixWorld);
        bounds.expandByPoint(boundsScratch);
    }
    return bounds;
}

function computeFootprintParams(modelBounds) {
    const size = modelBounds.getSize(new THREE.Vector3());
    // The scan has to stand on the plate, so the plate can never be
    // narrower or shallower than the scan's own footprint.
    state.minFootprint = { width: size.x, depth: size.z };
    const params = { ...state.baseParams };
    if (!state.sizeOverride) {
        params.width = state.settings.width;
        params.depth = state.settings.depth;
        params.height = state.settings.height;
        params.wall = state.settings.wall;
        params.hollow = state.settings.hollow;
        params.infill = state.settings.infill;
        params.clampBand = state.settings.clampBand;
        if (state.settings.autoGrow) {
            params.width = Math.max(params.width, size.x * BASE_AUTOFIT_PADDING);
            params.depth = Math.max(params.depth, size.z * BASE_AUTOFIT_PADDING);
        }
    }
    const normalized = normalizeBaseParams({
        ...params,
        width: Math.max(params.width, state.minFootprint.width),
        depth: Math.max(params.depth, state.minFootprint.depth)
    });
    ui?.setBaseFloors({
        width: Math.ceil(state.minFootprint.width * 10) / 10,
        depth: Math.ceil(state.minFootprint.depth * 10) / 10
    });

    return {
        ...normalized,
        posX: params.posX ?? 0,
        posZ: params.posZ ?? 0
    };
}

/**
 * A sunken model gets trimmed at the deck's underside: the hollow cavity
 * eats whatever reaches into it. Used for the live preview; the merge
 * carves the same volume for real.
 */
function modelCutPlaneY() {
    if (!state.base || !state.baseParams.hollow) return null;
    return state.base.position.y
        + state.baseParams.height
        - state.baseParams.wall;
}

function placeBase() {
    if (!state.base) return;
    state.base.position.set(
        state.baseAnchor.centerX + state.baseParams.posX,
        state.baseAnchor.topY - state.baseParams.height,
        state.baseAnchor.centerZ + state.baseParams.posZ
    );
    state.base.updateMatrixWorld(true);
    sceneContext.setModelCutPlane(state.processed ? null : modelCutPlaneY());
}

function clampOffset(value, limits) {
    return Math.min(limits.max, Math.max(limits.min, value));
}

/**
 * Keep everything aligned with the graph paper: the base sits directly
 * under the model (0.5 mm embed), its underside is pinned to Y = 0, and
 * the combined footprint touches the origin so the top view reads like a
 * one-quadrant ruler (width to the right, depth upward).
 *
 * `preserveBaseWorld` recomputes the base offsets so the base holds its
 * spot relative to a model the user just dragged.
 */
function settleLayout({ preserveBaseWorld = false } = {}) {
    if (!state.model || !state.base || state.processed) return;

    const bounds = meshWorldBounds(state.model);
    if (bounds.isEmpty()) return;

    state.baseParams = computeFootprintParams(bounds);
    const center = bounds.getCenter(new THREE.Vector3());

    if (preserveBaseWorld) {
        state.baseParams.posX = clampOffset(
            state.base.position.x - center.x, BASE_LIMITS.posX
        );
        state.baseParams.posZ = clampOffset(
            state.base.position.z - center.z, BASE_LIMITS.posZ
        );
        // Dragging the model down sinks it into the base; the cut preview
        // and the merge both honor this depth.
        state.sink = state.base.position.y
            + state.baseParams.height
            - bounds.min.y;
    }
    state.sink = Math.min(
        Math.max(state.sink, BASE_EMBED),
        state.baseParams.height
    );

    state.baseAnchor.centerX = center.x;
    state.baseAnchor.centerZ = center.z;
    state.baseAnchor.topY = bounds.min.y + state.sink;

    // Seat the pair on the grid plane.
    const baseBottom = state.baseAnchor.topY - state.baseParams.height;
    if (Math.abs(baseBottom) > 1e-6) {
        state.model.position.y -= baseBottom;
        state.baseAnchor.topY -= baseBottom;
        state.model.updateMatrixWorld(true);
    }

    rebuildBaseIfNeeded();

    // Slide the pair so the combined footprint corners on the origin,
    // spanning +X and -Z (the ruler quadrant).
    const baseCenterX = state.baseAnchor.centerX + state.baseParams.posX;
    const baseCenterZ = state.baseAnchor.centerZ + state.baseParams.posZ;
    const minX = Math.min(bounds.min.x, baseCenterX - state.baseParams.width / 2);
    const maxZ = Math.max(bounds.max.z, baseCenterZ + state.baseParams.depth / 2);
    if (Math.abs(minX) > 1e-6 || Math.abs(maxZ) > 1e-6) {
        state.model.position.x -= minX;
        state.model.position.z -= maxZ;
        state.baseAnchor.centerX -= minX;
        state.baseAnchor.centerZ -= maxZ;
        state.model.updateMatrixWorld(true);
    }

    placeBase();
    syncReadouts();
}

let lastBuiltKey = '';
function baseGeometryKey(params) {
    return [
        params.width, params.depth, params.height, params.wall, params.hollow,
        params.infill, params.clampBand, params.cornerRadius,
        params.textLine1, params.textLine2
    ].join('|');
}

/**
 * What to actually build right now.
 *
 * While a size slider is being dragged the wall pattern and the lettering
 * are dropped: each costs a boolean per rebuild, and the thing being
 * judged mid-drag is the plate's size, not its wall. They come back the
 * moment the slider is released.
 */
function effectiveBaseParams() {
    if (!state.previewPlain) return state.baseParams;
    return {
        ...state.baseParams,
        infill: 'solid',
        textLine1: '',
        textLine2: ''
    };
}

function rebuildBaseIfNeeded() {
    if (!state.base) return;
    const effective = effectiveBaseParams();
    const key = baseGeometryKey(effective);
    if (key === lastBuiltKey) return;

    // The build may normalize numbers, but the wall choice and lettering
    // stay whatever the user asked for, not whatever the preview used.
    const { posX, posZ, infill, textLine1, textLine2 } = state.baseParams;
    const normalized = rebuildBaseMesh(state.base, effective);
    state.baseParams = {
        ...normalized, posX, posZ, infill, textLine1, textLine2
    };
    lastBuiltKey = key;
    interactions.refreshOutline();
}

// Debounced settle keeps slider drags responsive: the base regenerates and
// the pair re-seats on the grid a beat after the last input event.
const rebuildBaseDebounced = debounce(settleLayout, 30);

function syncReadouts() {
    if (!state.model) return;
    const size = meshWorldBounds(state.model).getSize(new THREE.Vector3());
    const p = state.baseParams;
    const mm = value => value.toFixed(1).replace(/\.0$/, '');
    ui.setDims(
        `Model ${mm(size.x)} × ${mm(size.z)} mm · `
        + `Base ${mm(p.width)} × ${mm(p.depth)} × ${mm(p.height)} mm`
    );
    ui.syncBaseControls(p);
    // Whether a line fits depends on how wide the plate is, so this has to
    // be recomputed whenever the plate changes, not only when text is typed.
    ui.setEngravingHint(describeEngraving());
    syncModelRotationUI();
}

function syncModelRotationUI() {
    if (!state.model) return;
    const wrap = angle => {
        let degrees = THREE.MathUtils.radToDeg(angle);
        while (degrees > 180) degrees -= 360;
        while (degrees < -180) degrees += 360;
        return Math.round(degrees);
    };
    ui.syncModelRotation({
        x: wrap(state.model.rotation.x - MODEL_ROTATION_OFFSET.x),
        y: wrap(state.model.rotation.y - MODEL_ROTATION_OFFSET.y),
        z: wrap(state.model.rotation.z - MODEL_ROTATION_OFFSET.z)
    });
}

// ============ Undo ============

function captureSnapshot() {
    if (!state.model) return null;
    return {
        modelPosition: state.model.position.toArray(),
        modelRotation: [
            state.model.rotation.x,
            state.model.rotation.y,
            state.model.rotation.z
        ],
        baseParams: { ...state.baseParams },
        baseAnchor: { ...state.baseAnchor },
        sizeOverride: state.sizeOverride,
        sink: state.sink
    };
}

function restoreSnapshot(snapshot) {
    if (!snapshot || !state.model || !state.base) return;
    state.model.position.fromArray(snapshot.modelPosition);
    state.model.rotation.set(...snapshot.modelRotation);
    state.model.updateMatrixWorld(true);
    state.baseParams = { ...snapshot.baseParams };
    state.baseAnchor = { ...snapshot.baseAnchor };
    state.sizeOverride = snapshot.sizeOverride;
    state.sink = snapshot.sink ?? BASE_EMBED;
    rebuildBaseIfNeeded();
    placeBase();
    syncReadouts();
}

const undoManager = createUndoManager({
    capture: captureSnapshot,
    restore: restoreSnapshot
});

// ============ Selection ============

const interactions = createInteractionManager({
    canvas,
    scene: sceneContext.scene,
    getCamera: () => cameraManager.activeCamera,
    getPickables: () => [state.model, state.base].filter(Boolean),
    setMaterialState: sceneContext.setMaterialState,
    isBusy: () => state.busy || state.processed,
    onSelect: mesh => {
        if (!mesh) {
            transformManager.detach();
            ui.setSelection(null);
            return;
        }
        if (mesh === state.model) {
            // Y stays live so the model can sink into the hollow base.
            transformManager.attach(state.model, { allowY: true });
            ui.setSelection('model');
        } else if (mesh === state.base) {
            transformManager.attach(state.base, { allowY: false, translateOnly: true });
            ui.setSelection('base');
        }
    }
});

function deselect() {
    interactions.deselect();
}

// ============ Import ============

async function nextPaint(delay = 0) {
    // requestAnimationFrame never fires in a hidden tab, which would stall
    // a merge the user left running in the background.
    if (document.hidden) {
        await new Promise(resolve => window.setTimeout(resolve, delay));
        return;
    }
    await new Promise(resolve => {
        requestAnimationFrame(() => window.setTimeout(resolve, delay));
    });
}

/** Animated version of cameraManager.fitToObject. */
function glideCameraToFit(object, padding, duration = 850) {
    const camera = cameraManager.perspectiveCamera;
    const controls = cameraManager.controls;
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    cameraManager.fitToObject(object, padding);
    const endPosition = camera.position.clone();
    const endTarget = controls.target.clone();
    camera.position.copy(startPosition);
    controls.target.copy(startTarget);

    const animation = { t: 0 };
    new Tween(animation)
        .to({ t: 1 }, duration)
        .easing(Easing.Cubic.InOut)
        .onUpdate(() => {
            camera.position.lerpVectors(startPosition, endPosition, animation.t);
            controls.target.lerpVectors(startTarget, endTarget, animation.t);
        })
        .start();
}

function disposeCurrent() {
    rebuildBaseDebounced.cancel();
    interactions.setEnabled(false);
    transformManager.detach();
    ui.setSelection(null);
    if (state.model) {
        sceneContext.scene.remove(state.model);
        state.model.geometry.dispose();
    }
    if (state.base) {
        sceneContext.scene.remove(state.base);
        state.base.geometry.dispose();
    }
    state.preparedModel?.dispose();
    state.preparedModel = null;
    state.model = null;
    state.base = null;
    state.processed = false;
    state.sizeOverride = false;
    lastBuiltKey = '';
}

async function handleFile(file) {
    if (state.busy) return;
    const sequence = ++importSequence;
    state.busy = true;
    ui.showProcessing(`Reading ${file.name}…`);
    await nextPaint();

    try {
        const imported = await importModelFile(file);
        if (sequence !== importSequence) {
            imported.geometry.dispose();
            return;
        }

        disposeCurrent();
        state.filename = imported.filename;
        state.exported = false;
        state.sink = BASE_EMBED;
        state.meshHasSeams = false;
        character.setVisible(false);
        state.baseParams = {
            ...normalizeBaseParams(state.settings),
            posX: 0,
            posZ: 0
        };

        state.model = new THREE.Mesh(imported.geometry, sceneContext.materials.model);
        state.model.name = 'DentalModel';
        sceneContext.scene.add(state.model);
        state.model.updateMatrixWorld(true);

        // Weld once now, while the loading overlay is up, so the export
        // merge later skips this ~half-second step.
        ui.updateProcessing('Preparing the mesh…');
        await nextPaint();
        state.preparedModel = prepareGeometryForCSG(imported.geometry, {
            name: 'DentalModel'
        });

        state.base = new THREE.Mesh(
            buildBaseGeometry(state.baseParams),
            sceneContext.materials.base
        );
        state.base.name = 'ArticulatorBase';
        lastBuiltKey = baseGeometryKey(state.baseParams);
        sceneContext.scene.add(state.base);

        settleLayout();

        transformManager.setEnabled(true);
        transformManager.setMode('translate');
        interactions.setEnabled(true);

        ui.showWorkspace(imported.filename);
        ui.setExportState('ready');
        syncReadouts();
        undoManager.reset();
        undoManager.commit();

        sceneContext.setGridShown(true);
        glideCameraToFit(state.model, 1.9);

        ui.toast('Aligned and centered. Export when it looks right.');
        log('[Import] Loaded', imported.filename);
    } catch (error) {
        debugError('[Import] Could not load model:', error);
        ui.toast(`Import failed: ${error.message}`);
    } finally {
        if (sequence === importSequence) {
            state.busy = false;
            ui.hideProcessing();
        }
    }
}

// ============ Inspector actions ============

function updateBaseParam(name, value, commit) {
    if (!state.base || state.processed) return;
    state.sizeOverride = true;

    // Typing a number straight into the box bypasses the slider's stop, so
    // the floor is enforced here too.
    let requested = value;
    if (name === 'width') requested = Math.max(value, state.minFootprint.width);
    if (name === 'depth') requested = Math.max(value, state.minFootprint.depth);
    if (requested !== value) {
        ui.toast(`The plate cannot be smaller than the scan: ${
            requested.toFixed(1)} mm is the minimum.`, 2200);
    }

    const { posX, posZ } = state.baseParams;
    state.baseParams = {
        ...normalizeBaseParams({ ...state.baseParams, [name]: requested }),
        posX,
        posZ
    };
    // Mid-drag the plate rebuilds plain, which keeps it instant; the wall
    // detail returns as soon as the slider is let go.
    state.previewPlain = !commit;
    rebuildBaseDebounced();
    if (commit) {
        rebuildBaseDebounced.flush();
        settleLayout();
        undoManager.commit();
    }
}

function updateEngraving(line1, line2) {
    if (!state.base || state.processed) return;
    state.sizeOverride = true;
    state.previewPlain = false;
    state.baseParams = {
        ...state.baseParams,
        textLine1: cleanEngravedText(line1),
        textLine2: cleanEngravedText(line2)
    };
    rebuildBaseIfNeeded();
    placeBase();
    syncReadouts();
    undoManager.commit();
}

/**
 * Say plainly whether the lettering will actually appear. It needs a run
 * of flat back wall and enough open band, and quietly cutting nothing
 * would look like a bug.
 */
function describeEngraving() {
    const params = state.baseParams;
    if (!params || !hasEngraving(params)) {
        return 'Cut into the flat back of the plate, centered. Letters and numbers.';
    }

    const outline = measureOutline(createBaseOutline(params));
    const band = getInfillBand(params);
    const cutters = buildEngravingCutters(outline, params, band);
    const lines = [params.textLine1, params.textLine2].filter(Boolean).length;
    cutters.forEach(cutter => cutter.dispose());

    if (!cutters.length) {
        // Say the actual numbers. Lettering that quietly fails to appear
        // reads as a bug, and "make it bigger" is not an instruction.

        // Width bites first on a long line, and no amount of extra height
        // fixes that, so check it before talking about raising the base.
        const fits = maxLineCharacters(outline, params, band);
        const longest = Math.max(
            params.textLine1.length,
            params.textLine2.length
        );
        if (fits > 0 && longest > fits) {
            return `This plate holds ${fits} characters a line. Shorten the `
                + `line, or widen the plate to fit ${longest}.`;
        }

        const needed = lines > 1 ? TEXT_MIN_BAND * 2 + 1.2 : TEXT_MIN_BAND;
        const height = Math.ceil(params.clampBand + params.wall + needed);
        if (height <= BASE_LIMITS.height.max) {
            return `${lines > 1 ? 'Two lines need' : 'Lettering needs'} about ${
                needed.toFixed(0)} mm of open wall. Raise the base to ${
                height} mm.`;
        }
        const spare = Math.ceil(needed + params.wall);
        return `${lines > 1 ? 'Two lines need' : 'Lettering needs'} about ${
            needed.toFixed(0)} mm of open wall, more than this plate has. `
            + `Lower the clamp band to about ${
                Math.max(0, BASE_LIMITS.height.max - spare)} mm, or use one line.`;
    }
    return 'Cut into the flat back of the plate, centered.';
}

function updateBaseHollow(checked) {
    if (!state.base || state.processed) return;
    // Keep the user's choice past the next layout settle.
    state.sizeOverride = true;
    state.baseParams.hollow = checked;
    rebuildBaseIfNeeded();
    placeBase();
    syncReadouts();
    undoManager.commit();
}

function fitBase() {
    if (!state.base || state.processed) return;
    state.baseParams.posX = 0;
    state.baseParams.posZ = 0;
    state.sizeOverride = false;
    settleLayout();
    undoManager.commit();
    ui.toast('Base centered under the model.');
}

function updateModelRotation(axis, degrees, commit) {
    if (!state.model || state.processed) return;
    state.model.rotation[axis] =
        MODEL_ROTATION_OFFSET[axis] + THREE.MathUtils.degToRad(degrees);
    state.model.updateMatrixWorld(true);
    if (commit) {
        settleLayout();
        undoManager.commit();
    }
}

function recenterModel() {
    if (!state.model || state.processed) return;
    state.baseParams.posX = 0;
    state.baseParams.posZ = 0;
    settleLayout();
    undoManager.commit();
    ui.toast('Model re-centered on the plate.');
}

// ============ One-click export ============

function overlapExists() {
    const modelBounds = meshWorldBounds(state.model);
    const baseBounds = meshWorldBounds(state.base);
    const overlap = modelBounds.intersect(baseBounds);
    if (overlap.isEmpty()) return false;
    const size = overlap.getSize(new THREE.Vector3());
    return size.x > 1e-4 && size.y > 1e-4 && size.z > 1e-4;
}

/** The import-time welded copy, with the current world transform baked. */
function bakedPreparedModel() {
    const baked = state.preparedModel.clone();
    state.model.updateWorldMatrix(true, false);
    baked.applyMatrix4(state.model.matrixWorld);
    return baked;
}

/**
 * Hollow merge, in three clean cuts:
 * 1. If the model is sunk past the deck's underside, trim it there with a
 *    halfspace box (an open-space cut, no coplanar faces).
 * 2. Union the trimmed model with a SOLID base — one seam at the base top.
 * 3. Carve the cavity out of the pair. The cutter never meets the model,
 *    so near-tangent skirt/cavity intersections cannot happen.
 */
async function mergeHollow() {
    state.base.updateWorldMatrix(true, false);
    const deckBottom = modelCutPlaneY();
    const baseTop = state.base.position.y + state.baseParams.height;
    const modelName = state.model.name || 'Dental model';

    // Deep sinks slice the seam through rough gum anatomy; a slightly
    // coarser weld collapses the sliver triangles that otherwise leak.
    const deepSink = meshWorldBounds(state.model).min.y < deckBottom - 0.05;
    const tolerance = deepSink ? 5e-4 : undefined;

    if (!deepSink) {
        // Nothing reaches the cavity: one union with the hollow base is
        // enough, and it costs a single repair pass instead of two.
        ui.updateProcessing('Merging model and base…');
        await nextPaint();
        const bakedModel = bakedPreparedModel();
        try {
            const result = unionGeometries(bakedModel, state.base.geometry, {
                firstPrepared: true,
                secondMatrix: state.base.matrixWorld,
                firstName: modelName,
                secondName: state.base.name || 'Procedural base',
                planarSeamY: baseTop
            });
            // A plain solid wall is proven watertight, so only a patterned
            // wall is worth the cost of re-checking.
            state.meshHasSeams = state.baseParams.infill !== 'solid'
                && !getEdgeTopologyStats(result).isTwoManifold;
            return result;
        } finally {
            bakedModel.dispose();
        }
    }

    let trimmedModel = null;
    if (deepSink) {
        ui.updateProcessing('Trimming the sunken part of the model…');
        await nextPaint();
        const modelBounds = meshWorldBounds(state.model);
        const margin = 10;
        const cutter = new THREE.BoxGeometry(
            modelBounds.max.x - modelBounds.min.x + margin * 2,
            deckBottom - modelBounds.min.y + margin,
            modelBounds.max.z - modelBounds.min.z + margin * 2
        );
        cutter.translate(
            (modelBounds.min.x + modelBounds.max.x) / 2,
            deckBottom - (deckBottom - modelBounds.min.y + margin) / 2,
            (modelBounds.min.z + modelBounds.max.z) / 2
        );
        const bakedModel = bakedPreparedModel();
        try {
            trimmedModel = subtractGeometries(bakedModel, cutter, {
                firstPrepared: true,
                firstName: modelName,
                secondName: 'Halfspace cutter',
                planarSeamY: deckBottom,
                tolerance
            });
        } finally {
            bakedModel.dispose();
            cutter.dispose();
        }
    }

    ui.updateProcessing('Merging model and base…');
    await nextPaint();
    const modelInput = trimmedModel ?? bakedPreparedModel();
    const solidBase = buildBaseGeometry({ ...state.baseParams, hollow: false });
    const cavityCutter = buildCavityCutterGeometry(state.baseParams);
    try {
        const fused = unionGeometries(modelInput, solidBase, {
            firstPrepared: true,
            secondMatrix: state.base.matrixWorld,
            firstName: modelName,
            secondName: 'Solid base',
            planarSeamY: baseTop,
            tolerance
        });
        ui.updateProcessing('Hollowing the base…');
        await nextPaint();
        try {
            const result = subtractGeometries(fused, cavityCutter, {
                secondMatrix: state.base.matrixWorld,
                firstName: 'Model with base',
                secondName: 'Cavity',
                planarSeamY: deckBottom,
                tolerance
            });
            // Only deep sinks can leave slicer-repairable seams; the
            // default flow is proven watertight, so skip the check there.
            state.meshHasSeams = deepSink
                && !getEdgeTopologyStats(result).isTwoManifold;
            return result;
        } finally {
            fused.dispose();
        }
    } finally {
        modelInput.dispose();
        solidBase.dispose();
        cavityCutter.dispose();
    }
}

async function mergeGeometry() {
    rebuildBaseDebounced.flush();
    deselect();
    ui.showProcessing('Merging model and base…');
    await nextPaint(40);
    const startedAt = performance.now();

    let resultGeometry;
    state.meshHasSeams = false;
    if (state.base.visible && state.baseParams.hollow) {
        resultGeometry = await mergeHollow();
    } else if (state.base.visible) {
        state.base.updateWorldMatrix(true, false);
        const bakedModel = bakedPreparedModel();
        try {
            resultGeometry = unionGeometries(bakedModel, state.base.geometry, {
                firstPrepared: true,
                secondMatrix: state.base.matrixWorld,
                firstName: state.model.name || 'Dental model',
                secondName: state.base.name || 'Procedural base',
                planarSeamY: state.base.position.y + state.baseParams.height
            });
        } finally {
            bakedModel.dispose();
        }
    } else {
        resultGeometry = bakeMeshGeometry(state.model);
    }

    const previous = state.model.geometry;
    state.model.geometry = resultGeometry;
    previous.dispose();
    state.model.position.set(0, 0, 0);
    state.model.rotation.set(0, 0, 0);
    state.model.scale.set(1, 1, 1);
    state.model.updateMatrixWorld(true);
    state.base.visible = false;
    sceneContext.setModelCutPlane(null);

    transformManager.detach();
    transformManager.setEnabled(false);
    interactions.setEnabled(false);
    ui.setSelection(null);
    state.processed = true;

    const elapsed = performance.now() - startedAt;
    log('[CSG] Merge complete', getGeometryStats(resultGeometry), `${elapsed.toFixed(0)}ms`);
}

async function handleExport() {
    if (!state.model || state.busy) return;
    if (!state.processed && !overlapExists()) {
        ui.toast('The base is not touching the model. Click the base and choose "Center under model".');
        return;
    }

    state.busy = true;
    ui.setExportState('busy');
    try {
        const needsMerge = !state.processed;
        if (needsMerge) await mergeGeometry();
        ui.updateProcessing('Saving STL…');

        const stem = state.filename
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-z0-9_-]+/gi, '_');
        const exportResult = await exportSTL(state.model, {
            suggestedName: `${stem || 'model'}_based.stl`,
            oneClick: true,
            onStatus: () => {}
        });

        if (needsMerge) {
            // The file is already on its way; polish the on-screen normals
            // afterward so sharp edges shade cleanly (display only — the
            // STL exporter derives face normals from the triangles).
            ui.updateProcessing('Finishing up…');
            await nextPaint();
            const creased = BufferGeometryUtils.toCreasedNormals(
                state.model.geometry,
                THREE.MathUtils.degToRad(38)
            );
            state.model.geometry.dispose();
            state.model.geometry = creased;
        }
        ui.hideProcessing();
        ui.setExportState('exported');
        if (exportResult?.method === 'cancelled') {
            ui.toast('Export cancelled. No file was saved. Click "Export again" to save it.');
            return;
        }
        ui.toast(state.meshHasSeams
            ? 'STL downloaded. Your slicer may auto-close a few small seams on this one.'
            : 'STL downloaded. Check your Downloads folder.');

        // The thank-you moment: Max slides out once the file is saved.
        if (!state.exported && state.settings.showGreeter) {
            state.exported = true;
            character.setVisible(true);
            window.setTimeout(() => character.open(), 750);
        }
        state.exported = true;
    } catch (error) {
        debugError('[Export] Failed:', error);
        ui.hideProcessing();
        ui.setExportState(state.processed ? 'exported' : 'ready');
        ui.toast(`Export failed: ${error.message}`);
    } finally {
        state.busy = false;
    }
}

function handleReset() {
    if (state.busy) return;
    importSequence += 1;
    disposeCurrent();
    undoManager.reset();
    state.exported = false;
    character.setVisible(false);
    sceneContext.setGridShown(false);
    ui.setSelection(null);
    ui.setExportState('ready');
    ui.showDropScreen();
    cameraManager.controls.target.set(0, 0, 0);
    cameraManager.perspectiveCamera.position.set(100, 100, 100);
    cameraManager.perspectiveCamera.up.set(0, 1, 0);
    cameraManager.setActiveCamera(false);
    cameraManager.update();
}

// ============ Settings ============

const FOOTPRINT_SETTING_KEYS = [
    'width', 'depth', 'height', 'wall', 'hollow', 'autoGrow',
    'infill', 'clampBand'
];

/**
 * A pattern needs open wall above the clamp band. Rather than silently
 * cutting nothing, raise the base just enough to fit and say so.
 */
/** Open wall the chosen pattern wants, in millimeters. */
function requiredBand(infill) {
    return infill === 'text' ? TEXT_MIN_BAND : MIN_PATTERN_BAND;
}

function ensureRoomForPattern() {
    const settings = state.settings;
    if (settings.infill === 'solid') return null;

    const needed = settings.clampBand
        + settings.wall
        + requiredBand(settings.infill);
    if (settings.height >= needed) return null;

    const height = Math.min(needed, BASE_LIMITS.height.max);
    if (height <= settings.height) return 'tight';
    state.settings = saveSettings({ ...settings, height });
    ui.syncSettings(state.settings);
    return height;
}

function describeInfill() {
    const settings = state.settings;
    if (settings.infill === 'solid') {
        return 'A solid wall is the strongest option and the safest bet for the clamp.';
    }
    const band = settings.height - settings.wall - settings.clampBand;
    if (band < requiredBand(settings.infill)) {
        return `Not enough wall above the clamp band. Raise the base to about ${
            Math.ceil(settings.clampBand + settings.wall + requiredBand(settings.infill))
        } mm, or lower the clamp band, to fit this pattern.`;
    }
    if (settings.infill === 'text') {
        return `MedStar OMFS reads across the flat back wall. The bottom ${
            settings.clampBand} mm stays solid for the clamp.`;
    }
    return `The bottom ${settings.clampBand} mm stays solid for the clamp. `
        + `The pattern opens the ${band.toFixed(1)} mm above it.`;
}

function applySettings(patch, commit) {
    state.settings = { ...state.settings, ...patch };
    if (commit) state.settings = saveSettings(state.settings);

    if (commit && 'infill' in patch) {
        const raised = ensureRoomForPattern();
        if (typeof raised === 'number') {
            ui.toast(`Base raised to ${raised} mm so the pattern has wall to cut.`);
        }
    }

    ui.syncSettings(state.settings);
    ui.setInfillHint(describeInfill());
    character.setVisible(state.settings.showGreeter && state.exported);

    // Only a base-plate edit retakes control of the live base; toggling
    // something unrelated (like the greeter) must not wipe manual sizing.
    const touchesFootprint = FOOTPRINT_SETTING_KEYS.some(key => key in patch);
    if (state.base && !state.processed && touchesFootprint) {
        state.sizeOverride = false;
        if (commit) {
            settleLayout();
            undoManager.commit();
        } else {
            rebuildBaseDebounced();
        }
    }
}

function handleSettingsReset() {
    state.settings = resetSettings();
    ui.syncSettings(state.settings);
    character.setVisible(state.settings.showGreeter && state.exported);
    if (state.base && !state.processed) {
        state.sizeOverride = false;
        settleLayout();
        undoManager.commit();
    }
    ui.toast('Settings restored to factory defaults.');
}

// ============ UI ============

const ui = createUI({
    onFile: handleFile,
    onBaseParam: updateBaseParam,
    onBaseHollow: updateBaseHollow,
    onEngraving: updateEngraving,
    onFitBase: fitBase,
    onModelRotate: updateModelRotation,
    onRecenter: recenterModel,
    onExport: handleExport,
    onReset: handleReset,
    onTopView: () => cameraManager.setCameraView('top'),
    onSettingsChange: applySettings,
    onSettingsReset: handleSettingsReset,
    onInspectorClose: deselect
});

ui.syncSettings(state.settings);
ui.setInfillHint(describeInfill());
ui.showDropScreen();
ui.setExportState('ready');
// Max stays offstage until the first export finishes.
const character = createCharacter();
character.setVisible(false);

// ============ Keyboard ============

window.addEventListener('keydown', event => {
    const element = event.target;
    const isTyping = element instanceof HTMLElement && (
        element.matches('input, textarea, select') || element.isContentEditable
    );
    // Escape always works: leave the field, close panels, drop selection.
    if (isTyping && event.key === 'Escape') element.blur();
    else if (isTyping || state.busy) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (!state.processed && undoManager.undo()) ui.toast('Undone.', 1400);
        return;
    }

    switch (event.key.toLowerCase()) {
        case 'escape':
            if (ui.isSettingsOpen()) ui.closeSettings();
            else deselect();
            break;
        case 'g':
            if (interactions.selected) transformManager.setMode('translate');
            break;
        case 'r':
            if (interactions.selected === state.model) transformManager.setMode('rotate');
            break;
        case 't':
            cameraManager.setCameraView('top');
            break;
        default:
            break;
    }
});

window.addEventListener('resize', () => {
    sceneContext.resize();
    cameraManager.resize();
    viewCube.resize();
});

// ============ Render loop ============

function animate(now) {
    requestAnimationFrame(animate);
    cameraManager.update();
    TWEEN.update(now);
    interactions.update();
    sceneContext.renderer.render(sceneContext.scene, cameraManager.activeCamera);
    viewCube.animate(cameraManager.activeCamera);
}
requestAnimationFrame(animate);

// ============ Automation hooks (tests / acceptance) ============

window.__ARTICULATOR_BASER__ = Object.freeze({
    async loadTestAsset(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load fixture: ${response.status}`);
        const blob = await response.blob();
        const filename = new URL(response.url, window.location.href)
            .pathname.split('/').pop();
        await handleFile(new File([blob], filename));
        return this.summary();
    },
    selectModel: () => interactions.select(state.model),
    selectBase: () => interactions.select(state.base),
    deselect,
    fitBase,
    setSink(depth) {
        state.sink = depth;
        settleLayout();
        return state.sink;
    },
    merge: mergeGeometry,
    exportAndDownload: handleExport,
    reset: handleReset,
    undo: () => undoManager.undo(),
    setBaseParam: (name, value, commit = true) =>
        updateBaseParam(name, value, commit),
    exportBytes() {
        if (!state.processed) throw new Error('Merge the model first.');
        return binaryResultToBytes(createBinarySTL(state.model));
    },
    summary() {
        const modelBounds = state.model ? meshWorldBounds(state.model) : null;
        const baseBounds = state.base ? meshWorldBounds(state.base) : null;
        return {
            processed: state.processed,
            filename: state.filename,
            selected: interactions.selected?.name ?? null,
            settings: { ...state.settings },
            baseParams: state.baseParams ? { ...state.baseParams } : null,
            basePosition: state.base?.position.toArray() ?? null,
            modelBounds: modelBounds
                ? [modelBounds.min.toArray(), modelBounds.max.toArray()]
                : null,
            baseBounds: baseBounds
                ? [baseBounds.min.toArray(), baseBounds.max.toArray()]
                : null,
            geometry: state.model ? getGeometryStats(state.model.geometry) : null
        };
    }
});

log('Articulator Baser initialized.');
