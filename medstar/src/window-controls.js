const DEBUG = false;
const log = (...args) => {
    if (DEBUG) console.log(...args);
};

let controlsInitialized = false;

async function runWindowAction(action, name) {
    try {
        await action();
    } catch (error) {
        if (DEBUG) console.error(`[Window Controls] ${name} failed`, error);
    }
}

function initializeWindowControls() {
    if (controlsInitialized) return;

    const tauriWindow = window.__TAURI__?.window?.appWindow;
    if (!tauriWindow) {
        document.body.classList.add('browser-mode');
        const titlebar = document.querySelector('.titlebar');
        if (titlebar) titlebar.hidden = true;
        log('[Window Controls] Browser mode');
        return;
    }

    controlsInitialized = true;
    document.body.classList.remove('browser-mode');

    const titlebar = document.querySelector('.titlebar');
    if (titlebar) titlebar.hidden = false;

    const minimizeButton = document.getElementById('titlebar-minimize');
    const maximizeButton = document.getElementById('titlebar-maximize');
    const closeButton = document.getElementById('titlebar-close');

    minimizeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runWindowAction(() => tauriWindow.minimize(), 'Minimize');
    });

    maximizeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runWindowAction(() => tauriWindow.toggleMaximize(), 'Toggle maximize');
    });

    closeButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runWindowAction(() => tauriWindow.close(), 'Close');
    });

    log('[Window Controls] Initialized');
}

document.addEventListener('DOMContentLoaded', initializeWindowControls, { once: true });
window.addEventListener('load', initializeWindowControls, { once: true });
