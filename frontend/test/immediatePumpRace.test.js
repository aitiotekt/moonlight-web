/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * Tearing on: the queue is pumped on decode, nowhere else. An HDR renderer
 * compiles its pipelines while dav1d already decodes, so frames came out
 * before it was there. Three of them filled the queue, and every frame after
 * was dropped as "full" before the pump: no draw ever, a black screen one AV1
 * HDR launch in two (Chrome on Windows, 26/10/2026 — "fps in/out 31/0 ·
 * frmQ 0.0/0 · full 1268").
 */
const P = StreamView.prototype;

function frame(i) {
    return { displayWidth: 1920, displayHeight: 1080, timestamp: i, close: vi.fn() };
}

function view(over = {}) {
    return {
        stats: { decoded: 0, dropped: 0, rendered: 0 },
        _tellDecodeQueue() {},
        _recoveryAttempts: 0,
        _recoveryStartedPerf: 0,
        _fpsTimestamps: [],
        _resolution: '',
        _chunkSubmitTimes: new Map(),
        _contentAge: { running: false },
        _vsyncGrid: { running: false, aimed: false },
        _framePacer: null,
        frameQueue: [],
        _diag: { noteDrop: vi.fn(), noteFrameQueue: vi.fn(), noteDraw: vi.fn() },
        _immediateRender: true,
        _firstFrameRendered: true,
        renderRunning: true,
        _renderer: null,
        _drawsInFlight: 0,
        _nextCanvas: null,
        _clientQueueStats: { addSample() {} },
        onDecodedFrame: P.onDecodedFrame,
        _pumpRender: P._pumpRender,
        ...over,
    };
}

/** A renderer whose draws never finish: what is asked of it is all that counts. */
function renderer() {
    return { kind: 'webgpu', draw: vi.fn(() => new Promise(() => {})) };
}

describe('StreamView — tearing, frames decoded before the renderer', () => {
    it('draws once the renderer is there, though the queue filled before it', () => {
        const v = view();
        const frames = [0, 1, 2, 3, 4].map(frame);
        for (const f of frames) v.onDecodedFrame(f);
        // no renderer yet: three wait, the rest is dropped
        expect(v.frameQueue).toHaveLength(3);
        expect(v._diag.noteDrop).toHaveBeenCalledWith('queueFull');

        v._renderer = renderer();
        const next = frame(5);
        v.onDecodedFrame(next);
        // the stale ones are let go, and something is drawn
        expect(v._renderer.draw).toHaveBeenCalled();
        expect(frames[0].close).toHaveBeenCalled();
        expect(next.close).not.toHaveBeenCalled();
    });

    it('keeps the queue bounded while no renderer exists', () => {
        const v = view();
        for (let i = 0; i < 20; i++) v.onDecodedFrame(frame(i));
        expect(v.frameQueue).toHaveLength(3);
        expect(v.stats.dropped).toBe(17);
    });

    it('leaves the vsync path to its rAF loop', () => {
        const v = view({ _immediateRender: false, _renderer: renderer() });
        for (let i = 0; i < 5; i++) v.onDecodedFrame(frame(i));
        expect(v._renderer.draw).not.toHaveBeenCalled();
        expect(v.frameQueue).toHaveLength(3);
    });
});
