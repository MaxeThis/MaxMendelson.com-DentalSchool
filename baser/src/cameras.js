import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Tween, Easing } from './tween.js';
import { log } from './debug.js';

export function createCameraManager({ canvas, renderer, scene }) {
    const perspectiveCamera = new THREE.PerspectiveCamera(
        50,
        window.innerWidth / window.innerHeight,
        0.1,
        2000
    );
    perspectiveCamera.position.set(100, 100, 100);

    let orthoSpan = 120;
    const orthographicCamera = new THREE.OrthographicCamera(-60, 60, 60, -60, 0.1, 2000);
    orthographicCamera.position.set(0, 0, 100);

    let activeCamera = perspectiveCamera;
    let isOrthoView = false;
    let transformControls = null;
    let lastPointerButton = null;

    const controls = new OrbitControls(perspectiveCamera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 10;
    controls.maxDistance = 600;
    controls.target.set(0, 0, 0);

    function updateOrthoProjection(aspect = window.innerWidth / window.innerHeight) {
        orthographicCamera.left = -orthoSpan * aspect / 2;
        orthographicCamera.right = orthoSpan * aspect / 2;
        orthographicCamera.top = orthoSpan / 2;
        orthographicCamera.bottom = -orthoSpan / 2;
        orthographicCamera.updateProjectionMatrix();
    }
    updateOrthoProjection();

    function setTransformControls(nextTransformControls) {
        transformControls = nextTransformControls;
        transformControls.camera = activeCamera;
    }

    function setActiveCamera(toOrtho) {
        if (toOrtho === isOrthoView) return;
        isOrthoView = toOrtho;
        activeCamera = toOrtho ? orthographicCamera : perspectiveCamera;
        controls.object = activeCamera;
        controls.enableRotate = true;
        if (transformControls) transformControls.camera = activeCamera;
        renderer.render(scene, activeCamera);
        log(`[Camera] Switched to ${toOrtho ? 'orthographic' : 'perspective'}`);
    }

    function setCameraView(view) {
        const distance = Math.max(100, orthoSpan * 1.2);
        const currentPosition = activeCamera.position.clone();
        const currentTarget = controls.target.clone();
        const endTarget = currentTarget.clone();
        const endPosition = new THREE.Vector3();
        const endUp = new THREE.Vector3(0, 1, 0);
        const targetIsOrtho = view !== '3d';

        if (view === '3d') {
            const previous = perspectiveCamera.userData.lastPosition;
            if (Array.isArray(previous)) endPosition.fromArray(previous);
            else endPosition.set(endTarget.x + distance, endTarget.y + distance, endTarget.z + distance);
        } else {
            switch (view) {
                case 'front': endPosition.set(endTarget.x, endTarget.y, endTarget.z + distance); break;
                case 'back': endPosition.set(endTarget.x, endTarget.y, endTarget.z - distance); break;
                case 'left': endPosition.set(endTarget.x - distance, endTarget.y, endTarget.z); break;
                case 'right': endPosition.set(endTarget.x + distance, endTarget.y, endTarget.z); break;
                case 'top':
                    endPosition.set(endTarget.x, endTarget.y + distance, endTarget.z + 0.01);
                    endUp.set(0, 0, -1);
                    break;
                case 'bottom':
                    endPosition.set(endTarget.x, endTarget.y - distance, endTarget.z + 0.01);
                    endUp.set(0, 0, 1);
                    break;
                default: return;
            }
        }

        const animation = {
            x: currentPosition.x,
            y: currentPosition.y,
            z: currentPosition.z,
            tx: currentTarget.x,
            ty: currentTarget.y,
            tz: currentTarget.z
        };
        const target = {
            x: endPosition.x,
            y: endPosition.y,
            z: endPosition.z,
            tx: endTarget.x,
            ty: endTarget.y,
            tz: endTarget.z
        };

        if (targetIsOrtho && !isOrthoView) {
            new Tween(animation)
                .to(target, 500)
                .easing(Easing.Cubic.InOut)
                .onUpdate(() => {
                    perspectiveCamera.position.set(animation.x, animation.y, animation.z);
                    controls.target.set(animation.tx, animation.ty, animation.tz);
                    perspectiveCamera.lookAt(controls.target);
                })
                .onComplete(() => {
                    setActiveCamera(true);
                    orthographicCamera.position.copy(endPosition);
                    orthographicCamera.up.copy(endUp);
                    orthographicCamera.lookAt(endTarget);
                    orthographicCamera.zoom = 1;
                    orthographicCamera.updateProjectionMatrix();
                    controls.update();
                })
                .start();
            return;
        }

        if (!targetIsOrtho && isOrthoView) {
            setActiveCamera(false);
            perspectiveCamera.position.copy(currentPosition);
            perspectiveCamera.up.set(0, 1, 0);
        }

        new Tween(animation)
            .to(target, targetIsOrtho ? 500 : 800)
            .easing(Easing.Cubic.InOut)
            .onUpdate(() => {
                activeCamera.position.set(animation.x, animation.y, animation.z);
                controls.target.set(animation.tx, animation.ty, animation.tz);
                if (targetIsOrtho) {
                    activeCamera.up.copy(endUp);
                    activeCamera.lookAt(controls.target);
                }
            })
            .start();
    }

    // Capture pointerdown before OrbitControls. Three r160 listens to pointer
    // events, so doing this work on mousedown is too late at the pole views.
    canvas.addEventListener('pointerdown', event => {
        lastPointerButton = event.button;
        if (event.button !== 0 || Math.abs(activeCamera.up.y) >= 0.1) return;

        event.stopImmediatePropagation();
        const fromTop = activeCamera.position.y > controls.target.y;
        const distance = activeCamera.position.distanceTo(controls.target);
        const endPosition = new THREE.Vector3(
            controls.target.x + distance * 0.7,
            controls.target.y + (fromTop ? distance * 0.7 : -distance * 0.7),
            controls.target.z + distance * 0.7
        );
        perspectiveCamera.up.set(0, 1, 0);
        orthographicCamera.up.set(0, 1, 0);
        if (isOrthoView) {
            perspectiveCamera.position.copy(activeCamera.position);
            setActiveCamera(false);
        }

        const startPosition = perspectiveCamera.position.clone();
        const animation = { t: 0 };
        new Tween(animation)
            .to({ t: 1 }, 300)
            .easing(Easing.Cubic.Out)
            .onUpdate(() => {
                perspectiveCamera.position.lerpVectors(startPosition, endPosition, animation.t);
                perspectiveCamera.lookAt(controls.target);
            })
            .onComplete(() => controls.update())
            .start();
    }, true);
    window.addEventListener('pointerup', () => {
        lastPointerButton = null;
    });

    controls.addEventListener('start', () => {
        if (!isOrthoView || lastPointerButton !== 0) return;

        const direction = new THREE.Vector3()
            .subVectors(orthographicCamera.position, controls.target)
            .normalize();
        perspectiveCamera.position.copy(controls.target).add(direction.multiplyScalar(Math.max(100, orthoSpan)));
        if (Math.abs(direction.y) > 0.99) perspectiveCamera.position.z += 0.1;
        perspectiveCamera.up.set(0, 1, 0);
        perspectiveCamera.lookAt(controls.target);
        setActiveCamera(false);
    });

    controls.addEventListener('end', () => {
        if (!isOrthoView) {
            perspectiveCamera.userData.lastPosition = perspectiveCamera.position.toArray();
        }
    });

    function fitToObject(object, padding = 1.45) {
        object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z, 10);
        const fov = THREE.MathUtils.degToRad(perspectiveCamera.fov);
        const distance = (largest * padding) / (2 * Math.tan(fov / 2));
        const direction = new THREE.Vector3(1, 0.85, 1).normalize();

        controls.target.copy(center);
        perspectiveCamera.position.copy(center).add(direction.multiplyScalar(distance * 1.35));
        perspectiveCamera.near = Math.max(0.01, distance / 1000);
        perspectiveCamera.far = Math.max(2000, distance * 20);
        perspectiveCamera.updateProjectionMatrix();
        perspectiveCamera.lookAt(center);
        perspectiveCamera.userData.lastPosition = perspectiveCamera.position.toArray();
        orthoSpan = largest * padding;
        updateOrthoProjection();
        if (isOrthoView) setActiveCamera(false);
        controls.update();
    }

    function resize(width = window.innerWidth, height = window.innerHeight) {
        const aspect = width / height;
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix();
        updateOrthoProjection(aspect);
    }

    return {
        perspectiveCamera,
        orthographicCamera,
        controls,
        get activeCamera() { return activeCamera; },
        get isOrthoView() { return isOrthoView; },
        setTransformControls,
        setActiveCamera,
        setCameraView,
        fitToObject,
        resize,
        update: () => controls.update()
    };
}
