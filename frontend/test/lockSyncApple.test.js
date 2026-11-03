/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The lock state the page sends with the first key of a session, for the PC
 * to take on.
 *
 * An Apple keyboard has no NumLock: its keypad always types digits, which is
 * NumLock on at the PC. Sent as off, now that the host's NumLock sync works
 * (26/10/2026), the PC's NumLock would go off at the first key and its keypad
 * type arrows.
 */
function sink(apple) {
    const sent = [];
    return {
        sent,
        _appleKeyboard: apple,
        _locksSynced: false,
        webrtc: { send: (m) => sent.push(m) },
        _syncLockState: StreamView.prototype._syncLockState,
    };
}

/** A keydown whose lock keys read as `locks` says. */
function key(code, locks = {}) {
    return { code, getModifierState: (name) => !!locks[name] };
}

describe('lock sync', () => {
    it('from an Apple keyboard, NumLock is on, whatever the browser reads', () => {
        const v = sink(true);
        v._syncLockState(key('KeyA'));
        expect(v.sent).toEqual([
            { type: 'locksync', numLock: true, capsLock: false, scrollLock: false },
        ]);
        expect(v._locksSynced).toBe(true);
    });

    it('an Apple keyboard still sends its Caps Lock as it is', () => {
        const v = sink(true);
        v._syncLockState(key('KeyA', { CapsLock: true }));
        expect(v.sent[0]).toMatchObject({ numLock: true, capsLock: true });
    });

    it("an Apple keyboard's Clear key first: on after its own toggle", () => {
        // Clear is the NumLock code there; the PC takes the press as a toggle
        // after the sync, so the sync sends the state before it.
        const v = sink(true);
        v._syncLockState(key('NumLock'));
        expect(v.sent[0].numLock).toBe(false);
    });

    it('any other keyboard sends its own NumLock, off or on', () => {
        const off = sink(false);
        off._syncLockState(key('KeyA'));
        expect(off.sent[0].numLock).toBe(false);
        const on = sink(false);
        on._syncLockState(key('KeyA', { NumLock: true }));
        expect(on.sent[0].numLock).toBe(true);
    });

    it('its NumLock key first: the state before the toggle the PC will make', () => {
        const v = sink(false);
        v._syncLockState(key('NumLock', { NumLock: true }));
        expect(v.sent[0].numLock).toBe(false);
    });
});
