"""P8.0 step 1: every candidate filter at several strengths on every offline
encode, against the encoder's input (luma). Also ffmpeg's own post-filters as
references: `deblock` (blind), and for H.264 `spp`, `pp7`, `fspp` fed with the
decoder's per-macroblock QP (what a client would have with the host's help).

  python p8_sweep.py [workers] [content…]     → off/sweep.json
"""
import ctypes, json, os, sys, time
from multiprocessing import Pool

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
os.environ["OPENBLAS_NUM_THREADS"] = os.environ["MKL_NUM_THREADS"] = os.environ["OMP_NUM_THREADS"] = "1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from p8_offline import CONTENTS, KBPS, OUT, SIZES, enc_path
from p8_metrics import block_flat, decoded_y, frame_qp, measure, truth_y
from p8_filters import dc_field, dct_shrink, edge

EDGE_S = [2, 3, 4, 6, 8]
DCF_T = []  # the block-field filter: harmful on in-loop deblocked pictures (it adds steps)
DCT_T = [4, 6, 8, 12, 16, 24]
DCT4_T = [6, 8, 12, 16]  # four shifts only: a quarter of the cost
COMBO = []
FFM = {
    "ffm-deblock-weak": ("deblock=filter=weak:block=8", False),
    "ffm-deblock-strong": ("deblock=filter=strong:block=8", False),
    "ffm-spp-qp": ("spp=quality=3:qp=0:mode=hard", True),
    "ffm-pp7-qp": ("pp7=qp=0:mode=medium", True),
    "ffm-fspp-qp": ("fspp=quality=4:qp=0:strength=0", True),
}
KEEP = slice(0, None, 2)  # 20 of the 40 measured frames


def one(job):
    content, size, codec, kbps = job
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    t0 = time.time()
    T = truth_y(content, size)[KEEP]
    flats = [block_flat(t) for t in T]
    path = enc_path(content, size, codec, kbps)
    D = decoded_y(path, size, threads=1)[KEEP]
    acc = {}

    def add(name, i, out):
        m = measure(np.clip(out, 0, 255), T[i], flats[i])
        acc.setdefault(name, []).append(m)

    for i, d in enumerate(D):
        add("none", i, d)
        for s in EDGE_S:
            add("edge-s%d" % s, i, edge(d, s))
        for t in DCF_T:
            add("dcf-T%d" % t, i, dc_field(d, t))
        for t, out in dct_shrink(d, DCT_T).items():
            add("dct-T%d" % t, i, out)
        for t, out in dct_shrink(d, DCT4_T, step=4).items():
            add("dct4-T%d" % t, i, out)
        for t, s in COMBO:
            add("dcf%d+edge%d" % (t, s), i, edge(dc_field(d, t), s))
    for name, (vf, qp) in FFM.items():
        if qp and codec != "avc":
            continue
        try:
            F = decoded_y(path, size, vf=vf, qp_side=qp, threads=1)[KEEP]
        except RuntimeError as e:
            print("skip", name, path, str(e)[-200:], flush=True)
            continue
        for i, f in enumerate(F):
            add(name, i, f)
    res = {}
    for name, rows in acc.items():
        res[name] = {k: float(np.mean([r[k] for r in rows if r.get(k) is not None]))
                     for k in rows[0] if any(r.get(k) is not None for r in rows)}
    qp = frame_qp(path)
    print("%-10s %-4s %-4s %5d  %.0f s" % (content, size, codec, kbps, time.time() - t0), flush=True)
    return {"content": content, "size": size, "codec": codec, "kbps": kbps,
            "qp": float(np.mean(qp[KEEP])) if qp else None, "variants": res}


if __name__ == "__main__":
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    contents = sys.argv[2:] or list(CONTENTS)
    jobs = [(c, s, codec, k) for c in contents for s in SIZES for codec, ks in KBPS[s].items() for k in ks]
    # the 1080p jobs first, the longest
    jobs.sort(key=lambda j: j[1] != "1080")
    with Pool(workers) as p:
        res = p.map(one, jobs, chunksize=1)
    p_out = os.path.join(OUT, "sweep.json")
    old = json.load(open(p_out)) if os.path.exists(p_out) else []
    key = lambda r: (r["content"], r["size"], r["codec"], r["kbps"])
    new_keys = {key(r) for r in res}
    json.dump([r for r in old if key(r) not in new_keys] + res, open(p_out, "w"), indent=1)
    print("wrote", p_out, len(res))
