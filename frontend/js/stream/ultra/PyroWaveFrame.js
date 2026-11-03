// The CPU half of the PyroWave decoders (POC Ultra): the frame layout and the
// packet parser of pyrowave_decoder.cpp, shared by the WebGPU decoder
// (PyroWaveDecoder.js) and its WebGL2 fallback (PyroWaveDecoderGL.js).
//
// A port of parts of PyroWave by Hans-Kristian Arntzen
// (https://github.com/Themaister/pyrowave, commit 509e4f88):
//
//   Copyright (c) 2025 Hans-Kristian Arntzen
//   SPDX-License-Identifier: MIT
//
// A frame is gathered here as the payload words of its 32x32 blocks, back to
// back (`payloadCpu`), and the word offset of each block in the index order
// of bitstream.md (`offsetsCpu`, NONE for a block that did not come). The
// decoders upload both and do the rest on the GPU. A frame may also come in
// pieces cut anywhere (pushPiece): the WebGPU decoder then starts on the
// blocks already there, by slices.

export const LEVELS = 5;
export const NONE = 0xffffffff;
export const ALIGN = 1 << LEVELS;
export const MIN_SIZE = 4 << LEVELS;
const SEQ_MASK = 7;

export const alignUp = (v, a) => (v + a - 1) & ~(a - 1);

export class PyroWaveFrame {
    /**
     * @param {number} width picture width (even)
     * @param {number} height picture height (even)
     */
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.alignedW = Math.max(alignUp(width, ALIGN), MIN_SIZE);
        this.alignedH = Math.max(alignUp(height, ALIGN), MIN_SIZE);
        this._layout();
        this.offsetsCpu = new Uint32Array(this.blockCount);
        this.payloadCpu = new Uint32Array(1 << 20);
        this.clear();
    }

    // Planes, block metadata and the block index order of bitstream.md.
    _layout() {
        const W = this.alignedW;
        const H = this.alignedH;
        this.planeOf = {}; // "level,comp,band" -> float offset
        let floats = 0;
        for (let level = 0; level < LEVELS; level++) {
            for (let comp = 0; comp < 3; comp++) {
                if (level === 0 && comp !== 0) continue;
                for (let band = 0; band < 4; band++) {
                    this.planeOf[`${level},${comp},${band}`] = floats;
                    floats += (W >> (level + 1)) * (H >> (level + 1));
                }
            }
        }
        this.outY = floats;
        floats += W * H;
        this.outCb = floats;
        floats += (W / 2) * (H / 2);
        this.outCr = floats;
        floats += (W / 2) * (H / 2);
        this.coefFloats = floats;

        // The first block of each band, in the same order: "level,comp,band" -> index.
        this.firstBlockOf = {};
        const metas = [];
        for (let level = LEVELS - 1; level >= 0; level--) {
            for (let comp = 0; comp < 3; comp++) {
                if (level === 0 && comp !== 0) continue;
                for (let band = level === LEVELS - 1 ? 0 : 1; band < 4; band++) {
                    const w = W >> (level + 1);
                    const h = H >> (level + 1);
                    const plane = this.planeOf[`${level},${comp},${band}`];
                    this.firstBlockOf[`${level},${comp},${band}`] = metas.length / 4;
                    for (let by = 0; by < Math.ceil(h / 32); by++) {
                        for (let bx = 0; bx < Math.ceil(w / 32); bx++) {
                            metas.push(plane, w, h, bx | (by << 16));
                        }
                    }
                }
            }
        }
        this.blockCount = metas.length / 4;
        this.metas = new Uint32Array(metas);

        // The order our host sends blocks in (PyroWaveEncoder12::layout):
        // index order, except the finest level's three bands, interleaved by
        // rows of blocks. `sendOrder[pos]` is a block index, `posOf` the inverse.
        const f1 = this.firstBlockOf['0,0,1'];
        this.fineCols = Math.ceil(W / 2 / 32);
        this.fineRows = Math.ceil(H / 2 / 32);
        this.fineFirst = f1;
        this.sendOrder = new Uint32Array(this.blockCount);
        this.posOf = new Uint32Array(this.blockCount);
        let pos = 0;
        for (let i = 0; i < f1; i++) this.sendOrder[pos++] = i;
        const bandBlocks = this.fineCols * this.fineRows;
        for (let y = 0; y < this.fineRows; y++)
            for (let b = 0; b < 3; b++)
                for (let x = 0; x < this.fineCols; x++)
                    this.sendOrder[pos++] = f1 + b * bandBlocks + y * this.fineCols + x;
        this.sendOrder.forEach((index, p) => (this.posOf[index] = p));
    }

    /** Rows of blocks of the finest level whose three bands are settled below the frontier. */
    fineRowsSettled() {
        return Math.max(0, Math.floor((this.frontier - this.fineFirst) / (3 * this.fineCols)));
    }

    /**
     * A frame's packets (any block order, the reference encoder's for one)
     * as one buffer in our host's send order: what a decode by slices expects.
     */
    toSendOrder(packets) {
        let header = null;
        const blocks = new Array(this.blockCount);
        let total = 0;
        for (const p of packets) {
            const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
            for (let pos = 0; pos + 8 <= p.byteLength; ) {
                const w0 = dv.getUint32(pos, true);
                if (w0 >>> 31) {
                    header = p.subarray(pos, pos + 8);
                    pos += 8;
                    continue;
                }
                const size = ((w0 >>> 16) & 0xfff) * 4;
                blocks[dv.getUint32(pos + 4, true) >>> 8] = p.subarray(pos, pos + size);
                total += size;
                pos += size;
            }
        }
        const out = new Uint8Array((header ? 8 : 0) + total);
        let at = 0;
        if (header) {
            out.set(header);
            at = 8;
        }
        for (const index of this.sendOrder) {
            if (!blocks[index]) continue;
            out.set(blocks[index], at);
            at += blocks[index].length;
        }
        return out;
    }

    clear() {
        this.offsetsCpu.fill(NONE);
        this.payloadWords = 0;
        this.decodedBlocks = 0;
        this.totalBlocks = this.blockCount;
        this.lastSeq = -1;
        this.decodedThisSeq = false;
        // One past the furthest block seen, in send order (`sendOrder`):
        // every block before it that has not come never will.
        this.frontier = 0;
    }

    /** Feeds one network packet (one or more 32x32 blocks). False on a malformed packet. */
    pushPacket(bytes) {
        return this._parse(bytes, false) === bytes.byteLength;
    }

    /**
     * Feeds the next bytes of a frame cut anywhere (a transport's piece, for
     * the decode by slices): parses the whole blocks there. Returns the bytes
     * used, the rest to come again with the next piece; -1 when malformed.
     */
    pushPiece(bytes) {
        return this._parse(bytes, true);
    }

    _parse(bytes, piece) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let pos = 0;
        while (bytes.byteLength - pos >= 8) {
            const w0 = dv.getUint32(pos, true);
            const w1 = dv.getUint32(pos + 4, true);
            const seq = (w0 >>> 28) & 7;
            if (w0 >>> 31) {
                // Start of frame: dimensions and the number of coded blocks.
                if (!this._sequence(seq)) return bytes.byteLength;
                if (((w1 >>> 24) & 3) !== 0) return -1;
                if ((w0 & 0x3fff) + 1 !== this.width || ((w0 >>> 14) & 0x3fff) + 1 !== this.height)
                    return -1;
                if (((w1 >>> 26) & 1) !== 0) return -1; // 4:4:4 not handled here
                this.totalBlocks = w1 & 0xffffff;
                pos += 8;
                continue;
            }
            const words = (w0 >>> 16) & 0xfff;
            if (words < 2) return -1;
            if (words * 4 > bytes.byteLength - pos) return piece ? pos : -1;
            if (!this._sequence(seq)) return bytes.byteLength;
            const block = w1 >>> 8;
            if (block >= this.blockCount) return -1;
            if (this.offsetsCpu[block] === NONE) {
                // By slices, a block behind the frontier would land where the
                // GPU already took it as absent: a host that sends another order.
                if (piece && this.posOf[block] < this.frontier) return -1;
                this._ensurePayload(this.payloadWords + words);
                this.offsetsCpu[block] = this.payloadWords;
                // The block's words, copied as they are (little-endian on every WebGPU platform).
                const src = new Uint8Array(bytes.buffer, bytes.byteOffset + pos, words * 4);
                new Uint8Array(this.payloadCpu.buffer, this.payloadWords * 4, words * 4).set(src);
                this.payloadWords += words;
                this.decodedBlocks++;
                const p = this.posOf[block];
                if (p >= this.frontier) this.frontier = p + 1;
            }
            pos += words * 4;
        }
        return pos;
    }

    // False when the packet belongs to an older frame than the one in progress.
    _sequence(seq) {
        if (this.lastSeq < 0) {
            this.clear();
            this.lastSeq = seq;
            return true;
        }
        const diff = (seq - this.lastSeq) & SEQ_MASK;
        if (diff > SEQ_MASK / 2) return false;
        if (diff !== 0) {
            this.clear();
            this.lastSeq = seq;
        }
        return true;
    }

    _ensurePayload(words) {
        if (words <= this.payloadCpu.length) return;
        let n = this.payloadCpu.length;
        while (n < words) n *= 2;
        const grown = new Uint32Array(n);
        grown.set(this.payloadCpu.subarray(0, this.payloadWords));
        this.payloadCpu = grown;
        this._payloadGrown(n);
    }

    /** The payload array grew to `words`: a decoder resizes what holds it on the GPU. */
    _payloadGrown(words) {}

    /** Every block of the frame in progress arrived (or, partial, more than half). */
    isReady(allowPartial = false) {
        if (this.decodedThisSeq || this.lastSeq < 0) return false;
        if (this.decodedBlocks < this.totalBlocks) {
            return allowPartial && this.decodedBlocks > this.totalBlocks / 2;
        }
        return true;
    }
}
