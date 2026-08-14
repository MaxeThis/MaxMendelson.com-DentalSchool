import { DEFAULT_BASE_PARAMS, normalizeBaseParams } from './base.js';
import { warn } from './debug.js';

const STORAGE_KEY = 'articulator-baser-settings-v2';
// The app was called something else before. Anyone who had set their
// preferences then keeps them, rather than being handed the defaults back.
const FORMER_STORAGE_KEY = 'medstar-base-settings-v2';

/**
 * Factory defaults. Footprint and height target the "large adult" size the
 * clinic needs so the printed base seats in articulator clamps; the wall
 * stays thin to save resin. Values in millimeters.
 */
export const FACTORY_SETTINGS = Object.freeze({
    width: DEFAULT_BASE_PARAMS.width,
    depth: DEFAULT_BASE_PARAMS.depth,
    height: DEFAULT_BASE_PARAMS.height,
    wall: DEFAULT_BASE_PARAMS.wall,
    hollow: DEFAULT_BASE_PARAMS.hollow,
    infill: DEFAULT_BASE_PARAMS.infill,
    clampBand: DEFAULT_BASE_PARAMS.clampBand,
    // When true the footprint grows beyond the defaults to cover an
    // oversized scan; the defaults act as the guaranteed minimum.
    autoGrow: true,
    // The cartoon greeter in the corner.
    showGreeter: true
});

function sanitize(raw) {
    const merged = { ...FACTORY_SETTINGS, ...(raw ?? {}) };
    const normalized = normalizeBaseParams(merged);
    return {
        width: normalized.width,
        depth: normalized.depth,
        height: normalized.height,
        wall: normalized.wall,
        infill: normalized.infill,
        clampBand: normalized.clampBand,
        hollow: Boolean(merged.hollow),
        autoGrow: Boolean(merged.autoGrow),
        showGreeter: Boolean(merged.showGreeter)
    };
}

export function loadSettings() {
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY)
            ?? window.localStorage?.getItem(FORMER_STORAGE_KEY);
        return sanitize(raw ? JSON.parse(raw) : null);
    } catch (error) {
        warn('[Settings] Could not read saved settings; using defaults.', error);
        return sanitize(null);
    }
}

export function saveSettings(settings) {
    const clean = sanitize(settings);
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch (error) {
        warn('[Settings] Could not persist settings.', error);
    }
    return clean;
}

export function resetSettings() {
    try {
        window.localStorage?.removeItem(STORAGE_KEY);
        window.localStorage?.removeItem(FORMER_STORAGE_KEY);
    } catch (error) {
        warn('[Settings] Could not clear settings.', error);
    }
    return sanitize(null);
}
