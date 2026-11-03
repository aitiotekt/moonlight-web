import { describe, it, expect } from 'vitest';
import { PyroWaveFrame } from '../js/stream/ultra/PyroWaveFrame.js';

// A block of two words (the smallest the parser takes), sequence 0.
const block = (index) => new Uint32Array([2 << 16, index << 8]);
const bytesOf = (...words) => {
    const all = new Uint32Array(words.reduce((a, w) => a + w.length, 0));
    let at = 0;
    for (const w of words) {
        all.set(w, at);
        at += w.length;
    }
    return new Uint8Array(all.buffer);
};

describe('PyroWaveFrame send order', () => {
    // 512x256: the finest level's bands are 256x128, 8 x 4 blocks each.
    const f = new PyroWaveFrame(512, 256);
    const f1 = f.firstBlockOf['0,0,1'];

    it('is index order, then the finest level by rows of its three bands', () => {
        expect(f.fineCols).toBe(8);
        expect(f.fineRows).toBe(4);
        expect([...f.sendOrder].sort((a, b) => a - b)).toEqual([...Array(f.blockCount).keys()]);
        for (let i = 0; i < f1; i++) expect(f.sendOrder[i]).toBe(i);
        // Row 0 of band 1, row 0 of band 2, row 0 of band 3, then row 1 of band 1.
        expect(f.sendOrder[f1 + 8]).toBe(f.firstBlockOf['0,0,2']);
        expect(f.sendOrder[f1 + 16]).toBe(f.firstBlockOf['0,0,3']);
        expect(f.sendOrder[f1 + 24]).toBe(f1 + 8);
        for (let p = 0; p < f.blockCount; p++) expect(f.posOf[f.sendOrder[p]]).toBe(p);
    });

    it('settles a row of the finest level once its three bands passed it', () => {
        f.clear();
        // Up to the last block of band 3's row 0, then band 1's row 1 begins.
        const upTo = [...f.sendOrder.slice(0, f1 + 23)].map(block);
        expect(f.pushPiece(bytesOf(...upTo))).toBeGreaterThan(0);
        expect(f.fineRowsSettled()).toBe(0);
        expect(f.pushPiece(bytesOf(block(f.sendOrder[f1 + 23])))).toBe(8);
        expect(f.fineRowsSettled()).toBe(1);
    });

    it('refuses, by slices, a block behind the frontier (another order)', () => {
        f.clear();
        // Index order: band 1's row 1 before band 2's row 0.
        expect(f.pushPiece(bytesOf(block(f1), block(f1 + 8)))).toBe(16);
        expect(f.pushPiece(bytesOf(block(f.firstBlockOf['0,0,2'])))).toBe(-1);
        // A whole frame doesn't care.
        f.clear();
        expect(
            f.pushPacket(bytesOf(block(f1), block(f1 + 8), block(f.firstBlockOf['0,0,2']))),
        ).toBe(true);
    });

    it('rewrites a frame in index order into the send order', () => {
        const header = new Uint32Array([(511 | (255 << 14) | (1 << 31)) >>> 0, 3]);
        const b2 = f.firstBlockOf['0,0,2'];
        const out = f.toSendOrder([bytesOf(header, block(f1 + 8)), bytesOf(block(b2), block(0))]);
        const w = new Uint32Array(out.buffer);
        expect(w[0]).toBe(header[0]);
        expect([w[3] >>> 8, w[5] >>> 8, w[7] >>> 8]).toEqual([0, b2, f1 + 8]);
    });
});
