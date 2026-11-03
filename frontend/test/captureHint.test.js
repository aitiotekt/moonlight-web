/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The "click to capture" hint: up in gaming mode while the mouse is free,
 * never in desktop mode — where no click captures anything. Leaving gaming
 * mode releases the lock after the mode has changed, and that late
 * pointerlockchange put the hint back over the desktop-mode picture for good.
 */
function view({ gaming, locked }) {
    const inputEl = document.createElement('div');
    const hintEl = document.createElement('div');
    hintEl.style.display = 'flex';
    Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        get: () => (locked ? inputEl : null),
    });
    return {
        _gamingMode: gaming,
        inputEl,
        hintEl,
        _disarmPointerCapture() {},
        _syncKeyboardLock() {},
        _updateGamingOverlay() {},
        _sendCursorMode() {},
    };
}

describe('the click-to-capture hint', () => {
    afterEach(() => {
        delete document.pointerLockElement;
    });

    it('stays hidden when the lock goes after leaving gaming mode', () => {
        const v = view({ gaming: false, locked: false });
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('none');
    });

    it('comes back in gaming mode when the mouse is let go', () => {
        const v = view({ gaming: true, locked: false });
        v.hintEl.style.display = 'none';
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('flex');
    });

    it('goes when gaming mode takes the mouse', () => {
        const v = view({ gaming: true, locked: true });
        StreamView.prototype.handlePointerLockChange.call(v);
        expect(v.hintEl.style.display).toBe('none');
    });
});
