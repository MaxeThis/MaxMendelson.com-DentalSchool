import { isSupportedModelFile } from './importers.js';
import { INFILL_PATTERNS } from './base.js';

const $ = id => document.getElementById(id);

function syncRangeFill(range) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 100;
    const value = Number(range.value);
    const percent = ((value - min) / (max - min)) * 100;
    range.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
}

/**
 * Pair a range slider with its number box. `onValue(value, commit)` fires
 * with commit=false while sliding and commit=true on release/entry.
 */
function bindField(rangeEl, numberEl, onValue) {
    const parse = raw => {
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    };
    rangeEl.addEventListener('input', () => {
        numberEl.value = rangeEl.value;
        syncRangeFill(rangeEl);
        const value = parse(rangeEl.value);
        if (value !== null) onValue(value, false);
    });
    rangeEl.addEventListener('change', () => {
        const value = parse(rangeEl.value);
        if (value !== null) onValue(value, true);
    });
    numberEl.addEventListener('change', () => {
        const value = parse(numberEl.value);
        if (value === null) return;
        rangeEl.value = String(value);
        syncRangeFill(rangeEl);
        onValue(value, true);
    });
    numberEl.addEventListener('keydown', event => {
        if (event.key === 'Enter') numberEl.blur();
    });
}

function setField(rangeEl, numberEl, value, decimals = 1) {
    rangeEl.value = String(value);
    numberEl.value = String(Number(value.toFixed(decimals)));
    syncRangeFill(rangeEl);
}

export function createUI({
    onFile,
    onBaseParam,
    onBaseHollow,
    onEngraving,
    onFitBase,
    onModelRotate,
    onRecenter,
    onExport,
    onReset,
    onTopView,
    onSettingsChange,
    onSettingsReset,
    onInspectorClose
}) {
    const dropScreen = $('drop-screen');
    const actionBar = $('action-bar');
    const inspector = $('inspector');
    const inspectorTitle = $('inspector-title');
    const inspectorBase = $('inspector-base');
    const inspectorModel = $('inspector-model');
    const settingsPanel = $('settings-panel');
    const fileNameEl = $('file-name');
    const dimsEl = $('dims-readout');
    const toastEl = $('toast');
    const processingOverlay = $('processing-overlay');
    const processingStatus = $('processing-status');
    const exportBtn = $('btn-export');
    const exportLabel = exportBtn.querySelector('.btn-label');
    const resetBtn = $('btn-reset');
    const fileInput = $('file-input');

    let toastTimer = null;
    let suppressEvents = false;

    // ---------- File intake ----------

    $('btn-browse').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) intake(file);
    });

    function intake(file) {
        if (!isSupportedModelFile(file)) {
            toast('That file is not an STL or OBJ.');
            return;
        }
        onFile(file);
    }

    let dragDepth = 0;
    for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
        window.addEventListener(eventName, event => {
            event.preventDefault();
            event.stopPropagation();
        });
    }
    window.addEventListener('dragenter', () => {
        dragDepth += 1;
        document.body.classList.add('drag-active');
    });
    window.addEventListener('dragover', event => {
        event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.body.classList.remove('drag-active');
    });
    window.addEventListener('drop', event => {
        dragDepth = 0;
        document.body.classList.remove('drag-active');
        const file = event.dataTransfer?.files?.[0];
        if (file) intake(file);
    });

    // ---------- Inspector fields ----------

    const baseFields = {
        width: [$('base-width'), $('base-width-val')],
        depth: [$('base-depth'), $('base-depth-val')],
        height: [$('base-height'), $('base-height-val')],
        wall: [$('base-wall'), $('base-wall-val')]
    };
    for (const [name, [rangeEl, numberEl]] of Object.entries(baseFields)) {
        bindField(rangeEl, numberEl, (value, commit) => {
            if (!suppressEvents) onBaseParam(name, value, commit);
        });
    }
    $('base-hollow').addEventListener('change', event => {
        if (!suppressEvents) onBaseHollow(event.target.checked);
    });
    // Engraving. Typing repaints the wall, so the rebuild waits until the
    // user pauses rather than firing on every keystroke.
    const textFields = [$('base-text-1'), $('base-text-2')];
    let engravingTimer = null;
    for (const field of textFields) {
        field.addEventListener('input', () => {
            if (suppressEvents) return;
            if (engravingTimer) window.clearTimeout(engravingTimer);
            engravingTimer = window.setTimeout(() => {
                onEngraving(textFields[0].value, textFields[1].value);
            }, 400);
        });
        field.addEventListener('change', () => {
            if (suppressEvents) return;
            if (engravingTimer) window.clearTimeout(engravingTimer);
            onEngraving(textFields[0].value, textFields[1].value);
        });
    }

    $('btn-fit-base').addEventListener('click', () => onFitBase());

    const modelFields = {
        x: [$('model-rot-x'), $('model-rot-x-val')],
        y: [$('model-rot-y'), $('model-rot-y-val')],
        z: [$('model-rot-z'), $('model-rot-z-val')]
    };
    for (const [axis, [rangeEl, numberEl]] of Object.entries(modelFields)) {
        bindField(rangeEl, numberEl, (value, commit) => {
            if (!suppressEvents) onModelRotate(axis, value, commit);
        });
    }
    $('btn-recenter').addEventListener('click', () => onRecenter());
    $('btn-inspector-close').addEventListener('click', () => onInspectorClose());

    // ---------- Settings ----------

    const settingFields = {
        width: [$('setting-width'), $('setting-width-val')],
        depth: [$('setting-depth'), $('setting-depth-val')],
        height: [$('setting-height'), $('setting-height-val')],
        wall: [$('setting-wall'), $('setting-wall-val')],
        clampBand: [$('setting-clampband'), $('setting-clampband-val')]
    };

    const infillSelect = $('setting-infill');
    for (const pattern of INFILL_PATTERNS) {
        const option = document.createElement('option');
        option.value = pattern.id;
        option.textContent = pattern.label;
        infillSelect.appendChild(option);
    }
    infillSelect.addEventListener('change', event => {
        if (!suppressEvents) onSettingsChange({ infill: event.target.value }, true);
    });
    for (const [name, [rangeEl, numberEl]] of Object.entries(settingFields)) {
        bindField(rangeEl, numberEl, (value, commit) => {
            if (!suppressEvents) onSettingsChange({ [name]: value }, commit);
        });
    }
    $('setting-hollow').addEventListener('change', event => {
        if (!suppressEvents) onSettingsChange({ hollow: event.target.checked }, true);
    });
    $('setting-autogrow').addEventListener('change', event => {
        if (!suppressEvents) onSettingsChange({ autoGrow: event.target.checked }, true);
    });
    $('setting-greeter').addEventListener('change', event => {
        if (!suppressEvents) onSettingsChange({ showGreeter: event.target.checked }, true);
    });
    $('btn-settings-reset').addEventListener('click', () => onSettingsReset());

    $('btn-settings').addEventListener('click', () => {
        settingsPanel.hidden = !settingsPanel.hidden;
    });
    $('btn-settings-close').addEventListener('click', () => {
        settingsPanel.hidden = true;
    });

    // ---------- Actions ----------

    exportBtn.addEventListener('click', () => onExport());
    resetBtn.addEventListener('click', () => onReset());
    $('btn-top-view').addEventListener('click', () => onTopView());

    // ---------- Public API ----------

    function toast(message, duration = 3200) {
        toastEl.textContent = message;
        toastEl.hidden = false;
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, duration);
    }

    return {
        toast,

        showDropScreen() {
            document.body.classList.remove('has-model');
            const card = dropScreen.querySelector('.drop-card');
            card.classList.remove('leaving');
            dropScreen.hidden = false;
            // Restart the entrance animation.
            card.style.animation = 'none';
            void card.offsetWidth;
            card.style.animation = '';
            actionBar.hidden = true;
            inspector.hidden = true;
        },

        showWorkspace(filename) {
            document.body.classList.add('has-model');
            const card = dropScreen.querySelector('.drop-card');
            card.classList.add('leaving');
            window.setTimeout(() => {
                if (card.classList.contains('leaving')) dropScreen.hidden = true;
            }, 330);
            actionBar.hidden = false;
            fileNameEl.textContent = filename;
        },

        setDims(text) {
            dimsEl.textContent = text;
        },

        /** kind: null | 'model' | 'base' */
        setSelection(kind) {
            if (!kind) {
                inspector.hidden = true;
                return;
            }
            inspector.hidden = false;
            inspectorTitle.textContent = kind === 'base' ? 'Base plate' : 'Model';
            inspectorBase.hidden = kind !== 'base';
            inspectorModel.hidden = kind !== 'model';
        },

        /**
         * Raise the floor on the base size sliders so they physically stop
         * where the scan stops. `limits` is { width, depth } in mm.
         */
        setBaseFloors(limits) {
            for (const [name, floor] of Object.entries(limits)) {
                const field = baseFields[name];
                if (!field) continue;
                const [rangeEl, numberEl] = field;
                const value = String(Math.max(0, floor));
                rangeEl.min = value;
                numberEl.min = value;
                if (Number(rangeEl.value) < floor) {
                    rangeEl.value = value;
                    numberEl.value = value;
                    syncRangeFill(rangeEl);
                }
            }
        },

        syncBaseControls(params) {
            suppressEvents = true;
            setField(...baseFields.width, params.width);
            setField(...baseFields.depth, params.depth);
            setField(...baseFields.height, params.height);
            setField(...baseFields.wall, params.wall);
            $('base-hollow').checked = Boolean(params.hollow);
            if (document.activeElement !== textFields[0]) {
                textFields[0].value = params.textLine1 ?? '';
            }
            if (document.activeElement !== textFields[1]) {
                textFields[1].value = params.textLine2 ?? '';
            }
            suppressEvents = false;
        },

        setEngravingHint(text) {
            const hint = $('engraving-hint');
            hint.textContent = text;
            hint.hidden = !text;
        },

        syncModelRotation(degrees) {
            suppressEvents = true;
            setField(...modelFields.x, degrees.x, 0);
            setField(...modelFields.y, degrees.y, 0);
            setField(...modelFields.z, degrees.z, 0);
            suppressEvents = false;
        },

        syncSettings(settings) {
            suppressEvents = true;
            setField(...settingFields.width, settings.width);
            setField(...settingFields.depth, settings.depth);
            setField(...settingFields.height, settings.height);
            setField(...settingFields.wall, settings.wall);
            setField(...settingFields.clampBand, settings.clampBand);
            infillSelect.value = settings.infill;
            $('setting-hollow').checked = Boolean(settings.hollow);
            $('setting-autogrow').checked = Boolean(settings.autoGrow);
            $('setting-greeter').checked = Boolean(settings.showGreeter);
            suppressEvents = false;
        },

        setInfillHint(text) {
            const hint = $('infill-hint');
            hint.textContent = text;
            hint.hidden = !text;
        },

        isSettingsOpen: () => !settingsPanel.hidden,
        closeSettings() { settingsPanel.hidden = true; },

        /** state: 'ready' | 'busy' | 'exported' */
        setExportState(state) {
            exportBtn.disabled = state === 'busy';
            if (state === 'exported') {
                exportLabel.textContent = 'Export again';
                exportBtn.classList.remove('btn-primary');
                exportBtn.classList.add('btn-ghost');
                resetBtn.classList.remove('btn-ghost');
                resetBtn.classList.add('btn-primary');
            } else {
                exportLabel.textContent = 'Export STL';
                exportBtn.classList.add('btn-primary');
                exportBtn.classList.remove('btn-ghost');
                resetBtn.classList.add('btn-ghost');
                resetBtn.classList.remove('btn-primary');
            }
        },

        showProcessing(text) {
            processingStatus.textContent = text;
            processingOverlay.hidden = false;
        },

        updateProcessing(text) {
            processingStatus.textContent = text;
        },

        hideProcessing() {
            processingOverlay.hidden = true;
        }
    };
}
