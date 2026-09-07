import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { log, warn } from './debug.js';

const stlExporter = new STLExporter();

export function createBinarySTL(mesh) {
    const position = mesh?.geometry?.getAttribute('position');
    if (!position || (mesh.geometry.index?.count ?? position.count) < 3) {
        throw new Error('The model has no geometry to export.');
    }
    for (const value of position.array) {
        if (!Number.isFinite(value)) throw new Error('The model contains invalid coordinates.');
    }

    mesh.updateMatrixWorld(true);
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);

    // Keep the source app's matching export correction: imports are shown at
    // -90 degrees X, then exported at +90 degrees X for slicer orientation.
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    try {
        const exportMesh = new THREE.Mesh(geometry, mesh.material);
        return stlExporter.parse(exportMesh, { binary: true });
    } finally {
        geometry.dispose();
    }
}

export function binaryResultToBytes(result) {
    if (result instanceof DataView) {
        return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    }
    if (result instanceof ArrayBuffer) return new Uint8Array(result);
    if (ArrayBuffer.isView(result)) {
        return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    }
    return new TextEncoder().encode(String(result));
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.hidden = true;
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(url);
    }, 60_000);
}

export async function exportSTL(mesh, {
    suggestedName = `articulator_base_${Date.now()}.stl`,
    onStatus = () => {},
    oneClick = false
} = {}) {
    onStatus('Generating STL file...');
    const result = createBinarySTL(mesh);
    const bytes = binaryResultToBytes(result);
    if (!bytes.byteLength) throw new Error('Generated STL file is empty.');
    const blob = new Blob([bytes], { type: 'model/stl' });

    // One-click mode: no pickers, no prompts — straight to the browser's
    // download folder with the suggested name.
    if (oneClick && !window.__TAURI__) {
        downloadBlob(blob, suggestedName);
        log('[Export] One-click download started.');
        onStatus('STL downloaded.');
        return { method: 'download', filename: suggestedName, bytes: bytes.byteLength };
    }

    if (window.__TAURI__) {
        try {
            const { dialog, fs } = window.__TAURI__;
            const filePath = await dialog.save({
                defaultPath: suggestedName,
                filters: [{ name: 'STL Model', extensions: ['stl'] }]
            });
            if (!filePath) {
                onStatus('Export cancelled.');
                return { method: 'cancelled' };
            }
            await fs.writeBinaryFile(filePath, bytes);
            onStatus('STL saved successfully!');
            return { method: 'tauri', filePath, bytes: bytes.byteLength };
        } catch (error) {
            warn('[Export] Tauri save failed; using browser fallback.', error);
        }
    }

    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'Stereolithography File',
                    accept: { 'model/stl': ['.stl'] }
                }]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            onStatus('STL saved successfully!');
            return { method: 'file-system-access', bytes: bytes.byteLength };
        } catch (error) {
            if (error.name === 'AbortError') {
                onStatus('Export cancelled.');
                return { method: 'cancelled' };
            }
            warn('[Export] Save picker failed; using download fallback.', error);
        }
    }

    const requestedName = window.prompt?.('Enter filename to save:', suggestedName);
    if (!requestedName) {
        onStatus('Export cancelled.');
        return { method: 'cancelled' };
    }
    const filename = requestedName.toLowerCase().endsWith('.stl')
        ? requestedName
        : `${requestedName}.stl`;
    downloadBlob(blob, filename);
    log('[Export] Browser download started.');
    onStatus('STL exported successfully!');
    return { method: 'download', filename, bytes: bytes.byteLength };
}
