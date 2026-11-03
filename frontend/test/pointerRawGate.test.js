/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * Every host gets the mouse at the device's own report rate (pointerrawupdate)
 * instead of once a frame: the native host and, since 13/10/2026, GameStream
 * hosts too. The diagnostics key mw_raw_pointer = '0' goes back to the frame
 * cadence.
 */
function view({ nativeHost, gaming = true }) {
    const sent = [];
    const v = {
        _nativeHost: nativeHost,
        _gamingMode: gaming,
        _mouseFocused: true,
        _mouseSensitivity: 1,
        _mouseCarryX: 0,
        _mouseCarryY: 0,
        _mainThreadProbe: null,
        inputEl: document.createElement('div'),
        _sendToHost: (msg) => sent.push(msg),
        _sendRelativeMouse: StreamView.prototype._sendRelativeMouse,
        _noteMouseSent: StreamView.prototype._noteMouseSent,
    };
    StreamView.prototype._bindPointerRaw.call(v);
    return { v, sent };
}

/** One raw mouse report, as Chromium dispatches it. */
function rawMove(el, dx, dy) {
    const e = new window.Event('pointerrawupdate');
    Object.assign(e, { pointerType: 'mouse', movementX: dx, movementY: dy });
    el.dispatchEvent(e);
}

describe('mouse at the report rate', () => {
    let log;
    beforeEach(() => {
        // jsdom has no pointerrawupdate; Chromium does.
        window.onpointerrawupdate = null;
        localStorage.removeItem('mw_raw_pointer');
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        delete window.onpointerrawupdate;
        localStorage.removeItem('mw_raw_pointer');
        log.mockRestore();
    });

    it('gives a GameStream host every report by default, and says so', () => {
        const { v, sent } = view({ nativeHost: false });
        expect(v._rawPointer).toBe(true);
        rawMove(v.inputEl, 3, -2);
        rawMove(v.inputEl, 1, 0);
        expect(sent).toEqual([
            { type: 'mousemove', dx: 3, dy: -2 },
            { type: 'mousemove', dx: 1, dy: 0 },
        ]);
        expect(log).toHaveBeenCalledWith(
            '[StreamView] Mouse: raw report rate (pointerrawupdate, GameStream host)',
        );
    });

    it('gives the native host every report by default', () => {
        expect(view({ nativeHost: true }).v._rawPointer).toBe(true);
    });

    it('goes back to the frame cadence under mw_raw_pointer=0, for every host', () => {
        localStorage.setItem('mw_raw_pointer', '0');
        for (const nativeHost of [true, false]) {
            const { v, sent } = view({ nativeHost });
            expect(v._rawPointer).toBe(false);
            rawMove(v.inputEl, 3, -2);
            expect(sent).toEqual([]);
        }
    });

    it('leaves a browser without the event at the frame cadence', () => {
        delete window.onpointerrawupdate;
        expect(view({ nativeHost: false }).v._rawPointer).toBe(false);
    });
});
