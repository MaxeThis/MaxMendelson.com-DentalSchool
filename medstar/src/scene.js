import * as THREE from 'three';
import { createMeasurementGrid } from './grid.js';
import { Tween, Easing } from './tween.js';

export const MEDSTAR_COLORS = Object.freeze({
    navy: 0x002664,
    yellow: 0xFCD900,
    blue: 0x007DAC,
    backgroundTop: 0x0a2350,
    backgroundBottom: 0x030d24
});

// Hover/select emissive treatment, tuned per material below.
const HOVER_EMISSIVE_INTENSITY = 0.35;
const SELECT_EMISSIVE_INTENSITY = 0.55;

export function createScene(canvas) {
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);

    // Background is a CSS radial gradient behind the transparent canvas so
    // the deep blue reads with depth instead of one flat tone.
    const scene = new THREE.Scene();

    // Neutral studio lighting: cool ambient bounce, one warm-white key,
    // soft fill, and a cool rim so shapes stay readable while orbiting.
    scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x0d234a, 0.85));

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(60, 110, 70);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdfe9ff, 0.45);
    fillLight.position.set(-70, 40, -30);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0x9cc3ff, 0.5);
    rimLight.position.set(-20, 60, -90);
    scene.add(rimLight);

    // The graph paper stays hidden on the drop screen and fades in with
    // the first import.
    const grid = createMeasurementGrid();
    grid.position.y = 0;
    grid.visible = false;
    scene.add(grid);

    let gridProgress = 0;
    function applyGridProgress(progress) {
        gridProgress = progress;
        grid.visible = progress > 0.001;
        grid.traverse(object => {
            const material = object.material;
            if (!material?.userData) return;
            const target = material.userData.targetOpacity;
            if (typeof target === 'number') material.opacity = target * progress;
        });
    }

    function setGridShown(shown, { animate = true, duration = 750 } = {}) {
        const end = shown ? 1 : 0;
        if (!animate) {
            applyGridProgress(end);
            return;
        }
        const animation = { t: gridProgress };
        new Tween(animation)
            .to({ t: end }, duration)
            .easing(Easing.Cubic.InOut)
            .onUpdate(() => applyGridProgress(animation.t))
            .start();
    }

    const materials = {
        model: new THREE.MeshStandardMaterial({
            color: 0xf3eee3,
            metalness: 0.02,
            roughness: 0.58,
            emissive: 0x000000,
            side: THREE.DoubleSide
        }),
        base: new THREE.MeshStandardMaterial({
            color: MEDSTAR_COLORS.blue,
            metalness: 0.05,
            roughness: 0.38,
            emissive: 0x000000
        })
    };
    materials.model.userData.highlight = new THREE.Color(0x2b2b1f);
    materials.base.userData.highlight = new THREE.Color(0x0e3f56);

    /**
     * Interaction states drive a subtle emissive lift, like Blender's
     * hover/active shading. state: 'none' | 'hover' | 'selected'.
     */
    function setMaterialState(material, state) {
        if (!material?.userData?.highlight) return;
        if (state === 'hover') {
            material.emissive.copy(material.userData.highlight);
            material.emissiveIntensity = HOVER_EMISSIVE_INTENSITY;
        } else if (state === 'selected') {
            material.emissive.copy(material.userData.highlight);
            material.emissiveIntensity = SELECT_EMISSIVE_INTENSITY;
        } else {
            material.emissive.setHex(0x000000);
            material.emissiveIntensity = 1;
        }
    }

    function resize(width = window.innerWidth, height = window.innerHeight) {
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    return { renderer, scene, grid, materials, setMaterialState, setGridShown, resize };
}
