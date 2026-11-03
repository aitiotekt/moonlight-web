# self-checks: identity at zero strength, linear ramps kept, a flat staircase smoothed; timing
import time
import numpy as np
from p8_filters import edge, dc_field, dct_shrink

rng = np.random.default_rng(1)
Y = rng.uniform(0, 255, (64, 96)).astype(np.float32)
print("dct T=0 identity:", float(np.abs(dct_shrink(Y, [0.0])[0.0] - Y).max()))
ramp = np.tile(np.arange(96, dtype=np.float32) * 0.7 + 20, (64, 1))
print("dcf ramp kept (interior):", float(np.abs(dc_field(ramp, 8)[8:-8, 8:-8] - ramp[8:-8, 8:-8]).max()))
print("edge ramp kept:", float(np.abs(edge(ramp, 8) - ramp).max()))
stair = np.repeat(np.arange(12, dtype=np.float32) * 3 + 50, 8)[None, :].repeat(64, 0)
for name, out in (("dcf", dc_field(stair, 8)), ("edge", edge(stair, 4)), ("dct", dct_shrink(stair, [12.0])[12.0])):
    print(name, "staircase: max step on grid %.1f -> %.2f; row:" % (
        np.abs(np.diff(stair[0]))[7::8].max(), np.abs(np.diff(out[0]))[7::8][1:-1].max()), np.round(out[0, 24:40], 1))
Y = rng.uniform(0, 255, (1080, 1920)).astype(np.float32)
for name, fn in (("edge", lambda: edge(Y, 6)), ("dcf", lambda: dc_field(Y, 6)),
                 ("dct 6 T", lambda: dct_shrink(Y, [4, 8, 12, 16, 24, 32]))):
    t = time.time()
    fn()
    print(name, "1080p %.2f s" % (time.time() - t))
