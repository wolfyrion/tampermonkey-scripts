// ==UserScript==
// @name         noVNC Paste for Proxmox
// @namespace    https://github.com/wolfyrion
// @version      4.1
// @description  When PASTE ON, right-click the Proxmox noVNC console to type your PC's clipboard into the VM
// @author       Wolfyrion
// @homepageURL  https://github.com/wolfyrion/tampermonkey-scripts
// @supportURL   https://github.com/wolfyrion/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/wolfyrion/tampermonkey-scripts/main/novnc-paste-proxmox/novnc-paste-proxmox.user.js
// @downloadURL  https://raw.githubusercontent.com/wolfyrion/tampermonkey-scripts/main/novnc-paste-proxmox/novnc-paste-proxmox.user.js
// @include      /^https:\/\/[^\/]+:8006\/.*$/
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Only run on the noVNC console page (iframe or popup), not the main PVE UI.
    const isNoVNC = new URLSearchParams(location.search).get('novnc') === '1'
        || document.getElementById('noVNC_container');
    if (!isNoVNC) return;

    // -------------------------------------------------------
    // Configuration
    // -------------------------------------------------------
    const CFG = {
        keyDelay: 5,           // ms between keydown and keyup
        charDelay: 10,         // ms between characters (raise if the VM drops chars)
        confirmAbove: 2000,    // ask before typing more characters than this
        normalizeUnicode: true // convert smart quotes/dashes/nbsp to ASCII
    };

    // -------------------------------------------------------
    // State
    // -------------------------------------------------------
    let pasteMode = GM_getValue('pasteMode', true);
    let busy = false;
    let cancelRequested = false;
    let statusEl = null;
    let statusTimer = null;
    let indicatorEl = null;

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const BOX_STYLE = {
        position: 'fixed', right: '20px', color: '#fff', borderRadius: '8px',
        fontFamily: 'Arial, sans-serif', fontSize: '13px', zIndex: '9999999',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
    };

    // -------------------------------------------------------
    // UI: status message
    // -------------------------------------------------------
    function showStatus(msg, isError = false, sticky = false) {
        if (!statusEl) {
            statusEl = document.createElement('div');
            Object.assign(statusEl.style, BOX_STYLE, {
                bottom: '60px', padding: '8px 14px', maxWidth: '380px',
                wordBreak: 'break-word', pointerEvents: 'none',
                transition: 'opacity 0.3s ease'
            });
            document.body.appendChild(statusEl);
        }
        clearTimeout(statusTimer);
        statusEl.textContent = msg;
        statusEl.style.backgroundColor = isError ? '#d32f2f' : '#1976d2';
        statusEl.style.opacity = '0.95';
        if (!sticky) {
            statusTimer = setTimeout(() => { statusEl.style.opacity = '0'; },
                isError ? 8000 : 2500);
        }
    }

    // -------------------------------------------------------
    // UI: ON/OFF badge
    // -------------------------------------------------------
    function renderIndicator() {
        if (!indicatorEl) {
            indicatorEl = document.createElement('div');
            Object.assign(indicatorEl.style, BOX_STYLE, {
                bottom: '20px', padding: '7px 12px', fontWeight: 'bold',
                cursor: 'pointer', userSelect: 'none', opacity: '0.9'
            });
            indicatorEl.title = 'Click or Alt+P to toggle. When ON, right-click the console to paste.';
            indicatorEl.addEventListener('click', () => setPasteMode(!pasteMode));
            document.body.appendChild(indicatorEl);
        }
        indicatorEl.textContent = pasteMode ? 'PASTE ON' : 'PASTE OFF';
        indicatorEl.style.backgroundColor = pasteMode ? '#388e3c' : '#d32f2f';
    }

    function setPasteMode(value) {
        pasteMode = value;
        GM_setValue('pasteMode', value);
        renderIndicator();
        showStatus(`Paste Mode: ${value ? 'ON' : 'OFF'}`);
    }

    GM_addValueChangeListener('pasteMode', (_k, _old, value, remote) => {
        if (remote) { pasteMode = value; renderIndicator(); }
    });

    // -------------------------------------------------------
    // noVNC canvas
    // -------------------------------------------------------
    function getCanvas() {
        return document.querySelector('#noVNC_container canvas')
            || document.querySelector('#noVNC_canvas');
    }

    function isConsoleCanvas(target) {
        return target instanceof HTMLCanvasElement && target === getCanvas();
    }

    // -------------------------------------------------------
    // Keyboard simulation
    // -------------------------------------------------------
    function fire(target, type, init) {
        target.dispatchEvent(new KeyboardEvent(type, {
            bubbles: true, cancelable: true, composed: true, ...init
        }));
    }

    async function tap(target, init) {
        fire(target, 'keydown', init);
        await sleep(CFG.keyDelay);
        fire(target, 'keyup', init);
    }

    const SPECIAL = {
        '\n': { key: 'Enter', code: 'Enter' },
        '\t': { key: 'Tab', code: 'Tab' }
    };

    // Characters that need Shift on a US layout (otherwise "!" arrives as "1").
    const SHIFT_CHARS = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const SHIFT = { key: 'Shift', code: 'ShiftLeft' };

    // Make sure the VM doesn't think a modifier is still held down.
    const MODIFIERS = [
        ['Shift', 'ShiftLeft'], ['Shift', 'ShiftRight'],
        ['Control', 'ControlLeft'], ['Control', 'ControlRight'],
        ['Alt', 'AltLeft'], ['AltGraph', 'AltRight'],
        ['Meta', 'MetaLeft'], ['Meta', 'MetaRight']
    ];

    function releaseModifiers(target) {
        for (const [key, code] of MODIFIERS) fire(target, 'keyup', { key, code });
    }

    async function typeChar(target, c) {
        if (!SHIFT_CHARS.has(c)) {
            await tap(target, { key: c });
            return;
        }
        fire(target, 'keydown', { ...SHIFT, shiftKey: true });
        await sleep(CFG.keyDelay);
        try {
            await tap(target, { key: c, shiftKey: true });
            await sleep(CFG.keyDelay);
        } finally {
            fire(target, 'keyup', SHIFT);
        }
    }

    function normalize(text) {
        text = text.replace(/\r\n?/g, '\n');
        if (CFG.normalizeUnicode) {
            text = text
                .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
                .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
                .replace(/[\u2013\u2014\u2212]/g, '-')
                .replace(/\u2026/g, '...')
                .replace(/[\u00A0\u2007\u202F]/g, ' ')
                .replace(/[\u200B\uFEFF]/g, '');
        }
        return text;
    }

    async function typeText(raw) {
        const target = getCanvas();
        if (!target) {
            showStatus('noVNC console not found. Is the VM console connected?', true);
            return;
        }

        const chars = Array.from(normalize(raw));
        const total = chars.length;
        if (!total) {
            showStatus('Clipboard is empty.', true);
            return;
        }
        if (total > CFG.confirmAbove &&
            !confirm(`Type ${total} characters into the VM?\n(Press Esc to cancel while typing.)`)) {
            return;
        }

        busy = true;
        cancelRequested = false;
        target.focus();
        await sleep(50);
        releaseModifiers(target);
        await sleep(30);

        try {
            for (let i = 0; i < total; i++) {
                if (cancelRequested) {
                    showStatus(`Cancelled after ${i}/${total} characters.`, true);
                    return;
                }
                const c = chars[i];
                if (SPECIAL[c]) {
                    await tap(target, SPECIAL[c]);
                } else if (c >= ' ') {
                    await typeChar(target, c);
                } // other control characters are skipped

                if (i % 25 === 24) {
                    showStatus(`Typing... ${i + 1}/${total} (Esc to cancel)`, false, true);
                }
                await sleep(CFG.charDelay);
            }
            showStatus(`Pasted ${total} characters.`);
        } catch (err) {
            console.error('[noVNC Paste]', err);
            showStatus(`Paste failed: ${err.message || err}`, true);
        } finally {
            busy = false;
        }
    }

    // -------------------------------------------------------
    // Read the PC clipboard
    // -------------------------------------------------------
    async function explainFailure(err) {
        let state = null;
        try {
            state = (await navigator.permissions.query({ name: 'clipboard-read' })).state;
        } catch (_) { /* Firefox doesn't support this query */ }

        if (state === 'denied') {
            return 'The browser has clipboard access BLOCKED for this site. ' +
                'Click the icon left of the address bar → Site settings → Clipboard → Allow, ' +
                'then close and reopen the console.';
        }
        if (!document.hasFocus()) {
            return 'The console did not have focus. Left-click inside the console once, then right-click again.';
        }
        return `Browser said: ${(err && err.message) || err}`;
    }

    async function pasteFromClipboard() {
        if (busy) {
            showStatus('Paste already in progress.', true);
            return;
        }
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            showStatus('This browser does not allow reading the clipboard here.', true);
            return;
        }

        getCanvas()?.focus();
        window.focus();

        let text;
        try {
            showStatus('Reading clipboard... (click Allow if the browser asks)', false, true);
            text = await navigator.clipboard.readText();
        } catch (err) {
            console.warn('[noVNC Paste] Clipboard read failed:', err);
            showStatus(await explainFailure(err), true);
            return;
        }

        await typeText(text); // paste exactly what was copied (no trim)
    }

    // -------------------------------------------------------
    // Right-click = paste (when PASTE ON). Window capture runs before noVNC.
    // -------------------------------------------------------
    function onMouse(e) {
        if (!pasteMode || e.button !== 2 || !isConsoleCanvas(e.target)) return;

        // The VM never sees this right-click. mousedown is NOT preventDefault'ed,
        // so the browser still gives the console focus (needed to read the clipboard).
        e.stopImmediatePropagation();

        if (e.type === 'mouseup') {
            e.preventDefault();
            pasteFromClipboard();
        }
    }

    ['pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach(type =>
        window.addEventListener(type, onMouse, true));

    window.addEventListener('contextmenu', e => {
        if (pasteMode && isConsoleCanvas(e.target)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // -------------------------------------------------------
    // Keyboard: Alt+P toggle, Esc cancel, block real typing while pasting
    // -------------------------------------------------------
    window.addEventListener('keydown', e => {
        if (!e.isTrusted) return; // ignore our own synthetic events

        if (busy && e.key === 'Escape') {
            cancelRequested = true;
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }

        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyP') {
            e.preventDefault();
            e.stopImmediatePropagation();
            setPasteMode(!pasteMode);
            return;
        }

        if (busy && isConsoleCanvas(e.target)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // -------------------------------------------------------
    // Init
    // -------------------------------------------------------
    renderIndicator();
    showStatus(`noVNC Paste loaded - ${pasteMode ? 'ON' : 'OFF'}`);
    console.log('[noVNC Paste] Loaded. Paste Mode:', pasteMode ? 'ON' : 'OFF');
})();