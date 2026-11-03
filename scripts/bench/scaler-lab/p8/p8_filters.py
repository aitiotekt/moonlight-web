"""P8.0: client-side deblocking candidates, on a luma plane (float32, H and W
multiples of 8, the coding grid at the top left). Blind: they only see the
decoded picture, and a strength in code values."""
import numpy as np

B = 8


def _edge_pass(X, alpha, beta, tc):
    """One direction: every vertical edge of the grid. A step |q0-p0| < alpha
    that the pixels on each side do not explain (|p1-p0|, |q1-q0| < beta) is
    spread over p1..q1; where both sides are flat, over p2..q2."""
    H, W = X.shape
    xs = np.arange(B, W - 3, B)
    P3, P2, P1, P0 = X[:, xs - 4], X[:, xs - 3], X[:, xs - 2], X[:, xs - 1]
    Q0, Q1, Q2, Q3 = X[:, xs], X[:, xs + 1], X[:, xs + 2], X[:, xs + 3]
    d = Q0 - P0
    on = (np.abs(d) < alpha) & (np.abs(P1 - P0) < beta) & (np.abs(Q1 - Q0) < beta)
    ap = np.abs(P2 - P0) < beta
    aq = np.abs(Q2 - Q0) < beta
    strong = on & ap & aq & (np.abs(d) < alpha / 4 + 2)
    tce = tc + ap + aq
    delta = np.clip((4 * d + (P1 - Q1)) / 8, -tce, tce)
    mid = (P0 + Q0) / 2
    nP1 = np.where(ap, P1 + np.clip((P2 + mid - 2 * P1) / 2, -tc, tc), P1)
    nQ1 = np.where(aq, Q1 + np.clip((Q2 + mid - 2 * Q1) / 2, -tc, tc), Q1)
    out = X.copy()
    out[:, xs - 3] = np.where(strong, (2 * P3 + 3 * P2 + P1 + P0 + Q0) / 8, P2)
    out[:, xs - 2] = np.where(strong, (P2 + P1 + P0 + Q0) / 4, np.where(on, nP1, P1))
    out[:, xs - 1] = np.where(strong, (P2 + 2 * P1 + 2 * P0 + 2 * Q0 + Q1) / 8, np.where(on, P0 + delta, P0))
    out[:, xs] = np.where(strong, (Q2 + 2 * Q1 + 2 * Q0 + 2 * P0 + P1) / 8, np.where(on, Q0 - delta, Q0))
    out[:, xs + 1] = np.where(strong, (Q2 + Q1 + Q0 + P0) / 4, np.where(on, nQ1, Q1))
    out[:, xs + 2] = np.where(strong, (2 * Q3 + 3 * Q2 + Q1 + Q0 + P0) / 8, Q2)
    return out


def edge(Y, s):
    """The grid's steps smoothed, vertical edges then horizontal (as H.264)."""
    alpha, beta, tc = 3.0 * s, 0.5 * s + 1.0, 0.5 * s
    X = _edge_pass(Y, alpha, beta, tc)
    return np.ascontiguousarray(_edge_pass(np.ascontiguousarray(X.T), alpha, beta, tc).T)


def _trust(d, T):
    """1 up to T/2, 0 from T: how far two block means may differ and still be
    one surface."""
    return np.clip(2.0 * (1.0 - d / T), 0.0, 1.0)


def dc_field(Y, T, A=3.0):
    """Each block's bilinear fit (its plateau, or its slope) swapped for a
    surface that runs on into its neighbours'. At every grid corner the four
    blocks' fits are compared: those flat enough (their residual under A) and
    within T of the four's median share one corner value; a block that
    disagrees keeps its own fit there. What the fit does not hold (the detail)
    is kept, a linear ramp comes out unchanged, and so does a block that agrees
    with no one."""
    H, W = Y.shape
    hb, wb = H // B, W // B
    blk = Y.reshape(hb, B, wb, B)
    c = np.arange(B, dtype=np.float32) - (B - 1) / 2.0
    cc = float((c * c).sum())
    cy, cx = c[None, :, None, None], c[None, None, None, :]
    m = blk.mean(axis=(1, 3))
    gx = (blk * cx).sum(axis=(1, 3)) / (cc * B)
    gy = (blk * cy).sum(axis=(1, 3)) / (cc * B)
    gxy = (blk * cy * cx).sum(axis=(1, 3)) / (cc * cc)
    e4 = lambda a: a[:, None, :, None]
    fit = e4(m) + e4(gx) * cx + e4(gy) * cy + e4(gxy) * cy * cx
    f = np.clip(1.0 - np.abs(blk - fit).mean(axis=(1, 3)) / A, 0.0, 1.0)
    h = B / 2.0
    own = {(vy, vx): m + gx * (h * vx) + gy * (h * vy) + gxy * (h * h * vx * vy)
           for vy in (-1, 1) for vx in (-1, 1)}
    padv = lambda a: np.pad(a, 1, mode="edge")
    padz = lambda a: np.pad(a, 1, mode="constant")
    one = np.ones_like(m)
    # grid corner (i, j) touches blocks (i-1, j-1) by their bottom right, (i-1, j)
    # bottom left, (i, j-1) top right, (i, j) top left
    taps = (((1, 1), 0, 0), ((1, -1), 0, 1), ((-1, 1), 1, 0), ((-1, -1), 1, 1))
    V = np.stack([padv(own[k])[a:a + hb + 1, b:b + wb + 1] for k, a, b in taps])
    F = np.stack([padz(f)[a:a + hb + 1, b:b + wb + 1] for k, a, b in taps])
    ok = np.stack([padz(one)[a:a + hb + 1, b:b + wb + 1] for k, a, b in taps]) > 0
    med = np.nanmedian(np.where(ok, V, np.nan), axis=0)
    w = F * _trust(np.abs(V - med), T)
    ws = w.sum(axis=0)
    shared = np.where(ws > 1e-3, (w * V).sum(axis=0) / np.maximum(ws, 1e-3), med)
    corner = {}
    for (vy, vx), a, b in taps:
        sh = shared[(vy > 0):(vy > 0) + hb, (vx > 0):(vx > 0) + wb]
        lam = f * _trust(np.abs(own[(vy, vx)] - sh), T)
        corner[(vy, vx)] = e4(lam * sh + (1 - lam) * own[(vy, vx)])
    ty, tx = (cy + h) / B, (cx + h) / B
    field = ((1 - ty) * ((1 - tx) * corner[(-1, -1)] + tx * corner[(-1, 1)]) +
             ty * ((1 - tx) * corner[(1, -1)] + tx * corner[(1, 1)]))
    return (blk - fit + field).reshape(H, W).astype(np.float32)


def _dct8():
    k = np.arange(8)[:, None]
    i = np.arange(8)[None, :]
    D = np.cos(np.pi * (2 * i + 1) * k / 16) * np.sqrt(2.0 / 8)
    D[0] /= np.sqrt(2.0)
    return D


K64 = np.kron(_dct8(), _dct8()).astype(np.float32)  # a row-major 8×8 block → its 64 coefficients


def dct_shrink(Y, Ts, step=2):
    """Shifted 8×8 orthonormal DCTs, coefficients under T zeroed (DC kept), the
    shifted reconstructions averaged. One forward pass per shift, every T."""
    H, W = Y.shape
    P = 8
    Xp = np.pad(Y, P, mode="reflect")
    acc = {T: np.zeros_like(Xp) for T in Ts}
    cnt = np.zeros_like(Xp)
    hb, wb = (H + 8) // 8, (W + 8) // 8
    for dy in range(0, 8, step):
        for dx in range(0, 8, step):
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
