/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PyroWaveDecoder } from '../js/stream/ultra/PyroWaveDecoder.js';

/**
 * The present pass's pipeline in the canvas's own format (Bruno's Mac,
 * Chrome 126, 13/10/2026): without getConfiguration() the pipeline followed
 * the preferred format, bgra8unorm, while the player's canvas was configured
 * rgba8unorm — every frame refused by WebGPU, a black screen.
 */
const present = PyroWaveDecoder.prototype.present;

function gpu() {
    const pipelines = [];
    const device = {
        createShaderModule: () => ({}),
        createRenderPipeline: (desc) => {
            pipelines.push(desc.fragment.targets[0].format);
            return { getBindGroupLayout: () => ({}) };
        },
        createBuffer: () => ({}),
        createBindGroup: () => ({}),
        queue: { writeBuffer: vi.fn() },
    };
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const encoder = { beginRenderPass: vi.fn(() => pass) };
    const decoder = { device, fp16: false, coefBuf: {}, width: 1280, height: 720, alignedW: 1280 };
    return { pipelines, encoder, decoder };
}

/** A canvas context configured in @p format, as Chrome 126 shows it: no getConfiguration(). */
function context(format, withConfiguration = false) {
    const ctx = {
        getCurrentTexture: () => ({ format, createView: () => ({}) }),
    };
    if (withConfiguration) ctx.getConfiguration = () => ({ format });
    return ctx;
}

describe('PyroWaveDecoder.present — the pipeline matches the canvas', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('draws an rgba8unorm canvas where the device prefers bgra8unorm', () => {
        vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8 });
        const { pipelines, encoder, decoder } = gpu();
        present.call(decoder, encoder, context('rgba8unorm'), true);
        expect(pipelines).toEqual(['rgba8unorm']);
        expect(encoder.beginRenderPass).toHaveBeenCalledTimes(1);
    });

    it('follows the canvas it is given, one pipeline per format', () => {
        vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8 });
        const { pipelines, encoder, decoder } = gpu();
        present.call(decoder, encoder, context('rgba8unorm'), true);
        present.call(decoder, encoder, context('rgba8unorm'), true);
        // The page's own canvas, configured in the preferred format.
        present.call(decoder, encoder, context('bgra8unorm', true), true);
        expect(pipelines).toEqual(['rgba8unorm', 'bgra8unorm']);
    });
});
