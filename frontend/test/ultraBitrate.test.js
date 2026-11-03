/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { ByteRate } from '../js/stream/ByteRate.js';

/**
 * PyroWave frames in the stats' bitrate (13/10/2026): handleVideoFrame hands
 * them to the player before the line that counts a frame's bytes, and the
 * card read 0.0 Mbps — its graph flat at 0 — while the picture came.
 */
const P = StreamView.prototype;

function view(over = {}) {
    return {
        stats: { received: 0 },
        _quitting: false,
        _fatalDecodeError: false,
        _stepper: null,
        _totalBytes: 0,
        _byteRate: new ByteRate(2000),
        _ultraMode: () => true,
        _ultraPlayer: { push: vi.fn() },
        _trackChunkSubmit: vi.fn(),
        _handleUltraFrame: P._handleUltraFrame,
        ...over,
    };
}

describe('StreamView — a PyroWave stream counts in the bitrate', () => {
    it('counts every frame the player is given', () => {
        const v = view();
        for (let i = 0; i < 3; i++)
            P.handleVideoFrame.call(v, new Uint8Array(1400), true, 1000 + i, i + 1);
        expect(v._ultraPlayer.push).toHaveBeenCalledTimes(3);
        expect(v._totalBytes).toBe(4200);
        expect(v.stats.received).toBe(3);
    });

    it('reads a rate on the card, not 0.0 Mbps', () => {
        const v = view();
        // 30 frames of 50 kB a second for 2 s: 12 Mbps.
        for (let t = 0; t <= 2000; t += 500) {
            for (let i = 0; i < 15; i++)
                P.handleVideoFrame.call(v, new Uint8Array(50000), true, t, 0);
            v._byteRate.sample(t, v._totalBytes);
        }
        expect(v._byteRate.mbps()).toBeCloseTo(12, 0);
    });

    it('counts the frames that come before the player is made', () => {
        // Not a start of frame (top bit clear): the player waits for one, but
        // the bytes crossed the link all the same.
        const v = view({ _ultraPlayer: null, _ultraStarting: false });
        P.handleVideoFrame.call(v, new Uint8Array(1400), true, 1000, 1);
        expect(v._totalBytes).toBe(1400);
    });
});
