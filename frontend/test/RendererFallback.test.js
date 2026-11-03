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
 * RendererFallback — which renderer the plain picture is moved to, and when,
 * from a sequence of observation windows. The cases replay the measurements of
 * 12/10/2026: Firefox on an N95 (2D draw 55 ms, WebGL2 1.3 ms at 1080p60),
 * Chrome on the same machine (0.5 ms), Firefox on an M1 (4-5 ms on Canvas2D).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    RendererFallback,
    otherPlainRenderer,
    rememberedPlainRenderer,
    rememberPlainRenderer,
} from '../js/stream/RendererFallback.js';

const FRAME_60 = 1000 / 60;
const FRAME_120 = 1000 / 120;

/**
 * Feed windows 500 ms apart (the StreamView tick). @p costOf gives the draw's
 * cost for the renderer the picture is on, so a switch changes what is read.
 */
function run(f, costOf, arrivalMs, seconds, start = 0) {
    const steps = [];
    let now = start;
    for (let i = 0; i < seconds * 2; i++) {
        now += 500;
        const step = f.update({ submitMs: costOf(f.kind), arrivalMs, now });
        if (step) steps.push({ ...step, now });
    }
    return steps;
}

describe('RendererFallback', () => {
    it('moves Firefox on the N95 off Canvas2D, and keeps WebGL2', () => {
        const f = new RendererFallback('canvas2d');
        const cost = { canvas2d: 55, webgl: 1.3 };
        const steps = run(f, (k) => cost[k], FRAME_60, 10);
        expect(steps.map((s) => s.action)).toEqual(['switch', 'keep']);
        expect(steps[0]).toMatchObject({ kind: 'webgl', fromMs: 55 });
        expect(steps[1]).toMatchObject({ kind: 'webgl', fromMs: 55, toMs: 1.3 });
        // 2 s over the line, then 3 s on the new renderer before the verdict.
        expect(steps[0].now).toBe(2500);
        expect(steps[1].now).toBe(5500);
        expect(f.kind).toBe('webgl');
    });

    it('leaves a cheap draw alone: Chrome at 0.5 ms, Firefox on the M1 at 4-5 ms', () => {
        for (const ms of [0.5, 4.5]) {
            const f = new RendererFallback('canvas2d');
            expect(run(f, () => ms, FRAME_60, 30)).toEqual([]);
        }
    });

    it('needs the cost to hold for 2 s: one busy window is not a trend', () => {
        const f = new RendererFallback('canvas2d');
        let i = 0;
        // Over the line every third window only.
        const steps = run(f, () => (i++ % 3 === 0 ? 40 : 1), FRAME_60, 30);
        expect(steps).toEqual([]);
    });

    it('scales with the frame rate: 6 ms fits at 60 fps, not at 120', () => {
        expect(run(new RendererFallback('canvas2d'), () => 6, FRAME_60, 10)).toEqual([]);
        const steps = run(new RendererFallback('canvas2d'), () => 6, FRAME_120, 10);
        expect(steps[0]).toMatchObject({ action: 'switch', kind: 'webgl' });
    });

    it('goes back when the other renderer is no better, and stops trying', () => {
        const f = new RendererFallback('canvas2d');
        // A throttled screen: every renderer blocks the same.
        const steps = run(f, () => 40, FRAME_60, 30);
        expect(steps.map((s) => s.action)).toEqual(['switch', 'revert']);
        expect(steps[1]).toMatchObject({ kind: 'canvas2d', fromMs: 40, toMs: 40 });
        expect(f.kind).toBe('canvas2d');
    });

    it('keeps the new renderer only when it costs half or less', () => {
        const keep = run(
            new RendererFallback('canvas2d'),
            (k) => (k === 'canvas2d' ? 30 : 15),
            FRAME_60,
            10,
        );
        expect(keep.map((s) => s.action)).toEqual(['switch', 'keep']);
        const back = run(
            new RendererFallback('canvas2d'),
            (k) => (k === 'canvas2d' ? 30 : 16),
            FRAME_60,
            10,
        );
        expect(back.map((s) => s.action)).toEqual(['switch', 'revert']);
    });

    it('works the other way: a slow WebGL2 moves to Canvas2D', () => {
        const f = new RendererFallback('webgl');
        const cost = { canvas2d: 0.5, webgl: 25 };
        const steps = run(f, (k) => cost[k], FRAME_60, 10);
        expect(steps.map((s) => [s.action, s.kind])).toEqual([
            ['switch', 'canvas2d'],
            ['keep', 'canvas2d'],
        ]);
    });

    it('holds without a budget or a draw to measure', () => {
        const f = new RendererFallback('canvas2d');
        expect(run(f, () => 50, 0, 10)).toEqual([]);
        expect(run(f, () => 50, 500, 10)).toEqual([]);
        expect(run(f, () => 0, FRAME_60, 10)).toEqual([]);
    });

    it('stays put when the other renderer cannot be made', () => {
        const f = new RendererFallback('canvas2d');
        const steps = run(f, () => 55, FRAME_60, 3);
        expect(steps[0]).toMatchObject({ action: 'switch', kind: 'webgl' });
        f.abandon();
        expect(f.kind).toBe('canvas2d');
        expect(run(f, () => 55, FRAME_60, 30, 3000)).toEqual([]);
    });

    it('names the other renderer', () => {
        expect(otherPlainRenderer('canvas2d')).toBe('webgl');
        expect(otherPlainRenderer('webgl')).toBe('canvas2d');
    });
});

describe('rememberedPlainRenderer', () => {
    beforeEach(() => localStorage.clear());

    it('gives back the verdict made in the same browser version', () => {
        expect(rememberedPlainRenderer('ff/157')).toBe(null);
        rememberPlainRenderer('webgl', 'ff/157');
        expect(rememberedPlainRenderer('ff/157')).toBe('webgl');
        rememberPlainRenderer('canvas2d', 'ff/157');
        expect(rememberedPlainRenderer('ff/157')).toBe('canvas2d');
    });

    it('forgets it under another user agent (an update may have fixed it)', () => {
        rememberPlainRenderer('webgl', 'ff/157');
        expect(rememberedPlainRenderer('ff/158')).toBe(null);
    });

    it('ignores a broken entry', () => {
        localStorage.setItem('mw_plain_renderer', '{nope');
        expect(rememberedPlainRenderer('ff/157')).toBe(null);
        localStorage.setItem('mw_plain_renderer', JSON.stringify({ kind: 'webgpu', ua: 'x' }));
        expect(rememberedPlainRenderer('x')).toBe(null);
    });
});
