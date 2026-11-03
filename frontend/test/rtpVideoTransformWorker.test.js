/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { afterEach, describe, expect, it } from 'vitest';

// The audio road's repair (plan « Wi-Fi », W4): a frame lost whole shows only
// as a hole in the seqs and is asked for whole; asks left unanswered go again.

function chunk(seq, idx, count, len = 100) {
    const b = new ArrayBuffer(12 + len);
    const dv = new DataView(b);
    dv.setUint8(0, 0x4d);
    dv.setUint16(2, seq);
    dv.setUint16(4, idx);
    dv.setUint16(6, count);
    dv.setUint32(8, seq);
    return { data: b, timestamp: seq, getMetadata: () => ({}) };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function road(options) {
    const posts = [];
    const queue = [];
    let wake = null;
    const reader = {
        read: () =>
            queue.length
                ? Promise.resolve({ value: queue.shift(), done: false })
                : new Promise((r) => {
                      wake = r;
                  }),
    };
    globalThis.self = { postMessage: (m) => posts.push(m) };
    await import('../js/api/rtpVideoTransformWorker.js?' + Math.random());
    globalThis.self.onrtctransform({
        transformer: {
            options: { mid: 'vaudio', ...options },
            readable: { getReader: () => reader },
        },
    });
    const give = (f) => {
        if (wake) {
            const w = wake;
            wake = null;
            w({ value: f, done: false });
        } else queue.push(f);
    };
    return { posts, give, nacks: () => posts.filter((p) => p.nack).map((p) => p.nack) };
}

describe('rtpVideoTransformWorker — the audio road repair', () => {
    const saved = globalThis.self;
    afterEach(() => {
        globalThis.self = saved;
    });

    it('asks for frames lost whole, asks again, and stops once answered', async () => {
        const r = await road({});
        r.give(chunk(0, 0, 1));
        await tick(1);
        r.give(chunk(3, 0, 1)); // seqs 1 and 2: no chunk came
        await tick(1);
        r.give(chunk(4, 0, 2)); // frame 4's chunk 1 lost
        await tick(1);
        r.give(chunk(5, 0, 1)); // a newer frame: frame 4's chunk 1 asked for
        await tick(60);
        const nacks = r.nacks();
        // The hole asked for whole, once.
        expect(nacks.filter((n) => n.all).map((n) => n.s)).toEqual([1, 2]);
        expect(nacks.some((n) => n.all && n.reask)).toBe(false);
        // The chunk asked for, then once again.
        expect(nacks.some((n) => n.s === 4 && !n.reask && n.i[0] === 1)).toBe(true);
        expect(nacks.filter((n) => n.reask && n.s === 4).length).toBe(1);
        r.posts.length = 0;
        r.give(chunk(1, 0, 1));
        r.give(chunk(2, 0, 1));
        r.give(chunk(4, 1, 2));
        await tick(30);
        expect(r.nacks()).toEqual([]);
    });

    it('gives up on a longer hole: a burst of the socket, not asked for', async () => {
        const r = await road({});
        r.give(chunk(0, 0, 1));
        await tick(1);
        r.give(chunk(4, 0, 1)); // seqs 1-3: a hole of 3
        await tick(5);
        expect(r.nacks().some((n) => n.all)).toBe(false);
    });

    it('asks nothing whole nor twice with mw_aroad_reask=0 (reask: false)', async () => {
        const r = await road({ reask: false });
        r.give(chunk(0, 0, 1));
        await tick(1);
        r.give(chunk(3, 0, 1));
        await tick(1);
        r.give(chunk(4, 0, 2));
        await tick(1);
        r.give(chunk(5, 0, 1));
        await tick(45);
        const nacks = r.nacks();
        expect(nacks.some((n) => n.all || n.reask)).toBe(false);
        expect(nacks).toEqual([{ t: 'v', s: 4, i: [1] }]);
    });
});

describe('rtpVideoTransformWorker — pieces of a frame still coming (decode by slices)', () => {
    const saved = globalThis.self;
    afterEach(() => {
        globalThis.self = saved;
    });

    const fill = (c, byte) => {
        new Uint8Array(c.data, 12).fill(byte);
        return c;
    };

    it('gives the front of a frame in pieces, never its last chunk, then the frame whole', async () => {
        const r = await road({ partBytes: 200 });
        r.give(fill(chunk(0, 0, 5), 1));
        await tick(1);
        r.give(fill(chunk(0, 1, 5), 2)); // 200 bytes in front: a piece
        await tick(1);
        r.give(fill(chunk(0, 3, 5), 4)); // a hole at 2: nothing more in front
        await tick(1);
        r.give(fill(chunk(0, 2, 5), 3)); // 2 and 3 now: a piece
        await tick(1);
        r.give(fill(chunk(0, 4, 5), 5)); // the last: the frame, whole
        await tick(1);
        const parts = r.posts.filter((p) => p.part);
        expect(parts.map((p) => p.part)).toEqual([
            { fid: 0, off: 0 },
            { fid: 0, off: 200 },
        ]);
        expect([...new Uint8Array(parts[1].data)].filter((b, i) => i % 100 === 0)).toEqual([3, 4]);
        const whole = r.posts.find((p) => p.data && !p.part);
        expect(whole.data.byteLength).toBe(500);
        await tick(10); // the ack's timer, before self goes
    });

    it('gives no piece without partBytes', async () => {
        const r = await road({});
        r.give(chunk(0, 0, 3));
        r.give(chunk(0, 1, 3));
        await tick(1);
        expect(r.posts.some((p) => p.part)).toBe(false);
        await tick(10);
    });
});
