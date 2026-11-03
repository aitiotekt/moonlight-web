/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { hdrFramesOpaque } from '../js/util/BrowserDetect.js';

/**
 * A browser that hands its AV1 HDR frames opaque, decoded in hardware
 * whatever it was asked: Chrome 126 and Safari 27 on a MacBook Air M3
 * (26/10/2026). The readback of the HDR route has nothing to read; the stream
 * sees it on its first frame, the browser keeps the verdict, and the session
 * comes back on a route without one, relaunched as a codec fallback is.
 */
const P = StreamView.prototype;

function view(over = {}) {
    return {
        _hdrYuv: true,
        _playerMode: false,
        _quitting: false,
        _manualQuitting: false,
        _codecFallbackRequested: false,
        _codecFallback: null,
        quit: vi.fn(),
        _checkOpaqueHdrFrame: P._checkOpaqueHdrFrame,
        _relaunchWithoutReadback: P._relaunchWithoutReadback,
        ...over,
    };
}

const pq = { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false };
const opaque = (colorSpace = pq) => ({ format: null, colorSpace });

describe('StreamView — opaque HDR frames', () => {
    beforeEach(() => localStorage.removeItem('mw_hdr_opaque'));
    afterEach(() => {
        localStorage.removeItem('mw_hdr_opaque');
        localStorage.removeItem('mw_hdr_ext_tonemap');
        vi.unstubAllGlobals();
    });

    it('keeps the verdict and comes back in AV1 HDR, to the sink or the browser tone-map', () => {
        const v = view();
        expect(v._checkOpaqueHdrFrame(opaque())).toBe(true);
        expect(hdrFramesOpaque()).toBe(true);
        expect(v._codecFallbackRequested).toBe(true);
        expect(v._codecFallback).toEqual({ codec: 'av1', hdr: true, reason: 'opaque-hdr-frames' });
        expect(v.quit).toHaveBeenCalledOnce();
    });

    it('comes back in HEVC HDR where the route left imports the frame (WebKit)', () => {
        vi.stubGlobal('navigator', { userAgent: navigator.userAgent, gpu: {} });
        localStorage.setItem('mw_hdr_ext_tonemap', '1');
        const v = view();
        expect(v._checkOpaqueHdrFrame(opaque())).toBe(true);
        expect(v._codecFallback).toEqual({ codec: 'hevc', hdr: true, reason: 'opaque-hdr-frames' });
    });

    it('reads HLG as HDR too', () => {
        const v = view();
        expect(v._checkOpaqueHdrFrame(opaque({ ...pq, transfer: 'hlg' }))).toBe(true);
    });

    it('leaves a readable frame alone', () => {
        const v = view();
        expect(v._checkOpaqueHdrFrame({ format: 'I420P10', colorSpace: pq })).toBe(false);
        expect(v.quit).not.toHaveBeenCalled();
        expect(hdrFramesOpaque()).toBe(false);
    });

    it('leaves alone the 8-bit frame of a host that kept SDR, and a frame that says nothing', () => {
        const sdr = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
        for (const frame of [opaque(sdr), opaque(null), { format: null }]) {
            const v = view();
            expect(v._checkOpaqueHdrFrame(frame)).toBe(false);
            expect(v.quit).not.toHaveBeenCalled();
        }
        expect(hdrFramesOpaque()).toBe(false);
    });

    it('looks only on a readback route, and only at the first frame', () => {
        const off = view({ _hdrYuv: false });
        expect(off._checkOpaqueHdrFrame(opaque())).toBe(false);
        const v = view();
        expect(v._checkOpaqueHdrFrame({ format: 'I420P10', colorSpace: pq })).toBe(false);
        expect(v._checkOpaqueHdrFrame(opaque())).toBe(false);
        expect(v.quit).not.toHaveBeenCalled();
    });

    it("a guest keeps the verdict and stays: the feed is the owner's", () => {
        const v = view({ _playerMode: true });
        expect(v._checkOpaqueHdrFrame(opaque())).toBe(false);
        expect(hdrFramesOpaque()).toBe(true);
        expect(v._codecFallbackRequested).toBe(false);
        expect(v.quit).not.toHaveBeenCalled();
    });

    it('does nothing on the way out or with a fallback already asked', () => {
        for (const over of [
            { _quitting: true },
            { _manualQuitting: true },
            { _codecFallbackRequested: true },
        ]) {
            const v = view(over);
            expect(v._checkOpaqueHdrFrame(opaque())).toBe(false);
            expect(v.quit).not.toHaveBeenCalled();
        }
        expect(hdrFramesOpaque()).toBe(false);
    });
});
