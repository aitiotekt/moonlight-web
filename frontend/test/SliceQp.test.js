/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';

import { SliceQpReader } from '../js/util/SliceQp.js';

// Eight frames of testsrc2 each, made by x264 and x265 under a one-frame VBV
// so that the QP moves; `qp` is what ffmpeg's own header parser
// (trace_headers) reads: 26 + the PPS's init QP + the first slice's delta.
const FIXTURES = JSON.parse(
    readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'slice-qp.json'),
        'utf8',
    ),
);

/** An elementary stream's NAL units, start codes kept. */
function nals(es) {
    const at = [];
    for (let i = 0; i + 2 < es.length; i++) {
        if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) {
            at.push(i > 0 && es[i - 1] === 0 ? i - 1 : i);
            i += 2;
        }
    }
    return at.map((s, k) => es.subarray(s, k + 1 < at.length ? at[k + 1] : es.length));
}

/** The stream cut into access units, as the decode path hands them over. */
function accessUnits(es, codec) {
    const units = [];
    let cur = [];
    let hasSlice = false;
    for (const n of nals(es)) {
        const h = n[2] === 1 ? 3 : 4;
        let slice, first;
        if (codec === 'hevc') {
            const type = (n[h] >> 1) & 0x3f;
            slice = type < 32;
            first = slice && (n[h + 2] & 0x80) !== 0;
        } else {
            const type = n[h] & 0x1f;
            slice = type === 1 || type === 5;
            first = slice && (n[h + 1] & 0x80) !== 0; // first_mb_in_slice = 0
        }
        if (hasSlice && (!slice || first)) {
            units.push(cur);
            cur = [];
            hasSlice = false;
        }
        cur.push(n);
        hasSlice = hasSlice || slice;
    }
    if (cur.length) units.push(cur);
    return units.map((parts) => {
        const au = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) {
            au.set(p, o);
            o += p.length;
        }
        return au;
    });
}

describe('SliceQpReader', () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
        it(`reads each frame's QP from its first slice (${name})`, () => {
            const es = Uint8Array.from(Buffer.from(fx.b64, 'base64'));
            const reader = new SliceQpReader(fx.codec);
            const qps = accessUnits(es, fx.codec).map((au) => reader.read(au));
            expect(qps).toEqual(fx.qp);
        });
    }

    it('gives null for a frame whose parameter sets it never saw', () => {
        const fx = FIXTURES['h264-p'];
        const units = accessUnits(Uint8Array.from(Buffer.from(fx.b64, 'base64')), 'h264');
        // The second frame alone: a delta frame, no SPS or PPS before it.
        expect(new SliceQpReader('h264').read(units[1])).toBeNull();
    });

    it('keeps the sets of a keyframe for the delta frames after it', () => {
        const fx = FIXTURES['hevc-p'];
        const units = accessUnits(Uint8Array.from(Buffer.from(fx.b64, 'base64')), 'hevc');
        const reader = new SliceQpReader('hevc');
        reader.read(units[0]);
        expect(reader.read(units[3])).toBe(fx.qp[3]);
    });

    it('gives null for a cut-off header and for AV1, never a guess', () => {
        const fx = FIXTURES['h264-b'];
        const units = accessUnits(Uint8Array.from(Buffer.from(fx.b64, 'base64')), 'h264');
        const reader = new SliceQpReader('h264');
        reader.read(units[0]);
        const delta = units[1];
        // The start code, the NAL header and one byte of the slice header.
        expect(reader.read(delta.subarray(0, 5))).toBeNull();
        expect(new SliceQpReader('av1').read(delta)).toBeNull();
    });

    it('stops at the first slice: a garbled slice body changes nothing', () => {
        const fx = FIXTURES['hevc-b'];
        const units = accessUnits(Uint8Array.from(Buffer.from(fx.b64, 'base64')), 'hevc');
        const reader = new SliceQpReader('hevc');
        const garbled = units.map((au) => {
            const g = au.slice();
            // Everything 40 bytes past the first slice's NAL header: well
            // beyond its header, into the slice data.
            const slice = nals(au).find((n) => ((n[n[2] === 1 ? 3 : 4] >> 1) & 0x3f) < 32);
            for (let i = slice.byteOffset - au.byteOffset + 44; i < g.length; i++) g[i] = 0;
            return g;
        });
        expect(garbled.map((au) => reader.read(au))).toEqual(fx.qp);
    });
});
