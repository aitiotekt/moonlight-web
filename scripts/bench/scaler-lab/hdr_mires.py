"""The HDR test pictures of the laboratory (plan upscaler-mwsr.md §4.1, criterion
C8), in the renderer's `linear` feed: Display-P3 linear light with 1.0 = 203 nits,
encoded with the sRGB transfer continued past 1.0, as WebGpuRenderer's HDR pass
0 writes it to the rgba16float intermediate (1000 nits ≈ 2.0, 10000 nits ≈ 5.3).

    ramp(w, h)      a PQ ramp in grey and in red, PQ steps with a dark line, fine stripes
    text(w, h)      black text on 1000 nits, 1000-nit text on 10 nits, red text on white
    game(png)       the page's SDR `game` picture, its highlights expanded to 1000 nits

Each returns linear nits (h, w, 3) float32; write() encodes the ground truth at
the output size (.npy, float32 RGB) and the input at the input size (.f16, RGBA
half floats, reduced in linear light with Lanczos-3 like the SDR inputs).
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REF_WHITE = 203.0
# SMPTE ST 2084
M1, M2, C1, C2, C3 = 0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875


def pq_eotf(e):
    ep = np.power(np.clip(e, 0.0, 1.0), 1.0 / M2)
    return 10000.0 * np.power(np.maximum(ep - C1, 0.0) / (C2 - C3 * ep), 1.0 / M1)


def pq_oetf(nits):
    y = np.power(np.clip(nits / 10000.0, 0.0, 1.0), M1)
    return np.power((C1 + C2 * y) / (1.0 + C3 * y), M2)


def lin_to_srgb(c):
    """The sRGB transfer, continued past 1.0 (the renderer's linToSrgb)."""
    c = np.maximum(c, 0.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def srgb_to_lin(v):
    v = np.maximum(v, 0.0)
    return np.where(v <= 0.04045, v / 12.92, np.power((v + 0.055) / 1.055, 2.4))


def encode(nits):
    """Linear nits → the feed's encoded values (float32)."""
    return lin_to_srgb(np.asarray(nits, dtype=np.float32) / REF_WHITE).astype(np.float32)


def _font(px):
    for name in ("consola.ttf", "cour.ttf", "DejaVuSansMono.ttf"):
        for d in (r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"):
            p = os.path.join(d, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def ramp(w, h):
    nits = np.zeros((h, w, 3), dtype=np.float32)
    x = (np.arange(w, dtype=np.float32) + 0.5) / w
    band = h // 5
    # 1. grey PQ ramp, 0 → 10000 nits, perceptually uniform along x
    nits[0:band, :, :] = pq_eotf(x)[None, :, None]
    # 2. the same ramp in red (channel value, P3)
    nits[band:2 * band, :, 0] = pq_eotf(x)[None, :]
    # 3. twelve PQ-uniform steps of grey, a 2-px dark line in the middle of each
    steps = pq_eotf((np.arange(12) + 1.0) / 12.0)
    y0, y1 = 2 * band, 3 * band
    for k in range(12):
        xa, xb = (k * w) // 12, ((k + 1) * w) // 12
        nits[y0:y1, xa:xb, :] = steps[k]
        xm = (xa + xb) // 2
        nits[y0 + band // 4:y1 - band // 4, xm:xm + 2, :] = 1.0
    # 4. stripes of 1000 nits and 0.5 nit, 4 px then 2 px wide, and a 1000-nit
    #    field with 1-nit text-sized squares
    y0, y1 = 3 * band, 4 * band
    xs = np.arange(w)
    nits[y0:y1, :, :] = np.where(((xs // 4) % 2 == 0)[None, :, None], 1000.0, 0.5)
    nits[y0 + band // 2:y1, :, :] = np.where(((xs // 2) % 2 == 0)[None, :, None], 1000.0, 0.5)
    # 5. a soft diagonal gradient 5 → 400 nits (the flat path must leave it alone)
    y0 = 4 * band
    yy, xx = np.mgrid[y0:h, 0:w]
    t = (xx / w + (yy - y0) / max(1, h - y0)) / 2.0
    nits[y0:h, :, :] = pq_eotf(0.3 + 0.4 * t)[..., None]
    return nits


def _text_block(w, h, px, lines, fg, bg):
    """A block of monospaced text, anti-aliased, composed in linear light."""
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    f = _font(px)
    y = px // 2
    k = 0
    while y < h - px:
        d.text((px // 2, y), lines[k % len(lines)], fill=255, font=f)
        y += int(px * 1.4)
        k += 1
    m = (np.asarray(mask, dtype=np.float32) / 255.0)[..., None]
    return (np.asarray(bg, dtype=np.float32) * (1.0 - m) + np.asarray(fg, dtype=np.float32) * m).astype(np.float32)


LINES = [
    "The quick brown fox jumps over the lazy dog 0123456789",
    "mwsr: one sample on the flat, five on the edges; HDR 203 nits = 1.0",
    "clamp(R, lo, hi) — no pixel beyond the local maximum of the input",
    "ΔE ITP ≤ FSR1 on the same feed; the maximum of the picture kept",
]


def text(w, h):
    third = h // 3
    px = max(12, h // 60)
    white = [1000.0, 1000.0, 1000.0]
    blocks = [
        _text_block(w, third, px, LINES, [0.5, 0.5, 0.5], white),          # black on 1000 nits
        _text_block(w, third, px, LINES, white, [10.0, 10.0, 10.0]),       # 1000-nit text on 10 nits
        _text_block(w, h - 2 * third, px, LINES, [500.0, 0.0, 0.0], white),  # P3 red on white
    ]
    # the right third of each block: the same text at half the size
    small = max(9, px // 2)
    for b, (fg, bg) in zip(blocks, [([0.5] * 3, white), (white, [10.0] * 3), ([500.0, 0.0, 0.0], white)]):
        x0 = (2 * w) // 3
        b[:, x0:, :] = _text_block(w - x0, b.shape[0], small, LINES, fg, bg)
    return np.concatenate(blocks, axis=0)


def game(png_path):
    """The SDR `game` picture of the page (its ground truth PNG) in HDR: linear
    light, the highlights expanded up to 1000 nits (gain 1 → 5 over the top
    half of the SDR range), the rest at SDR levels."""
    img = np.asarray(Image.open(png_path).convert("RGB"), dtype=np.float32) / 255.0
    lin = srgb_to_lin(img)
    y = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    t = np.clip((y - 0.5) / 0.5, 0.0, 1.0)
    gain = 1.0 + 4.0 * t * t * (3.0 - 2.0 * t)
    return (lin * gain[..., None] * REF_WHITE).astype(np.float32)


def reduce_linear(nits, size):
    """Lanczos-3 reduction in linear light (nits), per channel."""
    chans = [Image.fromarray(np.ascontiguousarray(nits[..., c]), mode="F").resize(size, Image.LANCZOS)
             for c in range(3)]
    return np.maximum(np.stack([np.asarray(c, dtype=np.float32) for c in chans], axis=2), 0.0)


def write(nits_out, in_size, gt_path, in_path):
    """The ground truth (encoded, .npy float32 RGB at the output size) and the
    input (encoded, .f16 RGBA half floats at in_size)."""
    np.save(gt_path, encode(nits_out))
    enc_in = encode(reduce_linear(nits_out, in_size))
    rgba = np.concatenate([enc_in, np.ones(enc_in.shape[:2] + (1,), dtype=np.float32)], axis=2)
    with open(in_path, "wb") as f:
        f.write(np.ascontiguousarray(rgba, dtype=np.float16).tobytes())
    return enc_in


def preview_png(encoded, path):
    """A PQ-encoded grey-ish preview of an encoded picture, for a quick look."""
    nits = srgb_to_lin(np.asarray(encoded, dtype=np.float32)) * REF_WHITE
    Image.fromarray((np.clip(pq_oetf(nits), 0, 1) * 255.0 + 0.5).astype(np.uint8), mode="RGB").save(path)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("mire", choices=["ramp", "text"])
    ap.add_argument("--out", default="2560x1440")
    ap.add_argument("--in", dest="size_in", default="1280x720")
    ap.add_argument("--dir", default=".")
    a = ap.parse_args()
    ow, oh = (int(x) for x in a.out.split("x"))
    iw, ih = (int(x) for x in a.size_in.split("x"))
    n = ramp(ow, oh) if a.mire == "ramp" else text(ow, oh)
    base = os.path.join(a.dir, "hdr-" + a.mire)
    write(n, (iw, ih), base + "-gt.npy", base + "-in.f16")
    preview_png(encode(n), base + "-gt-preview.png")
    print("wrote", base + "-gt.npy", base + "-in.f16")
