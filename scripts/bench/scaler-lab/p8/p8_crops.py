"""P8.0 step 1: colour crops for the comparison page — the encoder's input,
the decoded frame, and the decoded frame deblocked (the filter on the luma,
its change added to R, G and B, as a pass on the product's RGB frame would).

  python p8_crops.py <out_dir> <content> <size> <codec> <kbps> <frame> <x> <y> <w> <h> <zoom> <variant>…
  variant: none | edge:<s> | dct:<t>[c<c>] | dct4:<t>
"""
import ctypes, os, subprocess, sys

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from p8_offline import SIZES, enc_path, src_path
from p8_filters import dct_shrink, edge


def yuv_frame(path, size, n, raw=False):
    w, h = SIZES[size]
    if raw:
        fs = w * h * 3 // 2
        mm = np.memmap(path, dtype=np.uint8, mode="r")
        b = np.asarray(mm[n * fs:(n + 1) * fs])
    else:
        r = subprocess.run(["ffmpeg", "-v", "error", "-threads", "2", "-i", path, "-vf", "select='eq(n,%d)'" % n,
                            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], capture_output=True)
        b = np.frombuffer(r.stdout, dtype=np.uint8)
    Y = b[:w * h].reshape(h, w).astype(np.float32)
    U = b[w * h:w * h * 5 // 4].reshape(h // 2, w // 2).astype(np.float32)
    V = b[w * h * 5 // 4:w * h * 3 // 2].reshape(h // 2, w // 2).astype(np.float32)
    return Y, U, V


def to_rgb(Y, U, V):
    """BT.709 limited range, the chroma bilinear (centred), as the lab's yuv2rgb."""
    def up(C):
        h, w = C.shape
        p = np.pad(C, 1, mode="edge")
        out = np.empty((2 * h, 2 * w), np.float32)
        for dy, oy in ((0, -1), (1, 1)):
            for dx, ox in ((0, -1), (1, 1)):
                c = p[1:-1, 1:-1]
                a = p[1 + oy:h + 1 + oy, 1:-1]
                b = p[1:-1, 1 + ox:w + 1 + ox]
                d = p[1 + oy:h + 1 + oy, 1 + ox:w + 1 + ox]
                out[dy::2, dx::2] = 0.5625 * c + 0.1875 * a + 0.1875 * b + 0.0625 * d
        return out
    yn = (Y - 16) / 219
    cb, cr = (up(U) - 128) / 224, (up(V) - 128) / 224
    r = yn + 1.5748 * cr
    b = yn + 1.8556 * cb
    g = (yn - 0.2126 * r - 0.0722 * b) / 0.7152
    return np.clip(np.stack([r, g, b], -1), 0, 1)


def deblock(Y, v):
    kind, _, arg = v.partition(":")
    if kind == "none":
        return Y
    if kind == "edge":
        return edge(Y, float(arg))
    if kind == "dct":
        t, _, c = arg.partition("c")  # dct:6c2 = T 6, the change bounded by 2
        out = dct_shrink(Y, [float(t)])[float(t)]
        return Y + np.clip(out - Y, -float(c), float(c)) if c else out
    if kind == "dct4":
        return dct_shrink(Y, [float(arg)], step=4)[float(arg)]
    raise SystemExit("variant " + v + "?")


def save(rgb, path, zoom):
    from PIL import Image
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))
    if zoom > 1:
        im = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
    im.save(path)


def main():
    out, content, size, codec, kbps, n, x, y, w, h, zoom = sys.argv[1:12]
    kbps, n, x, y, w, h, zoom = int(kbps), int(n), int(x), int(y), int(w), int(h), int(zoom)
    os.makedirs(out, exist_ok=True)
    tag = "%s-%s-%s-%d-f%d" % (content, size, codec, kbps, n)
    T = yuv_frame(src_path(content, size), size, n, raw=True)
    save(to_rgb(*T)[y:y + h, x:x + w], os.path.join(out, tag + "-truth.png"), zoom)
    D = yuv_frame(enc_path(content, size, codec, kbps), size, n)
    rgbD = to_rgb(*D)
    for v in sys.argv[12:]:
        Yd = deblock(D[0], v)
        rgb = rgbD + ((Yd - D[0]) / 219)[..., None]
        save(rgb[y:y + h, x:x + w], os.path.join(out, "%s-%s.png" % (tag, v.replace(":", ""))), zoom)
    print("crops", tag, sys.argv[12:])


if __name__ == "__main__":
    main()
