/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The deblocking pass of mwsr's versions 2 and 3, on the decoded frame before
 * the kernel (docs/design/upscaler-mwsr.md §14.6-14.7, journal J43). Debug
 * builds only: the menu's « MoonlightWeb 2 » and « MoonlightWeb 3 », which
 * neither 'auto' nor a release build ever picks — P8.0 shut its gate.
 *
 * The filter is P8.0's DCT shrinkage: the frame's luma cut into 8×8 blocks on
 * 16 grids shifted by (0, 2, 4, 6) on each axis, each block's coefficients
 * under a threshold zeroed (the DC kept), the 16 results averaged, the change
 * of each pixel's luma bounded and added to its three channels. One compute
 * dispatch does every block of every grid (z = the grid) and adds it into a
 * fixed-point buffer with atomics; one render pass then writes the frame the
 * kernel reads. The lab's version (scripts/bench/scaler-lab/seq-lab.js, `dbd`)
 * took a dispatch per grid with plain adds: the same sums, to the rounding of
 * ACC_SCALE.
 *
 * Strengths are in code values of the stream's Y (limited range), as the lab
 * gave them; the shaders work on luma × 255, hence × 255/219.
 */

/** Version 2: a fixed strength, the one P8.0's eight cases never saw lose (J43). */
export const DEBLOCK_FIXED = Object.freeze({ thr: 8, cmax: 2 });

/** Version 3: the threshold is this share of the frame's quantiser step… */
export const DEBLOCK_QP_K = 0.4;
/** …at most the lab's strongest… */
export const DEBLOCK_QP_MAX = 12;
/** …and under this the pass is left out: a frame that fine has no grid to lose. */
export const DEBLOCK_QP_MIN = 2.5;

/** The grids: (0, 2, 4, 6) on each axis. */
export const DEBLOCK_GRIDS = 16;

/** Fixed point of the sums: 1/256 of a code value, 16 grids in an i32. */
const ACC_SCALE = 256;

/**
 * The strength of one frame, or null to leave the pass out.
 *
 * Version 3 sets the threshold from the frame's QP (SliceQp.js): k times its
 * quantiser step 2^((QP − 4) / 6), the step H.264 and HEVC share, bounded by a
 * third of it (two code values at least). On P8.0's stream-alone sweep, k 0.25
 * to 0.3 did best; after mwsr the lab wanted stronger (t12c4 on the hard low
 * rates, t4 on the fine high ones), hence 0.4: QP 34 and up gives t12c4, QP 28
 * about t6c2, QP 22 t3, and under QP 20 nothing. A frame whose QP could not be
 * read (AV1, a header this does not read) takes version 2's strength.
 * @param {'fixed'|'qp'|null} mode
 * @param {number|null} qp
 * @returns {{thr: number, cmax: number}|null}
 */
export function deblockStrength(mode, qp) {
    if (mode === 'fixed') return DEBLOCK_FIXED;
    if (mode !== 'qp') return null;
    if (typeof qp !== 'number' || !(qp >= 0)) return DEBLOCK_FIXED;
    const thr = Math.min(DEBLOCK_QP_MAX, DEBLOCK_QP_K * 2 ** ((qp - 4) / 6));
    if (thr < DEBLOCK_QP_MIN) return null;
    return { thr, cmax: Math.max(2, thr / 3) };
}

/**
 * The uniform block both passes read: the frame's size, the threshold and the
 * bound, on luma × 255.
 * @param {number} w
 * @param {number} h
 * @param {{thr: number, cmax: number}} s
 * @returns {ArrayBuffer}
 */
export function deblockUniforms(w, h, s) {
    const b = new ArrayBuffer(16);
    new Int32Array(b, 0, 2).set([w, h]);
    new Float32Array(b, 8, 2).set([(s.thr * 255) / 219, (s.cmax * 255) / 219]);
    return b;
}

/**
 * The dispatch: a workgroup per 8×8 block of each grid, the blocks starting
 * 8 pixels before the frame so that every pixel is in one block of each grid.
 * @param {number} w
 * @param {number} h
 * @returns {[number, number, number]}
 */
export function deblockDispatch(w, h) {
    return [Math.ceil(w / 8) + 1, Math.ceil(h / 8) + 1, DEBLOCK_GRIDS];
}

// The orthonormal 8-point DCT, D[k * 8 + n].
const DCT8 = Array.from({ length: 64 }, (_, i) => {
    const k = Math.floor(i / 8);
    const c = Math.sqrt((k ? 2 : 1) / 8);
    return (c * Math.cos((Math.PI * (2 * (i % 8) + 1) * k) / 16)).toFixed(9);
}).join(', ');

const COMMON = /* wgsl */ `
struct DU {
    size : vec2i,
    thr : f32,
    cmax : f32,
};
const L709 = vec3f(0.2126, 0.7152, 0.0722);
const ACC_SCALE = ${ACC_SCALE}.0;
`;

/** The blocks: forward DCT, the threshold, inverse DCT, added into acc. */
export const DEBLOCK_DCT_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> acc : array<atomic<i32>>;
@group(0) @binding(2) var<uniform> u : DU;

var<private> D8 : array<f32, 64> = array<f32, 64>(${DCT8});
var<workgroup> sa : array<f32, 64>;
var<workgroup> sb : array<f32, 64>;

fn lumaMirror(p : vec2i) -> f32 {
    var q = select(p, -p, p < vec2i(0));
    q = select(q, 2 * (u.size - 1) - q, q >= u.size);
    return dot(textureLoad(src, clamp(q, vec2i(0), u.size - 1), 0).rgb, L709) * 255.0;
}

@compute @workgroup_size(8, 8)
fn cs(@builtin(workgroup_id) wg : vec3u, @builtin(local_invocation_id) l : vec3u) {
    let i = l.x;
    let j = l.y;
    let shift = vec2i(i32(wg.z % 4u), i32(wg.z / 4u)) * 2;
    let p = vec2i(wg.xy) * 8 - vec2i(8) + shift + vec2i(l.xy);
    sa[j * 8u + i] = lumaMirror(p);
    workgroupBarrier();
    var a = 0.0;
    for (var n = 0u; n < 8u; n++) {
        a += D8[i * 8u + n] * sa[j * 8u + n];
    }
    sb[j * 8u + i] = a;
    workgroupBarrier();
    var c = 0.0;
    for (var m = 0u; m < 8u; m++) {
        c += D8[j * 8u + m] * sb[m * 8u + i];
    }
    if ((i != 0u || j != 0u) && abs(c) < u.thr) {
        c = 0.0;
    }
    sa[j * 8u + i] = c;
    workgroupBarrier();
    var b = 0.0;
    for (var k = 0u; k < 8u; k++) {
        b += D8[k * 8u + j] * sa[k * 8u + i];
    }
    sb[j * 8u + i] = b;
    workgroupBarrier();
    var r = 0.0;
    for (var k = 0u; k < 8u; k++) {
        r += D8[k * 8u + i] * sb[j * 8u + k];
    }
    if (all(p >= vec2i(0)) && all(p < u.size)) {
        let idx = u32(p.y) * u32(u.size.x) + u32(p.x);
        atomicAdd(&acc[idx], i32(round(r * ACC_SCALE)));
    }
}
`;

/** The grids' mean luma, its change bounded by cmax and added to the RGB. */
export const DEBLOCK_FIN_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<storage, read> acc : array<i32>;
@group(0) @binding(2) var<uniform> u : DU;

struct VSOut {
    @builtin(position) pos : vec4f,
};
@vertex
fn vs(@builtin(vertex_index) vid : u32) -> VSOut {
    var out : VSOut;
    let uv = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
    out.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
    return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let p = vec2i(in.pos.xy);
    let c = textureLoad(src, p, 0);
    let y = dot(c.rgb, L709);
    let sum = f32(acc[u32(p.y) * u32(u.size.x) + u32(p.x)]);
    let yd = sum / (ACC_SCALE * 255.0 * ${DEBLOCK_GRIDS}.0);
    let dy = clamp(yd - y, -u.cmax / 255.0, u.cmax / 255.0);
    return vec4f(clamp(c.rgb + vec3f(dy), vec3f(0.0), vec3f(1.0)), c.a);
}
`;
