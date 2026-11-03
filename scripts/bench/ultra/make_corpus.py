"""The POC Ultra lab corpus (docs/design/ultra-lan-poc.md, U2.1): short 8-bit
4:2:0 Y4M clips that the reference PyroWave (mw-pyrowave-ref) and the ports
are measured on.

    python make_corpus.py [--out DIR] [--size 1920x1080] [--frames 60]

Synthetic clips are made here: scrolling text, moving gradients, a fine
checkerboard with thin lines, and noise (the hard cases). The game clip is cut
from the bench clip (cod.webm, outside the repository, see
../fetch-content.ps1) by ffmpeg when it is there. Nothing is captured from a
screen. The corpus lives outside the repository: by default
%USERPROFILE%\\.mw-bench\\ultra-corpus.
"""
import argparse
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\consola.ttf"
CLIP = os.path.join(os.path.expanduser("~"), ".mw-bench", "content", "cod.webm")


def rgb_to_yuv420(rgb):
    """BT.709 limited range, the range the product encodes."""
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    y = 16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255
    cb = 128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * 224 / 255
    cr = 128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * 224 / 255

    def sub(c):
        return (c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]) / 4

    planes = (y, sub(cb), sub(cr))
    return b"".join(np.clip(np.rint(p), 0, 255).astype(np.uint8).tobytes() for p in planes)


def write_y4m(path, w, h, fps, frames):
    with open(path, "wb") as f:
        f.write(b"YUV4MPEG2 W%d H%d F%d:1 Ip A1:1 C420jpeg\n" % (w, h, fps))
        for rgb in frames:
            f.write(b"FRAME\n")
            f.write(rgb_to_yuv420(rgb))


def text_frames(w, h, n):
    font = ImageFont.truetype(FONT, 18)
    lines = ["%04d  The quick brown fox jumps over the lazy dog. 0123456789 {}[]()<>=+-*/ éàçù" % i
             for i in range(400)]
    page = Image.new("RGB", (w, 24 * len(lines)), "white")
    draw = ImageDraw.Draw(page)
    for i, line in enumerate(lines):
        draw.text((12, 24 * i), line, fill=(20, 20, 20) if i % 7 else (180, 30, 30), font=font)
    page = np.asarray(page)
    for k in range(n):
        yield page[4 * k:4 * k + h]


def gradient_frames(w, h, n):
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    for k in range(n):
        t = k / 60.0
        r = 255 * (0.5 + 0.5 * np.sin(2 * np.pi * (x + t)))
        g = 255 * np.broadcast_to(y, (h, w))
        b = 255 * (0.5 + 0.5 * np.cos(2 * np.pi * (x * y + t / 2)))
        yield np.stack([r + 0 * y, g, b], axis=-1)


def checker_frames(w, h, n):
    yy, xx = np.mgrid[0:h, 0:w]
    for k in range(n):
        c = (((xx + k) // 8 + yy // 8) % 2) * 255
        img = np.stack([c, c, c], axis=-1).astype(np.uint8)
        img[:, ::64] = (255, 0, 0)  # 1-px lines, the worst case for a wavelet
        img[::64, :] = (0, 0, 255)
        yield img


def noise_frames(w, h, n):
    rng = np.random.default_rng(1)
    for _ in range(n):
        yield rng.integers(0, 256, (h, w, 3), dtype=np.uint8)


def game_clip(out, w, h, fps, n):
    if not os.path.exists(CLIP):
        print("no bench clip at", CLIP, "- game clip skipped")
        return
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "5", "-i", CLIP, "-frames:v", str(n),
                    "-vf", "scale=%d:%d:flags=lanczos,fps=%d" % (w, h, fps), "-pix_fmt", "yuv420p",
                    "-strict", "-1", out], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), ".mw-bench", "ultra-corpus"))
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--fps", type=int, default=60)
    a = ap.parse_args()
    w, h = map(int, a.size.split("x"))
    os.makedirs(a.out, exist_ok=True)
    for name, gen in (("text", text_frames), ("gradient", gradient_frames),
                      ("checker", checker_frames), ("noise", noise_frames)):
        path = os.path.join(a.out, "%s-%dp.y4m" % (name, h))
        write_y4m(path, w, h, a.fps, gen(w, h, a.frames))
        print("wrote", path)
    game_clip(os.path.join(a.out, "game-%dp.y4m" % h), w, h, a.fps, a.frames)


if __name__ == "__main__":
    main()
