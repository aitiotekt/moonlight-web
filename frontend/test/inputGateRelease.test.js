/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The strip a native Windows host raises when an administrator window holds
 * back the viewer's presses, and its "Minimise the host's windows" button.
 *
 * The button is offered for both reasons (Bruno's decision of 22/10/2026):
 * "uipi", where Windows refuses everything and the pointer is stuck too, and
 * "policy", an invited player before an administrator window — where a game
 * run as administrator that fills the screen leaves nothing else to click.
 * The stylesheet had already shown it there since 0.3.1; the script says so.
 */

/** Minimal stand-in exposing just what _applyInputGate touches. */
function gateView() {
    return {
        _inputGateEl: { hidden: true },
        _inputGateTextEl: { textContent: '' },
        _inputGateReleaseEl: { hidden: true, disabled: true, textContent: '' },
        _inputGateHideTimer: null,
        _inputGateShownAt: 0,
        _applyInputGate: StreamView.prototype._applyInputGate,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the input gate strip', () => {
    for (const reason of ['uipi', 'policy']) {
        it(`offers the way out when the gate closes for "${reason}"`, () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const view = gateView();
            view._applyInputGate({ blocked: true, reason, window: '"Admin" (cmd.exe, pid 1)' });
            expect(view._inputGateEl.hidden).toBe(false);
            expect(view._inputGateReleaseEl.hidden).toBe(false);
            expect(view._inputGateReleaseEl.disabled).toBe(false);
        });
    }

    it('re-arms a button spent on an earlier press', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const view = gateView();
        view._inputGateReleaseEl.disabled = true;
        view._applyInputGate({ blocked: true, reason: 'policy', window: 'w' });
        expect(view._inputGateReleaseEl.disabled).toBe(false);
    });

    it('stays up a few seconds after the gate reopens, then hides with its button', () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const view = gateView();
        view._applyInputGate({ blocked: true, reason: 'policy', window: 'w' });
        view._applyInputGate({ blocked: false });
        expect(view._inputGateEl.hidden).toBe(false);
        vi.advanceTimersByTime(4100);
        expect(view._inputGateEl.hidden).toBe(true);
        expect(view._inputGateReleaseEl.hidden).toBe(true);
    });
});
