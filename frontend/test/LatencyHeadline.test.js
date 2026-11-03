/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * LatencyHeadline — the stats card's headline: the frame log's measure when
 * there is one, the picture's growing age in a freeze, the legs' sum otherwise.
 */
import { describe, it, expect } from 'vitest';
import { FROZEN_AFTER_MS, latencyHeadline } from '../js/stream/LatencyHeadline.js';

/** A stream drawing frames normally: every input in its healthy state. */
function flowing(over = {}) {
    return {
        sumMs: 40,
        sumP99Ms: 70,
        measured: { count: 120, avg: 45, p99: 80 },
        lastE2eMs: 44,
        sinceDrawMs: 16,
        sinceRxMs: 5,
        silentAfterMs: 1500,
        framesSinceDraw: false,
        hidden: false,
        ...over,
    };
}

describe('LatencyHeadline — what the card says the delay is', () => {
    it('the M3 on 25/10: the legs summed ~78 ms, the measure read 4 s, the card says 4 s', () => {
        // Line 645 of the M3's page log: « arrival 77.7/736.5ms … p99 client
        // handoff/decode/queue/render 0.2/6.4/0.1/1.0ms … e2e measured
        // 3961.1/4124.3ms ». Frames were still being drawn, 14 a second.
        const h = latencyHeadline(
            flowing({
                sumMs: 78,
                sumP99Ms: 120,
                measured: { count: 28, avg: 3961.1, p99: 4124.3 },
                lastE2eMs: 4010,
                sinceDrawMs: 60,
            }),
        );
        expect(h.source).toBe('measured');
        expect(h.ms).toBeCloseTo(3961.1, 5);
        expect(h.p99Ms).toBeCloseTo(4124.3, 5);
    });

    it('takes the measure over the sum on a healthy stream too', () => {
        const h = latencyHeadline(flowing());
        expect(h).toEqual({ ms: 45, p99Ms: 80, source: 'measured' });
    });

    it('falls back to the sum where nothing measures the whole way', () => {
        // The decode worker, the native media track, a clock not known yet.
        const h = latencyHeadline(flowing({ measured: null, lastE2eMs: NaN }));
        expect(h).toEqual({ ms: 40, p99Ms: 70, source: 'sum' });
        const empty = latencyHeadline(
            flowing({ measured: { count: 0, avg: 0, p99: 0 }, lastE2eMs: NaN }),
        );
        expect(empty.source).toBe('sum');
    });

    it('a measure that makes no sense (a bad clock) is left out', () => {
        const h = latencyHeadline(flowing({ measured: { count: 10, avg: -30, p99: -5 } }));
        expect(h.source).toBe('sum');
    });

    it('says nothing when there is nothing to say', () => {
        const h = latencyHeadline(flowing({ sumMs: NaN, measured: null, lastE2eMs: NaN }));
        expect(h.source).toBe('none');
        expect(h.ms).toBeNaN();
    });

    it('a silent link: the picture on screen grows older, second by second', () => {
        // Drawn at an age of 900 ms, then nothing for 3 s: the link is silent.
        const at3s = latencyHeadline(
            flowing({ lastE2eMs: 900, sinceDrawMs: 3000, sinceRxMs: 2900 }),
        );
        expect(at3s).toEqual({ ms: 3900, p99Ms: 3900, source: 'frozen' });
        const at5s = latencyHeadline(
            flowing({ lastE2eMs: 900, sinceDrawMs: 5000, sinceRxMs: 4900 }),
        );
        expect(at5s.ms).toBe(5900);
    });

    it('frames coming in but none drawn (a decoder waiting for a keyframe) is a freeze', () => {
        const h = latencyHeadline(
            flowing({ lastE2eMs: 120, sinceDrawMs: 2000, sinceRxMs: 10, framesSinceDraw: true }),
        );
        expect(h).toEqual({ ms: 2120, p99Ms: 2120, source: 'frozen' });
    });

    it('back to the measure as soon as frames are drawn again', () => {
        const h = latencyHeadline(
            flowing({ measured: { count: 3, avg: 2500, p99: 2600 }, lastE2eMs: 2400 }),
        );
        expect(h.source).toBe('measured');
        expect(h.ms).toBe(2500);
    });

    it('a still screen is not a freeze: no frame waits, and the stats keep coming', () => {
        // Nothing drawn for 10 s, nothing to draw, the host's stats a second ago.
        const h = latencyHeadline(
            flowing({ sinceDrawMs: 10000, sinceRxMs: 900, framesSinceDraw: false }),
        );
        expect(h.source).toBe('measured');
    });

    it('a short pause is not a freeze yet', () => {
        const h = latencyHeadline(
            flowing({ sinceDrawMs: FROZEN_AFTER_MS, sinceRxMs: 2000, framesSinceDraw: true }),
        );
        expect(h.source).toBe('measured');
    });

    it('a hidden page draws nothing on purpose: no freeze there', () => {
        const h = latencyHeadline(
            flowing({ sinceDrawMs: 8000, framesSinceDraw: true, hidden: true }),
        );
        expect(h.source).toBe('measured');
    });

    it('no freeze without the age of the last frame (the sum path)', () => {
        const h = latencyHeadline(
            flowing({
                measured: null,
                lastE2eMs: NaN,
                sinceDrawMs: 4000,
                sinceRxMs: 4000,
            }),
        );
        expect(h.source).toBe('sum');
    });
});
