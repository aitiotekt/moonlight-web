# The WGSL passes of seq-lab.js transliterated thread by thread, against the
# numpy filters: same block indexing, same edge rules.
import numpy as np
from p8_filters import K64, _dct8, dct_shrink, edge

D = _dct8().reshape(-1)  # D8[k * 8 + n]
rng = np.random.default_rng(3)


def wgsl_dct_frame(Y, thr, step):
    H, W = Y.shape
    acc = np.zeros((H, W))
    n = 0
    for dy in range(0, 8, step):
        for dx in range(0, 8, step):
            n += 1
            for wy in range(H // 8 + 1):
                for wx in range(W // 8 + 1):
                    sa = np.zeros(64); sb = np.zeros(64)
                    P = {}
                    for j in range(8):
                        for i in range(8):
                            p = (wx * 8 - 8 + dx + i, wy * 8 - 8 + dy + j)
                            q = [abs(p[0]), abs(p[1])]
                            q[0] = 2 * (W - 1) - q[0] if q[0] >= W else q[0]
                            q[1] = 2 * (H - 1) - q[1] if q[1] >= H else q[1]
                            sa[j * 8 + i] = Y[q[1], q[0]]
                            P[(i, j)] = p
                    for j in range(8):
                        for i in range(8):
                            sb[j * 8 + i] = sum(D[i * 8 + k] * sa[j * 8 + k] for k in range(8))
                    c = np.zeros(64)
                    for j in range(8):
                        for i in range(8):
                            v = sum(D[j * 8 + m] * sb[m * 8 + i] for m in range(8))
                            c[j * 8 + i] = 0.0 if (i or j) and abs(v) < thr else v
                    sa = c
                    for j in range(8):
                        for i in range(8):
                            sb[j * 8 + i] = sum(D[k * 8 + j] * sa[k * 8 + i] for k in range(8))
                    for j in range(8):
                        for i in range(8):
                            r = sum(D[k * 8 + i] * sb[j * 8 + k] for k in range(8))
                            p = P[(i, j)]
                            if 0 <= p[0] < W and 0 <= p[1] < H:
                                acc[p[1], p[0]] += r
    return acc / n


Y = rng.uniform(0, 255, (16, 24)).astype(np.float32)
for step in (4, 2):
    a = wgsl_dct_frame(Y, 30.0, step)
    b = dct_shrink(Y, [30.0], step=step)[30.0]
    print("dct step %d: max |wgsl - numpy| = %.2e" % (step, np.abs(a - b).max()))


def wgsl_edge_pass(X, thr, dirx):
    H, W = X.shape
    out = X.copy()
    for y in range(H):
        for x0 in range(W):
            p = (x0, y)
            xx = p[0] if dirx else p[1]
            ln = W if dirx else H
            k = xx % 8
            e = xx - k if k <= 2 else xx - k + 8
            o = xx - e
            if k in (3, 4) or e < 4 or e > ln - 4:
                continue
            L = []
            for i in range(8):
                t = xx + (i - 4 - o)
                t = min(max(t, 0), ln - 1)
                L.append(X[y, t] if dirx else X[t, x0])
            alpha, beta, tc = 3 * thr, 0.5 * thr + 1, 0.5 * thr
            d = L[4] - L[3]
            if not (abs(d) < alpha and abs(L[2] - L[3]) < beta and abs(L[5] - L[4]) < beta):
                continue
            ap = abs(L[1] - L[3]) < beta
            aq = abs(L[6] - L[4]) < beta
            if ap and aq and abs(d) < alpha / 4 + 2:
                nv = [(2 * L[0] + 3 * L[1] + L[2] + L[3] + L[4]) / 8, (L[1] + L[2] + L[3] + L[4]) / 4,
                      (L[1] + 2 * L[2] + 2 * L[3] + 2 * L[4] + L[5]) / 8, (L[6] + 2 * L[5] + 2 * L[4] + 2 * L[3] + L[2]) / 8,
                      (L[6] + L[5] + L[4] + L[3]) / 4, (2 * L[7] + 3 * L[6] + L[5] + L[4] + L[3]) / 8]
            else:
                tce = tc + ap + aq
                delta = min(max((4 * d + (L[2] - L[5])) / 8, -tce), tce)
                mid = (L[3] + L[4]) / 2
                nv = [L[1], L[2] + min(max((L[1] + mid - 2 * L[2]) / 2, -tc), tc) if ap else L[2], L[3] + delta,
                      L[4] - delta, L[5] + min(max((L[6] + mid - 2 * L[5]) / 2, -tc), tc) if aq else L[5], L[6]]
            out[y, x0] = nv[o + 3]
    return out


Y = (np.repeat(np.repeat(rng.integers(60, 66, (4, 5)), 8, 0), 8, 1) + rng.normal(0, 0.4, (32, 40))).astype(np.float32)
a = wgsl_edge_pass(wgsl_edge_pass(Y, 4.0, True), 4.0, False)
b = edge(Y, 4.0)
print("edge: max |wgsl - numpy| = %.2e (changed pixels %d)" % (np.abs(a - b).max(), int((np.abs(b - Y) > 1e-4).sum())))
