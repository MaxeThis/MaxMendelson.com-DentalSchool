function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}

function fingerprint(snapshot) {
    return JSON.stringify(snapshot);
}

export function createUndoManager({ capture, restore, maxSteps = 50, onChange = () => {} }) {
    let history = [];

    function reset(snapshot = capture()) {
        history = [cloneSnapshot(snapshot)];
        onChange(history.length);
    }

    function commit(snapshot = capture()) {
        const next = cloneSnapshot(snapshot);
        const previous = history.at(-1);
        if (previous && fingerprint(previous) === fingerprint(next)) return false;

        history.push(next);
        if (history.length > maxSteps) history.shift();
        onChange(history.length);
        return true;
    }

    function undo() {
        if (history.length < 2) return false;
        history.pop();
        restore(cloneSnapshot(history.at(-1)));
        onChange(history.length);
        return true;
    }

    return {
        reset,
        commit,
        undo,
        clear: () => { history = []; onChange(0); },
        get length() { return history.length; }
    };
}
