/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonlightApp } from '../js/app.js';

/**
 * A standby the host answered as streaming, and that never showed a picture.
 *
 * Issue #36 (Sunshine, 0.4.0): the congestion ladder opened a standby session
 * for its lower quality; the host said "streaming", sent nothing, and the page
 * then tore the live stream down to apply the step the classic way. From then
 * on every resume of that app got no picture until it was quit on the host.
 * Now the live stream keeps playing at the quality it has, the host is kept to
 * one session, and the backend is told so through the standby's /quit.
 */

function view() {
    return { quit: vi.fn(async () => {}) };
}

let saved;

beforeEach(() => {
    saved = {
        streamView: MoonlightApp.streamView,
        _standbyView: MoonlightApp._standbyView,
        _standbyResult: MoonlightApp._standbyResult,
        _standbyTimer: MoonlightApp._standbyTimer,
        _dualSupported: MoonlightApp._dualSupported,
        _lastStreamingSettings: MoonlightApp._lastStreamingSettings,
        _degradeOverrides: MoonlightApp._degradeOverrides,
        _degradeLevel: MoonlightApp._degradeLevel,
        _originalStreamHeight: MoonlightApp._originalStreamHeight,
        _liveQuality: MoonlightApp._liveQuality,
    };
    vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(MoonlightApp, saved);
});

/** A live stream at 1440p, then the ladder's first step written and a standby up. */
function standbyForAStep() {
    const live = view();
    const standby = view();
    MoonlightApp.streamView = live;
    MoonlightApp._lastStreamingSettings = { stream_height: 1440, stream_bitrate: 80000 };
    MoonlightApp._degradeOverrides = {};
    MoonlightApp._degradeLevel = 0;
    MoonlightApp._originalStreamHeight = undefined;
    MoonlightApp._noteLiveQuality();
    // What _onStreamCongested writes before it relaunches.
    MoonlightApp._degradeOverrides = { stream_height: 1080, stream_bitrate: 40000 };
    MoonlightApp._degradeLevel = 1;
    MoonlightApp._originalStreamHeight = 1440;
    MoonlightApp._standbyView = standby;
    MoonlightApp._standbyResult = { slot: 1 };
    return { live, standby };
}

describe('a standby that never shows a picture', () => {
    it('keeps the live stream and never relaunches it', () => {
        const relaunch = vi.spyOn(MoonlightApp, '_relaunchTransport').mockImplementation(() => {});
        const { live, standby } = standbyForAStep();
        MoonlightApp._failStandby('timeout');
        expect(relaunch).not.toHaveBeenCalled();
        expect(MoonlightApp.streamView).toBe(live);
        expect(live.quit).not.toHaveBeenCalled();
        expect(MoonlightApp._standbyView).toBe(null);
        expect(standby.quit).toHaveBeenCalledWith({
            silent: true,
            retire: true,
            dualFailed: true,
        });
    });

    it('keeps the host to one session, so the next step is the classic relaunch', () => {
        const relaunch = vi.spyOn(MoonlightApp, '_relaunchTransport').mockImplementation(() => {});
        const seamless = vi.spyOn(MoonlightApp, '_seamlessRelaunch').mockImplementation(() => {});
        standbyForAStep();
        MoonlightApp._failStandby('connect failed: DataChannel "video" closed unexpectedly');
        expect(MoonlightApp._dualSupported).toBe(false);

        MoonlightApp.streamView._firstFrameRendered = true;
        vi.spyOn(MoonlightApp, '_sharePinsQuality').mockReturnValue(false);
        MoonlightApp._qualityRelaunch(0);
        expect(seamless).not.toHaveBeenCalled();
        expect(relaunch).toHaveBeenCalledWith(0);
    });

    it('puts back the quality the stream really has', () => {
        standbyForAStep();
        const settings = MoonlightApp._lastStreamingSettings;
        settings.stream_height = 1080; // a caller that wrote into the settings
        MoonlightApp._failStandby('timeout');
        expect(MoonlightApp._lastStreamingSettings).toBe(settings);
        expect(settings).toEqual({ stream_height: 1440, stream_bitrate: 80000 });
        expect(MoonlightApp._degradeOverrides).toEqual({});
        expect(MoonlightApp._degradeLevel).toBe(0);
        expect(MoonlightApp._originalStreamHeight).toBe(undefined);
    });

    it('does nothing once the standby is gone', () => {
        standbyForAStep();
        MoonlightApp._standbyView = null;
        MoonlightApp._failStandby('timeout');
        expect(MoonlightApp._degradeLevel).toBe(1);
    });
});
