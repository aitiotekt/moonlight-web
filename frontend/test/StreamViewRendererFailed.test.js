/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../js/stream/renderers/createRenderer.js', async (importOriginal) => ({
    ...(await importOriginal()),
    createVideoRenderer: vi.fn(),
}));

import { StreamView } from '../js/ui/StreamView.js';
import { createVideoRenderer } from '../js/stream/renderers/createRenderer.js';

/**
 * A renderer that gives up (VideoRenderer.failed: a WebGPU renderer no frame
 * reaches any more, or whose device did not come back) hands the picture over
 * on the 500 ms tick: to the pass it ran, on WebGL2, else to Canvas2D, rather
 * than leave it black (Bruno, 22/10/2026).
 */
const P = StreamView.prototype;

const gave = () => ({ kind: 'webgpu', failed: true, hdrActive: false, dispose: vi.fn() });
const made = (kind) => ({ kind, failed: false, hdrActive: false, dispose: vi.fn() });

function view(over = {}) {
    return {
        _renderer: gave(),
        _failedRenderer: null,
        _quitting: false,
        _swappingRenderer: false,
        renderRunning: true,
        canvas: { cloneNode: vi.fn(() => ({ copy: true })) },
        _nextCanvas: null,
        _tearing: false,
        videoCodec: 'h264',
        _isChromeWindowsHevc: false,
        _yuv444: false,
        _plainWebGl: false,
        _enhancerCeiling: 'mwsr',
        _videoEnhancementAlgo: 'mwsr',
        _enhancerStart: null,
        _enhancerProfile: {},
        _enhancerDegraded: false,
        _governor: null,
        _wantWebGpu: true,
        _notePresentation: vi.fn(),
        _contentAge: { attach: vi.fn() },
        _applyOutputSize: vi.fn(),
        _checkRendererFailed: P._checkRendererFailed,
        _replaceFailedRenderer: P._replaceFailedRenderer,
        _takeOverRenderer: P._takeOverRenderer,
        _createEnhancerGovernor: P._createEnhancerGovernor,
        _governorProfile: P._governorProfile,
        ...over,
    };
}

describe('StreamView — a renderer that gave up', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        createVideoRenderer.mockReset();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('moves the picture to the same pass on WebGL2, on a fresh canvas', async () => {
        const next = made('webgl');
        createVideoRenderer.mockResolvedValue(next);
        const v = view();
        const old = v._renderer;
        await v._replaceFailedRenderer();
        const [el, opts] = createVideoRenderer.mock.calls[0];
        expect(el).toEqual({ copy: true });
        expect(opts).toMatchObject({
            webgpu: false,
            algo: 'gl-mwsr',
            ceiling: 'gl-mwsr',
            plainWebGl: false,
        });
        expect(v._renderer).toBe(next);
        expect(v._nextCanvas).toBe(el);
        expect(v._activeRendererKind).toBe('webgl');
        expect(v._notePresentation).toHaveBeenCalledWith('webgl');
        expect(v._contentAge.attach).toHaveBeenCalledWith(next);
        expect(v._enhancerCeiling).toBe('gl-mwsr');
        expect(v._videoEnhancementAlgo).toBe('gl-mwsr');
        expect(v._wantWebGpu).toBe(false);
        expect(v._governor.ceiling).toBe('mwsr');
        expect(v._governor.level).toBe('mwsr');
        // the old renderer goes once its last draw is surely done
        expect(old.dispose).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(old.dispose).toHaveBeenCalledTimes(1);
    });

    it('resumes the ladder from the rung it stood on, under the same setting', async () => {
        createVideoRenderer.mockResolvedValue(made('webgl'));
        const v = view({
            _enhancerCeiling: 'fsr1',
            _videoEnhancementAlgo: 'mwsr',
            _governor: { degraded: true, level: 'mwsr', recoverAfterMs: 30000 },
        });
        await v._replaceFailedRenderer();
        expect(createVideoRenderer.mock.calls[0][1]).toMatchObject({
            algo: 'gl-mwsr',
            ceiling: 'gl-fsr1',
        });
        expect(v._governor.ceiling).toBe('fsr1');
        expect(v._governor.level).toBe('mwsr');
        expect(v._governor.recoverAfterMs).toBe(30000);
        expect(v._enhancerDegraded).toBe(true);
    });

    it('lands on Canvas2D where WebGL2 refuses, and names no pass', async () => {
        createVideoRenderer.mockResolvedValue(made('canvas2d'));
        const v = view();
        await v._replaceFailedRenderer();
        expect(v._renderer.kind).toBe('canvas2d');
        expect(v._videoEnhancementAlgo).toBe('off');
        // the overlay then reads "OFF (WebGL unavailable)"
        expect(v._enhancerCeiling).toBe('gl-mwsr');
        expect(v._governor).toBe(null);
    });

    it('puts a plain copy on the presenter the page uses for one', async () => {
        createVideoRenderer.mockResolvedValue(made('webgl'));
        const v = view({
            _enhancerCeiling: 'off',
            _videoEnhancementAlgo: 'off',
            _plainWebGl: true,
        });
        await v._replaceFailedRenderer();
        expect(createVideoRenderer.mock.calls[0][1]).toMatchObject({
            webgpu: false,
            algo: 'off',
            ceiling: 'off',
            plainWebGl: true,
        });
        expect(v._enhancerCeiling).toBe('off');
        expect(v._videoEnhancementAlgo).toBe('off');
    });

    it('leaves things as they are when the stream ended meanwhile', async () => {
        const next = made('webgl');
        createVideoRenderer.mockImplementation(async () => {
            v._quitting = true;
            return next;
        });
        const v = view();
        const old = v._renderer;
        await v._replaceFailedRenderer();
        expect(next.dispose).toHaveBeenCalledTimes(1);
        expect(v._renderer).toBe(old);
        expect(v._swappingRenderer).toBe(false);
    });

    it('hands over once per renderer, never while another swap runs or the view quits', () => {
        const v = view({ _replaceFailedRenderer: vi.fn() });
        v._checkRendererFailed();
        v._checkRendererFailed();
        expect(v._replaceFailedRenderer).toHaveBeenCalledTimes(1);
        for (const over of [
            { _swappingRenderer: true },
            { _quitting: true },
            { _renderer: null },
        ]) {
            const w = view({ _replaceFailedRenderer: vi.fn(), ...over });
            w._checkRendererFailed();
            expect(w._replaceFailedRenderer).not.toHaveBeenCalled();
        }
        const healthy = view({ _replaceFailedRenderer: vi.fn(), _renderer: made('webgpu') });
        healthy._checkRendererFailed();
        expect(healthy._replaceFailedRenderer).not.toHaveBeenCalled();
    });
});
