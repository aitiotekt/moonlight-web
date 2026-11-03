// sgsr1-half.js — SGSR1 in half precision, for the lab only: Qualcomm's
// SGSR1 computes in `half` (sgsr1.h, SgsrYuvH: the samples, the weights and
// the vote in half, the coordinates in float), while the product's port
// (SGSR_WGSL of WebGpuRenderer.js) computes in f32. The comparison of MWSR
// with SGSR1 (mwsr/README.md) times each at its best precision.
//
// sgsrHalf(SGSR_WGSL) is the product's port with that split: the same
// constants (EdgeThreshold 6/255, EdgeSharpness 1.5, mode 1, luma = green),
// bindings, uniforms and entry points; it needs the device's shader-f16.
// fsr1-half.js' asF32() lowers it to f32 (cell sgsrh32), to check its logic on
// an adapter without shader-f16.
//
// Ported from Snapdragon Game Super Resolution 1 (sgsr1.h):
//
// Copyright (c) 2023, Qualcomm Innovation Center, Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its contributors
//    may be used to endorse or promote products derived from this software
//    without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
//
// SPDX-License-Identifier: BSD-3-Clause

const BODY = /* wgsl */ `
struct Uniforms { viewport : vec4f }; // (1/inW, 1/inH, inW, inH)
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var inputTex : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : Uniforms;

const EDGE_THRESHOLD : f16 = 6.0h / 255.0h;
const EDGE_SHARPNESS : f16 = 1.5h;

fn fastLanczos2(x : f16) -> f16 {
    var wA = x - 4.0h;
    let wB = x * wA - wA;
    wA = wA * wA;
    return wB * wA;
}

fn weightY(dx : f16, dy : f16, c : f16, data : vec3<f16>) -> vec2<f16> {
    let stdev = data.x;
    let dir = data.yz;
    let edgeDis = (dx * dir.y) + (dy * dir.x);
    let x = ((dx * dx) + (dy * dy)) +
            ((edgeDis * edgeDis) * ((clamp((c * c) * stdev, 0.0h, 1.0h) * 0.7h) - 1.0h));
    let w = fastLanczos2(x);
    return vec2<f16>(w, w * c);
}

fn edgeDirection(left : vec4<f16>, right : vec4<f16>) -> vec2<f16> {
    let RxLz = right.x - left.z;
    let RwLy = right.w - left.y;
    var delta : vec2<f16>;
    delta.x = RxLz + RwLy;
    delta.y = RxLz - RwLy;
    let lengthInv = inverseSqrt((delta.x * delta.x + 3.075740e-05h) + (delta.y * delta.y));
    return vec2<f16>(delta.x * lengthInv, delta.y * lengthInv);
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
    let uv = in.uv;
    let con1 = u.viewport;

    var pix = vec4<f16>(vec3<f16>(textureSampleLevel(inputTex, samp, uv, 0.0).xyz), 1.0h);

    // the coordinates stay in f32, as sgsr1.h keeps them in float
    let imgCoord = (uv * con1.zw) + vec2f(-0.5, 0.5);
    let imgCoordPixel = floor(imgCoord);
    var coord = imgCoordPixel * con1.xy;
    let pl = vec2<f16>(imgCoord - imgCoordPixel);
    var left = vec4<f16>(textureGather(1, inputTex, samp, coord));

    let pixL = pix.y;
    let edgeVote = abs(left.z - left.y) + abs(pixL - left.y) + abs(pixL - left.z);
    if (edgeVote > EDGE_THRESHOLD) {
        coord.x += con1.x;
        var right = vec4<f16>(textureGather(1, inputTex, samp, coord + vec2f(con1.x, 0.0)));
        let udUp = vec4<f16>(textureGather(1, inputTex, samp, coord + vec2f(0.0, -con1.y)));
        let udDn = vec4<f16>(textureGather(1, inputTex, samp, coord + vec2f(0.0,  con1.y)));
        var upDown = vec4<f16>(udUp.w, udUp.z, udDn.y, udDn.x);

        let mean = (left.y + left.z + right.x + right.w) * 0.25h;
        left = left - vec4<f16>(mean);
        right = right - vec4<f16>(mean);
        upDown = upDown - vec4<f16>(mean);
        let pixW = pixL - mean;

        let sum = (abs(left.x) + abs(left.y) + abs(left.z) + abs(left.w)) +
                  (abs(right.x) + abs(right.y) + abs(right.z) + abs(right.w)) +
                  (abs(upDown.x) + abs(upDown.y) + abs(upDown.z) + abs(upDown.w));
        let sumMean = 1.014185e+01h / sum;
        let stdev = sumMean * sumMean;

        let data = vec3<f16>(stdev, edgeDirection(left, right));

        var aWY = weightY(pl.x,        pl.y + 1.0h, upDown.x, data);
        aWY += weightY(pl.x - 1.0h, pl.y + 1.0h, upDown.y, data);
        aWY += weightY(pl.x - 1.0h, pl.y - 2.0h, upDown.z, data);
        aWY += weightY(pl.x,        pl.y - 2.0h, upDown.w, data);
        aWY += weightY(pl.x + 1.0h, pl.y - 1.0h, left.x,   data);
        aWY += weightY(pl.x,        pl.y - 1.0h, left.y,   data);
        aWY += weightY(pl.x,        pl.y,        left.z,   data);
        aWY += weightY(pl.x + 1.0h, pl.y,        left.w,   data);
        aWY += weightY(pl.x - 1.0h, pl.y - 1.0h, right.x,  data);
        aWY += weightY(pl.x - 2.0h, pl.y - 1.0h, right.y,  data);
        aWY += weightY(pl.x - 2.0h, pl.y,        right.z,  data);
        aWY += weightY(pl.x - 1.0h, pl.y,        right.w,  data);

        var finalY = aWY.y / aWY.x;
        let max4 = max(max(left.y, left.z), max(right.x, right.w));
        let min4 = min(min(left.y, left.z), min(right.x, right.w));
        finalY = clamp(EDGE_SHARPNESS * finalY, min4, max4);

        let deltaY = finalY - pixW;
        pix.x = saturate(pix.x + deltaY);
        pix.y = saturate(pix.y + deltaY);
        pix.z = saturate(pix.z + deltaY);
    }
    pix.w = 1.0h;
    return vec4f(pix);
}
`;

/** The f16 text from the product's SGSR_WGSL: its vertex stage, this body. */
export function sgsrHalf(sgsrWgsl) {
  const at = sgsrWgsl.indexOf("struct Uniforms");
  if (at < 0) throw new Error("sgsrHalf: no 'struct Uniforms' in SGSR_WGSL");
  // `enable` must open the module, before the vertex stage's declarations
  return "enable f16;\n" + sgsrWgsl.slice(0, at) + BODY;
}
