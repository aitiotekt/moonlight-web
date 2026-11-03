import { describe, it, expect } from 'vitest';
import { ByteRate } from '../js/stream/ByteRate.js';

describe('ByteRate', () => {
    it('reads 0 until two points half a second apart', () => {
        const r = new ByteRate(2000);
        expect(r.mbps()).toBe(0);
        r.sample(0, 0);
        expect(r.mbps()).toBe(0);
        r.sample(400, 1_000_000);
        expect(r.mbps()).toBe(0);
        r.sample(500, 1_250_000);
        expect(r.mbps()).toBeCloseTo(20, 6); // 1.25 MB in 0.5 s
    });

    it('follows a step down within the window instead of the session average', () => {
        const r = new ByteRate(2000);
        let total = 0;
        // 60 s at 50 Mbps, sampled twice a second.
        for (let t = 0; t <= 60_000; t += 500) {
            r.sample(t, total);
            total += (50e6 / 8) * 0.5;
        }
        expect(r.mbps()).toBeCloseTo(50, 3);
        // Then 10 Mbps: once the window has passed, the card reads 10, where
        // the old session average would still read ~48.
        for (let t = 60_500; t <= 63_000; t += 500) {
            total += (10e6 / 8) * 0.5;
            r.sample(t, total);
        }
        expect(r.mbps()).toBeCloseTo(10, 3);
    });

    it('spans the whole window and keeps few points', () => {
        const r = new ByteRate(2000);
        for (let t = 0; t <= 10_000; t += 500) r.sample(t, t * 1000);
        expect(r._points[0].t).toBe(8000);
        expect(r._points.length).toBe(5);
        expect(r.mbps()).toBeCloseTo(8, 6); // 1 000 000 B/s
    });

    it('starts over when the counter goes back', () => {
        const r = new ByteRate(2000);
        r.sample(0, 5_000_000);
        r.sample(1000, 6_000_000);
        r.sample(1500, 100);
        expect(r.mbps()).toBe(0);
        r.sample(2000, 125_100);
        expect(r.mbps()).toBeCloseTo(2, 6);
    });
});
