import { isSupportedModelFile } from './importers.js';
import { INFILL_PATTERNS, cleanEngravedText, createBaseOutline } from './base.js';
import { engravingPreviewRectangles, engravingCapHeight, engravingIssue, measureOutline } from './infill.js';

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
    onViewLettering,
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
        wall: [$('base-wall'), $('base-wall-val')],
        clampBand: [$('base-clampband'), $('base-clampband-val')]
    };
    for (const [name, [rangeEl, numberEl]] of Object.entries(baseFields)) {
        bindField(rangeEl, numberEl, (value, commit) => {
            if (!suppressEvents) onBaseParam(name, value, commit);
        });
    }

    /**
     * Paint the shared track and say in words what the two handles mean.
     * The clamp band can never exceed the height it is measured inside, so
     * the lower handle stops where the upper one stands.
     */
    function paintHeightStack(height, clampBand) {
        const max = Number($('base-height').max) || 30;
        const band = Math.min(clampBand, height);
        $('dual-clamp').style.width = `${(band / max) * 100}%`;
        $('dual-wall').style.left = `${(band / max) * 100}%`;
        $('dual-wall').style.width = `${Math.max(0, (height - band) / max) * 100}%`;
        const open = Math.max(0, height - band - Number($('base-wall').value || 0));
        $('height-stack-legend').textContent = open > 0.05
            ? `${open.toFixed(1)} mm open wall`
            : 'no wall left to pattern';
    }

    // Repaint while a handle is moving, rather than waiting for the rebuild
    // to come back and tell us where things ended up.
    for (const id of ['base-height', 'base-clampband', 'base-wall']) {
        $(id).addEventListener('input', () => {
            const height = Number($('base-height').value);
            baseFields.clampBand[0].max = String(height);
            if (Number($('base-clampband').value) > height) {
                $('base-clampband').value = String(height);
                $('base-clampband-val').value = String(height);
            }
            paintHeightStack(height, Number($('base-clampband').value));
        });
    }
    $('base-hollow').addEventListener('change', event => {
        if (!suppressEvents) onBaseHollow(event.target.checked);
    });
    // Typing only changes the inexpensive SVG proof. A pause in typing must
    // never start a full mesh rebuild on the same thread as the next keypress.
    const textFields = [$('base-text-1'), $('base-text-2')];
    const textSize = $('base-text-size');
    const textAlign = $('base-text-align');
    let engravingDirty = false;
    let forceEngravingSync = true;
    let currentBaseParams = null;
    const engravingValues = () => ({ textSize: Number(textSize.value), textAlign: textAlign.value });
    function flushEngraving() {
        engravingDirty = false;
        onEngraving(textFields[0].value, textFields[1].value, engravingValues());
        const issue = currentBaseParams && engravingIssue(currentBaseParams, measureOutline(createBaseOutline(currentBaseParams)));
        $('engraving-edit-status').textContent = issue
            ? 'Adjust the label to fit before exporting.'
            : 'Applied to the plate. Export also applies any new edits.';
    }
    function discardEngravingDraft() {
        engravingDirty = false;
        forceEngravingSync = true;
        $('engraving-edit-status').textContent = 'Preview updates as you type. Press Enter or Apply lettering to update the plate.';
    }
    function paintEngraving(params) {
        if (!params) return;
        const svg = $('engraving-preview');
        svg.replaceChildren();
        const lines = [params.textLine1, params.textLine2].filter(Boolean);
        const outline = measureOutline(createBaseOutline(params));
        const cap = engravingCapHeight(params, lines.length);
        const width = outline.chordLength;
        const height = Math.max(10, params.clampBand);
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const issue = engravingIssue(params, outline);
        $('engraving-proof').classList.toggle('has-error', Boolean(issue));
        $('engraving-caption').textContent = !lines.length ? 'Your label, engraved into the back wall'
            : issue ? 'Adjust the label to fit before exporting'
                : `${cap.toFixed(1)} mm letters · 0.6 mm recessed · back wall`;
        if (!lines.length || issue) return;
        const strokes = document.createDocumentFragment();
        lines.forEach((line, index) => {
            const rowPitch = cap / 7;
            const columnPitch = Math.min(rowPitch, (width - 6) / (line.length * 6 - 1));
            const lineWidth = (line.length * 6 - 1) * columnPitch;
            const x = params.textAlign === 'left' ? 3 : params.textAlign === 'right'
                ? width - 3 - lineWidth : (width - lineWidth) / 2;
            const y = height - 1.5 - cap - (lines.length - index - 1) * (cap + 1);
            for (const stroke of engravingPreviewRectangles(line)) {
                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', String(x + stroke.x * columnPitch));
                rect.setAttribute('y', String(y + stroke.y * rowPitch));
                rect.setAttribute('width', String(stroke.width * columnPitch));
                rect.setAttribute('height', String(stroke.height * rowPitch));
                strokes.appendChild(rect);
            }
        });
        svg.appendChild(strokes);
    }
    function draftEngravingParams() {
        return { ...currentBaseParams, ...engravingValues(),
            textLine1: cleanEngravedText(textFields[0].value), textLine2: cleanEngravedText(textFields[1].value) };
    }
    function renderEngravingHint(text) {
        const hint = $('engraving-hint');
        hint.textContent = text;
        hint.hidden = !text;
    }
    function paintDraft() {
        if (!currentBaseParams) return;
        const draft = draftEngravingParams();
        paintEngraving(draft);
        renderEngravingHint(engravingIssue(draft, measureOutline(createBaseOutline(draft))));
    }
    function editEngraving() {
        if (suppressEvents) return;
        engravingDirty = true;
        paintDraft();
        $('engraving-edit-status').textContent = 'Preview only · press Enter or Apply lettering to update the plate.';
    }
    for (const field of textFields) {
        field.addEventListener('input', editEngraving);
        field.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                flushEngraving();
            }
        });
    }
    for (const field of [textSize, textAlign]) field.addEventListener('change', editEngraving);
    $('btn-apply-lettering').addEventListener('click', flushEngraving);
    $('btn-view-lettering').addEventListener('click', () => { flushEngraving(); onViewLettering(); });
    $('btn-wall-design').addEventListener('click', () => {
        settingsPanel.hidden = false;
        $('pattern-gallery').scrollIntoView({ block: 'nearest' });
    });

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
    const patternButtons = [];
    // Decorative silhouettes only; the actual cuts are built by infill.js.
    const previews = {
        solid: '<path d="M12 23H112" stroke-width="3" opacity=".35"/>',
        honeycomb: '<path d="m12 12 5-7h10l5 7-5 7H17Zm28 0 5-7h10l5 7-5 7H45Zm28 0 5-7h10l5 7-5 7H73Zm28 0 5-7h10l5 7-5 7h-10ZM26 32l5-7h10l5 7-5 7H31Zm28 0 5-7h10l5 7-5 7H59Zm28 0 5-7h10l5 7-5 7H87Z"/>',
        diamond: '<path d="m10 12 9-9 9 9-9 9Zm29 0 9-9 9 9-9 9Zm29 0 9-9 9 9-9 9Zm29 0 9-9 9 9-9 9ZM24 33l9-9 9 9-9 9Zm29 0 9-9 9 9-9 9Zm29 0 9-9 9 9-9 9Z"/>',
        chevron: '<path d="m9 29 10-15 10 15m9-15 10 15 10-15m9 15 10-15 10 15m9-15 10 15 10-15" fill="none" stroke-width="5"/>',
        wave: '<path d="M8 29c7 0 7-15 15-15s8 15 15 15m6-15c7 0 7 15 15 15s8-15 15-15m6 15c7 0 7-15 15-15s8 15 15 15" fill="none" stroke-width="5" stroke-linecap="round"/>',
        bars: '<path d="M15 8h14v28H15Zm27 0h14v28H42Zm27 0h14v28H69Zm27 0h14v28H96Z"/><path d="M22 8v28M49 8v28M76 8v28M103 8v28" stroke="var(--navy)" stroke-width="4"/>',
        wide: '<path d="M13 9h20v26H13Zm38 0h20v26H51Zm38 0h20v26H89Z"/>',
        text: '<text x="62" y="27" text-anchor="middle" font-family="monospace" font-size="12" stroke="none">MEDSTAR OMFS</text>'
    };
    for (const pattern of INFILL_PATTERNS) {
        const option = document.createElement('option');
        option.value = pattern.id;
        option.textContent = pattern.label;
        infillSelect.appendChild(option);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pattern-card';
        button.dataset.pattern = pattern.id;
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `${pattern.label}. ${pattern.description}`);
        button.innerHTML = `<svg viewBox="0 0 124 44" aria-hidden="true">${previews[pattern.id]}</svg><span class="pattern-name">${pattern.label}${pattern.fresh ? '<small>New</small>' : ''}</span>`;
        button.title = pattern.description;
        button.addEventListener('click', () => onSettingsChange({ infill: pattern.id }, true));
        $('pattern-gallery').appendChild(button);
        patternButtons.push(button);
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
        flushEngraving,
        discardEngravingDraft,

        showDropScreen() {
            engravingDirty = false;
            forceEngravingSync = true;
            currentBaseParams = null;
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
            currentBaseParams = { ...params };
            setField(...baseFields.width, params.width);
            setField(...baseFields.depth, params.depth);
            setField(...baseFields.height, params.height);
            setField(...baseFields.wall, params.wall);
            // The clamp band lives inside the height, so its handle can
            // never travel past it.
            baseFields.clampBand[0].max = String(params.height);
            setField(...baseFields.clampBand, params.clampBand);
            paintHeightStack(params.height, params.clampBand);
            $('base-hollow').checked = Boolean(params.hollow);
            if (!engravingDirty && (forceEngravingSync || document.activeElement !== textFields[0])) {
                textFields[0].value = params.textLine1 ?? '';
            }
            if (!engravingDirty && (forceEngravingSync || document.activeElement !== textFields[1])) {
                textFields[1].value = params.textLine2 ?? '';
            }
            if (!engravingDirty) {
                textSize.value = String(params.textSize ?? 4.2);
                textAlign.value = params.textAlign ?? 'center';
                paintEngraving(params);
                forceEngravingSync = false;
            } else paintDraft();
            suppressEvents = false;
        },

        setEngravingHint(text) {
            if (engravingDirty && currentBaseParams) {
                const draft = draftEngravingParams();
                text = engravingIssue(draft, measureOutline(createBaseOutline(draft)));
            }
            renderEngravingHint(text);
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
            for (const button of patternButtons) button.setAttribute('aria-pressed', String(button.dataset.pattern === settings.infill));
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
