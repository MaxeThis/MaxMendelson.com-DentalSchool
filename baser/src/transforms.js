import { TransformControls } from 'three/addons/controls/TransformControls.js';

function hideTransformGizmoExtras(transformControls) {
    transformControls.showE = false;
    if (transformControls._helper) transformControls._helper.visible = false;
    if (transformControls.helper) transformControls.helper.visible = false;

    transformControls.traverse(object => {
        if (object.name === 'E' || object.name === 'XYZE') object.visible = false;
        if (object.name === 'XY' || object.name === 'XZ' || object.name === 'YZ') {
            object.visible = false;
        }
    });
}

export function createTransformManager({
    camera,
    canvas,
    scene,
    orbitControls,
    onDragStart = () => {},
    onDragEnd = () => {}
}) {
    const controls = new TransformControls(camera, canvas);
    controls.setMode('translate');
    controls.setSize(0.55);
    scene.add(controls);

    // The vertical arrow is hidden while translating (the layout auto-seats
    // everything on the grid) but Y must stay available as a rotation ring.
    let allowTranslateY = true;
    let rotateAllowed = true;

    // Deliberately run once at initialization. This traversal must never be
    // attached to TransformControls change/objectChange events.
    hideTransformGizmoExtras(controls);

    controls.addEventListener('dragging-changed', event => {
        orbitControls.enabled = !event.value;
        if (event.value) onDragStart();
        else onDragEnd();
    });

    function applyAxisVisibility() {
        controls.showX = true;
        controls.showZ = true;
        controls.showY = controls.mode === 'rotate' ? true : allowTranslateY;
    }

    function setMode(mode) {
        if (mode === 'rotate' && !rotateAllowed) return;
        controls.setMode(mode);
        applyAxisVisibility();
        hideTransformGizmoExtras(controls);
    }

    function attach(object, { allowY = true, translateOnly = false } = {}) {
        controls.attach(object);
        allowTranslateY = allowY;
        rotateAllowed = !translateOnly;
        if (translateOnly || controls.mode !== 'rotate') controls.setMode('translate');
        applyAxisVisibility();
        hideTransformGizmoExtras(controls);
        controls.visible = controls.enabled;
    }

    function detach() {
        controls.detach();
        controls.visible = false;
    }

    function setEnabled(enabled) {
        controls.enabled = enabled;
        // Never show a floating gizmo with nothing attached.
        controls.visible = enabled && Boolean(controls.object);
    }

    return {
        controls,
        setMode,
        attach,
        detach,
        setEnabled,
        setVisible: visible => { controls.visible = visible && Boolean(controls.object); }
    };
}
