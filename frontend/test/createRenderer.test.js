/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The real renderers touch WebGPU/Canvas/<video> and are out of scope; we mock
 * them and assert only the selection/fallback logic of createVideoRenderer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/stream/renderers/Canvas2DRenderer.js', () => ({
    Canvas2DRenderer: { create: vi.fn(async () => ({ kind: 'canvas2d' })) },
}));
vi.mock('../js/stream/renderers/WebGpuRenderer.js', () => ({
    WebGpuRenderer: { create: vi.fn(async () => ({ kind: 'webgpu' })) },
}));
vi.mock('../js/stream/renderers/VideoElementRenderer.js', () => ({
    VideoElementRenderer: { create: vi.fn(async () => ({ kind: 'video' })) },
}));
vi.mock('../js/stream/renderers/WebGlRenderer.js', () => ({
    WebGlRenderer: { create: vi.fn(async () => ({ kind: 'webgl' })) },
    WEBGL_ALGOS: ['gl-fsr1', 'gl-sgsr', 'gl-nis', 'gl-mwsr'],
}));

import {
    createVideoRenderer,
    geckoPresentsOnPlainWebGl,
    iosPresentsOnPlainWebGl,
    plainPicture,
    presentsOnVsync,
    rendererAfterFailure,
} from '../js/stream/renderers/createRenderer.js';
import { Canvas2DRenderer } from '../js/stream/renderers/Canvas2DRenderer.js';
import { WebGpuRenderer } from '../js/stream/renderers/WebGpuRenderer.js';
import { VideoElementRenderer } from '../js/stream/renderers/VideoElementRenderer.js';
import { WebGlRenderer } from '../js/stream/renderers/WebGlRenderer.js';

const canvas = {};

describe('createVideoRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        WebGpuRenderer.create.mockResolvedValue({ kind: 'webgpu' });
        VideoElementRenderer.create.mockResolvedValue({ kind: 'video' });
        Canvas2DRenderer.create.mockResolvedValue({ kind: 'canvas2d' });
        WebGlRenderer.create.mockResolvedValue({ kind: 'webgl' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('routes HDR to the <video> renderer when supported', async () => {
        vi.stubGlobal('MediaStreamTrackGenerator', function () {});
        vi.stubGlobal('navigator', { gpu: {} });
        const r = await createVideoRenderer(canvas, { hdr: true, videoEl: {}, webgpu: true });
        expect(r.kind).toBe('video');
        expect(VideoElementRenderer.create).toHaveBeenCalled();
    });

    it('prefers WebGPU when available', async () => {
        vi.stubGlobal('navigator', { gpu: {} });
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('webgpu');
    });

    it('falls back to Canvas2D when WebGPU is unavailable', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('canvas2d');
    });

    it('falls back to Canvas2D when WebGPU init throws', async () => {
        vi.stubGlobal('navigator', { gpu: {} });
        WebGpuRenderer.create.mockRejectedValue(new Error('no device'));
        const r = await createVideoRenderer(canvas, { webgpu: true });
        expect(r.kind).toBe('canvas2d');
    });

    it('falls back from a failing <video> HDR renderer to the canvas path', async () => {
        vi.stubGlobal('MediaStreamTrackGenerator', function () {});
        vi.stubGlobal('navigator', { gpu: {} });
        VideoElementRenderer.create.mockRejectedValue(new Error('no MSTG'));
        const r = await createVideoRenderer(canvas, { hdr: true, videoEl: {}, webgpu: true });
        expect(r.kind).toBe('webgpu'); // HDR failed → WebGPU still preferred
    });

    it('presents the plain picture on WebGL with no pass in Firefox', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { plainWebGl: true, algo: 'off' });
        expect(r.kind).toBe('webgl');
        expect(WebGlRenderer.create.mock.calls[0][1].algo).toBe('off');
    });

    it('falls back to Canvas2D when that WebGL context is refused', async () => {
        vi.stubGlobal('navigator', {});
        WebGlRenderer.create.mockRejectedValue(new Error('WebGL2 unavailable'));
        const r = await createVideoRenderer(canvas, { plainWebGl: true, algo: 'off' });
        expect(r.kind).toBe('canvas2d');
    });

    it('keeps Canvas2D for the plain picture everywhere else', async () => {
        vi.stubGlobal('navigator', {});
        const r = await createVideoRenderer(canvas, { algo: 'off' });
        expect(r.kind).toBe('canvas2d');
        expect(WebGlRenderer.create).not.toHaveBeenCalled();
    });

    it("routes the WebGL2 twin of MoonlightWeb's upscaler to WebGL, like the three ports", async () => {
        vi.stubGlobal('navigator', { gpu: {} });
        const r = await createVideoRenderer(canvas, { algo: 'gl-mwsr', webgpu: false });
        expect(r.kind).toBe('webgl');
        expect(WebGlRenderer.create.mock.calls[0][1].algo).toBe('gl-mwsr');
        expect(WebGpuRenderer.create).not.toHaveBeenCalled();
    });
});

/**
 * Firefox's 2D canvas copies each decoded frame on the main thread: 55 ms a
 * 1080p frame on the N95, an IDR every 300 ms at 60 fps (12/10/2026).
 */
describe('geckoPresentsOnPlainWebGl', () => {
    const ff = { gecko: true, hdr: false, algo: 'off', webgpu: false, sink: false };

    it('moves the plain SDR picture to WebGL in Firefox', () => {
        expect(geckoPresentsOnPlainWebGl(ff)).toBe(true);
    });

    it('leaves every other browser, and every other choice, as it was', () => {
        expect(geckoPresentsOnPlainWebGl({ ...ff, gecko: false })).toBe(false);
        // HDR has its own routing; an enhancer picks its own renderer.
        expect(geckoPresentsOnPlainWebGl({ ...ff, hdr: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, algo: 'gl-fsr1' })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, webgpu: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, sink: true })).toBe(false);
        // The debug menu's Canvas2D, and mw_force_2d, stay Canvas2D.
        expect(geckoPresentsOnPlainWebGl({ ...ff, forceCanvas2d: true })).toBe(false);
        expect(geckoPresentsOnPlainWebGl({ ...ff, devCanvas2d: true })).toBe(false);
    });
});

/** The picture RendererFallback may move between Canvas2D and WebGL2. */
describe('iosPresentsOnPlainWebGl', () => {
    const ios = { ios: true, hdr: false, algo: 'off', webgpu: false, sink: false };

    it('moves the plain SDR picture to WebGL on iOS, where the zoom stays sharp', () => {
        expect(iosPresentsOnPlainWebGl(ios)).toBe(true);
    });

    it('leaves every other device, and every other choice, as it was', () => {
        expect(iosPresentsOnPlainWebGl({ ...ios, ios: false })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, hdr: true })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, algo: 'gl-sgsr' })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, webgpu: true })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, sink: true })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, forceCanvas2d: true })).toBe(false);
        expect(iosPresentsOnPlainWebGl({ ...ios, devCanvas2d: true })).toBe(false);
    });
});

describe('plainPicture', () => {
    const plain = { hdr: false, algo: 'off', webgpu: false, sink: false };

    it('is the SDR picture with no enhancer, in any browser', () => {
        expect(plainPicture(plain)).toBe(true);
    });

    it('is not a picture something else already placed', () => {
        expect(plainPicture({ ...plain, algo: 'smooth2d' })).toBe(false);
        expect(plainPicture({ ...plain, hdr: true })).toBe(false);
        expect(plainPicture({ ...plain, sink: true })).toBe(false);
        expect(plainPicture({ ...plain, forceCanvas2d: true })).toBe(false);
    });
});

/**
 * What the native host is told about this view's vsync: "Allow tearing" said
 * "tearing" for every renderer, and an HDR stream, always on WebGPU or on the
 * <video> sink, waits for the vsync whatever the setting (14/10/2026).
 */
describe('presentsOnVsync', () => {
    const tears = { tearing: true, transport: 'webrtc', kind: 'canvas2d' };

    it('tears only on a canvas that skips the compositor, tearing on', () => {
        expect(presentsOnVsync(tears)).toBe(false);
        expect(presentsOnVsync({ ...tears, kind: 'webgl' })).toBe(false);
        expect(presentsOnVsync({ ...tears, transport: 'wss' })).toBe(false);
    });

    it('waits for the vsync on WebGPU and on a <video> element', () => {
        expect(presentsOnVsync({ ...tears, kind: 'webgpu' })).toBe(true);
        expect(presentsOnVsync({ ...tears, kind: 'video-element' })).toBe(true);
        // The media transport presents on its own <video>: no renderer at all.
        expect(presentsOnVsync({ ...tears, transport: 'webrtc-media', kind: null })).toBe(true);
    });

    it('waits for the vsync whatever the renderer, tearing off', () => {
        for (const kind of ['canvas2d', 'webgl', 'webgpu', 'video-element', null])
            expect(presentsOnVsync({ ...tears, tearing: false, kind })).toBe(true);
    });

    it('keeps the setting until the renderer is made', () => {
        expect(presentsOnVsync({ ...tears, kind: null })).toBe(false);
    });
});

/**
 * Where the picture goes when its WebGPU renderer gives up (Bruno, 22/10/2026:
 * `gl-<algo>`, then Canvas2D — the second is createVideoRenderer's own answer
 * to a refused WebGL2).
 */
describe('rendererAfterFailure', () => {
    it('keeps the pass, on its WebGL2 twin, under the setting as ceiling', () => {
        for (const rung of ['fsr1', 'nis', 'sgsr', 'mwsr'])
            expect(rendererAfterFailure({ ceiling: rung, pass: rung })).toEqual({
                algo: 'gl-' + rung,
                ceiling: 'gl-' + rung,
                plainWebGl: false,
            });
    });

    it('keeps the rung the ladder stood on, below the setting', () => {
        expect(rendererAfterFailure({ ceiling: 'fsr1', pass: 'mwsr' })).toEqual({
            algo: 'gl-mwsr',
            ceiling: 'gl-fsr1',
            plainWebGl: false,
        });
        // stepped down to no pass: the WebGL2 renderer all the same, to climb back
        expect(rendererAfterFailure({ ceiling: 'fsr1', pass: 'off' })).toEqual({
            algo: 'off',
            ceiling: 'gl-fsr1',
            plainWebGl: false,
        });
    });

    it('puts the plain copy on the presenter the page uses for one', () => {
        expect(rendererAfterFailure({ ceiling: 'off', pass: 'off', plainWebGl: false })).toEqual({
            algo: 'off',
            ceiling: 'off',
            plainWebGl: false,
        });
        expect(rendererAfterFailure({ ceiling: 'off', pass: 'off', plainWebGl: true })).toEqual({
            algo: 'off',
            ceiling: 'off',
            plainWebGl: true,
        });
    });

    it('lands where createVideoRenderer puts those options', async () => {
        WebGlRenderer.create.mockClear();
        Canvas2DRenderer.create.mockClear();
        const next = rendererAfterFailure({ ceiling: 'mwsr', pass: 'mwsr' });
        const r = await createVideoRenderer(canvas, { webgpu: false, ...next });
        expect(r.kind).toBe('webgl');
        expect(WebGlRenderer.create.mock.calls[0][1]).toMatchObject({ algo: 'gl-mwsr' });
        // WebGL2 refused: Canvas2D
        WebGlRenderer.create.mockRejectedValueOnce(new Error('WebGL2 unavailable'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const r2 = await createVideoRenderer(canvas, { webgpu: false, ...next });
        expect(r2.kind).toBe('canvas2d');
        console.warn.mockRestore();
    });
});
