import * as THREE from 'three';

const CLICK_MAX_TRAVEL_PX = 6;
const OUTLINE_COLOR = 0xFCD900;
const OUTLINE_SCALE = 1.012;

/**
 * Blender-style viewport picking: hovering a pickable mesh lifts its shade
 * and shows a pointer cursor; a click (not an orbit drag) selects it and
 * adds a yellow back-face outline; clicking empty space deselects.
 *
 * The outline lives directly in the scene (not as a child of the selected
 * mesh) so bounding-box math on the model/base never includes it. Call
 * `update()` once per frame to keep it glued to the selection.
 */
export function createInteractionManager({
    canvas,
    scene,
    getCamera,
    getPickables,
    setMaterialState,
    isBusy = () => false,
    onSelect = () => {}
}) {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const scaleMatrix = new THREE.Matrix4().makeScale(
        OUTLINE_SCALE, OUTLINE_SCALE, OUTLINE_SCALE
    );

    let hovered = null;
    let selected = null;
    let enabled = true;
    let gizmoDragging = false;
    let pointerDown = null;

    const outline = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
            color: OUTLINE_COLOR,
            side: THREE.BackSide,
            transparent: true,
            opacity: 0.95,
            depthWrite: false
        })
    );
    outline.name = 'SelectionOutline';
    outline.matrixAutoUpdate = false;
    outline.visible = false;
    outline.raycast = () => {};
    scene.add(outline);

    function applyState(mesh, state) {
        if (mesh?.material) setMaterialState(mesh.material, state);
    }

    function refreshOutline() {
        if (!selected) return;
        outline.geometry = selected.geometry;
        outline.visible = true;
    }

    function hideOutline() {
        outline.visible = false;
        outline.geometry = new THREE.BufferGeometry();
    }

    function setHovered(mesh) {
        if (hovered === mesh) return;
        if (hovered && hovered !== selected) applyState(hovered, 'none');
        hovered = mesh;
        if (hovered && hovered !== selected) applyState(hovered, 'hover');
        canvas.style.cursor = hovered ? 'pointer' : '';
    }

    function setSelected(mesh, { notify = true } = {}) {
        if (selected === mesh) {
            if (notify && mesh) onSelect(selected);
            return;
        }
        if (selected) applyState(selected, 'none');
        hideOutline();
        selected = mesh;
        if (selected) {
            applyState(selected, 'selected');
            refreshOutline();
        }
        if (hovered && hovered !== selected) applyState(hovered, 'hover');
        if (notify) onSelect(selected);
    }

    function pick(event) {
        const bounds = canvas.getBoundingClientRect();
        pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
        pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
        raycaster.setFromCamera(pointer, getCamera());
        const pickables = getPickables().filter(mesh => mesh?.visible);
        const hits = raycaster.intersectObjects(pickables, false);
        return hits[0]?.object ?? null;
    }

    canvas.addEventListener('pointermove', event => {
        if (!enabled || gizmoDragging || isBusy()) return;
        // Any held button means the user is orbiting/panning, not picking.
        if (event.buttons !== 0) return;
        setHovered(pick(event));
    });

    canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        pointerDown = { x: event.clientX, y: event.clientY };
    });

    canvas.addEventListener('pointerup', event => {
        if (!enabled || gizmoDragging || isBusy()) { pointerDown = null; return; }
        if (event.button !== 0 || !pointerDown) return;
        const travel = Math.hypot(
            event.clientX - pointerDown.x,
            event.clientY - pointerDown.y
        );
        pointerDown = null;
        if (travel > CLICK_MAX_TRAVEL_PX) return;
        setSelected(pick(event));
    });

    canvas.addEventListener('pointerleave', () => setHovered(null));

    return {
        get selected() { return selected; },
        select: mesh => setSelected(mesh),
        deselect: () => setSelected(null),
        clearHover: () => setHovered(null),
        refreshOutline,

        /** Keep the outline glued to the selected mesh. Call every frame. */
        update() {
            if (!selected || !outline.visible) return;
            selected.updateMatrixWorld();
            outline.matrix.copy(selected.matrixWorld).multiply(scaleMatrix);
        },

        setGizmoDragging(value) {
            gizmoDragging = value;
            if (value) setHovered(null);
        },

        setEnabled(value) {
            enabled = value;
            if (!value) {
                setHovered(null);
                setSelected(null, { notify: false });
            }
        }
    };
}
