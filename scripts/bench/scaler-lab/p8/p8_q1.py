"""P8.0 step 1, Q1: how much blocking each encode leaves (no filter yet)."""
import ctypes, json, os, sys
from multiprocessing import Pool

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
os.environ["OPENBLAS_NUM_THREADS"] = os.environ["MKL_NUM_THREADS"] = os.environ["OMP_NUM_THREADS"] = "1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from p8_offline import CONTENTS, KBPS, OUT, SIZES, enc_path
from p8_metrics import block_flat, decoded_y, frame_qp, measure, nr_blockiness, truth_y


def one(job):
    content, size, codec, kbps = job
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    T = truth_y(content, size)
    path = enc_path(content, size, codec, kbps)
    D = decoded_y(path, size, threads=1)
    rows = []
    for t, d in zip(T, D):
        m = measure(d, t, block_flat(t))
        m["nr"] = nr_blockiness(d)
        m["nr_truth"] = nr_blockiness(t)
        rows.append(m)
    qp = frame_qp(path)
    agg = {k: float(np.mean([r[k] for r in rows if r[k] is not None])) for k in rows[0] if rows[0][k] is not None}
    agg.update({"content": content, "size": size, "codec": codec, "kbps": kbps,
                "qp": float(np.mean(qp)) if qp else None})
    return agg


if __name__ == "__main__":
    jobs = [(c, s, codec, k) for c in CONTENTS for s in SIZES for codec, ks in KBPS[s].items() for k in ks]
    with Pool(4) as p:
        res = p.map(one, jobs, chunksize=1)
    json.dump(res, open(os.path.join(OUT, "q1.json"), "w"), indent=1)
    enc = {(e["content"], e["size"], e["codec"], e["kbps"]): e for e in json.load(open(os.path.join(OUT, "encodes.json")))}
    print("%-10s %-4s %-4s %5s %5s %5s | %6s %6s %6s | %5s %5s %5s %5s | %5s %5s" % (
        "content", "size", "cod", "kbps", "Mbps", "QP", "PSNR", "flat", "tex", "R", "R4", "Rflat", "R4fl", "TR", "-"))
    for r in res:
        e = enc[(r["content"], r["size"], r["codec"], r["kbps"])]
        print("%-10s %-4s %-4s %5d %5.2f %5s | %6.2f %6s %6.2f | %5.2f %5.2f %5.2f %5.2f | %5.2f %5.2f" % (
            r["content"], r["size"], r["codec"], r["kbps"], e["mbps"], "%.1f" % r["qp"] if r["qp"] else "-",
            r["psnr"], "%.2f" % r["psnr_flat"] if r.get("psnr_flat") else "-", r["psnr_tex"],
            r["R"], r["R4"], r.get("R_flat", 0), r.get("R4_flat", 0), r["TR"], 0))
