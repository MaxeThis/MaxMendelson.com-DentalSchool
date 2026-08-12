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
    buildBaseGeometry,
    rebuildBaseMesh,
    normalizeBaseParams,
    debounce
} from './base.js';
import { bakeMeshGeometry, unionModelAndBase, getGeometryStats } from './csg.js';
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
    baseParams: null,          // normalized params + posX/posZ offsets
    baseAnchor: { centerX: 0, centerZ: 0, topY: 0 },
    sizeOverride: false,       // user set an explicit size this session
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
 * World-space bounds from the mesh's own geometry only (children like the
 * transform gizmo never pollute the result).
 */
function meshWorldBounds(mesh) {
    mesh.updateMatrixWorld(true);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

function computeFootprintParams(modelBounds) {
    const size = modelBounds.getSize(new THREE.Vector3());
    const params = { ...state.baseParams };
    if (!state.sizeOverride) {
        params.width = state.settings.width;
        params.depth = state.settings.depth;
        params.height = state.settings.height;
        params.wall = state.settings.wall;
        params.hollow = state.settings.hollow;
        if (state.settings.autoGrow) {
            params.width = Math.max(params.width, size.x * BASE_AUTOFIT_PADDING);
            params.depth = Math.max(params.depth, size.z * BASE_AUTOFIT_PADDING);
        }
    }
    return {
        ...normalizeBaseParams(params),
        posX: params.posX ?? 0,
        posZ: params.posZ ?? 0
    };
}

function placeBase() {
    if (!state.base) return;
    state.base.position.set(
        state.baseAnchor.centerX + state.baseParams.posX,
        state.baseAnchor.topY - state.baseParams.height,
        state.baseAnchor.centerZ + state.baseParams.posZ
    );
    state.base.updateMatrixWorld(true);
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
    }

    state.baseAnchor.centerX = center.x;
    state.baseAnchor.centerZ = center.z;
    state.baseAnchor.topY = bounds.min.y + BASE_EMBED;

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
    return [params.width, params.depth, params.height, params.wall, params.hollow]
        .join('|');
}

function rebuildBaseIfNeeded() {
    if (!state.base) return;
    const key = baseGeometryKey(state.baseParams);
    if (key === lastBuiltKey) return;
    const { posX, posZ } = state.baseParams;
    const normalized = rebuildBaseMesh(state.base, state.baseParams);
    state.baseParams = { ...normalized, posX, posZ };
    lastBuiltKey = baseGeometryKey(state.baseParams);
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
        sizeOverride: state.sizeOverride
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
            transformManager.attach(state.model, { allowY: false });
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
    const { posX, posZ } = state.baseParams;
    state.baseParams = {
        ...normalizeBaseParams({ ...state.baseParams, [name]: value }),
        posX,
        posZ
    };
    rebuildBaseDebounced();
    if (commit) {
        rebuildBaseDebounced.flush();
        settleLayout();
        undoManager.commit();
    }
}

function updateBaseHollow(checked) {
    if (!state.base || state.processed) return;
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

async function mergeGeometry() {
    rebuildBaseDebounced.flush();
    deselect();
    ui.showProcessing('Merging model and base…');
    await nextPaint(40);
    const startedAt = performance.now();

    let resultGeometry = state.base.visible
        ? unionModelAndBase(state.model, state.base)
        : bakeMeshGeometry(state.model);

    // Split normals at sharp edges so the flat deck and walls shade
    // cleanly instead of smearing across the crease (display only; the
    // STL exporter derives face normals from the triangles).
    const creased = BufferGeometryUtils.toCreasedNormals(
        resultGeometry,
        THREE.MathUtils.degToRad(38)
    );
    resultGeometry.dispose();
    resultGeometry = creased;

    const previous = state.model.geometry;
    state.model.geometry = resultGeometry;
    previous.dispose();
    state.model.position.set(0, 0, 0);
    state.model.rotation.set(0, 0, 0);
    state.model.scale.set(1, 1, 1);
    state.model.updateMatrixWorld(true);
    state.base.visible = false;

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
        if (!state.processed) await mergeGeometry();
        ui.updateProcessing('Saving STL…');

        const stem = state.filename
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-z0-9_-]+/gi, '_');
        await exportSTL(state.model, {
            suggestedName: `${stem || 'model'}_based.stl`,
            oneClick: true,
            onStatus: () => {}
        });
        ui.hideProcessing();
        ui.setExportState('exported');
        ui.toast('STL downloaded. Check your Downloads folder.');

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

function applySettings(patch, commit) {
    state.settings = { ...state.settings, ...patch };
    if (commit) state.settings = saveSettings(state.settings);
    ui.syncSettings(state.settings);
    character.setVisible(state.settings.showGreeter && state.exported);

    if (state.base && !state.processed) {
        // Defaults drive the live base whenever it has no manual override.
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

window.__MEDSTAR_BASE__ = Object.freeze({
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
    merge: mergeGeometry,
    exportAndDownload: handleExport,
    reset: handleReset,
    undo: () => undoManager.undo(),
    setBaseParam: (name, value) => updateBaseParam(name, value, true),
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

log('MedStar Base initialized.');
