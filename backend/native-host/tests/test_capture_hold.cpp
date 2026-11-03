/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "core/CaptureHold.h"
#include "native_test_framework.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

using mw::native::CaptureHold;

namespace {

/// One second of the capture loop, as WindowsSession feeds CaptureHold: one
/// acquire per present the loop saw (@p folded more merged into the first
/// ones), each waited for a share @p waitFraction of its turn, the gate
/// called on each (@p lockable of them on the lattice), @p carried of them
/// encoded. The second closes at its end.
struct Second
{
    int presents = 0;
    int folded = 0;
    int carried = 0;
    int lockable = 0;
    double waitFraction = 0;
    bool gate = true;
};

void run(CaptureHold& h, int64_t& nowUs, const Second& s, int seconds)
{
    for (int n = 0; n < seconds; ++n) {
        const int64_t startUs = nowUs;
        const int wakes = std::max(0, s.presents - s.folded);
        const int64_t turnUs = wakes > 0 ? CaptureHold::kSecondUs / wakes : 0;
        for (int i = 0; i < wakes; ++i) {
            h.waited(static_cast<int64_t>(static_cast<double>(turnUs) * s.waitFraction));
            const int64_t folded = i < s.folded ? 1 : 0;
            h.presents(1 + folded, folded);
            if (s.gate) h.gateCall(i < s.lockable);
            if (i < s.carried) h.carried();
            h.tick(startUs + turnUs * i + turnUs / 2);
        }
        nowUs = startUs + CaptureHold::kSecondUs;
        h.tick(nowUs);
    }
}

/// DualRTX's RTX at 330 Hz for a 165 fps stream on CoD's dense band (V2 of
/// plan glissade, 15/10/2026): 296 presents a second, 97 % of the gate's
/// calls locked, every frame of the stream carried, 71 % of the time waiting.
Second dualRtx330()
{
    Second s;
    s.presents = 296;
    s.folded = 0;
    s.carried = 165;
    s.lockable = 287;
    s.waitFraction = 0.71;
    return s;
}

bool near(double a, double b)
{
    return std::fabs(a - b) < 0.005;
}

} // namespace

void run_capture_hold_tests()
{
    SECTION("CaptureHold — nothing seen, nothing judged");
    {
        CaptureHold h;
        const CaptureHold::Verdict v = h.verdict();
        CHECK(!v.judged);
        CHECK(v.held);
        CHECK_EQ(v.denseSeconds, 0);
        h.tick(5000000); // never started: no second closes
        CHECK_EQ(h.verdict().denseSeconds, 0);
    }

    SECTION("CaptureHold — V2's 330 Hz on DualRTX holds");
    {
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 165);
        run(h, now, dualRtx330(), 60);
        const CaptureHold::Verdict v = h.verdict();
        CHECK(v.judged);
        CHECK(v.held);
        CHECK(v.why.empty());
        CHECK_EQ(v.denseSeconds, 60);
        CHECK(near(v.locked, 287.0 / 296.0));
        CHECK(near(v.carried, 1.0));
        CHECK(near(v.folded, 0.0));
        CHECK(near(v.busy, 0.29));
    }

    SECTION("CaptureHold — a desktop at rest is no content to judge on");
    {
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 165);
        Second rest;
        rest.presents = 12;
        rest.carried = 12;
        rest.lockable = 0;
        rest.waitFraction = 0.99;
        run(h, now, rest, 120);
        const CaptureHold::Verdict v = h.verdict();
        CHECK(!v.judged);
        CHECK(v.held);
        CHECK_EQ(v.denseSeconds, 0);
    }

    SECTION("CaptureHold — dense from 1.5 presents per frame of the stream, and 20 s of it");
    {
        Second edge = dualRtx330();
        edge.presents = 248; // 1.503 × 165
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 165);
        run(h, now, edge, 19);
        CHECK(!h.verdict().judged);
        CHECK_EQ(h.verdict().denseSeconds, 19);
        run(h, now, edge, 1);
        CHECK(h.verdict().judged);

        Second below = dualRtx330();
        below.presents = 246; // 1.49 ×
        CaptureHold k;
        now = 0;
        k.start(now, 165);
        run(k, now, below, 60);
        CHECK_EQ(k.verdict().denseSeconds, 0);
    }

    SECTION("CaptureHold — only the dense seconds count");
    {
        // A page that loads, then the content: the seconds before it say
        // nothing, however few frames they carried.
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 144);
        Second loading;
        loading.presents = 30;
        loading.carried = 30;
        loading.waitFraction = 0.9;
        run(h, now, loading, 8);
        Second dense = dualRtx330();
        dense.presents = 258;
        dense.carried = 144;
        dense.lockable = 252;
        run(h, now, dense, 30);
        const CaptureHold::Verdict v = h.verdict();
        CHECK(v.judged);
        CHECK(v.held);
        CHECK_EQ(v.denseSeconds, 30);
        CHECK(near(v.carried, 1.0));
    }

    SECTION("CaptureHold — each threshold, and the first one missed says why");
    {
        const auto judge = [](const Second& s) {
            CaptureHold h;
            int64_t now = 0;
            h.start(now, 165);
            run(h, now, s, 30);
            return h.verdict();
        };
        Second folded = dualRtx330();
        folded.folded = 4; // 1.35 % of 296
        CaptureHold::Verdict v = judge(folded);
        CHECK(v.judged);
        CHECK(!v.held);
        CHECK(v.why == "presents folded");

        Second edgeFolded = dualRtx330();
        edgeFolded.folded = 2; // 0.68 %
        CHECK(judge(edgeFolded).held);

        Second busy = dualRtx330();
        busy.waitFraction = 0.25; // busy 75 %
        v = judge(busy);
        CHECK(!v.held);
        CHECK(v.why == "loop busy");

        Second missed = dualRtx330();
        missed.carried = 155; // 93.9 %
        v = judge(missed);
        CHECK(!v.held);
        CHECK(v.why == "frames not carried");

        Second loose = dualRtx330();
        loose.lockable = 250; // 84.5 %
        v = judge(loose);
        CHECK(!v.held);
        CHECK(v.why == "lattice not locked");

        // Folded and busy at once: folded is named first.
        Second both = dualRtx330();
        both.folded = 6;
        both.waitFraction = 0.1;
        CHECK(judge(both).why == "presents folded");
    }

    SECTION("CaptureHold — no gate on the lattice: the lock is not judged");
    {
        Second s = dualRtx330();
        s.gate = false;
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 165);
        run(h, now, s, 30);
        const CaptureHold::Verdict v = h.verdict();
        CHECK(v.judged);
        CHECK(v.held);
        CHECK(v.locked < 0);
    }

    SECTION("CaptureHold — a step to the display's rate is no dense content");
    {
        // "Auto" steps a 144 fps stream to 288 on a 288 Hz display: every
        // present is a frame, and nothing says the capture held twice the rate.
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 144);
        Second dense = dualRtx330();
        dense.presents = 258;
        dense.carried = 144;
        dense.lockable = 252;
        run(h, now, dense, 25);
        h.setFps(288);
        Second stepped = dense;
        stepped.carried = 258;
        run(h, now, stepped, 25);
        const CaptureHold::Verdict v = h.verdict();
        CHECK_EQ(v.denseSeconds, 25);
        CHECK(v.held);
    }

    SECTION("CaptureHold — start() begins afresh");
    {
        CaptureHold h;
        int64_t now = 0;
        h.start(now, 165);
        Second bad = dualRtx330();
        bad.carried = 100;
        run(h, now, bad, 30);
        CHECK(!h.verdict().held);
        h.start(now, 165);
        CHECK(!h.verdict().judged);
        run(h, now, dualRtx330(), 30);
        CHECK(h.verdict().held);
    }
}
