// PyroWave decoder on WebGL2 fragment shaders: the fallback of the WebGPU
// decoder (PyroWaveDecoder.js) for browsers with WebGL2 and no WebGPU adapter
// (POC Ultra: Android TV boxes, older Safari, Firefox off Windows).
//
// A port of the decoder of PyroWave by Hans-Kristian Arntzen
// (https://github.com/Themaister/pyrowave, commit 509e4f88), the shaders
// wavelet_dequant.comp and idwt.comp:
//
//   Copyright (c) 2025 Hans-Kristian Arntzen
//   SPDX-License-Identifier: MIT
//
// WebGL2 has no compute and no scattered write, so each step becomes a pass
// in which every fragment computes one output, gathering what it needs:
// - info: per 32x32 block, the byte offset of each 8x8 block's bit planes and
//   the bit offset of its signs (upstream's planeOffsets / signStart);
// - mags: per decode thread of a block (upstream's 128 invocations), its 8
//   magnitudes, scaled, and how many are non-zero;
// - groups: the non-zero counts of each run of 16 threads;
// - signs: per thread, the exclusive count of non-zero values before it (the
//   scan upstream does in workgroup memory), then its sign bits;
// - per level and component, the inverse wavelet: one pass along the rows,
//   reading the coefficients straight from the thread texture, then one
//   along the columns. Each output sample runs the four CDF 9/7 lifting steps
//   on its own 9-sample window, mirrored at the edges (JPEG 2000 whole-sample
//   symmetric extension, as the WebGPU decoder does).
// The output is the same f32 planes (before the DC shift), drawn as RGB by
// present(), or read back as 8-bit 4:2:0 by readPlanes() (the lab).

import { LEVELS, NONE, PyroWaveFrame } from './PyroWaveFrame.js';

// Blocks per row of the per-block textures: 128 threads x 16 = 2048 texels,
// the width every WebGL2 implementation takes.
const BPR = 16;
// Width of the payload and offset textures, in 32-bit words.
const WORDS_PER_ROW = 4096;

const VS = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
const uint NONE = ${NONE}u;
const int BPR = ${BPR};
uniform usampler2D payload;
uniform usampler2D offsets;
uint word(uint i) { return texelFetch(payload, ivec2(int(i & ${WORDS_PER_ROW - 1}u), int(i >> ${Math.log2(WORDS_PER_ROW)}u)), 0).r; }
uint u8at(uint i) { return (word(i >> 2u) >> ((i & 3u) * 8u)) & 0xffu; }
uint u16at(uint i) { return (word(i >> 1u) >> ((i & 1u) * 16u)) & 0xffffu; }
uint blockOffset(int b) { return texelFetch(offsets, ivec2(b & ${WORDS_PER_ROW - 1}, b >> ${Math.log2(WORDS_PER_ROW)}), 0).r; }
uint popc(uint v) {
    v = v - ((v >> 1u) & 0x55555555u);
    v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
    v = (v + (v >> 4u)) & 0x0f0f0f0fu;
    return (v * 0x01010101u) >> 24u;
}
// The planes of a 2-bit-per-subblock control word below a bit position.
uint planesBelow(uint code, uint bits) {
    uint mask = bits >= 32u ? 0xffffffffu : (1u << bits) - 1u;
    uint lsbs = code & 0x5555u;
    uint msbs = code & 0xaaaau;
    msbs = msbs | (msbs >> 1u);
    return popc(lsbs & mask) + popc(msbs & mask);
}
`;

// Per block b (row b / BPR, 5 texels at (b % BPR) * 5 + j): j < 4 holds
// planeOffsets[4j .. 4j+3], j = 4 holds signStart in x.
const INFO_FS =
    HEAD +
    `
uniform int blockCount;
out uvec4 o;
void main() {
    int tx = int(gl_FragCoord.x), ty = int(gl_FragCoord.y);
    int b = ty * BPR + tx / 5, j = tx - (tx / 5) * 5;
    uint off = b < blockCount ? blockOffset(b) : NONE;
    if (off == NONE) { o = uvec4(0u); return; }
    uint ballot = word(off) & 0xffffu;
    uint pc = popc(ballot);
    uint codeBase = off * 2u + 4u;
    uint qsBase = off * 4u + 8u + pc * 2u;
    uint acc = off * 4u + 8u + pc * 3u;
    uint po[16];
    for (int k = 0; k < 16; k++) {
        po[k] = acc;
        if (((ballot >> uint(k)) & 1u) != 0u) {
            uint idx = popc(ballot & ((1u << uint(k)) - 1u));
            acc += planesBelow(u16at(codeBase + idx), 32u) + (u8at(qsBase + idx) & 0xfu) * 8u;
        }
    }
    if (j == 4) { o = uvec4(acc * 8u, 0u, 0u, 0u); return; }
    o = uvec4(po[4 * j], po[4 * j + 1], po[4 * j + 2], po[4 * j + 3]);
}`;

// Per thread li of block b (texel (b % BPR) * 128 + li, row b / BPR): the
// magnitudes of its 8 pixels, scaled (the 4x2 subblock, column-major), and
// how many are non-zero.
const MAGS_FS =
    HEAD +
    `
uniform highp usampler2D info;
layout(location = 0) out vec4 lo;
layout(location = 1) out vec4 hi;
layout(location = 2) out uint count;
float decodeQuant(uint q) {
    int e = 4 - int(q >> 3u);
    int m = int(q & 7u);
    return float(8 + m) * exp2(float(e - 3));
}
void main() {
    int tx = int(gl_FragCoord.x), ty = int(gl_FragCoord.y);
    int bc = tx >> 7;
    int b = ty * BPR + bc;
    uint li = uint(tx & 127);
    float v[8];
    for (int k = 0; k < 8; k++) v[k] = 0.0;
    uint n = 0u;
    uint off = blockOffset(b);
    if (off != NONE) {
        uint ballot = word(off) & 0xffffu;
        uint qCode = word(off + 1u) & 0xffu;
        uint pc = popc(ballot);
        uint codeBase = off * 2u + 4u;
        uint qsBase = off * 4u + 8u + pc * 2u;
        uint sub = li & 7u;
        uint bx = (li >> 3u) & 3u;
        uint by = (li >> 5u) & 3u;
        uint lb = by * 4u + bx;
        if (((ballot >> lb) & 1u) != 0u) {
            uint idx = popc(ballot & ((1u << lb) - 1u));
            uint cw = u16at(codeBase + idx);
            uint qs = u8at(qsBase + idx);
            uint qBits = qs & 0xfu;
            uint lcode = (cw >> (2u * sub)) & 3u;
            if (cw != 0u) {
                uvec4 inf = texelFetch(info, ivec2(bc * 5 + int(lb >> 2u), ty), 0);
                uint po = inf[int(lb & 3u)];
                uint byteOffset = planesBelow(cw, 2u * sub) + qBits * sub + po;
                uint mag[8];
                for (int k = 0; k < 8; k++) mag[k] = 0u;
                int planes = int(qBits + lcode);
                for (int q = planes - 1; q >= 0; q--) {
                    uint bv = u8at(byteOffset);
                    for (int k = 0; k < 8; k++) mag[k] |= ((bv >> uint(k)) & 1u) << uint(q);
                    byteOffset++;
                }
                float scale = decodeQuant(qCode) * (float((qs >> 4u) & 0xfu) / 8.0 + 0.25);
                for (int k = 0; k < 8; k++) {
                    if (mag[k] != 0u) {
                        v[k] = (float(mag[k]) + 0.5) * scale;
                        n++;
                    }
                }
            }
        }
    }
    lo = vec4(v[0], v[1], v[2], v[3]);
    hi = vec4(v[4], v[5], v[6], v[7]);
    count = n;
}`;

// Per run g of 16 threads of block b (texel (b % BPR) * 8 + g): their non-zero count.
const GROUPS_FS =
    HEAD +
    `
uniform highp usampler2D counts;
out uint o;
void main() {
    int tx = int(gl_FragCoord.x), ty = int(gl_FragCoord.y);
    int base = (tx >> 3) * 128 + (tx & 7) * 16;
    uint s = 0u;
    for (int t = 0; t < 16; t++) s += texelFetch(counts, ivec2(base + t, ty), 0).r;
    o = s;
}`;

// Per thread: its signs, which follow all magnitudes of the block in thread
// order, at the exclusive count of the non-zero values before it.
const SIGNS_FS =
    HEAD +
    `
uniform highp usampler2D info;
uniform highp usampler2D counts;
uniform highp usampler2D groups;
uniform sampler2D magLo;
uniform sampler2D magHi;
layout(location = 0) out vec4 lo;
layout(location = 1) out vec4 hi;
void main() {
    ivec2 at = ivec2(gl_FragCoord.xy);
    int bc = at.x >> 7;
    int li = at.x & 127;
    vec4 a = texelFetch(magLo, at, 0);
    vec4 c = texelFetch(magHi, at, 0);
    uint n = texelFetch(counts, at, 0).r;
    if (n == 0u) { lo = a; hi = c; return; }
    uint before = 0u;
    int g = li >> 4;
    for (int k = 0; k < g; k++) before += texelFetch(groups, ivec2(bc * 8 + k, at.y), 0).r;
    for (int t = g * 16; t < li; t++) before += texelFetch(counts, ivec2(bc * 128 + t, at.y), 0).r;
    uint signOffset = texelFetch(info, ivec2(bc * 5 + 4, at.y), 0).x + before;
    uint w = signOffset >> 5u;
    uint sh = signOffset & 31u;
    uint signs = word(w) >> sh;
    if (sh != 0u) signs |= word(w + 1u) << (32u - sh);
    // Filled element by element: Mali's compiler finds no precision for an
    // array constructor, whatever the default.
    float v[8];
    for (int k = 0; k < 4; k++) {
        v[k] = a[k];
        v[k + 4] = c[k];
    }
    uint m = 0u;
    for (int k = 0; k < 8; k++) {
        if (v[k] != 0.0) {
            if (((signs >> m) & 1u) != 0u) v[k] = -v[k];
            m++;
        }
    }
    lo = vec4(v[0], v[1], v[2], v[3]);
    hi = vec4(v[4], v[5], v[6], v[7]);
}`;

// The CDF 9/7 lifting of one sample on its 9-sample window s (s[4] is the
// sample, p its parity): upstream's constants and step order.
const LIFT = `
const float ALPHA = -1.586134342059924;
const float BETA = -0.052980118572961;
const float GAMMA = 0.882911075530934;
const float DELTA = 0.443506852043971;
const float K = 1.230174104914001;
const float INV_K = 1.0 / 1.230174104914001;
int mirror(int i, int n) {
    int j = i < 0 ? -i : i;
    return j > n - 1 ? 2 * (n - 1) - j : j;
}
float lift(inout float s[9], int p) {
    for (int i = 1; i < 8; i++) if (((p + i) & 1) == 0) s[i] -= DELTA * (s[i - 1] + s[i + 1]);
    for (int i = 2; i < 7; i++) if (((p + i) & 1) == 1) s[i] -= GAMMA * (s[i - 1] + s[i + 1]);
    for (int i = 3; i < 6; i++) if (((p + i) & 1) == 0) s[i] -= BETA * (s[i - 1] + s[i + 1]);
    if (p == 1) s[4] -= ALPHA * (s[3] + s[5]);
    return s[4];
}
`;

// One level of one component along the rows. The interleaved signal is 2w x
// 2h: LL at even x and y (the level below's output, or the coefficients at
// the deepest level), HL odd x, LH odd y, HH both odd, read from the signed
// thread texture by block index. Scaled by K / 1/K in each direction first.
const ROW_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
const int BPR = ${BPR};
uniform sampler2D coefLo;
uniform sampler2D coefHi;
uniform sampler2D ll;
uniform ivec4 first;  // first block of LL (or -1: from ll), HL, LH, HH
uniform int blocksPerRow;  // blocks across one band
uniform ivec2 size;  // 2w, 2h
out vec4 o;
${LIFT}
float coef(int band, int x, int y) {
    int b = first[band] + (y >> 5) * blocksPerRow + (x >> 5);
    int lx = x & 31, ly = y & 31;
    int sx = lx & 7, sy = ly & 7;
    int li = (((sx >> 2) << 2) | (sy >> 1)) | ((lx >> 3) << 3) | ((ly >> 3) << 5);
    int k = ((sx & 3) << 1) | (sy & 1);
    ivec2 at = ivec2((b % BPR) * 128 + li, b / BPR);
    return k < 4 ? texelFetch(coefLo, at, 0)[k] : texelFetch(coefHi, at, 0)[k - 4];
}
float sample0(int x, int y) {
    x = mirror(x, size.x);
    bool xo = (x & 1) == 1, yo = (y & 1) == 1;
    float v;
    if (!xo && !yo)
        v = first.x < 0 ? texelFetch(ll, ivec2(x >> 1, y >> 1), 0).r : coef(0, x >> 1, y >> 1);
    else
        v = coef(yo ? (xo ? 3 : 2) : 1, x >> 1, y >> 1);
    return v * (xo ? INV_K : K) * (yo ? INV_K : K);
}
void main() {
    int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
    float s[9];
    for (int i = 0; i < 9; i++) s[i] = sample0(x - 4 + i, y);
    o = vec4(lift(s, x & 1));
}`;

const COL_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D rows;
uniform int height;  // 2h
out vec4 o;
${LIFT}
void main() {
    int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
    float s[9];
    for (int i = 0; i < 9; i++) s[i] = texelFetch(rows, ivec2(x, mirror(y - 4 + i, height)), 0).r;
    o = vec4(lift(s, y & 1));
}`;

// The decoded planes drawn as RGB, top row first: Y at its pixel, Cb and Cr
// at half resolution (nearest), BT.709, limited or full range.
const PRESENT_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D planeY;
uniform sampler2D planeCb;
uniform sampler2D planeCr;
uniform int height;
uniform bool limited;
out vec4 o;
void main() {
    int x = int(gl_FragCoord.x), y = height - 1 - int(gl_FragCoord.y);
    float yv = clamp(texelFetch(planeY, ivec2(x, y), 0).r + 0.5, 0.0, 1.0);
    float cb = clamp(texelFetch(planeCb, ivec2(x >> 1, y >> 1), 0).r + 0.5, 0.0, 1.0) - 0.5;
    float cr = clamp(texelFetch(planeCr, ivec2(x >> 1, y >> 1), 0).r + 0.5, 0.0, 1.0) - 0.5;
    if (limited) {
        yv = (yv * 255.0 - 16.0) / 219.0;
        cb = cb * 255.0 / 224.0;
        cr = cr * 255.0 / 224.0;
    }
    vec3 rgb = vec3(yv + 1.5748 * cr, yv - 0.1873 * cb - 0.4681 * cr, yv + 1.8556 * cb);
    o = vec4(clamp(rgb, vec3(0.0), vec3(1.0)), 1.0);
}`;

/** True when this WebGL2 context can run the decoder (it renders to f32 targets). */
export function glDecoderSupported(gl) {
    return !!gl && !!gl.getExtension('EXT_color_buffer_float');
}

export class PyroWaveDecoderGL extends PyroWaveFrame {
    /**
     * @param {WebGL2RenderingContext} gl a context of the canvas present() draws to
     *        (glDecoderSupported() true for it)
     * @param {number} width picture width (even)
     * @param {number} height picture height (even)
     */
    constructor(gl, width, height) {
        super(width, height);
        this.gl = gl;
        gl.getExtension('EXT_color_buffer_float');
        this._programs();
        this._textures();
    }

    _programs() {
        const gl = this.gl;
        const build = (fs) => {
            const p = gl.createProgram();
            for (const [type, src] of [
                [gl.VERTEX_SHADER, VS],
                [gl.FRAGMENT_SHADER, fs],
            ]) {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                    throw new Error('PyroWave GL shader: ' + gl.getShaderInfoLog(s));
                gl.attachShader(p, s);
                gl.deleteShader(s);
            }
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS))
                throw new Error('PyroWave GL program: ' + gl.getProgramInfoLog(p));
            const u = {};
            const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const name = gl.getActiveUniform(p, i).name;
                u[name] = gl.getUniformLocation(p, name);
            }
            return { p, u };
        };
        this.prog = {
            info: build(INFO_FS),
            mags: build(MAGS_FS),
            groups: build(GROUPS_FS),
            signs: build(SIGNS_FS),
            row: build(ROW_FS),
            col: build(COL_FS),
            present: build(PRESENT_FS),
        };
        this.vao = gl.createVertexArray();
    }

    _tex(format, w, h) {
        const gl = this.gl;
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return { t, w, h };
    }

    _fbo(...targets) {
        const gl = this.gl;
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        targets.forEach((T, i) =>
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0 + i,
                gl.TEXTURE_2D,
                T.t,
                0,
            ),
        );
        gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('PyroWave GL framebuffer incomplete: 0x' + status.toString(16));
        return { fb, w: targets[0].w, h: targets[0].h };
    }

    _textures() {
        const gl = this.gl;
        const rows = Math.ceil(this.blockCount / BPR);
        this.offsetRows = Math.ceil(this.blockCount / WORDS_PER_ROW);
        // Past the last block, "not sent": the passes run on whole rows of BPR blocks.
        this.offsetsPadded = new Uint32Array(this.offsetRows * WORDS_PER_ROW).fill(NONE);
        this.offsetsTex = this._tex(gl.R32UI, WORDS_PER_ROW, this.offsetRows);
        this._payloadGrown(this.payloadCpu.length);

        this.infoTex = this._tex(gl.RGBA32UI, BPR * 5, rows);
        this.magLo = this._tex(gl.RGBA32F, BPR * 128, rows);
        this.magHi = this._tex(gl.RGBA32F, BPR * 128, rows);
        this.counts = this._tex(gl.R32UI, BPR * 128, rows);
        this.groupsTex = this._tex(gl.R32UI, BPR * 8, rows);
        this.coefLo = this._tex(gl.RGBA32F, BPR * 128, rows);
        this.coefHi = this._tex(gl.RGBA32F, BPR * 128, rows);
        this.infoFb = this._fbo(this.infoTex);
        this.magsFb = this._fbo(this.magLo, this.magHi, this.counts);
        this.groupsFb = this._fbo(this.groupsTex);
        this.signsFb = this._fbo(this.coefLo, this.coefHi);

        // Per level, deepest first, and component: the row pass's output and
        // the level's (the level above's LL, or a decoded plane).
        this.passes = [];
        for (let level = LEVELS - 1; level >= 0; level--) {
            const w = this.alignedW >> (level + 1);
            const h = this.alignedH >> (level + 1);
            for (let comp = 0; comp < (level === 0 ? 1 : 3); comp++) {
                const first = [0, 1, 2, 3].map((band) =>
                    band === 0 && level !== LEVELS - 1
                        ? -1
                        : this.firstBlockOf[`${level},${comp},${band}`],
                );
                const rowsT = this._tex(gl.R32F, 2 * w, 2 * h);
                const out = this._tex(gl.R32F, 2 * w, 2 * h);
                this.passes.push({
                    level,
                    comp,
                    first,
                    blocksPerRow: Math.ceil(w / 32),
                    rows: rowsT,
                    rowsFb: this._fbo(rowsT),
                    out,
                    outFb: this._fbo(out),
                });
            }
        }
        const outOf = (level, comp) =>
            this.passes.find((p) => p.level === level && p.comp === comp).out;
        for (const p of this.passes) p.ll = p.first[0] < 0 ? outOf(p.level + 1, p.comp) : null;
        this.planeY = outOf(0, 0);
        this.planeCb = outOf(1, 1);
        this.planeCr = outOf(1, 2);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    _payloadGrown(words) {
        const gl = this.gl;
        if (this.payloadTex) gl.deleteTexture(this.payloadTex.t);
        this.payloadTex = this._tex(gl.R32UI, WORDS_PER_ROW, Math.ceil(words / WORDS_PER_ROW));
    }

    _bind(unit, T) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, T.t);
        return unit;
    }

    _draw(prog, target, textures, ints = {}) {
        const gl = this.gl;
        gl.useProgram(prog.p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
        gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
        let unit = 0;
        for (const [name, T] of Object.entries(textures)) {
            if (prog.u[name] !== undefined) gl.uniform1i(prog.u[name], this._bind(unit++, T));
        }
        for (const [name, v] of Object.entries(ints)) {
            const loc = prog.u[name];
            if (loc === undefined) continue;
            if (Array.isArray(v)) (v.length === 4 ? gl.uniform4iv : gl.uniform2iv).call(gl, loc, v);
            else gl.uniform1i(loc, v);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Records the decode of the frame in progress: the planes end in planeY/Cb/Cr. */
    decode() {
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.SCISSOR_TEST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        const rows = Math.max(1, Math.ceil(this.payloadWords / WORDS_PER_ROW));
        gl.bindTexture(gl.TEXTURE_2D, this.payloadTex.t);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            WORDS_PER_ROW,
            rows,
            gl.RED_INTEGER,
            gl.UNSIGNED_INT,
            this.payloadCpu,
            0,
        );
        this.offsetsPadded.set(this.offsetsCpu);
        gl.bindTexture(gl.TEXTURE_2D, this.offsetsTex.t);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            WORDS_PER_ROW,
            this.offsetRows,
            gl.RED_INTEGER,
            gl.UNSIGNED_INT,
            this.offsetsPadded,
        );

        const P = this.prog;
        const io = { payload: this.payloadTex, offsets: this.offsetsTex };
        this._draw(P.info, this.infoFb, io, { blockCount: this.blockCount });
        this._draw(P.mags, this.magsFb, { ...io, info: this.infoTex });
        this._draw(P.groups, this.groupsFb, { counts: this.counts });
        this._draw(P.signs, this.signsFb, {
            ...io,
            info: this.infoTex,
            counts: this.counts,
            groups: this.groupsTex,
            magLo: this.magLo,
            magHi: this.magHi,
        });
        for (const p of this.passes) {
            const tex = { coefLo: this.coefLo, coefHi: this.coefHi };
            if (p.ll) tex.ll = p.ll;
            else tex.ll = this.coefLo; // unread: LL comes from the coefficients
            this._draw(P.row, p.rowsFb, tex, {
                first: p.first,
                blocksPerRow: p.blocksPerRow,
                size: [p.rows.w, p.rows.h],
            });
            this._draw(P.col, p.outFb, { rows: p.rows }, { height: p.rows.h });
        }
        this.decodedThisSeq = true;
    }

    /** Draws the last decoded frame to the context's canvas (BT.709, limited or full range). */
    present(limited = true) {
        this._draw(
            this.prog.present,
            null,
            { planeY: this.planeY, planeCb: this.planeCb, planeCr: this.planeCr },
            { height: this.height, limited: limited ? 1 : 0 },
        );
    }

    /** The last decoded frame as 8-bit 4:2:0, cropped, as the reference decoder writes it (the lab). */
    readPlanes() {
        const gl = this.gl;
        const out = new Uint8Array((this.width * this.height * 3) / 2);
        const q = (v) => Math.round(Math.min(1, Math.max(0, v + 0.5)) * 255);
        let at = 0;
        const read = (T, w, h) => {
            const fb = this._fbo(T);
            const px = new Float32Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
            gl.deleteFramebuffer(fb.fb);
            for (let i = 0; i < w * h; i++) out[at++] = q(px[i * 4]);
        };
        read(this.planeY, this.width, this.height);
        read(this.planeCb, this.width / 2, this.height / 2);
        read(this.planeCr, this.width / 2, this.height / 2);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return out;
    }

    destroy() {
        const gl = this.gl;
        const texs = [
            this.payloadTex,
            this.offsetsTex,
            this.infoTex,
            this.magLo,
            this.magHi,
            this.counts,
            this.groupsTex,
            this.coefLo,
            this.coefHi,
            ...this.passes.flatMap((p) => [p.rows, p.out]),
        ];
        for (const T of texs) if (T) gl.deleteTexture(T.t);
        for (const f of [
            this.infoFb,
            this.magsFb,
            this.groupsFb,
            this.signsFb,
            ...this.passes.flatMap((p) => [p.rowsFb, p.outFb]),
        ])
            gl.deleteFramebuffer(f.fb);
        for (const { p } of Object.values(this.prog)) gl.deleteProgram(p);
        gl.deleteVertexArray(this.vao);
    }
}
