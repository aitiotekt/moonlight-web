// compare-worker.js — the CPU side of compare.js (the side-by-side viewer of
// the upscalers): the bicubic reductions of the picture, which are the inputs
// of the upscale cases and the references of the reductions, and the distance
// of an output to its reference. Off the main thread: a 1440p reduction is a
// hundred million multiplications, an SSIM map four hundred million.
//
// Messages (every reply carries the request's id):
//   {type: "source", width, height, data, levels: [1080, 720]}
//     the picture, kept as the reference at its own height; each level's
//     reduction computed, kept as that level's reference, and sent back
//     → {levels: {1080: ArrayBuffer, 720: ArrayBuffer}} (RGBA, 16:9)
//   {type: "metrics", level, width, height, data}
//     an output at that level → {psnr, ssim, black}
//
// The reduction is the Catmull-Rom bicubic (a = -0.5), separable, in gamma
// space, its support widened by the reduction factor so that it antialiases:
// Pillow's Image.BICUBIC. PSNR is on the RGB values; SSIM on the luma (BT.709
// weights), with the Gaussian window of Wang et al. (σ 1.5, 11 taps) and the
// window's border cropped before the mean: the definition of metrics.py
// (scikit-image, gaussian_weights, no sample covariance).

const refs = new Map(); // height → {w, h, data: Uint8ClampedArray}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "source") {
      const src = {
        w: m.width,
        h: m.height,
        data: new Uint8ClampedArray(m.data),
      };
      refs.clear();
      refs.set(m.height, src);
      const levels = {};
      const transfer = [];
      for (const h of m.levels) {
        const w = Math.round((h * src.w) / src.h);
        const red = resample(src, w, h);
        refs.set(h, red);
        const copy = red.data.slice();
        levels[h] = copy.buffer;
        transfer.push(copy.buffer);
      }
      self.postMessage({ id: m.id, levels }, transfer);
    } else if (m.type === "metrics") {
      const ref = refs.get(m.level);
      if (!ref) throw new Error("no reference at " + m.level + "p");
      if (ref.w !== m.width || ref.h !== m.height)
        throw new Error(
          `output ${m.width}x${m.height}, reference ${ref.w}x${ref.h}`,
        );
      const out = {
        w: m.width,
        h: m.height,
        data: new Uint8ClampedArray(m.data),
      };
      self.postMessage({
        id: m.id,
        psnr: psnr(ref.data, out.data),
        ssim: ssim(ref, out),
        black: isBlack(out.data),
      });
    } else throw new Error("message " + m.type + "?");
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};

// ── the bicubic reduction ──────────────────────────────────────────────────

// Keys' cubic with a = -0.5 (Catmull-Rom).
function cubic(x) {
  x = Math.abs(x);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

// The taps of every output index along one axis: where they start, how many,
// and their weights, normalised. Pillow's conventions (centre at (i + ½) ×
// scale, support 2 × max(1, scale)).
function taps(inN, outN) {
  const scale = inN / outN;
  const fs = Math.max(1, scale);
  const support = 2 * fs;
  const maxTaps = Math.ceil(2 * support) + 2;
  const start = new Int32Array(outN);
  const count = new Int32Array(outN);
  const w = new Float32Array(outN * maxTaps);
  for (let i = 0; i < outN; i++) {
    const center = (i + 0.5) * scale;
    let lo = Math.floor(center - support + 0.5);
    let hi = Math.floor(center + support + 0.5);
    if (lo < 0) lo = 0;
    if (hi > inN) hi = inN;
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      const v = cubic((j - center + 0.5) / fs);
      w[i * maxTaps + (j - lo)] = v;
      sum += v;
    }
    for (let j = 0; j < hi - lo; j++) w[i * maxTaps + j] /= sum;
    start[i] = lo;
    count[i] = hi - lo;
  }
  return { start, count, w, maxTaps };
}

function resample(src, outW, outH) {
  const { w: inW, h: inH, data } = src;
  const tx = taps(inW, outW);
  const ty = taps(inH, outH);
  // rows at the output width, in float
  const tmp = new Float32Array(inH * outW * 3);
  for (let y = 0; y < inH; y++) {
    const row = y * inW * 4;
    const trow = y * outW * 3;
    for (let x = 0; x < outW; x++) {
      const s = tx.start[x];
      const n = tx.count[x];
      const wo = x * tx.maxTaps;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < n; k++) {
        const wt = tx.w[wo + k];
        const p = row + (s + k) * 4;
        r += wt * data[p];
        g += wt * data[p + 1];
        b += wt * data[p + 2];
      }
      const o = trow + x * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  const acc = new Float32Array(outW * 3);
  for (let y = 0; y < outH; y++) {
    acc.fill(0);
    const s = ty.start[y];
    const n = ty.count[y];
    const wo = y * ty.maxTaps;
    for (let k = 0; k < n; k++) {
      const wt = ty.w[wo + k];
      const trow = (s + k) * outW * 3;
      for (let i = 0; i < outW * 3; i++) acc[i] += wt * tmp[trow + i];
    }
    const orow = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const o = orow + x * 4;
      out[o] = Math.round(acc[x * 3]);
      out[o + 1] = Math.round(acc[x * 3 + 1]);
      out[o + 2] = Math.round(acc[x * 3 + 2]);
      out[o + 3] = 255;
    }
  }
  return { w: outW, h: outH, data: out };
}

// ── the distances ──────────────────────────────────────────────────────────

function psnr(a, b) {
  let se = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    se += dr * dr + dg * dg + db * db;
  }
  const mse = se / ((n / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

const SIGMA = 1.5;
const RADIUS = 5; // scipy's truncate 3.5: int(3.5 × 1.5 + 0.5)
const GAUSS = (() => {
  const g = new Float32Array(2 * RADIUS + 1);
  let s = 0;
  for (let k = -RADIUS; k <= RADIUS; k++) {
    const v = Math.exp(-(k * k) / (2 * SIGMA * SIGMA));
    g[k + RADIUS] = v;
    s += v;
  }
  for (let i = 0; i < g.length; i++) g[i] /= s;
  return g;
})();

// The SSIM of the luma, averaged over the picture less a border of RADIUS
// (scikit-image crops the window's half width before its mean), so that no
// window ever reaches past the picture: computed by strips of rows, the five
// maps (μx, μy, E[x²], E[y²], E[xy]) blurred horizontally per input row, then
// vertically per output row, a few megabytes at a time.
function ssim(ref, out) {
  const { w, h } = ref;
  const R = RADIUS;
  if (w <= 2 * R || h <= 2 * R) return NaN;
  const STRIP = 64;
  const rowsMax = STRIP + 2 * R;
  const maps = [];
  for (let k = 0; k < 5; k++) maps.push(new Float32Array(rowsMax * w));
  const lx = new Float32Array(w);
  const ly = new Float32Array(w);
  const prod = [
    lx,
    ly,
    new Float32Array(w),
    new Float32Array(w),
    new Float32Array(w),
  ];
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let cnt = 0;
  for (let y0 = R; y0 < h - R; y0 += STRIP) {
    const y1 = Math.min(h - R, y0 + STRIP);
    const rows = y1 - y0 + 2 * R;
    for (let r = 0; r < rows; r++) {
      const sy = y0 - R + r;
      lumaRow(ref.data, sy, w, lx);
      lumaRow(out.data, sy, w, ly);
      for (let x = 0; x < w; x++) {
        prod[2][x] = lx[x] * lx[x];
        prod[3][x] = ly[x] * ly[x];
        prod[4][x] = lx[x] * ly[x];
      }
      for (let k = 0; k < 5; k++) blurRow(prod[k], w, maps[k], r * w);
    }
    for (let yy = y0; yy < y1; yy++) {
      const r0 = yy - (y0 - R); // the strip row of this output row
      for (let x = R; x < w - R; x++) {
        let mx = 0;
        let my = 0;
        let exx = 0;
        let eyy = 0;
        let exy = 0;
        for (let k = -R; k <= R; k++) {
          const g = GAUSS[k + R];
          const i = (r0 + k) * w + x;
          mx += g * maps[0][i];
          my += g * maps[1][i];
          exx += g * maps[2][i];
          eyy += g * maps[3][i];
          exy += g * maps[4][i];
        }
        const vx = exx - mx * mx;
        const vy = eyy - my * my;
        const vxy = exy - mx * my;
        sum +=
          ((2 * mx * my + C1) * (2 * vxy + C2)) /
          ((mx * mx + my * my + C1) * (vx + vy + C2));
        cnt++;
      }
    }
  }
  return sum / cnt;
}

function lumaRow(data, y, w, out) {
  let p = y * w * 4;
  for (let x = 0; x < w; x++, p += 4)
    out[x] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
}

// One row blurred horizontally into dst at `at`, for the columns the mean
// keeps ([RADIUS, w - RADIUS)); the others stay whatever they were.
function blurRow(src, w, dst, at) {
  const R = RADIUS;
  for (let x = R; x < w - R; x++) {
    let s = 0;
    for (let k = -R; k <= R; k++) s += GAUSS[k + R] * src[x + k];
    dst[at + x] = s;
  }
}

// A picture that is black all over (a capture that failed): every 97th pixel.
function isBlack(data) {
  for (let i = 0; i < data.length; i += 97 * 4)
    if (data[i] || data[i + 1] || data[i + 2]) return false;
  return true;
}
