/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, expect, it, vi } from 'vitest';
import { RtpStallWatch, receivedPackets } from '../js/api/RtpStallWatch.js';

function watch() {
    let t = 1000;
    let packets = 0;
    const onStall = vi.fn();
    const w = new RtpStallWatch({
        packets: async () => packets,
        onStall,
        now: () => t,
    });
    return {
        w,
        onStall,
        advance: (ms, newPackets = 0) => {
            t += ms;
            packets += newPackets;
        },
    };
}

describe('RtpStallWatch', () => {
    it('stays quiet while frames come out', async () => {
        const { w, onStall, advance } = watch();
        await w.check();
        for (let i = 0; i < 10; i++) {
            advance(100, 50);
            w.noteFrame();
            await w.check();
        }
        expect(onStall).not.toHaveBeenCalled();
    });

    it('stays quiet on a desktop at rest: no packets, no frames', async () => {
        const { w, onStall, advance } = watch();
        await w.check();
        advance(2000, 0);
        await w.check();
        expect(onStall).not.toHaveBeenCalled();
    });

    it('calls a stall when packets keep coming and no frame comes out', async () => {
        const { w, onStall, advance } = watch();
        await w.check();
        advance(100, 40);
        expect(await w.check()).toBe(false); // 100 ms: not yet
        advance(200, 40);
        expect(await w.check()).toBe(true);
        expect(onStall).toHaveBeenCalledTimes(1);
        // A frame again: the watch is quiet again.
        w.noteFrame();
        advance(100, 40);
        expect(await w.check()).toBe(false);
    });

    it('a stats read that fails is no stall', async () => {
        const onStall = vi.fn();
        const w = new RtpStallWatch({
            packets: async () => {
                throw new Error('closed');
            },
            onStall,
        });
        expect(await w.check()).toBe(false);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('sums the inbound-rtp packets of a receiver', async () => {
        const stats = new Map([
            ['a', { type: 'inbound-rtp', packetsReceived: 12 }],
            ['b', { type: 'transport', packetsReceived: 999 }],
        ]);
        expect(await receivedPackets({ getStats: async () => stats })).toBe(12);
    });
});
