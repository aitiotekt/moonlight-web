# Cheap single-frame upscalers/downscalers for a game-streaming video client — literature survey (10 Oct 2026)

Scope as briefed: spatial-only (no motion vectors, no history), measured fairly (quality, GPU time, power). Markers used throughout: **[M]** = measured and published by someone (who is named), **[C]** = vendor claim without a published measurement, **[3P]** = third-party anecdote (forum/blog), **[S]** = standard textbook fact not taken from a fetched page, **[?]** = could not verify (also collected in §7). No files were written in the repo; four PDFs were text-extracted into the session scratchpad only.

---

## 0. Takeaways that matter for the plan

1. **The two production-grade "directional" spatial scalers are single-pass compute/fragment shaders with a 6×6 (NIS) or 12-tap (EASU, SGSR1) footprint, both MIT/BSD-licensed, and both reject or discourage >2× per axis and any downscaling.** NIS's host code hard-rejects scale outside [1.0, 2.0] per axis; EASU and CAS are specified for ≤4× *area* (CAS checks area, not axis). SGSR1 is the only one with vendor-published ms on mobile (0.29–0.48 ms for a 1240×576 input on Adreno 660/730/740 at max clock) **[M, Qualcomm]**.
2. **The only published mobile measurement of FSR1 EASU is a third-party one: 5.4 ms stock (pixel shader, 1772×819→2532×1170 on iPhone 12), 1.8 ms after fp16 + simplifications** **[M, atyuwen]**. That is the realistic order of magnitude for a 12-tap directional kernel on a phone GPU at display resolution without hand-optimisation; the 0.2–1.0 ms figures on AMD's page are desktop budgets **[C]**.
3. **No vendor (AMD, NVIDIA, Qualcomm, Apple, Arm) publishes any objective quality metric for its spatial upscaler**; all use side-by-side images. The academic benchmark closest to our use (SR+Codec, BMVC 2024) found PSNR/MS-SSIM/VMAF correlate poorly (SRCC 0.15–0.45) with human ranking of upscaled *compressed* video; LPIPS 0.43, ERQA 0.62, a no-reference VQA (MDTVSFA) 0.64 **[M]**. Protocol recommendation in §3.4.
4. **Public per-frame costs on recent iGPUs (780M/890M, Xe-LPG/Arc 140V) and on Apple M-series / Mali-G7xx for any spatial upscaler: none found.** §5 states this plainly and gives the few numbers that exist.
5. **GPU-time tooling for a browser client is weaker than for a native app**: WebGPU `timestamp-query` is quantised to 100 µs unless the Chrome developer-features flag is set; Xcode capture of Chrome needs a non-codesigned build and freezes the browser after capture; Android GPU Inspector needs a debuggable app (release Chrome is not). Realistic protocol and noise floor in §4.3.

---

## 1. Algorithm survey

### 1.1 Classical kernels (bilinear, bicubic family, Lanczos, EWA)

| Filter | Principle | Fetches / output px | Separable? | Edge-adaptive | Known artefacts | 1.0–2.0× up | >2× up | Downscale | Reference impl. / licence |
|---|---|---|---|---|---|---|---|---|---|
| Bilinear | Hardware tent filter | 1 bilinear | n/a (HW) | No | Blur; blocky look at ≥2×; aliasing/moiré when reducing >2× (skips pixels) | Acceptable baseline | Blurry | Only ≤2× reduction | Everywhere; mpv `--scale=bilinear` "fastest, very low quality" (mpv manual) |
| Bicubic B-spline (B=1,C=0) | 4×4 cubic, all-positive weights | 16 nearest **or 4 bilinear** (GPU Gems 2 ch. 20 trick: pair adjacent taps, offset by w₁/(w₀+w₁); valid only when both weights share sign) **[fetched]** | Yes (or 1 pass with the 4-fetch trick) | No | Soft/blurry (smoothing spline) | Soft | Soft | Decent (no ringing) | GPU Gems 2 ch.20 (Sigg & Hadwiger); precision caveat: 8-bit textures insufficient for the bilinear-combination trick, authors used 16-bit **[fetched]** |
| Catmull-Rom (B=0,C=0.5) | Interpolating cubic, negative lobes | 16 nearest or **9 bilinear** (3×3 of combined taps; MJP gist) or **5 bilinear** dropping corners (Jimenez, SIGGRAPH 2016 Filmic SMAA; renormalisation question left open in the gist) **[fetched]** | Yes | No | Mild ringing ("sharper, but prone to ringing" — mpv manual) | Good general-purpose | Ringing more visible | OK with widened support | MJP gist (public domain-style, no licence header seen **[?]**); mpv `catmull_rom`; "Fast Catmull-Rom" user shader by garamond13 |
| Mitchell–Netravali (B=C=1/3) | Compromise cubic, radius 2 | 16 / 9-bilinear trick works partially (mixed-sign weights) **[S]** | Yes | No | Balanced; slight blur; little ringing | Good | OK | **Good downscaler** (ImageMagick/Robidoux ring test: "tensor Mitchell… balanced sharpness and aliasing best") **[fetched]** | mpv/libplacebo `mitchell`; libplacebo lists it under downscalers |
| Hermite (B=0,C=0) | Radius-1 cubic | 4 | Yes | No | "fast, but prone to blocking" (mpv) | Poor | Poor | **mpv/libplacebo default `dscale`** since mpv 0.37 ("vo_gpu, vo_gpu_next: default to dscale=hermite") **[fetched]** | mpv/libplacebo (LGPL-2.1+) |
| Lanczos2 / Lanczos3 (tensor) | windowed sinc, radius 2 / 3 | 16 / 36 nearest; separable: 4+4 / 6+6 across two passes **[S]** | Yes | No | Ringing/halos at hard edges (Robidoux: "halo rings around sharp edges"); aliasing when downscaling unless support widened | **mpv default `--scale=lanczos`** ("good balance of quality and performance") | Ringing grows; still used | Needs `--correct-downscaling` (widen kernel; mpv default on) | mpv/libplacebo; ImageMagick |
| EWA Lanczos (jinc) / `ewa_lanczossharp` / `ewa_lanczos4sharpest` | Polar (circular) windowed jinc; one 2-D pass | ≈π·r² taps in a disc (r=3 → ~28) per output px, single pass **[S]**; libplacebo `<scaler>_polar=yes` | **No (polar, 1 pass)** | No | Less aliasing/moiré than tensor; still halos ("EWA LanczosSharp … reasonably mild halos" — Robidoux); `4sharpest` "prone to ringing" | libplacebo `preset=high_quality` → `ewa_lanczossharp`; mpv manual: "relatively slow, but very good quality" | Same | EWA "generally suppress moiré well" for shrinking (Robidoux) | libplacebo (LGPL-2.1+); ImageMagick |
| Sigmoid / linear-light | Pre-transform to reduce ringing | — | — | — | mpv `--sigmoid-upscaling` default on; `--linear-downscaling` default on; Robidoux: avoid linear light for *enlarging* with negative-lobe filters, use it for *shrinking* | | | | mpv manual, ImageMagick |

Sources read: GPU Gems 2 ch. 20 (developer.nvidia.com/gpugems/gpugems2/…/chapter-20), MJP gist c83b8c0f…, mpv `DOCS/man/options.rst` (raw, chunk 215k–315k), mpv v0.37.0 release notes, libplacebo.org/options, usage.imagemagick.org/filter/nicolas. The vec3.ca "Bicubic filtering in fewer taps" page is gone (404; web.archive.org not reachable from this tool) — its content is covered by GPU Gems 2 + the MJP gist, which cites it.

### 1.2 NVIDIA Image Scaling (NIS) — read from the repo README, `NIS/NIS_Scaler.h`, `NIS/NIS_Config.h`, and the 19-page `NIS_SDK_Programming_Guide.pdf` (text-extracted)

- **Licence:** MIT, "Copyright(c) 2022 NVIDIA CORPORATION & AFFILIATES" (repo `licence.txt`, README). v1.0.3.
- **Principle (guide §1):** "a 6-tap scaling filter combined with 4 directional scaling and adaptive sharpening filters"; NVScaler = upscale+sharpen in one compute pass; NVSharpen = sharpen only ("do NOT integrate both").
- **Structure (`NIS_Scaler.h`):** `kPhaseCount = 64` (fractional position quantised to 64 phases); `kSupportSize = 6`; coefficient LUTs `coef_scale`/`coef_usm` are `64 × 8` float (or fp16 `uint16_t`) — 6 taps padded to two `float4` texels (the header reports `kFilterSize = 6` while the config tables are 64×8; I read both and report the discrepancy as seen **[?]**). Tile in shared memory: `(NIS_BLOCK_WIDTH+6)×(NIS_BLOCK_HEIGHT+6)` luma → 38×30 for the default 32×24 block; edge map `(W+2)×(H+2)`.
- **Edge map:** `GetEdgeMap` computes four directional gradients (0°, 45°, 90°, 135°) from a **4×4 luma neighbourhood** by absolute differences, tested against `kDetectRatio = 2·1127/1024 ≈ 2.20` and `kDetectThres = 64/1024` (SDR; 32/1024 HDR); output is 4 weights. Computed once per input pixel into shared memory (4 calls per 2×2 batch), then bilinearly interpolated per output pixel (`GetInterpEdgeMap`).
- **Per output pixel:** `FilterNormal` = 6×6 weighted sum (36 shared-memory reads) × baseWeight + `AddDirFilters` = up to four 6-tap directional `EvalPoly6` evaluations (scaler row + USM row, luma-dependent ramp `kSharpStartY 0.45 → 0.9`, clamp to `kSharpLimit`, local-contrast term `CalcLTI` to reduce ringing) + **1 bilinear RGB sample**; the final luma correction is added to RGB. Tile load: 4 bilinear samples per 2×2 batch, or **3 gathers** with `NIS_TEXTURE_GATHER=1` ("edge map from 4 gathers" in the brief is not what the code does — it is 3 gathers for the luma tile, edge map computed in LDS).
- **Sharpen-only (`NIS_SCALER=0`):** 5×5 window (`kSupportSize = 5`), tile `(W+6)×(H+6)`, four fixed-coefficient directional USMs (−0.6001, 1.2002, −0.6001) weighted by the same edge map; 1 bilinear colour sample per pixel.
- **Scale limits (`NIS_Config.h`):** `NISUpdateConfig` requires `kScaleX, kScaleY` (= input/output) **between 0.5 and 1.0** → **1× to 2× per axis only; downscaling rejected.**
- **Variants/defines:** `NIS_USE_HALF_PRECISION` (min16float / float16_t / f16vec — shared arrays and math), `NIS_HDR_MODE` 0/1 linear (input [0, 12.5], 1.0 = 80 nits)/2 PQ, **`NIS_NV12_SUPPORT`** (reads separate Y and UV textures — directly relevant to a video client), `NIS_VIEWPORT_SUPPORT`, `NIS_CLAMP_OUTPUT`, `NIS_HLSL`/`NIS_HLSL_6_2`/`NIS_GLSL`.
- **Recommended block/thread-group (NISOptimizer):** NVIDIA 32×24 (scaler)/32×32 (sharpen), 128 threads; NVIDIA fp16 32×32/32×32, 128; AMD and Intel 32×24/32×32, **256** threads. Dispatch = ceil(outW/blockW) × ceil(outH/blockH).
- **Placement (guide §3.1):** after tone mapping in display-referred space; film grain *after* NIS ("sharpening algorithms can enhance noisy or grainy regions"); motion blur/bloom before; negative mip bias `log2(render/display)`.
- **Performance:** **No ms figures anywhere** in README, guide or headers. The only claim: NVScaler "performs faster and produces better image quality" than NVSharpen + separate upscale **[C]**. Press FPS gains (RTX 3080/3090 at 4K, +24–76 %) are whole-frame and say nothing about the pass cost **[3P]**.

### 1.3 AMD FidelityFX — CAS (read `ffx_cas.h` + GPUOpen CAS page) and FSR1 EASU/RCAS (read `ffx_fsr1.h` + GPUOpen FSR1 page; another agent owns EASU in depth)

| | CAS (sharpen) | CAS (upscale mode) | EASU | RCAS |
|---|---|---|---|---|
| Footprint | "minimal nearest 3×3 source texel window"; **5 fetches** (cross) by default, 9 with `CAS_BETTER_DIAGONALS` | 4×4 around the output point; runs the sharpen math at the 4 surrounding input pixels and blends with contrast-thinned bilinear weights; **12 fetches** | **12 taps via four `gather4`**; "directionally and anisotropically adaptive elliptical Lanczos-style filter" approximated without sin/rcp/sqrt; output clamped to min/max of nearest 2×2 (deringing) | **5-tap cross**; solves for the largest sharpening weight that avoids clipping, then clamps to a fixed limit; optional `FSR_RCAS_DENOISE` high-pass noise detector |
| Passes | 1 | 1 | 1 | 1 (after EASU) |
| Scale | — | `CasSupportScaling`: output/input **area ≤ 4.0** (e.g. 1080p→4K is the "practical limit"); GPUOpen page: "supports both up-sampling and down-sampling in the same single pass" **[C]** | "1x to 4x area range" | — |
| Sharpness | negative lobe = −1/lerp(8,5,sharpness): 0 → −1/8 "lower ringing", 1 → −1/5 "highest ringing" | same | — | in "stops": 0.0 = max, each +1 halves |
| FP16 | `CasFilterH` packed, two 8×8 tiles per 16×8 | same | `FsrEasuH` packed (two taps in parallel) | `FsrRcasH`, `FsrRcasHx2` packed |
| Input | **linear** data in [0,1] ("does not function well on sRGB or gamma 2.2") | | sRGB-ish display-referred, anti-aliased, noise-free, [0,1] | |
| Artefacts | header: ringing grows with sharpness; on PQ "positive side of the ring … over-bright" | bilinear weights "thinned" to hide interpolation | ringing removed by 2×2 clamp; residual stair-step on thin lines **[S]** | over-sharpening if stops too low; grain amplification unless `DENOISE` |
| Cost | GPUOpen: "highly optimized", no number; forum quoting DIIT: "<100 µs on Navi" **[3P, unverified]** | header: 12 taps × 3 ch = 36× the per-tap conversion cost; "already quite VALU heavy" | **AMD page (upper bounds, 4K / 1440p): 0.40/0.20 ms (RX 6800 XT, RTX 3080), 0.60/0.30 (RX 6700 XT, RTX 3060 Ti), 1.0/0.50 (RX 5700 XT, RTX 2060 S)** **[C]**; **iPhone 12, 1772×819→2532×1170, pixel shader: EASU 5.4 ms → 4.7 (fp16) → 4.3 (no dering clamp) → 3.8 (one `FsrEasuSetH` on interpolated inputs) → 3.6 (early-out on non-edges) → 1.8 ms (5 bilinear samples on early-out path)** **[M, atyuwen.github.io/posts/optimizing-fsr]** | iPhone 12: **0.9 ms** **[M, same]** |
| Licence | MIT (2020 AMD) | | MIT (2021 AMD) | |

FSR1 quality modes (AMD page): Ultra Quality 1.3×, Quality 1.5×, Balanced 1.7×, Performance 2.0× per axis; "arbitrary scaling from 1x to 4x area" for DRS. No quality metric is named on either AMD page.

### 1.4 Qualcomm SGSR1 (reference only; read `sgsr/v1/README.md`)

- BSD-3-Clause. "12-tap Lanczos-like scaling filter and adaptive sharpening filter" in **one fragment pass**; optional edge-direction weighting ("adds a small additional cost… might lower wave occupancy"); modes RGBA (default) / RGBY / LERP; `EdgeThreshold` 8/255 mobile, 4/255 VR; `EdgeSharpness` 2 in [1,2]; luma from green channel only (Qualcomm blog).
- **Measured by Qualcomm, 1240×576 input, "maximum GPU frequency", output size not stated (device panels 2340×1080 / 2400×1600), API and method not stated:** SGSR 0.4756 / 0.3563 / 0.2952 ms on SD888 / 8 Gen 1 / 8 Gen 2; bilinear 0.2476 / 0.1963 / 0.1558 ms. Edge threshold has no cost effect **[M]**. Marketing "~2× faster than other mobile upscalers" **[C]**.
- SGSR2 (temporal, needs depth + motion vectors): SD 8 Gen 3 at max clock, 2-pass fragment 0.905–1.107 ms, 2-pass compute 1.80–2.00 ms, 3-pass compute 2.02–2.40 ms for 630×1400–840×1866 → 1260×2800 **[M, Qualcomm]** — given only to calibrate "what a well-optimised multi-pass costs on a flagship Adreno".
- mpv user-shader port by agyild exists (mpv wiki "Snapdragon GSR v1").

### 1.5 Apple MetalFX Spatial (closed) and Arm ASR

- **MetalFX Spatial** (WWDC22 session 10103, `MTLFXSpatialScalerDescriptor` doc JSON): "analyzes the input's spatial information to produce new, upscaled samples"; needs **anti-aliased, noise-free** input; best performance in **perceptual** mode (tone-mapped sRGB 0–1), also linear and HDR modes; create the scaler once (expensive); iOS 16 / macOS 13 / visionOS 1 / tvOS 27.1. **Apple publishes no cost, no scale-range statement, no metric.** Third-party numbers: iPhone 13 (Unity URP, iOS beta) whole-frame 14 ms native → 26 ms with spatial at 0.5–0.8 render scale **[3P, developer.apple.com/forums/thread/736915]**; search snippets quote "4 ms+ for 1280×720→2560×1440" and an open-source MSPR benchmark "7.6 ms full path vs 2.59 ms bilinear on iPhone 13" **[3P, not fetched — ?]**. Net: on A15-class hardware MetalFX Spatial appears to cost several ms, i.e. not cheap, but this is anecdotal.
- **Arm ASR** (GitHub README): FSR 2.2.2-derived **temporal** upscaler requiring depth, motion vectors, jitter, optional reactive mask → **not applicable** to a decoded-video client (no MVs/depth); MIT; Arm's own numbers 2.5–6.5 ms on Immortalis-G715/G720 at 2400×1080–2800×1260 **[C]**. Intel XeSS-SR likewise needs motion vectors/depth (DP4a path on any SM6.4 GPU) — not applicable **[guide not fetched; ?]**.

### 1.6 Edge-directed interpolation families (NEDI, iNEDI, ICBI/FCBI, DCCI)

| Method | Principle | Cost | Ratio | Artefacts | Code / licence |
|---|---|---|---|---|---|
| **NEDI** (Li & Orchard, IEEE TIP 2001 — PDF read) | Estimate local covariance from a low-res window, exploit "geometric duality" to derive high-res covariance, solve a 4-tap Wiener/MMSE interpolation per pixel; two interlaced steps (diagonal, then the rest) **[S for the step detail]** | "about two orders of magnitude higher than that of linear interpolation"; eq. (4) "about 1300 multiplications per pixel"; **hybrid**: covariance path only on "edge pixels" (local variance > threshold; "window size and the threshold… both set to be 8"; edge pixels are 5–15 % of the image) **[fetched]** | 2× per step only | Speckle/"oil painting" artefacts in texture, numerical instability (per iNEDI paper) | Paper only; MATLAB re-implementations abound, no canonical licence **[?]** |
| **iNEDI** (Asuni & Giachetti, VISAPP 2008 — PDF read) | NEDI with numerically stabilised solve and **adaptive, approximately circular estimation windows** | "even if computationally heavy (as the Li and Orchard's method)" | 2× (tables for 2× and 4× = two passes) | Removes NEDI's directional artefacts; ~1 dB PSNR gain claimed | "code is publicly available at the web site" (andreagiachetti.it — TLS cert expired, not fetched) **[?]** |
| **ICBI / FCBI** (Giachetti & Asuni, IEEE TIP 2011 — abstract via search) | Two-step grid filling along the direction of lower second-order derivative, then iterative correction minimising a second-derivative energy | "one to two orders of magnitude" cheaper than NEDI; real-time with a CUDA implementation (2011) | 2× | Fewer jaggies, mild blur | MATLAB on author site **[?]** |
| **DCCI** (Zhou, Shen, Dong, IET IP 2012) | Two-step directional cubic convolution: pick the diagonal (then axial) direction with the smaller gradient energy; weights (−1, 9, 9, −1)/16, blend in smooth areas | ~2 cubic evaluations + gradients per new pixel **[S]** | **2× minus 1 pixel** | Removes staircase on diagonals; a 2013 analysis (Wikipedia) found DCCI best in PSNR/SSIM among tested edge-directed methods | MATLAB File Exchange (licence not read); **G'MIC `scale_dcci2x`** (CeCILL): `edge_threshold=1.15`, `exponent=5` **[fetched]** |
| "Fast edge-adaptive" patents/papers | Various (e.g. CN103500437A "Fast NEDI") | — | 2× | — | not read **[?]** |

Suitability verdict: all are **integer-2× two-step schemes** — unusable as-is for 1.0–2.0× arbitrary ratios without a second resampling pass; none has a maintained GPU implementation with a permissive licence.

### 1.7 mpv / libplacebo user-shader ecosystem (licences read from the files themselves)

| Shader | What it is | Passes / fetches | Licence (as read) | Notes |
|---|---|---|---|---|
| **RAVU** (bjin/mpv-prescalers) | "inspired by RAISR" (learned per-bucket filters on top of a cheap interpolation; RAISR hashes gradient angle/strength/coherence **[S, RAISR abstract only fetched]**); radius r2/r3/r4 (r3 recommended); `ravu-lite` luma-only, faster/sharper, no half-pixel offset; `ravu-zoom` arbitrary ratio but "expect it to be much slower"; `-ar` variants add libplacebo antiringing (0.8) | `gather/` (textureGather) variants fastest for luma; `compute/` for yuv/rgb | **LGPLv3** ("Shaders in this repo are licensed under terms of LGPLv3") | 2× prescaler, then mpv's `--scale` finishes the ratio |
| **nnedi3** (same repo) | Neural edge-directed doubler (tritical's design) | **4 passes** (double_y → combine_y → double_x → combine_x), nns16–256 neurons, win8x4/8x6; weights hard-coded as int bit patterns | **LGPLv3** header (port) — upstream nnedi3 is GPL **[S]** | luma only, 2× steps |
| **FSRCNNX** (igv/FSRCNN-TensorFlow releases) | FSRCNN variants exported to GLSL (x2_8-0-4-1, x2_16-0-4-1 = d/s/m/… layers) | multi-pass CNN; "doesn't work unless ≥2× scaling required" (forum) | repo shows **GPL-3.0 and an `LICENSE.MIT`** side by side — shader licence ambiguous **[?]** | heavy; RX 6600 XT ~90 % busy in a 4K shader stack **[3P]** |
| **Anime4K** (bloc97) | CNN "Restore" (removes compression artefacts/blur/ringing), "Upscale" (2×, assumes clean input), Upscale_Denoise, Deblur (DoG), Clamp_Highlights; sizes S/M/L/VL/UL | "each CNN size step doubles processing time"; "a shader placed after a x2 upscale takes four times as long" | **MIT** | tuned for 1080p anime (line art), not live video; release note: pre-scaler "1.5 ms for 1080p→4K… total 4 ms on Vega 64" **[C, search snippet]**; **Anime4K-WebGPU** (MIT) reports "within 3 ms" per 720p frame on RTX 4090/3070 Ti via Chrome's GPU tool **[M, desktop only]** |
| **adaptive-sharpen** (bacondither, gist by igv) | Edge-adaptive Laplacian sharpen; 3×3 Gaussian contrast estimate; soft min/max limiter against ringing; `curve_height` strength | **25 texture positions** (~±3 px pattern), 1 pass | **BSD-style** (bacondither 2015–2021) | "Tuned for use post-resize" |
| **SSimSuperRes** (Shiandow, gist by igv) | Post-upscale correction: downscale the upscaled image back, compare local mean/variance to the source, nudge output (sharpen + antiring) | ≥4 passes (2 downscale, stats, final 3×3 Hann) | **LGPLv3** | author recommends `scale=lanczos` under it |
| **KrigBilateral** (Shiandow) | Chroma upscaling guided by luma (kriging + bilateral weights, 8×8 solve per pixel) | 3 passes; ~18 fetches + per-pixel 8×8 solve | **LGPLv3** | chroma only — relevant to 4:2:0 but costly |
| **SSimDownscaler** (igv) | Variance-preserving downscaler (mean/variance matching) | 4 passes, Catmull-Rom core | **LGPLv3** | "Tuned for linear-downscaling=no" |
| agyild ports: FSR, CAS, NIS, SGSR1 | GLSL `.hook` ports of the vendor shaders | as upstream | upstream MIT/BSD (wiki lists no licence) | easiest way to A/B vendor kernels inside mpv |
| ArtCNN, CuNNy | CNN luma doublers (Manga109 / anime) | heavy | not read | anime-oriented |

Source: github.com/mpv-player/mpv/wiki/User-Scripts (shader section), the gists and repos above.

### 1.8 Tiny neural upscalers as shaders

- **ESPCN** (Shi et al. 2016, arXiv 1609.05158): sub-pixel convolution; "real-time SR of 1080p videos on a single K2 GPU" (no fps in abstract) **[C]**. **FSRCNN** (Dong et al. 2016, arXiv 1608.00367): hourglass CNN, ">40 times" faster than SRCNN, parameter sets for 24 fps on a CPU **[C]**; FSRCNN-s is the small variant (d=32,s=5,m=1 **[S]**). **edge-SR** (2021, arXiv 2108.10335): one-layer "interpretable" upscalers positioned between bicubic and deep SR for edge devices; numbers are in the PDF, not the abstract **[?]**. **RAISR** (arXiv 1606.01299): learned filters, "one to two orders of magnitude faster" than competing SR **[C]**.
- **ONNX Runtime Web WebGPU EP** (onnxruntime.ai docs): `executionProviders:['webgpu']`, I/O binding with `GPUBuffer` tensors and `preferredOutputLocation:'gpu-buffer'` to stay on-GPU, graph capture for static shapes; **no performance numbers published**, and no `shader-f16` statement on that page.
- **Realistic per-frame costs at 1080p→1440p/4K on an iGPU: no public source found.** OpenCV CPU numbers (ESPCN ~8.8 ms, FSRCNN ~21.7 ms per *small* General100 image at 2×) only show ESPCN is the cheaper of the two. The only GPU datapoints are desktop (Anime4K-WebGPU <3 ms at 720p on RTX 3070 Ti/4090; Anime4K 1.5 ms pre-scaler 1080p→4K on Vega 64). Extrapolating an ~3 k-parameter FSRCNNX to a 780M-class iGPU at 1440p output would land in the several-ms range per frame **[my extrapolation, not a source]**.

### 1.9 Sharpening passes compared

| Pass | Taps | Adaptivity | Typical artefacts on compressed video | Cost anchor |
|---|---|---|---|---|
| Unsharp mask (e.g. LumaSharpenHook) | 3×3–5×5 | none | amplifies blocking edges, mosquito noise and ringing uniformly **[S]** | cheapest |
| CAS | 5 (or 9) | local soft-min/max contrast | moderate halo at sharpness→1; linear-light input required | "<100 µs on Navi" **[3P]** |
| RCAS | 5 | solves non-clipping weight + fixed limit; optional noise detector (`FSR_RCAS_DENOISE`) that *reduces* sharpening on grain-like detail | the denoise path is the one designed against noise/grain amplification; AMD suggests applying film grain after RCAS | 0.9 ms on iPhone 12 at 2532×1170 **[M, 3P]** |
| NVSharpen / NIS USM | 5×5 directional USM, luma-dependent strength ramp, LTI local-contrast term, limit clamp | directional | NVIDIA's guide warns sharpening "can enhance noisy or grainy regions" | no number **[C]** |
| adaptive-sharpen | 25 positions | edge strength + contrast compression + soft limiter | designed to narrow overshoot; still a sharpener | no number |

Metric trap: VMAF's standard models reward sharpening ("No Enhancement Gain" NEG mode exists precisely because enhancement operations inflate VMAF — VMAF README calls it the "codec evaluation-friendly NEG mode"; the Netflix memo was 403 for this tool). Any sharpening comparison must therefore not be scored with plain VMAF.

### 1.10 Compressed-video-aware upscaling

- **COMISR** (Google, ICCV 2021, arXiv 2105.01237): compression-informed *video* SR (bi-directional recurrent warping, detail-preserving flow, Laplacian enhancement; aware of intra-frame positions) — temporal and far from real-time; cited by SR+Codec as the one model that "eliminates the compression artifact… VRT and Real-ESRGAN fail to remove this artifact".
- **SR+Codec benchmark** (Bogatyrev, Molodetskikh, Vatolin, BMVC 2024 / arXiv 2305.04844 — PDF read): pipeline 4× bicubic downscale → 480×270 → x264/x265/vvenc/aomenc/uavs3e at **0.6/1.0/2.0 Mbps** (plus 0.1/0.3/4.0 for metrics) → 19 SR models incl. bicubic; crowd-sourced pairwise ranking. Findings: no single SR model handles all codecs; generative models (Real-ESRGAN, RealSR) rank best subjectively at very low bitrate; "No SR" wins with AV1 because libaom's own low-bitrate super-res mode already upsamples; RealSR+x264 at 1.2 Mbps ≈ x264 at 3.8 Mbps ("more than 65 %" bitrate saving). **Metric correlation with subjective (PLCC/SRCC): MS-SSIM 0.146/0.151, PSNR 0.187/0.285, VMAF 0.344/0.448, LPIPS 0.414/0.431, ERQA 0.582/0.624, MDTVSFA 0.634/0.644, ERQA×MDTVSFA 0.770/0.801** **[M]**.
- **Gap:** nothing published for a *spatial, real-time* upscaler on **10–50 Mbps H.264/HEVC/AV1 game video** (our regime). The two usable design cues are (a) EASU's 2×2 clamp and RCAS's noise detector are the only "artefact-aware" mechanisms in the cheap kernels, and (b) Anime4K's "Restore" family is the only shipped shader explicitly trained to remove compression artefacts before upscaling (anime-tuned, MIT).

---

## 2. Downscaling (4K stream on 1440p/1080p, 1080p on a 720p-wide phone)

- **Why a bilinear sampler aliases:** bilinear/bicubic "sample a fixed number of pixels… when downscaling by more than twice, they skip pixels" (Wikipedia Image scaling) → moiré on fences/text/HUD. libplacebo's `skip_anti_aliasing=yes` option description says the same thing in reverse: disabling anti-aliasing on downscaling "speeds up high downscaling ratios but causes moiré".
- **Correct approaches:**
  1. **Widened support** — mpv `--correct-downscaling` (default **on**): "extends the filter size when downscaling"; i.e. kernel radius × reduction factor, so Lanczos3 at 2× reduction becomes a 12×12 footprint (separable 12+12) **[S for the arithmetic]**. libplacebo does this implicitly for its downscalers.
  2. **Box/area average** — exact for integer ratios; libplacebo `box` "very fast".
  3. **Mipmap chain / successive 2× reductions** then a final resample — GPU-native, cheap, slightly blurrier; (AMD SPD does single-pass mip chains **[S]**).
  4. **Linear light** — mpv `--linear-downscaling` default on; Robidoux: "Downsample through linear light… otherwise, gamma-related damage can occur, especially with dense color patterns" (the opposite advice holds for enlarging with negative-lobe filters).
  5. **Variance-preserving** — SSimDownscaler (LGPLv3, 4 passes).
- **What mpv/libplacebo recommend:** mpv default `--dscale=hermite` since 0.37 ("fast, but prone to blocking" — chosen for speed); libplacebo downscaler presets listed "fastest to slowest": `box`, `hermite`, `bilinear` (triangle averaging), `bicubic`, `gaussian`, `catmull_rom`, `mitchell`, `lanczos`. Robidoux's ring test: tensor **Mitchell** / Triangle and EWA QuadraticJinc balance sharpness vs aliasing best; EWA generally suppresses moiré.
- **Vendor kernels:** NIS **rejects** downscaling (scale must be in [1,2]); EASU is 1–4× area *up* only; CAS's page claims up- and down-sampling in one pass **[C]**, but its 4×4 footprint is not area-correct beyond ~1.5× reduction **[S]**.
- **Cost:** a separable widened Lanczos at 2× reduction ≈ 12+12 fetches per output pixel across two passes (fewer output pixels, so absolute cost is lower than the equivalent upscale); a 2-level mip chain + bilinear ≈ 3 cheap passes **[S]**. No vendor-published downscale timings exist.

---

## 3. Quality metrics for upscaler comparison

### 3.1 Metrics

| Metric | What it is | Licence / impl. | Fit for spatial-upscaler A/B |
|---|---|---|---|
| PSNR / SSIM / MS-SSIM | pixel / structural error | everywhere | SR+Codec: SRCC 0.29 / — / 0.15 vs humans on upscaled compressed video — nearly useless for ranking; fine as a regression guard |
| **VMAF** (Netflix) | fused VIF/DLM/motion, trained on streaming subjective data | BSD-2+patent grant **[S]**; `libvmaf` | FAQ (read): default model assumes **1080p at 3H**; **`vmaf_4k_v0.6.1` trained for 4K TV at 1.5H** (added VDK 1.3.7); reference and distorted must be at the same resolution → upscale the distorted to the reference/display resolution first (FAQ's ffmpeg example uses `flags=bicubic`); "the VMAF model was not trained with upsampled references"; **NEG mode** removes enhancement gain (use it when sharpening is in the loop). SR+Codec: SRCC 0.45. There is also a phone model **[README mention]** |
| **ꟻLIP** (NVIDIA, HPG 2020 + HDR-FLIP) | perceptual difference when *alternating* two images; needs pixels-per-degree (example run: 67 ppd); outputs per-pixel map + mean (authors now recommend **mean** over weighted median) | **BSD-3-Clause**; C++/CUDA single header, `pip install flip-evaluator`, PyTorch loss | Designed for rendered-image comparison at a known viewing distance — the natural choice for "does this upscaler differ from the native render", and it gives a map that shows *where* (edges vs. flat) |
| LPIPS | deep-feature distance (AlexNet/VGG/Squeeze + linear calibration) | **BSD-2-Clause** | BAPPS has a 'superres' 2AFC subset; SR+Codec SRCC 0.43 |
| DISTS | VGG structure + texture similarity, tolerant to texture resampling / mild misalignment | **MIT** | good for generative SR; less relevant for linear kernels |
| **SSIMULACRA 2** (Cloudinary/libjxl) | MS-SSIM-like in XYB, 6 scales, blockiness/ringing and blur maps, 1- and 4-norms; score ≤100 (90 ≈ visually lossless in flicker test, 70 "high", 50 "medium", 30 "low"); tuned on CID22/TID2013/KADID-10k/KonFiG | **BSD-3-Clause + PATENTS file** | Built for *compression* artefacts (it has explicit blockiness/ringing terms) — useful to check that an upscaler/sharpener does not amplify codec artefacts; TID2013 SRCC 0.84 vs VMAF 0.74 |
| Butteraugli | libjxl psychovisual distance | Apache-2 **[S]** | image-level; same remark |
| ERQA, MDTVSFA | edge-restoration quality; no-reference VQA | research code | Highest correlation in SR+Codec; ERQA×MDTVSFA SRCC 0.80 |

### 3.2 What the big players actually used
AMD FSR1 pages: side-by-side images and sliders, **no metric**. NVIDIA NIS: none (ICAT comparison tool only). Qualcomm SGSR: "smooth images and sharp edges", **no metric**. Apple MetalFX: demo footage. Arm ASR: FPS/power charts and screenshots. Conclusion: there is no vendor protocol to copy; the academic one (SR+Codec) and NVIDIA's own metric (FLIP) are the defensible references.

### 3.3 Ground truth choice
- *Downscale-then-upscale against the native render* is the only protocol with a true reference and is what every SR paper and SR+Codec do (they downscale with ffmpeg bicubic). Caveat: results depend on the downscale filter; use the same one for all candidates and report it.
- *Compare to the real high-res stream* mixes codec noise into the reference; useful only as a sanity check of "does the upscaled low-bitrate stream look like the high-bitrate one", scored with no-reference or NEG metrics.

### 3.4 Recommended protocol (my synthesis, not a quoted source)
1. Corpus: 10–20 s clips from the real pipeline (captured game frames) at native 1440p/4K; also the *decoded* 1080p stream at 10/20/50 Mbps for the artefact-amplification check.
2. Reference = native frame. Candidate = native → downscale (Lanczos3 with widened support, linear light) → encode at the target bitrate → decode → candidate upscaler → display resolution.
3. Score per frame: **FLIP mean** at the real viewing ppd (phone ≈ 60–70 ppd at 35 cm for a 1080p-wide 6" panel **[S]**), **VMAF 4K model or default model matched to display**, both standard and **NEG**, **SSIMULACRA2** on sampled frames, PSNR as regression guard. Report median and p10 over frames; look at FLIP maps on HUD/text crops.
4. Sharpening passes must be judged with NEG + SSIMULACRA2 + a FLIP map, never with plain VMAF.

---

## 4. GPU time and power measurement

### 4.1 Tools by platform (what was verified)

| Platform | Tool | What it gives | Caveats (as read) |
|---|---|---|---|
| Any browser (WebGPU) | `timestamp-query` (Chrome 121+; `timestampWrites` on compute/render pass descriptors, `resolveQuerySet`, ns values) | per-pass GPU time | **quantised to 100 µs** by default; disable via `chrome://flags/#enable-webgpu-developer-features`; GPUs may reset counters → negative deltas; adapter support 98.8 % overall (web3dsurvey), Safari 92.7 %, Arm Bifrost 82 %. Our passes are 0.3–2 ms, so the flag is mandatory or you must time N stacked dispatches |
| Windows / Chrome | **PIX** (toji.dev guide) | per-draw/dispatch GPU durations on the D3D12 timeline, readable HLSL with `--enable-dawn-features=emit_hlsl_debug_symbols,disable_symbol_renaming` | launch Chrome from PIX with `--disable-gpu-sandbox --disable-gpu-watchdog`, run PIX as admin for timing, copy `WinPixEventRuntime.dll` into the Chrome version folder after every update; you see Dawn's D3D12 translation (extra barriers). RenderDoc: "limited WebGPU capture support" (Windows D3D12) |
| Windows (any app) | **PresentMon** (MIT) | per-frame `GPU Busy`, `GPU Time`, `GPU Wait`, display latency, click-to-photon; telemetry (GPU power/temp/utilisation via vendor APIs, NVAPI named) | "GPU execution metrics can be less accurate with HAGS enabled, sometimes by about 0.5 ms" — our bench rule is HAGS on, so this is a real floor |
| Windows GPU power | NVML (`nvmlDeviceGetPowerUsage`), AMD ADLX, Intel PCM/RAPL PP1, HWiNFO logging | board/package power at ~100 ms–1 s | **not fetched this session [?]**; iGPU "GPU power" on AMD APUs is an SMU estimate, not a rail |
| macOS / Chrome | Xcode Metal Debugger (toji.dev guide) | Metal capture with Dawn labels, GPU counters | requires a Chrome you can attach to (SIP off / strip codesign / own build), `--disable-gpu-sandbox`, `MTL_CAPTURE_ENABLED=1`, attach to "Chrome Helper (GPU)" as root; **browser freezes after each capture**; command-queue labels invisible. **Safari's GPU process: not covered by any source found [?]** |
| macOS power | `sudo powermetrics -s gpu_power -i <ms>` | GPU power (mW), frequency/residency | man page: "Average power values reported by powermetrics are estimated and may be inaccurate"; no external validation found |
| Android / shader cost offline | **Mali Offline Compiler** (`malioc --core Mali-G715 --vulkan …`) | approximate cycles per unit (A/LS/V/T), bound unit, shortest/longest path, registers, spilling, 16-bit % | "approximate cycle cost breakdown"; ignores cache misses, occupancy and scheduling ("must be measured with direct benchmarks on a real device"); texture cost assumes bilinear, trilinear ≈ 2×; loops → N/A. `--vulkan` mode exists; **whether it ingests a `.spv` produced by Tint from WGSL was not confirmed from the pages read [?]** (Tint can emit SPIR-V **[S]**) |
| Android / Adreno | **Adreno Offline Compiler** (Qualcomm Package Manager) | instruction counts, register footprint, texture reads; accepts **SPIR-V, HLSL, GLSL** (Qualcomm 2025 blog via search) | no per-shader *cycle* estimate confirmed; **Snapdragon Profiler** integrates it; Realtime mode gives `% shader busy`, clocks; its product page returned no body text [?] |
| Android / system | **Perfetto**: `gpu.renderstages.<vendor>`, `gpu.counters.<vendor>`, ftrace `power/gpu_frequency`; `android.power` battery counters (Pixel), **ODPM rails** (`collect_power_rails`, Pixel 6+; GPU rail e.g. `S2S_VDD_G3D`; API 35 `PowerMonitor` maps labels→rails) | GPU work slices per queue, GPU frequency, rail energy → `android_powerrails` metric `avg_used_power_mw` | render-stage producers are vendor-specific (`.adreno`, `.mali` suffixes must match); battery current reads positive on USB; ODPM "not yet available on most production phones" |
| Android / frame | **Android GPU Inspector** | per-render-pass GPU time, GPU counters (Adreno 6xx, Mali G76–G710 on listed Pixel/Samsung/OPPO/OnePlus) | **app must be `android:debuggable="true"`** → release Chrome cannot be frame-profiled; Android 11+ |
| Android / power | `dumpsys batterystats`, `/sys/class/power_supply/battery/current_now` | coarse whole-device | **[S]**, not fetched |
| External | **Monsoon HVPM** (Python API, PowerTool) | battery-bypass current/voltage; CTS `monsoon.py` samples at 5000 Hz | spec page served no table — voltage range/accuracy **unverified [?]** |

### 4.2 Methodology used by the one published mobile power study found
Kuro Games / Wuthering Waves (Android Developers story): ODPM via Perfetto trace processor, `avg_used_power_mw` over 30 s sessions; constant screen brightness; same scene, camera, duration, FPS cap and graphics settings; A/B across idle/running/combat; result 3233 → 2920 mW (−9.7 %). Proxies without ODPM: CPU/GPU clocks and bandwidth.

### 4.3 Realistic protocol and noise floor (my synthesis; floors cite the sources above)
- **GPU time:** WebGPU `timestamp-query` with quantisation disabled, around the upscale pass only; 10 s warm-up, then ≥ 5 runs × ≥ 600 frames, interleaved A/B/A/B in the same session; report median and p95 per run and the spread across runs. Cross-check one configuration per platform with PIX / Xcode / Perfetto render stages. Floors: 100 µs quantisation if the flag is forgotten; ~0.5 ms on PresentMon GPU metrics under HAGS; DVFS: Qualcomm's SGSR numbers are at *max GPU frequency* — at steady-state clocks expect 1.5–3× those figures **[my estimate]**, so report both "clocks pinned/max" and "steady-state after 10 min".
- **Power:** phones on battery (USB-charging corrupts battery counters) with ODPM (Pixel 6+) or Monsoon; fixed brightness, airplane mode, same clip, 30–60 s windows, ≥ 5 repeats, thermal soak first (and a soak check at the end: if the last run is > 10 % off the first, discard). Report ΔmW between candidates, not absolute mW. macOS `powermetrics` and Windows vendor counters are *estimates*: use them for A/B deltas on the same machine only. Expected noise floor: tens of mW on ODPM rails for a 30 s window **[Kuro-style methodology; floor is my estimate]**, hundreds of mW on whole-battery counters.
- **Controls:** brightness, charge state (battery 40–80 %), background apps/notifications killed, same browser build, same clip, same display refresh rate, thermal soak, and the renderer path recorded (Dawn backend, fp16 availability).

---

## 5. Realism check — published per-frame costs of single-pass spatial upscalers

| GPU / device | Scaler | Resolution | Cost | Marker |
|---|---|---|---|---|
| Adreno 660 (SD888) / 730 (8 Gen 1) / 740 (8 Gen 2), max clock | SGSR1 | 1240×576 in → (≈1080p-class panel, not stated) | **0.476 / 0.356 / 0.295 ms**; bilinear 0.248 / 0.196 / 0.156 ms | **[M, Qualcomm README]** |
| Adreno 750 (8 Gen 3), max clock | SGSR2 2-pass fragment (temporal, for calibration) | 630×1400–840×1866 → 1260×2800 | 0.91–1.11 ms | **[M, Qualcomm]** |
| Apple A14 (iPhone 12) | FSR1 EASU (pixel shader) / RCAS | 1772×819 → 2532×1170 | **5.4 ms stock → 1.8 ms optimised; RCAS 0.9 ms** | **[M, 3P blog]** |
| Apple A15 (iPhone 13) | MetalFX Spatial | 0.5–0.8 render scale (Unity) | whole frame 14 → 26 ms | **[3P forum, not isolated]** |
| Immortalis-G715 / G720 | Arm ASR (temporal) | 2400×1080–2800×1260 | 2.5–6.5 ms | **[C, Arm]** |
| Desktop RX 6800 XT … RX 5700 XT | FSR1 (EASU+RCAS) | 1440p / 4K | 0.20–0.50 / 0.40–1.0 ms | **[C, AMD "upper bounds"]** |
| Vega 64 | Anime4K pre-scaler | 1080p → 4K | ~1.5 ms (4 ms total chain) | **[C, release note via search]** |
| RTX 3070 Ti / 4090 | Anime4K-WebGPU (WGSL compute) | 720p in | "within 3 ms" | **[M, project README]** |
| NIS (any GPU) | — | — | **no published ms** | — |
| CAS | — | — | "<100 µs on Navi" | **[3P hearsay]** |
| **Intel Xe-LPG / Arc 140V, AMD 780M/890M, Apple M1–M4, Mali-G7xx spatial, Adreno 8xx** | any spatial scaler | — | **no public data found** | — |

Reading across: a 12-tap directional kernel costs ~0.3 ms at ~2.5 MP output on a 2023 flagship Adreno **at max clock**, and ~2–5 ms at ~3 MP on an A14 as a *fragment* shader before hand-optimisation; output-pixel scaling suggests 1440p (3.7 MP) ≈ 0.45 ms on an 8 Gen 2 at max clock and plausibly 1–1.5 ms at throttled clocks **[extrapolation]**. For the AMD 780M / Intel Arc 140V class there is simply nothing to cite — these must be measured on the bench.

---

## 6. URLs actually fetched and read (primary sources)

NIS: github.com/NVIDIAGameWorks/NVIDIAImageScaling (README), raw …/main/NIS/NIS_Scaler.h, raw …/main/NIS/NIS_Config.h, github …/tree/main/docs, raw …/docs/NIS_SDK_Programming_Guide.pdf (text-extracted locally), github.com/NVIDIAGameWorks/Streamline/blob/main/docs/ProgrammingGuideNIS.md.
AMD: github.com/GPUOpen-Effects/FidelityFX-CAS (README), raw …/ffx-cas/ffx_cas.h, gpuopen.com/fidelityfx-cas/, github.com/GPUOpen-Effects/FidelityFX-FSR (README), raw …/ffx-fsr/ffx_fsr1.h, gpuopen.com/fidelityfx-superresolution/, gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-spatial/, atyuwen.github.io/posts/optimizing-fsr/.
Qualcomm: github.com/SnapdragonStudios/snapdragon-gsr (README), raw …/sgsr/v1/README.md, raw …/sgsr/v2/README.md, github …/tree/main/sgsr/v1.
Apple: developer.apple.com/videos/play/wwdc2022/10103/, developer.apple.com/forums/thread/736915, developer.apple.com/tutorials/data/documentation/metalfx/mtlfxspatialscalerdescriptor.json (+ inputwidth.json).
Arm/Intel: github.com/arm/accuracy-super-resolution-generic-library, newsroom.arm.com/blog/arm-accuracy-super-resolution-mobile-gaming, github.com/intel/xess (+ /tree/main/doc).
Classical: developer.nvidia.com/gpugems/gpugems2/…/chapter-20-fast-third-order-texture-filtering, gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1, raw mpv DOCS/man/options.rst (chunks), github.com/mpv-player/mpv/releases/tag/v0.37.0, libplacebo.org/options/, usage.imagemagick.org/filter/nicolas/, en.wikipedia.org/wiki/Image_scaling, en.wikipedia.org/wiki/Directional_Cubic_Convolution_Interpolation, gmic.eu/reference/scale_dcci2x.html.
Edge-directed papers: www.ece.lsu.edu/gunturk/EE7700/NEDI.pdf and www.scitepress.org/Papers/2008/10741/10741.pdf (both text-extracted locally); Semantic Scholar API records for DOIs 10.1109/83.951537, 10.1049/iet-ipr.2011.0534, 10.1109/TIP.2011.2136352.
mpv ecosystem: github.com/bjin/mpv-prescalers (README), raw …/nnedi3-nns32-win8x4.hook, github.com/igv/FSRCNN-TensorFlow, gists igv/8a77e4eb… (adaptive-sharpen), igv/2364ffa6… (SSimSuperRes), igv/a015fc88… (KrigBilateral), igv/36508af3… (SSimDownscaler), github.com/bloc97/Anime4K (README, md/GLSL_Instructions_Advanced.md, md/GLSL_Instructions_Windows_MPV.md), github.com/Anime4KWebBoost/Anime4K-WebGPU, github.com/mpv-player/mpv/wiki/User-Scripts.
Neural: arxiv.org/abs/1609.05158, arxiv.org/abs/1608.00367, arxiv.org/abs/2108.10335, arxiv.org/abs/1606.01299, arxiv.org/abs/2105.01237, bmva-archive.org.uk/bmvc/2024/papers/Paper_959/paper.pdf (text-extracted locally), onnxruntime.ai/docs/tutorials/web/ep-webgpu.html.
Metrics: github.com/Netflix/vmaf/blob/master/resource/doc/faq.md, raw …/README.md, github …/tree/master/resource/doc, github.com/NVlabs/flip (+ raw README, src/python/README.md, src tree), research.nvidia.com/publication/2020-07_flip, github.com/cloudinary/ssimulacra2, github.com/richzhang/PerceptualSimilarity, github.com/dingkeyan93/DISTS.
Tooling: developer.chrome.com/blog/new-in-webgpu-121, web3dsurvey.com/webgpu/features/timestamp-query, toji.dev/webgpu-profiling/ (+ /pix, /xcode), github.com/GameTechDev/PresentMon (+ README-ConsoleApplication.md), keith.github.io/xcode-man-pages/powermetrics.1.html, learn.arm.com/learning-paths/mobile-graphics-and-gaming/ams/malioc/, developer.arm.com/community/…/accelerating-shader-programs-with-mali-offline-compiler-7, perfetto.dev/docs/data-sources/battery-counters, perfetto.dev/docs/data-sources/gpu, developer.android.com/agi (+ /start, /supported-devices), developer.android.com/stories/games/kuro-powerprofiler, www.msoon.com/high-voltage-power-monitor (+ /specifications, empty).
Web searches (extended where noted) were used only to locate the above and for the secondary quotes marked [3P].

## 7. Could not verify (explicit list)

1. **NIS performance in ms** — none exists in NVIDIA's repo, guide or Streamline doc; press numbers are whole-frame FPS.
2. **NIS `kFilterSize`** — header says 6-tap support; config tables are 64×8; I report both as read.
3. **CAS official cost** — only forum hearsay ("<100 µs on Navi").
4. **MetalFX Spatial cost and scale limits** — Apple publishes neither; forum/MSPR figures were search snippets, not fetched pages.
5. **Arm ASR community blog with per-mode tables** — 404 at both URLs; numbers taken from the GitHub README instead.
6. **XeSS-SR input requirements** — developer guide not fetched (MV/depth/jitter requirement stated from general knowledge).
7. **DCCI internals (1.15 threshold, k=5, (−1,9,9,−1)/16)** — confirmed only via G'MIC defaults and Wikipedia; IET paper paywalled. **ICBI iteration count** and MATLAB licences — not read. **iNEDI code licence** — author site TLS-expired.
8. **RAISR hashing details (angle/strength/coherence, 11×11 filters)** — abstract only.
9. **FSRCNNX shader licence** — repo carries GPL-3.0 and an MIT file; unresolved.
10. **Anime4K "1.5 ms on Vega 64"** — from a release-note search snippet.
11. **Mali Offline Compiler `.spv` input flag** and the Tint→SPIR-V→malioc path; **Adreno Offline Compiler cycle output**; **Snapdragon Profiler** page body (empty) and docs.
12. **Xcode Metal System Trace attached to Safari's GPU process** — no source at all; only Chrome is documented (toji.dev).
13. **`powermetrics gpu_power` accuracy** — no external validation found; man page itself says estimates.
14. **Monsoon HVPM specs** (voltage range, accuracy, 5 kHz) — spec page served no table.
15. **NVML / ADLX / Intel PCM / HWiNFO GPU-power semantics** — not fetched.
16. **VMAF `models.md` / NEG memo** — 404/403; NEG existence confirmed from README, 4K model from FAQ.
17. **FLIP default viewing parameters (0.7 m, 0.7 m, 3840 px → 67 ppd)** — only "Pixels per degree: 67" seen in the example output.
18. **Chrome `--enable-gpu-command-logging`, chrome://tracing / Perfetto GPU tracks for Dawn** — not checked.
19. **mpv manual's full kernel list (spline16/36/64, ginseng, robidoux, haasnsoft, box, triangle…)** — not in the chunks read; defaults and the main filters were.
20. **Per-frame costs on Intel Xe-LPG/Arc 140V, AMD 780M/890M, Apple M-series, Mali-G7xx/Immortalis, Adreno 8xx for any spatial scaler** — no public data; bench measurement required.
21. "Fast edge-adaptive" family (Allebach–Wong EASE, Fast-NEDI patent) — not read.

Notes: WebFetch hit a session rate limit at the very end (resets 03:20 Europe/Paris), which is why items 5, 15, 16 and 17 stayed open; everything else above was read directly. Scratchpad holds the four extracted PDF texts (`…/scratchpad/pdftext/`); nothing in the repository was touched.