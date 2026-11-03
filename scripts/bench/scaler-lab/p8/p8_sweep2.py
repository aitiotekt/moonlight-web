"""P8.0 step 1, second sweep: the DCT shrinkage around its optimum, per frame,
so that any strength policy (fixed, from the frame's QP, blind from the
picture) can be judged afterwards from the stored per-frame results.

  python p8_sweep2.py [workers]     → off/sweep2.json
"""
import ctypes, json, os, sys, time
from multiprocessing import Pool

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
os.environ["OPENBLAS_NUM_THREADS"] = os.environ["MKL_NUM_THREADS"] = os.environ["OMP_NUM_THREADS"] = "1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from p8_offline import CONTENTS, KBPS, OUT, SIZES, enc_path
from p8_metrics import MEAS, block_flat, decoded_y, measure, truth_y
from p8_filters import dct_shrink, edge

T16 = [3, 4, 5, 6, 8, 12, 16]
CLAMP = [(4, 2), (6, 2), (8, 2), (8, 4), (12, 4)]  # T, the largest change of a pixel's luma
T8 = [4, 6, 8]
CHECKER8 = [(dy, dx) for dy in range(0, 8, 2) for dx in range(0, 8, 2) if ((dx + dy) // 2) % 2 == 0]
KEEP = slice(0, None, 2)
KEYS = ("psnr", "psnr_flat", "psnr_tex", "R", "R_flat", "TR", "TR16")


def dct_shifts(Y, Ts, shifts):
    """dct_shrink with an explicit list of shifts (the 8 of a checkerboard)."""
    from p8_filters import K64
    H, W = Y.shape
    P = 8
    Xp = np.pad(Y, P, mode="reflect")
    acc = {T: np.zeros_like(Xp) for T in Ts}
    cnt = np.zeros_like(Xp)
    hb, wb = (H + 8) // 8, (W + 8) // 8
    for dy, dx in shifts:
        sub = Xp[dy:dy + H + 8, dx:dx + W + 8]
        blk = sub.reshape(hb, 8, wb, 8).transpose(0, 2, 1, 3).reshape(-1, 64)
        C = blk @ K64.T
        for T in Ts:
            Ct = np.where(np.abs(C) >= T, C, 0)
            Ct[:, 0] = C[:, 0]
            r = (Ct @ K64).reshape(hb, wb, 8, 8).transpose(0, 2, 1, 3).reshape(hb * 8, wb * 8)
            acc[T][dy:dy + H + 8, dx:dx + W + 8] += r
        cnt[dy:dy + H + 8, dx:dx + W + 8] += 1
    cnt = np.maximum(cnt, 1)
    return {T: (acc[T] / cnt)[P:P + H, P:P + W] for T in Ts}


def nr_step(D):
    """No reference: the picture's own step across the grid's edges where both
    sides are flat (the steps two pixels away under 3), minus the same at the
    blocks' middles — the visible block step, in Y code values."""
    out = []
    for X in (D, D.T):
        dx = np.abs(np.diff(X, axis=1))
        W = X.shape[1]
        k = np.arange(1, W // 8 - 1)
        on, l, r = dx[:, 8 * k - 1], dx[:, 8 * k - 3], dx[:, 8 * k + 1]
        mid, ml, mr = dx[:, 8 * k + 3], dx[:, 8 * k + 1], dx[:, 8 * k + 5]
        f_on = (l < 3) & (r < 3)
        f_mid = (ml < 3) & (mr < 3)
        out.append((on[f_on].mean() if f_on.any() else 0.0, mid[f_mid].mean() if f_mid.any() else 0.0))
    return float(np.mean([a for a, b in out]) - np.mean([b for a, b in out]))


def frame_qps(path, n_meas):
    """The encoder's QP per measured frame (vstats); a frame without one (the
    last ones, flushed at -1) takes its nearest neighbour's."""
    p = path[:-4] + ".vst"
    if not os.path.exists(p):
        return None
    q = {}
    for line in open(p):
        parts = line.split()
        try:
            i = parts.index("frame=")
            v = float(parts[parts.index("q=") + 1])
            if v > 0:
                q[int(parts[i + 1])] = v
        except (ValueError, IndexError):
            pass
    if not q:
        return None
    keys = sorted(q)
    return [q[min(keys, key=lambda k: abs(k - n))] for n in n_meas]


def one(job):
    content, size, codec, kbps = job
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    t0 = time.time()
    T = truth_y(content, size)[KEEP]
    flats = [block_flat(t) for t in T]
    path = enc_path(content, size, codec, kbps)
    D = decoded_y(path, size, threads=1)[KEEP]
    frames = []
    for i, d in enumerate(D):
        row = {}

        def add(name, out):
            m = measure(np.clip(out, 0, 255), T[i], flats[i])
            row[name] = [m.get(k) for k in KEYS]

        add("none", d)
        add("edge-s2", edge(d, 2))
        outs = dct_shrink(d, T16)
        for t, out in outs.items():
            add("dct-T%d" % t, out)
        for t, c in CLAMP:
            add("dct-T%dc%d" % (t, c), d + np.clip(outs[t] - d, -c, c))
        for t, out in dct_shifts(d, T8, CHECKER8).items():
            add("dct8-T%d" % t, out)
        frames.append({"v": row, "nr": nr_step(d), "nr_truth": nr_step(T[i])})
    meas = MEAS[KEEP]
    qp = frame_qps(path, meas)
    print("%-10s %-4s %-4s %5d  %.0f s" % (content, size, codec, kbps, time.time() - t0), flush=True)
    return {"content": content, "size": size, "codec": codec, "kbps": kbps, "qp": qp, "keys": KEYS,
            "frames": frames}


if __name__ == "__main__":
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    jobs = [(c, s, codec, k) for c in CONTENTS for s in SIZES for codec, ks in KBPS[s].items() for k in ks]
    jobs.sort(key=lambda j: j[1] != "1080")
    with Pool(workers) as p:
        res = p.map(one, jobs, chunksize=1)
    p_out = os.path.join(OUT, "sweep2.json")
    json.dump(res, open(p_out, "w"))
    print("wrote", p_out, len(res))
