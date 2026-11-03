"""P8.0: the lab's dumped crops (raw RGBA rows, .f16 by the server's naming) as
PNGs for the comparison page: the truth and each variant of one frame, whole
(640x360 of the 1440p screen) and a zoomed part.

  python p8_labcrops.py <out_dir> <run> <t> <kbps> <zx,zy,zw,zh> <zoom> <variant>…
  e.g. p8v-x2-cloud-vid 50 4000 200,120,160,90 4 none dbd-t3-n16 dbe-s2
"""
import os, sys

import numpy as np
from PIL import Image

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
LAB = os.path.join(REPO, "bench-out", "scaler-lab", "p8", "lab")
W, H = 640, 360


def load(name):
    raw = np.fromfile(os.path.join(LAB, name + ".f16"), dtype=np.uint8)
    return raw.reshape(H, W, 4)[..., :3]


def main():
    out, run, t, kbps, zone, zoom = sys.argv[1:7]
    zx, zy, zw, zh = map(int, zone.split(","))
    zoom = int(zoom)
    os.makedirs(out, exist_ok=True)
    items = [("truth", "%s-f%s-gt" % (run, t))] + [(v, "%s-f%s-b%s-%s" % (run, t, kbps, v)) for v in sys.argv[7:]]
    gt = load(items[0][1]).astype(np.float64)
    for label, name in items:
        a = load(name)
        mse = ((a.astype(np.float64) - gt) ** 2).mean()
        tag = "%s-f%s-b%s-%s" % (run, t, kbps, label)
        Image.fromarray(a).save(os.path.join(out, tag + ".png"))
        z = Image.fromarray(a[zy:zy + zh, zx:zx + zw]).resize((zw * zoom, zh * zoom), Image.NEAREST)
        z.save(os.path.join(out, tag + "-zoom.png"))
        print("%-16s crop PSNR %s" % (label, "-" if label == "truth" else "%.2f dB" % (10 * np.log10(255 ** 2 / mse))))


if __name__ == "__main__":
    main()
