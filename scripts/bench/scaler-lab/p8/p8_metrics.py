"""P8.0 step 1: frame access and luma metrics, shared by the analysis passes."""
import os, subprocess
import numpy as np

from p8_offline import N, SIZES, STEP, WARM, src_path

MEAS = list(range(WARM, N, STEP))  # the measured frames: 40 of 180
B = 8  # the coding grid every codec here puts its edges on


def truth_y(content, size):
    """The encoder's input, luma, for every measured frame (exact)."""
    w, h = SIZES[size]
    fs = w * h * 3 // 2
    mm = np.memmap(src_path(content, size), dtype=np.uint8, mode="r")
    return [np.asarray(mm[n * fs:n * fs + w * h]).reshape(h, w).astype(np.float32) for n in MEAS]


def decoded_y(path, size, vf=None, qp_side=False, threads=2):
    """The decoder's output, luma, for the measured frames, optionally through
    an ffmpeg filter (vf) that runs after the frame selection."""
    w, h = SIZES[size]
    sel = "select='gte(n,%d)*not(mod(n-%d,%d))'" % (WARM, WARM, STEP)
    chain = sel + ("," + vf if vf else "")
    cmd = ["ffmpeg", "-v", "error", "-threads", str(threads)]
    if qp_side:
        cmd += ["-export_side_data", "venc_params"]
    cmd += ["-i", path, "-vf", chain, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace")[-2000:])
    fs = w * h * 3 // 2
    n = len(r.stdout) // fs
    if n != len(MEAS):
        raise RuntimeError("%s: %d frames, not %d" % (path, n, len(MEAS)))
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    return [buf[i * fs:i * fs + w * h].reshape(h, w).astype(np.float32) for i in range(n)]


def frame_qp(path):
    """The encoder's QP per frame (x264, x265: -vstats_file), measured frames only."""
    p = path[:-4] + ".vst"
    if not os.path.exists(p):
        return None
    q = {}
    for line in open(p):
        parts = line.split()
        try:
            i = parts.index("frame=")
            q[int(parts[i + 1])] = float(parts[parts.index("q=") + 1])
        except (ValueError, IndexError):
            pass
    out = [q.get(n) for n in MEAS]
    return None if any(v is None or v <= 0 for v in out) else out


def block_flat(T, thr=1.5):
    """Per 8×8 block of the truth: True where the mean |gradient| is below thr
    (code values a pixel), the areas where a block edge shows."""
    h, w = T.shape
    gx = np.abs(np.diff(T, axis=1, append=T[:, -1:]))
    gy = np.abs(np.diff(T, axis=0, append=T[-1:, :]))
    a = (gx + gy).reshape(h // B, B, w // B, B).mean(axis=(1, 3))
    return a < thr


def measure(D, T, flatb):
    """PSNR (all, flat, textured) and the error's steps on the grid against
    off the grid: R = E[phase 0] / E[phases 2,3,5,6], all and in flat areas."""
    e = D - T
    h, w = e.shape
    mse = float((e * e).mean())
    fp = np.repeat(np.repeat(flatb, B, 0), B, 1)
    out = {"psnr": 10 * np.log10(255.0 ** 2 / max(mse, 1e-9))}
    for name, m in (("flat", fp), ("tex", ~fp)):
        k = int(m.sum())
        out["psnr_" + name] = 10 * np.log10(255.0 ** 2 / max(float((e[m] ** 2).sum()) / max(k, 1), 1e-9)) if k else None
    sx = e[:, 1:] - e[:, :-1]
    sy = e[1:, :] - e[:-1, :]
    fx = fp[:, 1:] & fp[:, :-1]
    fy = fp[1:, :] & fp[:-1, :]
    phx = np.arange(1, w) % B
    phy = np.arange(1, h) % B
    for tag, mx, my in (("", None, None), ("_flat", fx, fy)):
        E = []
        for k in range(B):
            a, b = sx[:, phx == k], sy[phy == k, :]
            if mx is None:
                E.append(((a * a).sum() + (b * b).sum()) / (a.size + b.size))
            else:
                ma, mb = mx[:, phx == k], my[phy == k, :]
                cnt = ma.sum() + mb.sum()
                E.append(((a * a)[ma].sum() + (b * b)[mb].sum()) / max(cnt, 1))
        off = np.mean([E[2], E[3], E[5], E[6]])
        out["R" + tag] = float(E[0] / max(off, 1e-9))
        out["R4" + tag] = float(E[4] / max(off, 1e-9))
        out["E0" + tag] = float(E[0])
        out["Eoff" + tag] = float(off)
    out["flat_share"] = float(fp.mean())
    out["TR"] = tile_ratio(e)
    out["TR16"] = tile_ratio(e, 16)
    return out


def _hp_means(e, oy, ox, b=B):
    """The 8×8 block means of e on a grid offset by (oy, ox), minus their 3×3
    neighbourhood's: the tile pattern, without the error's slow drift."""
    h, w = e.shape
    hb, wb = (h - oy) // b, (w - ox) // b
    m = e[oy:oy + hb * b, ox:ox + wb * b].reshape(hb, b, wb, b).mean(axis=(1, 3))
    p = np.pad(m, 1, mode="edge")
    box = sum(p[i:i + hb, j:j + wb] for i in range(3) for j in range(3)) / 9.0
    return (m - box)[1:-1, 1:-1]


def tile_ratio(e, b=B):
    """Block tiles in the error: the spread of its b×b block means on the coding
    grid over the same on a grid shifted half a block. 1 = no tiles."""
    a = _hp_means(e, 0, 0, b)
    s = _hp_means(e, b // 2, b // 2, b)
    return float((a * a).mean() / max((s * s).mean(), 1e-9))


def nr_blockiness(D):
    """No reference: the decoded picture's own steps on the grid, minus off it,
    in its flat parts — what a client can see without the truth."""
    h, w = D.shape
    dx = np.abs(D[:, 1:] - D[:, :-1])
    ph = np.arange(1, w) % B
    # flat around: the steps two pixels left and right of the edge are small
    on = dx[:, ph == 0]
    left = dx[:, ph == 6]
    right = dx[:, ph == 2][:, :on.shape[1]]
    left = left[:, :on.shape[1]]
    flat = (left < 2) & (right < 2)
    off = dx[:, (ph == 3) | (ph == 5)]
    return float(on[flat].mean() - off.mean()) if flat.any() else 0.0
