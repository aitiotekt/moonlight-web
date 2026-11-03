/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The stats card's codec line over a PyroWave stream (13/10/2026): the launch
 * asks for the HEVC PyroWave falls back to, and the card read "HEVC" while
 * the picture was PyroWave. Only the value changes; the other codecs read as
 * they did.
 */
const P = StreamView.prototype;

describe('StreamView._statsCodecName — the codec the card names', () => {
    it('names PyroWave once a PyroWave frame was drawn', () => {
        expect(P._statsCodecName.call({ _ultraFrames: 1 }, 'hevc')).toBe('PyroWave');
        expect(P._statsCodecName.call({ _ultraFrames: 240 }, 'hevc')).toBe('PyroWave');
    });

    it('keeps the HEVC of a PyroWave launch the host did not take', () => {
        expect(P._statsCodecName.call({}, 'hevc')).toBe('HEVC');
        expect(P._statsCodecName.call({ _ultraFrames: 0 }, 'hevc')).toBe('HEVC');
    });

    it('reads the other codecs as before', () => {
        expect(P._statsCodecName.call({}, 'h264')).toBe('H264');
        expect(P._statsCodecName.call({}, 'av1')).toBe('AV1');
    });
});
