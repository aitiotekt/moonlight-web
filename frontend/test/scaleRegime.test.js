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
 * scaleRegime — the canvas backing the two shader renderers give a frame, and
 * the one case where they copy it instead of running the enhancer: exactly its
 * own size on both axes.
 */
import { describe, it, expect } from 'vitest';
import {
    MAX_CANVAS_DIM,
    fitOutputSize,
    isIdentityScale,
} from '../js/stream/renderers/scaleRegime.js';

const identity = (inW, inH, outW, outH) => {
    const { cw, ch } = fitOutputSize(inW, inH, outW, outH);
    return isIdentityScale(inW, inH, cw, ch);
};

describe('fitOutputSize', () => {
    it('backs the frame at its own size while no box is known', () => {
        expect(fitOutputSize(1920, 1080, 0, 0)).toEqual({ cw: 1920, ch: 1080 });
        expect(fitOutputSize(1920, 1080, -1, 900)).toEqual({ cw: 1920, ch: 1080 });
    });

    it('fits the frame-aspect rectangle to the box, width-bound or height-bound', () => {
        // ×2 on a 1440p screen
        expect(fitOutputSize(1280, 720, 2560, 1440)).toEqual({ cw: 2560, ch: 1440 });
        // a wider box: the height binds, the picture is pillar-boxed
        expect(fitOutputSize(1920, 1080, 3440, 1440)).toEqual({ cw: 2560, ch: 1440 });
        // a phone held upright: the width binds
        expect(fitOutputSize(1280, 720, 1170, 2532)).toEqual({ cw: 1170, ch: 658 });
    });

    it('caps the longer side, aspect kept', () => {
        const { cw, ch } = fitOutputSize(1920, 1080, 8000, 4500);
        expect(cw).toBe(MAX_CANVAS_DIM);
        expect(ch).toBe(2304);
    });
});

describe('isIdentityScale', () => {
    it('is the frame drawn at exactly its own size', () => {
        expect(identity(2560, 1440, 2560, 1440)).toBe(true);
        expect(identity(1920, 1080, 0, 0)).toBe(true);
    });

    it('still holds in a box one pixel wider or taller: the picture keeps its size', () => {
        expect(identity(2560, 1440, 2561, 1440)).toBe(true);
        expect(identity(2560, 1440, 2560, 1441)).toBe(true);
    });

    it('is not a near miss: one pixel more on both axes, or 0.98, is a resample', () => {
        expect(identity(2560, 1440, 2561, 1441)).toBe(false);
        expect(identity(2560, 1440, 2509, 1411)).toBe(false);
        expect(identity(1280, 720, 2560, 1440)).toBe(false);
        expect(identity(2560, 1440, 1920, 1080)).toBe(false);
    });
});
