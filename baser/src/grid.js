import * as THREE from 'three';

/**
 * Single-quadrant measuring grid: graph paper in millimeters, labeled in
 * centimeters. One scene unit is one millimeter.
 *
 * The model and base are laid out with their combined footprint touching
 * the origin, spanning +X (width) and -Z (depth). In the top view, where
 * screen-up is -Z, the origin sits at the bottom-left: read the width on
 * the bottom ruler and the depth on the left ruler.
 *
 * - Minor lines every 1 mm (faint)
 * - Major lines every 10 mm = 1 cm (brighter)
 * - Axis lines through the origin (brightest)
 * - cm numerals along both rulers, plus a "cm" unit marker on each
 */

const GRID_COLORS = Object.freeze({
    minor: 0x2e5f9e,
    major: 0x5b8fd4,
    axis: 0x9dc4f5,
    label: '#a8c8f0',
    unit: '#f5d76e'
});

function buildQuadrantLines(extentX, extentZ, step, skipEvery) {
    const positions = [];
    const push = (x1, z1, x2, z2) => positions.push(x1, 0, z1, x2, 0, z2);
    const onSkip = value => skipEvery
        && Math.abs(Math.round(value / skipEvery) * skipEvery - value) < 1e-6;

    for (let x = 0; x <= extentX + 1e-6; x += step) {
        const snapped = Math.round(x / step) * step;
        if (onSkip(snapped)) continue;
        push(snapped, -extentZ, snapped, 0);
    }
    for (let z = 0; z <= extentZ + 1e-6; z += step) {
        const snapped = Math.round(z / step) * step;
        if (onSkip(snapped)) continue;
        push(0, -snapped, extentX, -snapped);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
}

function makeLabelMesh(text, worldHeight, color = GRID_COLORS.label) {
    const scale = 12;
    const probe = document.createElement('canvas').getContext('2d');
    const font = `600 ${10 * scale}px "Instrument Sans", "Avenir Next", sans-serif`;
    probe.font = font;
    const textWidth = Math.ceil(probe.measureText(text).width);

    const canvas = document.createElement('canvas');
    canvas.width = textWidth + 2 * scale;
    canvas.height = 12 * scale;
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide
    });
    material.userData.targetOpacity = 0.85;
    const aspect = canvas.width / canvas.height;
    const geometry = new THREE.PlaneGeometry(worldHeight * aspect, worldHeight);
    const mesh = new THREE.Mesh(geometry, material);
    // Lay flat on the ground plane. Plane-space +Y maps to world -Z, which
    // matches the top view's screen-up direction (camera up = (0, 0, -1)).
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
}

export function createMeasurementGrid({
    extentX = 170,
    extentZ = 170,
    labelEveryCm = 1,
    labelSize = 4.2
} = {}) {
    const group = new THREE.Group();
    group.name = 'MeasurementGrid';

    const makeLines = (geometry, color, opacity) => {
        const material = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false
        });
        material.userData.targetOpacity = opacity;
        const lines = new THREE.LineSegments(geometry, material);
        lines.renderOrder = -3;
        return lines;
    };

    group.add(makeLines(
        buildQuadrantLines(extentX, extentZ, 1, 10), GRID_COLORS.minor, 0.10
    ));
    group.add(makeLines(
        buildQuadrantLines(extentX, extentZ, 10, 0), GRID_COLORS.major, 0.32
    ));

    const axisGeometry = new THREE.BufferGeometry();
    axisGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0, extentX, 0, 0,
        0, 0, 0, 0, 0, -extentZ
    ], 3));
    group.add(makeLines(axisGeometry, GRID_COLORS.axis, 0.6));

    // Width ruler along the bottom edge (below the X axis on screen).
    const labelOffset = 6.5;
    const centimetersX = Math.floor(extentX / 10);
    for (let cm = labelEveryCm; cm <= centimetersX; cm += labelEveryCm) {
        const label = makeLabelMesh(String(cm), labelSize);
        label.position.set(cm * 10, 0.02, labelOffset);
        group.add(label);
    }

    // Depth ruler along the left edge.
    const centimetersZ = Math.floor(extentZ / 10);
    for (let cm = labelEveryCm; cm <= centimetersZ; cm += labelEveryCm) {
        const label = makeLabelMesh(String(cm), labelSize);
        label.position.set(-labelOffset, 0.02, -cm * 10);
        group.add(label);
    }

    // Unit markers, one per ruler, in accent yellow.
    const unitX = makeLabelMesh('cm', labelSize, GRID_COLORS.unit);
    unitX.position.set(extentX + labelOffset + 2, 0.02, labelOffset);
    group.add(unitX);

    const unitZ = makeLabelMesh('cm', labelSize, GRID_COLORS.unit);
    unitZ.position.set(-labelOffset, 0.02, -(extentZ + labelOffset + 2));
    group.add(unitZ);

    // Origin marker.
    const origin = makeLabelMesh('0', labelSize);
    origin.position.set(-labelOffset, 0.02, labelOffset);
    group.add(origin);

    return group;
}
