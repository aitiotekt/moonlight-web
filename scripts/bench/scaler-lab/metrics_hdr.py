"""Quality of an upscaler's output on the HDR `linear` feed (plan upscaler-mwsr.md
§4.1, criterion C8), from the laboratory's half-float dumps.

The pictures are the feed's encoded values (hdr_mires.py: Display-P3, 1.0 = 203
nits, sRGB transfer continued past 1.0). Everything is judged in linear light:

- ΔE ITP (ITU-R BT.2124, ICtCp from BT.2020 linear nits): mean, p99 and max of
  the colour difference to the ground truth; 1 unit ≈ one just noticeable
  difference. The threshold is FSR1 on the same feed (plan §8.1).
- PSNR and SSIM of the PQ-encoded picture (perceptually uniform code values).
- the maximum luminance of the output against the input's (a highlight must
  not be lost: ratio ≈ 1), and the share of pixels beyond the local 2×2
  maximum of the input in linear light (1 % + 0.5 nit of tolerance): ringing.
"""
import numpy as np
from skimage.metrics import structural_similarity

from hdr_mires import REF_WHITE, pq_oetf, srgb_to_lin

# The renderer's BT.2020 → P3 matrix (WGSL, column-major), as rows here.
M_2020_TO_P3 = np.array([[1.343578, -0.282180, -0.061399],
                         [-0.065298, 1.075788, -0.010491],
                         [0.002822, -0.019599, 1.016777]], dtype=np.float64)
M_P3_TO_2020 = np.linalg.inv(M_2020_TO_P3)
# BT.2100 ICtCp
M_RGB_TO_LMS = np.array([[1688, 2146, 262], [683, 2951, 462], [99, 309, 3688]], dtype=np.float64) / 4096.0
M_LMS_TO_ICTCP = np.array([[2048, 2048, 0], [6610, -13613, 7003], [17933, -17390, -543]], dtype=np.float64) / 4096.0
Y_2020 = np.array([0.2627, 0.6780, 0.0593])


def load_f16(path, w, h):
    """An RGBA half-float dump of the lab → encoded RGB float32 (h, w, 3)."""
    a = np.frombuffer(open(path, "rb").read(), dtype=np.float16)
    if a.size != w * h * 4:
        raise SystemExit("%s: %d halves, not %dx%dx4" % (path, a.size, w, h))
    return a.reshape(h, w, 4)[..., :3].astype(np.float32)


def nits_2020(encoded):
    lin_p3 = srgb_to_lin(np.asarray(encoded, dtype=np.float64)) * REF_WHITE
    return np.maximum(lin_p3 @ M_P3_TO_2020.T, 0.0)


def ictcp(nits):
    lms = np.maximum(nits @ M_RGB_TO_LMS.T, 0.0)
    return pq_oetf(lms) @ M_LMS_TO_ICTCP.T


def delta_e_itp(a, b):
    """ΔE ITP between two ICtCp pictures (ΔT = 0.5 ΔCt)."""
    d = a - b
    return 720.0 * np.sqrt(d[..., 0] ** 2 + 0.25 * d[..., 1] ** 2 + d[..., 2] ** 2)


def luminance(nits):
    return nits @ Y_2020


def overshoot_linear(out_nits, in_nits, rel=0.01, abs_nits=0.5):
    oh, ow = out_nits.shape[:2]
    ih, iw = in_nits.shape[:2]
    px = (np.arange(ow) + 0.5) * (iw / ow) - 0.5
    py = (np.arange(oh) + 0.5) * (ih / oh) - 0.5
    x0 = np.clip(np.floor(px).astype(int), 0, iw - 1)
    x1 = np.clip(x0 + 1, 0, iw - 1)
    y0 = np.clip(np.floor(py).astype(int), 0, ih - 1)
    y1 = np.clip(y0 + 1, 0, ih - 1)
    a = in_nits[y0][:, x0]
    b = in_nits[y0][:, x1]
    c = in_nits[y1][:, x0]
    d = in_nits[y1][:, x1]
    lo = np.minimum(np.minimum(a, b), np.minimum(c, d))
    hi = np.maximum(np.maximum(a, b), np.maximum(c, d))
    over = (out_nits > hi * (1 + rel) + abs_nits) | (out_nits < lo * (1 - rel) - abs_nits)
    return float(over.any(axis=2).mean())


def measure(gt_enc, in_enc, out_enc):
    if out_enc.shape != gt_enc.shape:
        raise SystemExit("size %s != ground truth %s" % (out_enc.shape, gt_enc.shape))
    gt = nits_2020(gt_enc)
    inp = nits_2020(in_enc)
    out = nits_2020(out_enc)
    de = delta_e_itp(ictcp(gt), ictcp(out))
    pq_gt = pq_oetf(gt)
    pq_out = pq_oetf(out)
    mse = float(np.mean((pq_gt - pq_out) ** 2))
    h, w = gt.shape[:2]
    cy0, cy1, cx0, cx1 = h // 3, 2 * h // 3, w // 3, 2 * w // 3
    de_c = de[cy0:cy1, cx0:cx1]
    mse_c = float(np.mean((pq_gt[cy0:cy1, cx0:cx1] - pq_out[cy0:cy1, cx0:cx1]) ** 2))
    return {
        "dEitp": float(de.mean()),
        "dEitpP99": float(np.percentile(de, 99)),
        "dEitpMax": float(de.max()),
        "centre": {"dEitp": float(de_c.mean()), "dEitpP99": float(np.percentile(de_c, 99)),
                   "psnrPQ": float(10 * np.log10(1.0 / mse_c)) if mse_c > 0 else 99.0},
        "psnrPQ": float(10 * np.log10(1.0 / mse)) if mse > 0 else 99.0,
        "ssimPQ": float(structural_similarity(luminance(pq_gt), luminance(pq_out), data_range=1.0,
                                              gaussian_weights=True, sigma=1.5, use_sample_covariance=False)),
        "maxNits": float(luminance(out).max()),
        "maxRatio": float(luminance(out).max() / max(luminance(inp).max(), 1e-6)),
        "overshoot": overshoot_linear(out, inp),
    }


def fmt_row(cell, r):
    return "%-14s dE ITP %6.3f p99 %6.2f max %7.2f | centre %6.3f / %6.2f | PSNR PQ %6.2f SSIM %.4f | max %7.1f nits (x%.3f) | over %5.2f%%" % (
        cell, r["dEitp"], r["dEitpP99"], r["dEitpMax"], r["centre"]["dEitp"], r["centre"]["dEitpP99"],
        r["psnrPQ"], r["ssimPQ"], r["maxNits"], r["maxRatio"], 100 * r["overshoot"])
