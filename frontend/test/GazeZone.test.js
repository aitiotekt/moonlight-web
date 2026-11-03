import { describe, it, expect } from 'vitest';
import { GazeZone } from '../js/stream/GazeZone.js';

const AREA_1080P = 1920 * 1080;
const AREA_4K = 3840 * 2160;

/** `seconds` of frames at 60 fps, `bytes` each, from `from` ms; the level read after each. */
function run(g, from, seconds, bytes, area = AREA_1080P, key = () => false) {
    const levels = [];
    for (let i = 0; i < seconds * 60; i++) {
        const t = from + (i * 1000) / 60;
        g.note(bytes, key(i), t);
        levels.push(g.level(t, area));
    }
    return levels;
}

describe('GazeZone', () => {
    it('stays at 0 on a still desktop, whose delta frames are a few hundred bytes', () => {
        const g = new GazeZone();
        const levels = run(g, 0, 5, 300);
        expect(Math.max(...levels)).toBe(0);
        expect(g.motion(5000, AREA_1080P)).toBe(0);
    });

    it('rises to 1 on a moving picture, in about a second, never in a step', () => {
        const g = new GazeZone();
        // 40 KB per frame at 60 fps: 19 Mbit/s, a 1080p game.
        const levels = run(g, 0, 4, 40_000);
        expect(g.motion(4000, AREA_1080P)).toBe(1);
        expect(levels[levels.length - 1]).toBeGreaterThan(0.98);
        // past 0.9 within 2.5 s (the easing's 1 s time constant)
        expect(levels[Math.floor(2.5 * 60)]).toBeGreaterThan(0.9);
        // and by 1/64 at most... per 16 ms step: about 0.016, no pop
        for (let i = 1; i < levels.length; i++)
            expect(levels[i] - levels[i - 1]).toBeLessThan(0.05);
        // in steps of 1/64
        for (const l of levels) expect(Number.isInteger(l * 64)).toBe(true);
    });

    it('falls back to 0 in a few seconds once the picture holds still', () => {
        const g = new GazeZone();
        run(g, 0, 4, 40_000);
        const levels = run(g, 4000, 10, 300);
        // still above a half after a second (the window empties first), below
        // a tenth after nine (the 3 s time constant)
        expect(levels[60]).toBeGreaterThan(0.5);
        expect(levels[9 * 60]).toBeLessThan(0.1);
        for (let i = 1; i < levels.length; i++)
            expect(levels[i - 1] - levels[i]).toBeLessThan(0.05);
    });

    it('leaves the key frames out: a still stream with one a second stays at 0', () => {
        const g = new GazeZone();
        const levels = run(g, 0, 5, 300, AREA_1080P, (i) => i % 60 === 0);
        // a 200 KB key frame every second would read as 1.6 Mbit/s
        const g2 = new GazeZone();
        const l2 = [];
        for (let i = 0; i < 300; i++) {
            const t = (i * 1000) / 60;
            const key = i % 60 === 0;
            g2.note(key ? 200_000 : 300, key, t);
            l2.push(g2.level(t, AREA_1080P));
        }
        expect(Math.max(...levels)).toBe(0);
        expect(Math.max(...l2)).toBe(0);
    });

    it('reads the rate per pixel, so a setting or a resolution moves no threshold', () => {
        // 2 Mbit/s: 0.97 bit per pixel per second at 1080p, a moving picture;
        // the same bytes at 4K are a quarter of that, under the floor.
        const bytes = Math.round(2e6 / 8 / 60);
        const g = new GazeZone();
        run(g, 0, 3, bytes, AREA_1080P);
        expect(g.motion(3000, AREA_1080P)).toBeGreaterThan(0.9);
        const g4 = new GazeZone();
        run(g4, 0, 3, bytes, AREA_4K);
        expect(g4.motion(3000, AREA_4K)).toBe(0);
        // no frame area, no motion
        expect(g.motion(3000, 0)).toBe(0);
    });

    it('starts over on a clock that went back, and on reset()', () => {
        const g = new GazeZone();
        run(g, 0, 3, 40_000);
        expect(g.level(3000, AREA_1080P)).toBeGreaterThan(0.9);
        g.reset();
        expect(g.level(3000, AREA_1080P)).toBe(0);
        run(g, 3000, 3, 40_000);
        expect(g.motion(6000, AREA_1080P)).toBe(1);
        g.note(40_000, false, 100); // a new stream's clock
        expect(g._frames.length).toBe(1);
    });
});
