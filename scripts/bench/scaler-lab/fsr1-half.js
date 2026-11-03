// fsr1-half.js — FSR1 in half precision, for the lab only: the comparison of
// MWSR with FSR1 (mwsr/README.md) times each at its best, and AMD's FSR1 has a
// 16-bit path (ffx_fsr1.h, FSR_EASU_H and FSR_RCAS_H) that the product's port
// (EASU_WGSL, RCAS_WGSL of WebGpuRenderer.js, firdawolf's fp32 WGSL) lacks.
//
// EASU_H_WGSL is FsrEasuH line for line: the 12 taps gathered and converted to
// f16, the direction and length of the four quadrants set two at a time, the
// taps weighed two at a time, the 2×2 bound by the packed min/max trick. The
// position and the gathers' coordinates stay in f32, as AMD keeps them (AF2).
// RCAS_H_WGSL is FsrRcasH, with what the product's fp32 port does the same way
// (the noise term always on, sharpness 0.595), so that the two RCAS differ by
// their precision alone. Same bindings, uniforms and entry points as the fp32
// texts; both need the device's shader-f16.
//
// Ported from AMD FidelityFX Super Resolution 1.0 (ffx_fsr1.h, v1.20210629):
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files(the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions :
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const HEAD = /* wgsl */ `
enable f16;

struct Resolution { inputwidth : f32, inputheight : f32, outputwidth : f32, outputheight : f32, }
@group(0) @binding(0) var input : texture_2d<f32>;
@group(0) @binding(1) var sam : sampler;
@group(0) @binding(2) var<uniform> resolution : Resolution;

struct VertexOutput {
    @builtin(position) clip_position : vec4<f32>,
    @location(0) tex_coords : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VertexOutput {
    var out : VertexOutput;
    let uv = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
    out.tex_coords = uv;
    out.clip_position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    return out;
}
`;

export const EASU_H_WGSL =
  HEAD +
  /* wgsl */ `
// FsrEasuTapH: two taps at once.
struct TapH { r : vec2<f16>, g : vec2<f16>, b : vec2<f16>, w : vec2<f16>, }
fn FsrEasuTapH(a : TapH, offX : vec2<f16>, offY : vec2<f16>, dir : vec2<f16>, len : vec2<f16>,
               lob : f16, clp : f16, cR : vec2<f16>, cG : vec2<f16>, cB : vec2<f16>) -> TapH {
    var vX : vec2<f16> = offX * dir.xx + offY * dir.yy;
    var vY : vec2<f16> = offX * (-dir.yy) + offY * dir.xx;
    vX = vX * len.x;
    vY = vY * len.y;
    var d2 : vec2<f16> = vX * vX + vY * vY;
    d2 = min(d2, vec2<f16>(clp));
    var wB : vec2<f16> = vec2<f16>(2.0h / 5.0h) * d2 + vec2<f16>(-1.0h);
    var wA : vec2<f16> = vec2<f16>(lob) * d2 + vec2<f16>(-1.0h);
    wB = wB * wB;
    wA = wA * wA;
    wB = vec2<f16>(25.0h / 16.0h) * wB + vec2<f16>(-(25.0h / 16.0h - 1.0h));
    let w : vec2<f16> = wB * wA;
    return TapH(a.r + cR * w, a.g + cG * w, a.b + cB * w, a.w + w);
}

// FsrEasuSetH: two quadrants at once, w their bilinear weights.
struct SetH { dirX : vec2<f16>, dirY : vec2<f16>, len : vec2<f16>, }
fn FsrEasuSetH(s : SetH, w : vec2<f16>,
               lA : vec2<f16>, lB : vec2<f16>, lC : vec2<f16>, lD : vec2<f16>, lE : vec2<f16>) -> SetH {
    let dc : vec2<f16> = lD - lC;
    let cb : vec2<f16> = lC - lB;
    var lenX : vec2<f16> = max(abs(dc), abs(cb));
    lenX = vec2<f16>(1.0h) / lenX;
    let dirX : vec2<f16> = lD - lB;
    lenX = saturate(abs(dirX) * lenX);
    lenX = lenX * lenX;
    let ec : vec2<f16> = lE - lC;
    let ca : vec2<f16> = lC - lA;
    var lenY : vec2<f16> = max(abs(ec), abs(ca));
    lenY = vec2<f16>(1.0h) / lenY;
    let dirY : vec2<f16> = lE - lA;
    lenY = saturate(abs(dirY) * lenY);
    lenY = lenY * lenY;
    return SetH(s.dirX + dirX * w, s.dirY + dirY * w, s.len + lenX * w + lenY * w);
}

@fragment
fn fs_main(in : VertexOutput) -> @location(0) vec4<f32> {
    let inputSize = vec2<f32>(resolution.inputwidth, resolution.inputheight);
    let outputSize = vec2<f32>(resolution.outputwidth, resolution.outputheight);

    var pp : vec2<f32> = (floor(in.tex_coords * outputSize) + 0.5) / outputSize * inputSize - 0.5;
    let fp : vec2<f32> = floor(pp);
    pp = pp - fp;
    let ppp : vec2<f16> = vec2<f16>(pp);
    var p0 : vec2<f32> = fp + vec2<f32>(1.0, -1.0);
    var p1 : vec2<f32> = p0 + vec2<f32>(-1.0, 2.0);
    var p2 : vec2<f32> = p0 + vec2<f32>(1.0, 2.0);
    var p3 : vec2<f32> = p0 + vec2<f32>(0.0, 4.0);
    p0 = p0 / inputSize;
    p1 = p1 / inputSize;
    p2 = p2 / inputSize;
    p3 = p3 / inputSize;

    let bczzR = vec4<f16>(textureGather(0, input, sam, p0));
    let bczzG = vec4<f16>(textureGather(1, input, sam, p0));
    let bczzB = vec4<f16>(textureGather(2, input, sam, p0));
    let ijfeR = vec4<f16>(textureGather(0, input, sam, p1));
    let ijfeG = vec4<f16>(textureGather(1, input, sam, p1));
    let ijfeB = vec4<f16>(textureGather(2, input, sam, p1));
    let klhgR = vec4<f16>(textureGather(0, input, sam, p2));
    let klhgG = vec4<f16>(textureGather(1, input, sam, p2));
    let klhgB = vec4<f16>(textureGather(2, input, sam, p2));
    let zzonR = vec4<f16>(textureGather(0, input, sam, p3));
    let zzonG = vec4<f16>(textureGather(1, input, sam, p3));
    let zzonB = vec4<f16>(textureGather(2, input, sam, p3));

    let bczzL : vec4<f16> = bczzB * 0.5h + (bczzR * 0.5h + bczzG);
    let ijfeL : vec4<f16> = ijfeB * 0.5h + (ijfeR * 0.5h + ijfeG);
    let klhgL : vec4<f16> = klhgB * 0.5h + (klhgR * 0.5h + klhgG);
    let zzonL : vec4<f16> = zzonB * 0.5h + (zzonR * 0.5h + zzonG);
    let bL = bczzL.x;
    let cL = bczzL.y;
    let iL = ijfeL.x;
    let jL = ijfeL.y;
    let fL = ijfeL.z;
    let eL = ijfeL.w;
    let kL = klhgL.x;
    let lL = klhgL.y;
    let hL = klhgL.z;
    let gL = klhgL.w;
    let oL = zzonL.z;
    let nL = zzonL.w;

    // the quadrants s and t (biST), then u and v (biUV)
    let wX : vec2<f16> = vec2<f16>(1.0h, 0.0h) + vec2<f16>(-ppp.x, ppp.x);
    var s = SetH(vec2<f16>(0.0h), vec2<f16>(0.0h), vec2<f16>(0.0h));
    s = FsrEasuSetH(s, wX * (1.0h - ppp.y), vec2<f16>(bL, cL), vec2<f16>(eL, fL), vec2<f16>(fL, gL),
                    vec2<f16>(gL, hL), vec2<f16>(jL, kL));
    s = FsrEasuSetH(s, wX * ppp.y, vec2<f16>(fL, gL), vec2<f16>(iL, jL), vec2<f16>(jL, kL),
                    vec2<f16>(kL, lL), vec2<f16>(nL, oL));
    var dir : vec2<f16> = vec2<f16>(s.dirX.x + s.dirX.y, s.dirY.x + s.dirY.y);
    var len : f16 = s.len.x + s.len.y;

    let dir2 : vec2<f16> = dir * dir;
    var dirR : f16 = dir2.x + dir2.y;
    let zro : bool = dirR < 1.0h / 32768.0h;
    dirR = inverseSqrt(dirR);
    dirR = select(dirR, 1.0h, zro);
    dir.x = select(dir.x, 1.0h, zro);
    dir = dir * dirR;
    len = len * 0.5h;
    len = len * len;
    let stretch : f16 = (dir.x * dir.x + dir.y * dir.y) * (1.0h / max(abs(dir.x), abs(dir.y)));
    let len2 = vec2<f16>(1.0h + (stretch - 1.0h) * len, 1.0h + -0.5h * len);
    let lob : f16 = 0.5h + ((1.0h / 4.0h - 0.04h) - 0.5h) * len;
    let clp : f16 = 1.0h / lob;

    // the min (negated) and the max of the 2×2 in one max
    let bothR = max(max(vec2<f16>(-ijfeR.z, ijfeR.z), vec2<f16>(-klhgR.w, klhgR.w)),
                    max(vec2<f16>(-ijfeR.y, ijfeR.y), vec2<f16>(-klhgR.x, klhgR.x)));
    let bothG = max(max(vec2<f16>(-ijfeG.z, ijfeG.z), vec2<f16>(-klhgG.w, klhgG.w)),
                    max(vec2<f16>(-ijfeG.y, ijfeG.y), vec2<f16>(-klhgG.x, klhgG.x)));
    let bothB = max(max(vec2<f16>(-ijfeB.z, ijfeB.z), vec2<f16>(-klhgB.w, klhgB.w)),
                    max(vec2<f16>(-ijfeB.y, ijfeB.y), vec2<f16>(-klhgB.x, klhgB.x)));

    var t = TapH(vec2<f16>(0.0h), vec2<f16>(0.0h), vec2<f16>(0.0h), vec2<f16>(0.0h));
    t = FsrEasuTapH(t, vec2<f16>(0.0h, 1.0h) - ppp.xx, vec2<f16>(-1.0h, -1.0h) - ppp.yy, dir, len2, lob, clp,
                    bczzR.xy, bczzG.xy, bczzB.xy);
    t = FsrEasuTapH(t, vec2<f16>(-1.0h, 0.0h) - ppp.xx, vec2<f16>(1.0h, 1.0h) - ppp.yy, dir, len2, lob, clp,
                    ijfeR.xy, ijfeG.xy, ijfeB.xy);
    t = FsrEasuTapH(t, vec2<f16>(0.0h, -1.0h) - ppp.xx, vec2<f16>(0.0h, 0.0h) - ppp.yy, dir, len2, lob, clp,
                    ijfeR.zw, ijfeG.zw, ijfeB.zw);
    t = FsrEasuTapH(t, vec2<f16>(1.0h, 2.0h) - ppp.xx, vec2<f16>(1.0h, 1.0h) - ppp.yy, dir, len2, lob, clp,
                    klhgR.xy, klhgG.xy, klhgB.xy);
    t = FsrEasuTapH(t, vec2<f16>(2.0h, 1.0h) - ppp.xx, vec2<f16>(0.0h, 0.0h) - ppp.yy, dir, len2, lob, clp,
                    klhgR.zw, klhgG.zw, klhgB.zw);
    t = FsrEasuTapH(t, vec2<f16>(1.0h, 0.0h) - ppp.xx, vec2<f16>(2.0h, 2.0h) - ppp.yy, dir, len2, lob, clp,
                    zzonR.zw, zzonG.zw, zzonB.zw);
    let aC = vec3<f16>(t.r.x + t.r.y, t.g.x + t.g.y, t.b.x + t.b.y);
    let aW : f16 = t.w.x + t.w.y;

    let pix = min(vec3<f16>(bothR.y, bothG.y, bothB.y),
                  max(-vec3<f16>(bothR.x, bothG.x, bothB.x), aC * vec3<f16>(1.0h / aW)));
    return vec4<f32>(vec3<f32>(pix), 1.0);
}
`;

// resolution.output{width,height} are TEXEL sizes here (1/outW, 1/outH), as
// for RCAS_WGSL.
export const RCAS_H_WGSL =
  HEAD +
  /* wgsl */ `
const sharpness : f16 = 0.595h;
const FSR_RCAS_LIMIT : f16 = 0.25h - (1.0h / 16.0h);

fn min3h(a : f16, b : f16, c : f16) -> f16 { return min(a, min(b, c)); }
fn max3h(a : f16, b : f16, c : f16) -> f16 { return max(a, max(b, c)); }

@fragment
fn fs_main(in : VertexOutput) -> @location(0) vec4<f32> {
    let b = vec3<f16>(textureSample(input, sam, in.tex_coords + vec2<f32>(0.0, -resolution.outputheight)).rgb);
    let d = vec3<f16>(textureSample(input, sam, in.tex_coords + vec2<f32>(-resolution.outputwidth, 0.0)).rgb);
    let e = vec3<f16>(textureSample(input, sam, in.tex_coords).rgb);
    let f = vec3<f16>(textureSample(input, sam, in.tex_coords + vec2<f32>(resolution.outputwidth, 0.0)).rgb);
    let h = vec3<f16>(textureSample(input, sam, in.tex_coords + vec2<f32>(0.0, resolution.outputheight)).rgb);

    // luma times 2
    let bL : f16 = b.b * 0.5h + (b.r * 0.5h + b.g);
    let dL : f16 = d.b * 0.5h + (d.r * 0.5h + d.g);
    let eL : f16 = e.b * 0.5h + (e.r * 0.5h + e.g);
    let fL : f16 = f.b * 0.5h + (f.r * 0.5h + f.g);
    let hL : f16 = h.b * 0.5h + (h.r * 0.5h + h.g);

    // noise detection
    var nz : f16 = 0.25h * bL + 0.25h * dL + 0.25h * fL + 0.25h * hL - eL;
    nz = saturate(abs(nz) * (1.0h / (max3h(max3h(bL, dL, eL), fL, hL) - min3h(min3h(bL, dL, eL), fL, hL))));
    nz = -0.5h * nz + 1.0h;

    // min and max of the ring, per channel
    let mn4 : vec3<f16> = min(min(min(b, d), f), h);
    let mx4 : vec3<f16> = max(max(max(b, d), f), h);
    let peakC = vec2<f16>(1.0h, -1.0h * 4.0h);
    let hitMin : vec3<f16> = min(mn4, e) * (vec3<f16>(1.0h) / (4.0h * mx4));
    let hitMax : vec3<f16> = (peakC.x - max(mx4, e)) * (vec3<f16>(1.0h) / (4.0h * mn4 + peakC.y));
    let lobeC : vec3<f16> = max(-hitMin, hitMax);
    var lobe : f16 = max(-FSR_RCAS_LIMIT, min(max3h(lobeC.r, lobeC.g, lobeC.b), 0.0h)) * sharpness;
    lobe = lobe * nz;

    let rcpL : f16 = 1.0h / (4.0h * lobe + 1.0h);
    let c : vec3<f16> = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;
    return vec4<f32>(vec3<f32>(c), 1.0);
}
`;

// The same texts with every f16 lowered to f32: the logic of the port, checked
// on an adapter without shader-f16 (SwiftShader) against the fp32 texts, which
// it must match to the rounding of its pairwise sums (cells easuh32, fsr1h32).
export const asF32 = (wgsl) =>
  wgsl
    .replace("enable f16;", "")
    .replace(/\bf16\b/g, "f32")
    .replace(/\b(\d+\.\d+(?:e[+-]?\d+)?)h\b/g, "$1");
