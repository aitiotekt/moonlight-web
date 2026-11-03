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

// The stream's gate locked on the display's presents (plan « glissade »,
// 14/10/2026): PresentLattice, and FrameCadence::admit() with a lattice.
// test_frame_cadence.cpp holds today's gate as it is; this file holds the
// lock, and the golden train that scripts/bench/clickpath/gatesim.py
// --selftest replays with the same counts.

#include "core/FrameCadence.h"
#include "core/PresentLattice.h"
#include "mw/native/EncoderTuning.h"
#include "native_test_framework.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

using mw::native::cadenceLockArmed;
using mw::native::cadenceLockHead;
using mw::native::cadenceLockState;
using mw::native::cadenceLockText;
using mw::native::floorDiv;
using mw::native::FrameCadence;
using mw::native::PresentLattice;

namespace {

/// One period of a display at 240 Hz as its mode says it (240/1).
constexpr int64_t kT = 4166666;
constexpr int64_t kStartNs = 1000LL * 1000000000LL;

/// gatesim.py's SplitMix64, line for line: every draw a whole uint64, so the
/// train is the same on every compiler and in Python.
struct SplitMix64
{
    explicit SplitMix64(uint64_t seed)
        : state(seed)
    {}
    uint64_t next()
    {
        state += 0x9E3779B97F4A7C15ULL;
        uint64_t z = state;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    uint64_t below(uint64_t n) { return next() % n; }
    /// A whole number from @p lo to @p hi, both in.
    int64_t between(int64_t lo, int64_t hi)
    {
        return lo + static_cast<int64_t>(below(static_cast<uint64_t>(hi - lo + 1)));
    }
    uint64_t state;
};

/// One call of the gate: when today's gate decides (µs), the picture's own
/// time (µs), the refresh it was presented on (-1: none, or a pointer), and
/// whether it is a present or a pointer that moved alone.
struct Call
{
    int64_t nowUs;
    int64_t ownUs;
    int64_t refresh;
    bool present;
};

/// gatesim.py's GoldenTrain, line for line: a display at 240 Hz, 20 ppm fast
/// against the host's clock, its phase wandering ±60 µs over 20 s; each
/// present off its refresh by σ 350 µs (three draws of ±350), one in 250 by
/// 1.5 to 2 ms more. Ten stretches: dense, content at 60 fps (one in 20 a
/// refresh early or late), a pause of 2 s, dense, 4 s of presents with no
/// grid, dense, a pause of 12 s, dense with one present in 8 missing, content
/// at 77 fps, content at 120 fps. A pointer that moved alone after every 37th
/// present of a dense stretch, and one after the 5000th whose time is past
/// the next present's.
class GoldenTrain
{
public:
    static constexpr int64_t kPeriodNs = 4166583;

    GoldenTrain() { build(); }

    bool inDense(int64_t refresh) const
    {
        for (const auto& range : dense)
            if (range.first <= refresh && refresh < range.second) return true;
        return false;
    }

    /// (refresh, present µs) of every present; the gate's calls.
    std::vector<std::pair<int64_t, int64_t>> presents;
    std::vector<Call> calls;
    std::vector<std::pair<int64_t, int64_t>> dense;

private:
    int64_t presentUs(int64_t refresh)
    {
        int64_t wave = refresh % 4800;
        wave = wave < 2400 ? wave : 4800 - wave;
        int64_t off = wave * 50 - 60000;
        for (int i = 0; i < 3; ++i)
            off += m_Rng.between(-350000, 350000);
        if (m_Rng.below(250) == 0) {
            const int64_t far = m_Rng.between(1500000, 2000000);
            off += m_Rng.below(2) == 0 ? far : -far;
        }
        return (kStartNs + refresh * kPeriodNs + off) / 1000;
    }

    void add(int64_t refresh, int64_t us)
    {
        if (!presents.empty() && us <= presents.back().second) us = presents.back().second + 1;
        presents.emplace_back(refresh, us);
    }

    void build()
    {
        struct Stretch
        {
            int64_t length;
            const char* kind;
        };
        const Stretch stretches[] = {
            {7200, "dense"}, {2400, "60"},    {480, "pause"},  {1200, "dense"}, {960, "nogrid"},
            {2400, "dense"}, {2880, "pause"}, {2400, "holes"}, {2400, "77"},    {1200, "120"},
        };
        int64_t r = 0;
        for (const Stretch& s : stretches) {
            const int64_t end = r + s.length;
            const std::string kind = s.kind;
            if (kind == "dense") {
                dense.emplace_back(r, end);
                for (int64_t k = r; k < end; ++k)
                    add(k, presentUs(k));
            } else if (kind == "60") {
                for (int64_t k = r; k < end; k += 4) {
                    const uint64_t step = m_Rng.below(20);
                    const int64_t at = k + (step == 0 ? 1 : (step == 1 && k > r) ? -1 : 0);
                    add(at, presentUs(at));
                }
            } else if (kind == "nogrid") {
                std::vector<int64_t> times;
                for (int i = 0; i < 800; ++i)
                    times.push_back(static_cast<int64_t>(
                        m_Rng.below(static_cast<uint64_t>(s.length * kPeriodNs))));
                std::sort(times.begin(), times.end());
                for (int64_t x : times)
                    add(-1, (kStartNs + r * kPeriodNs + x) / 1000);
            } else if (kind == "holes") {
                for (int64_t k = r; k < end; ++k)
                    if (m_Rng.below(8) != 0) add(k, presentUs(k));
            } else if (kind == "77") {
                for (int64_t j = 0; r + j * 240 / 77 < end; ++j)
                    add(r + j * 240 / 77, presentUs(r + j * 240 / 77));
            } else if (kind == "120") {
                for (int64_t k = r; k < end; k += 2)
                    add(k, presentUs(k));
            }
            r = end;
        }
        int64_t lastUs = 0;
        for (size_t i = 0; i < presents.size(); ++i) {
            const int64_t refresh = presents[i].first;
            const int64_t us = presents[i].second;
            const int64_t nowUs =
                std::max(us + 200 + static_cast<int64_t>(m_Rng.below(600)), lastUs + 1);
            calls.push_back({nowUs, us, refresh, true});
            lastUs = nowUs;
            if (inDense(refresh) && i % 37 == 36) {
                lastUs = nowUs + 1500;
                calls.push_back({lastUs, lastUs, -1, false});
            }
            if (i == 5000 && i + 1 < presents.size()) {
                lastUs = std::max(lastUs + 1, presents[i + 1].second + 100);
                calls.push_back({lastUs, lastUs, -1, false});
            }
        }
    }

    SplitMix64 m_Rng{0x676C697373616465ULL}; // "glissade"
};

/// What gatesim.py's golden_run() counts.
struct Golden
{
    int64_t admitted = 0;
    int64_t indexSum = 0;
    int64_t skipped = 0;
    int64_t lockedCalls = 0;
    int64_t window = 0;
    int64_t empty = 0;
    int64_t pause = 0;
    int64_t today = 0;
    int64_t engagements = 0;
    int64_t releases = 0;
    int64_t resyncs = 0;
    int64_t ignored = 0;
    int64_t phaseNs = 0;
    int64_t acc = 0;
    /// Steps between dense pictures while the lattice is engaged (a lattice
    /// is fed in both runs, so today's gate is counted on the same span).
    std::map<int64_t, int64_t> steps;
};

/// The train through the gate at @p fps on 240 Hz, locked on a lattice of
/// the display's nominal period (240/1) or not, as golden_run() runs it.
Golden goldenRun(const GoldenTrain& train, int fps, bool lock)
{
    FrameCadence gate(fps, 240);
    PresentLattice lattice(PresentLattice::periodNsFromRational(240, 1));
    Golden g;
    bool haveLast = false;
    int64_t lastRefresh = 0;
    for (size_t i = 0; i < train.calls.size(); ++i) {
        const Call& c = train.calls[i];
        if (c.present) lattice.note(c.ownUs * 1000);
        const bool ok = lock ? gate.admit(c.nowUs, c.ownUs, lattice.view()) : gate.admit(c.nowUs);
        if (!ok) continue;
        g.admitted++;
        g.indexSum += static_cast<int64_t>(i);
        if (c.refresh >= 0 && train.inDense(c.refresh)) {
            if (haveLast && lattice.engaged()) g.steps[c.refresh - lastRefresh]++;
            haveLast = true;
            lastRefresh = c.refresh;
        } else {
            haveLast = false;
        }
    }
    g.skipped = gate.skipped();
    g.lockedCalls = gate.lockedCalls();
    g.window = gate.admitted(FrameCadence::Rule::Window);
    g.empty = gate.admitted(FrameCadence::Rule::Empty);
    g.pause = gate.admitted(FrameCadence::Rule::Pause);
    g.today = gate.admitted(FrameCadence::Rule::Today);
    g.engagements = lattice.engagements();
    g.releases = lattice.releases();
    g.resyncs = lattice.resyncs();
    g.ignored = lattice.ignored();
    g.phaseNs = lattice.phaseNs();
    g.acc = lattice.acc();
    return g;
}

/// A display's presents, refresh by refresh, made as the golden train makes
/// them: @p ppm off the nominal period, the phase wandering by ±wanderNs over
/// 20 s at 240 Hz, three draws of ±jitterNs, one in farOdds 1.5 to 2 ms off.
struct Display
{
    int64_t periodNs = kT;
    int64_t ppm = 0;
    int64_t wanderNs = 0;
    int64_t jitterNs = 0;
    uint64_t farOdds = 0;
    int64_t startNs = kStartNs;
    SplitMix64 rng{7};

    int64_t presentUs(int64_t refresh)
    {
        int64_t off = 0;
        if (wanderNs > 0) {
            int64_t wave = refresh % 4800;
            wave = wave < 2400 ? wave : 4800 - wave;
            off += wave * 2 * wanderNs / 2400 - wanderNs;
        }
        for (int i = 0; i < 3 && jitterNs > 0; ++i)
            off += rng.between(-jitterNs, jitterNs);
        if (farOdds > 0 && rng.below(farOdds) == 0) {
            const int64_t far = rng.between(1500000, 2000000);
            off += rng.below(2) == 0 ? far : -far;
        }
        const int64_t base = refresh * periodNs;
        return (startNs + base + base / 1000000 * ppm + off) / 1000;
    }
};

struct Present
{
    int64_t refresh;
    int64_t us;
};

/// The presents of @p refreshes on @p display, in time order.
std::vector<Present> stamp(Display& display, const std::vector<int64_t>& refreshes)
{
    std::vector<Present> out;
    for (int64_t r : refreshes) {
        int64_t us = display.presentUs(r);
        if (!out.empty() && us <= out.back().us) us = out.back().us + 1;
        out.push_back({r, us});
    }
    return out;
}

/// Refreshes @p first to @p first + @p count - 1, every @p step.
std::vector<int64_t> every(int64_t first, int64_t count, int64_t step = 1)
{
    std::vector<int64_t> out;
    for (int64_t r = first; r < first + count; r += step)
        out.push_back(r);
    return out;
}

/// Content at @p milliFps on a display at @p milliHz, for @p refreshes from
/// @p first: frame k on the first refresh at or after its own time.
std::vector<int64_t> atRate(int64_t first, int64_t refreshes, int64_t milliFps, int64_t milliHz)
{
    std::vector<int64_t> out;
    for (int64_t k = 0;; ++k) {
        const int64_t r = first + (k * milliHz + milliFps - 1) / milliFps;
        if (r >= first + refreshes) break;
        if (out.empty() || r > out.back()) out.push_back(r);
    }
    return out;
}

/// What the gate admitted of a run: the refreshes, and their presents' µs.
struct Outcome
{
    std::vector<int64_t> refreshes;
    std::vector<int64_t> us;
};

/// @p presents through @p gate, @p lattice fed each present first; each
/// decided @p delayUs after its present by today's gate (the loop's wake-up
/// and conversion), on its own time by the locked one.
void through(FrameCadence& gate, PresentLattice& lattice, const std::vector<Present>& presents,
             Outcome& out, bool lock = true, int64_t delayUs = 300)
{
    for (const Present& p : presents) {
        lattice.note(p.us * 1000);
        const bool ok =
            lock ? gate.admit(p.us + delayUs, p.us, lattice.view()) : gate.admit(p.us + delayUs);
        if (!ok) continue;
        out.refreshes.push_back(p.refresh);
        out.us.push_back(p.us);
    }
}

/// The steps between the refreshes admitted from the one at @p from on.
std::map<int64_t, int64_t> stepsOf(const std::vector<int64_t>& refreshes, size_t from = 0)
{
    std::map<int64_t, int64_t> steps;
    for (size_t i = from + 1; i < refreshes.size(); ++i)
        steps[refreshes[i] - refreshes[i - 1]]++;
    return steps;
}

/// The share of steps of @p n, and whether every step is within @p n ± 1.
double shareOf(const std::map<int64_t, int64_t>& steps, int64_t n)
{
    int64_t total = 0;
    for (const auto& s : steps)
        total += s.second;
    const auto it = steps.find(n);
    return total > 0 && it != steps.end() ? static_cast<double>(it->second) / total : 0.0;
}

bool within(const std::map<int64_t, int64_t>& steps, int64_t lo, int64_t hi)
{
    for (const auto& s : steps)
        if (s.first < lo || s.first > hi) return false;
    return true;
}

/// The first admitted picture whose present is at or after @p us.
size_t firstAfter(const Outcome& out, int64_t us)
{
    size_t i = 0;
    while (i < out.us.size() && out.us[i] < us)
        ++i;
    return i;
}

} // namespace

void run_cadence_lock_tests()
{
    SECTION("PresentLattice — division rounded down, periods from a rate or a mode");
    {
        CHECK_EQ(floorDiv(7, 2), int64_t(3));
        CHECK_EQ(floorDiv(-7, 2), int64_t(-4));
        CHECK_EQ(floorDiv(-8, 2), int64_t(-4));
        CHECK_EQ(floorDiv(-1, 32), int64_t(-1));
        CHECK_EQ(floorDiv(-33, 32), int64_t(-2));
        CHECK_EQ(floorDiv(0, 32), int64_t(0));
        CHECK_EQ(PresentLattice::periodNsFromMilliHz(240000), int64_t(4166666));
        CHECK_EQ(PresentLattice::periodNsFromMilliHz(0), int64_t(0));
        CHECK_EQ(PresentLattice::periodNsFromRational(240, 1), int64_t(4166666));
        CHECK_EQ(PresentLattice::periodNsFromRational(239757, 1000), int64_t(4170889));
        CHECK_EQ(PresentLattice::periodNsFromRational(60000, 1001), int64_t(16683333));
        // DXGI's "not known".
        CHECK_EQ(PresentLattice::periodNsFromRational(0, 1), int64_t(0));
        CHECK_EQ(PresentLattice::periodNsFromRational(0, 0), int64_t(0));
        CHECK_EQ(PresentLattice::periodNsFromRational(240, 0), int64_t(0));
    }

    SECTION("PresentLattice — its points and halfway points, at ties and below the phase");
    {
        const PresentLattice::View v{1000, 100, true};
        CHECK_EQ(v.slotNs(1000), int64_t(1000));
        CHECK_EQ(v.slotNs(1049), int64_t(1000));
        CHECK_EQ(v.slotNs(1050), int64_t(1100)); // a tie goes to the later one
        CHECK_EQ(v.slotNs(951), int64_t(1000));
        CHECK_EQ(v.slotNs(950), int64_t(1000));
        CHECK_EQ(v.slotNs(949), int64_t(900));
        CHECK_EQ(v.slotNs(-5049), int64_t(-5000));
        CHECK_EQ(v.midNs(1000), int64_t(1050)); // a tie, between 950 and 1050
        CHECK_EQ(v.midNs(1049), int64_t(1050));
        CHECK_EQ(v.midNs(999), int64_t(950));
        CHECK_EQ(v.midNs(-5000), int64_t(-4950));
        CHECK_EQ(v.midNs(-5001), int64_t(-5050));
    }

    SECTION("PresentLattice — exact presents engage it on the 64th sample, not before");
    {
        PresentLattice lattice(kT);
        CHECK(!lattice.started());
        CHECK(lattice.sharpness() < 0);
        bool engagedEarly = false;
        PresentLattice::Change last = PresentLattice::Change::None;
        for (int64_t k = 0; k <= 64; ++k) {
            last = lattice.note(kStartNs + k * kT);
            if (k < 64 && lattice.engaged()) engagedEarly = true;
        }
        CHECK(!engagedEarly);
        CHECK(last == PresentLattice::Change::Engaged);
        CHECK(lattice.engaged());
        CHECK_EQ(lattice.samples(), int64_t(64));
        CHECK_EQ(lattice.acc(), int64_t(0));
        CHECK_EQ(lattice.taken(), int64_t(65));
        CHECK_EQ(lattice.phaseNs(), kStartNs + 64 * kT);
        CHECK_EQ(lattice.firstNs(), kStartNs);
        CHECK_EQ(lattice.firstEngagedNs(), kStartNs + 64 * kT);
        CHECK(lattice.sharpness() == 0.0);
    }

    SECTION("PresentLattice — content at 60 fps on 240 Hz engages it within 1.5 s");
    {
        Display d;
        d.ppm = -20;
        d.wanderNs = 60000;
        d.jitterNs = 350000;
        d.farOdds = 250;
        const std::vector<Present> presents = stamp(d, every(0, 2400, 4));
        PresentLattice lattice(kT);
        for (const Present& p : presents)
            lattice.note(p.us * 1000);
        CHECK(lattice.engaged());
        CHECK_EQ(lattice.engagements(), int64_t(1));
        CHECK_EQ(lattice.releases(), int64_t(0));
        CHECK(lattice.firstEngagedNs() - lattice.firstNs() < 1500000000LL);
        // σ 350 µs is 0.06 of a period at 240 Hz, as measured on the virtual
        // display under dense content.
        CHECK(lattice.sharpness() > 0.03 && lattice.sharpness() < 0.10);
    }

    SECTION("PresentLattice — presents with no grid never engage it");
    {
        SplitMix64 rng(11);
        std::vector<int64_t> times;
        for (int i = 0; i < 3000; ++i)
            times.push_back(kStartNs + static_cast<int64_t>(rng.below(20000000000ULL)));
        std::sort(times.begin(), times.end());
        PresentLattice lattice(kT);
        int64_t engagedAt = -1;
        for (int64_t t : times) {
            lattice.note(t);
            if (lattice.engaged() && engagedAt < 0) engagedAt = t;
        }
        CHECK_EQ(engagedAt, int64_t(-1));
        CHECK_EQ(lattice.engagements(), int64_t(0));
        CHECK(lattice.sharpness() > 0.2);
    }

    SECTION("PresentLattice — let go when the grid goes, engaged again when it comes back");
    {
        Display d;
        d.jitterNs = 350000;
        PresentLattice lattice(kT);
        for (const Present& p : stamp(d, every(0, 720)))
            lattice.note(p.us * 1000);
        CHECK(lattice.engaged());
        // 4 s of presents anywhere, 150 a second.
        SplitMix64 rng(12);
        std::vector<int64_t> times;
        for (int i = 0; i < 600; ++i)
            times.push_back(kStartNs + 720 * kT + static_cast<int64_t>(rng.below(960 * kT)));
        std::sort(times.begin(), times.end());
        for (int64_t t : times)
            lattice.note(t);
        CHECK(!lattice.engaged());
        CHECK_EQ(lattice.releases(), int64_t(1));
        for (const Present& p : stamp(d, every(1700, 720)))
            lattice.note(p.us * 1000);
        CHECK(lattice.engaged());
        CHECK_EQ(lattice.engagements(), int64_t(2));
        CHECK_EQ(lattice.releases(), int64_t(1));
        CHECK_EQ(lattice.resyncs(), int64_t(0));
    }

    SECTION("PresentLattice — the phase starts again on a present after a pause");
    {
        PresentLattice lattice(kT);
        for (int64_t k = 0; k < 240; ++k)
            lattice.note(kStartNs + k * kT);
        CHECK(lattice.engaged());
        // 11 s later, a third of a period off the old lattice: a new phase,
        // no sample, still engaged.
        const int64_t backNs = kStartNs + 239 * kT + 11000000000LL + kT / 3;
        CHECK(lattice.note(backNs) == PresentLattice::Change::Resynced);
        CHECK_EQ(lattice.phaseNs(), backNs);
        CHECK(lattice.engaged());
        const int64_t acc = lattice.acc();
        CHECK_EQ(lattice.note(backNs + kT) == PresentLattice::Change::None, true);
        CHECK_EQ(lattice.acc(), acc - acc / PresentLattice::kSamples);
        // 1.5 s later: 0.4 of a period off starts it again, 0.2 does not.
        const int64_t shortNs = backNs + kT + 1500000000LL;
        const int64_t slot = lattice.view().slotNs(shortNs);
        CHECK(lattice.note(slot + 2 * kT / 5) == PresentLattice::Change::Resynced);
        CHECK_EQ(lattice.resyncs(), int64_t(2));
        const int64_t later = lattice.phaseNs() + 1500000000LL;
        const int64_t slot2 = lattice.view().slotNs(later);
        CHECK(lattice.note(slot2 + kT / 5) == PresentLattice::Change::None);
        CHECK_EQ(lattice.resyncs(), int64_t(2));
        CHECK(lattice.phaseNs() != slot2 + kT / 5);
    }

    SECTION("PresentLattice — 240 Hz presents never engage a lattice of 120 Hz; 120 Hz ones "
            "engage one of 240");
    {
        // Every other present falls halfway between two points of the slow
        // lattice: those just before it are on the point already taken and
        // leave no trace, those just after it are half a period off.
        Display d;
        d.jitterNs = 350000;
        PresentLattice slow(PresentLattice::periodNsFromMilliHz(120000));
        for (const Present& p : stamp(d, every(0, 2400)))
            slow.note(p.us * 1000);
        CHECK_EQ(slow.engagements(), int64_t(0));
        CHECK(slow.sharpness() > 0.12);
        CHECK(slow.ignored() > 0);
        Display e;
        e.jitterNs = 350000;
        PresentLattice fast(kT);
        for (const Present& p : stamp(e, every(0, 2400, 2)))
            fast.note(p.us * 1000);
        CHECK(fast.engaged());
        CHECK_EQ(fast.engagements(), int64_t(1));
    }

    SECTION("PresentLattice — a present at or before the last one, or on its point, leaves no "
            "trace");
    {
        PresentLattice lattice(kT);
        for (int64_t k = 0; k < 100; ++k)
            lattice.note(kStartNs + k * kT);
        const int64_t phase = lattice.phaseNs();
        const int64_t taken = lattice.taken();
        const int64_t acc = lattice.acc();
        CHECK(lattice.note(kStartNs + 99 * kT) == PresentLattice::Change::None);
        CHECK(lattice.note(kStartNs + 98 * kT) == PresentLattice::Change::None);
        // Later, but on the same point of the lattice.
        CHECK(lattice.note(kStartNs + 99 * kT + kT / 3) == PresentLattice::Change::None);
        CHECK_EQ(lattice.ignored(), int64_t(3));
        CHECK_EQ(lattice.phaseNs(), phase);
        CHECK_EQ(lattice.taken(), taken);
        CHECK_EQ(lattice.acc(), acc);
    }

    SECTION("PresentLattice — a new lattice with the capture, the session's counters kept");
    {
        PresentLattice lattice(kT);
        for (int64_t k = 0; k < 100; ++k)
            lattice.note(kStartNs + k * kT);
        CHECK(lattice.engaged());
        const int64_t firstEngaged = lattice.firstEngagedNs();
        lattice.restart(PresentLattice::periodNsFromMilliHz(120000));
        CHECK(!lattice.engaged());
        CHECK(!lattice.started());
        CHECK_EQ(lattice.periodNs(), int64_t(8333333));
        CHECK_EQ(lattice.restarts(), int64_t(1));
        CHECK_EQ(lattice.samples(), int64_t(0));
        CHECK_EQ(lattice.engagements(), int64_t(1));
        CHECK_EQ(lattice.firstNs(), kStartNs);
        for (int64_t k = 0; k < 100; ++k)
            lattice.note(kStartNs + 2000000000LL + k * 8333333);
        CHECK(lattice.engaged());
        CHECK_EQ(lattice.engagements(), int64_t(2));
        CHECK_EQ(lattice.firstEngagedNs(), firstEngaged);
        // A restart before any present counts no new lattice.
        lattice.restart(kT);
        lattice.restart(kT);
        CHECK_EQ(lattice.restarts(), int64_t(2));
        // No period: nothing is ever taken.
        PresentLattice none;
        CHECK(none.note(kStartNs) == PresentLattice::Change::None);
        CHECK_EQ(none.taken(), int64_t(0));
        CHECK(!none.view().engaged);
    }

    SECTION("FrameCadence — lockRatio: N display periods to within 0.2 %, never for a ceiling");
    {
        CHECK_EQ(FrameCadence(60, 240).lockRatio(kT), int64_t(4));
        CHECK_EQ(FrameCadence(120, 240).lockRatio(kT), int64_t(2));
        CHECK_EQ(FrameCadence(80, 240).lockRatio(kT), int64_t(3));
        CHECK_EQ(FrameCadence(30, 240).lockRatio(kT), int64_t(8));
        CHECK_EQ(FrameCadence(60, 120).lockRatio(8333333), int64_t(2));
        CHECK_EQ(FrameCadence(50, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence(72, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence(90, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence(144, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence(145, 240).lockRatio(kT), int64_t(0));
        // One period a picture is a stream at the display's rate.
        CHECK_EQ(FrameCadence::fromIntervalNs(kT, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence::ceiling(1000000000LL / 240, 240).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence::ceiling(1000000000LL / 60, 60).lockRatio(16666666), int64_t(0));
        CHECK_EQ(FrameCadence(0).lockRatio(kT), int64_t(0));
        CHECK_EQ(FrameCadence(60, 240).lockRatio(0), int64_t(0));
        // A client at 59.94 Hz on its vsync, on a display at 240.000 Hz.
        CHECK_EQ(FrameCadence::fromIntervalNs(16683333, 240).lockRatio(kT), int64_t(4));
        // 60 fps on a display at 239.757 Hz.
        CHECK_EQ(FrameCadence(60, 240).lockRatio(4170889), int64_t(4));
        // 0.19 % off four periods locks, 0.25 % does not.
        CHECK_EQ(FrameCadence::fromIntervalNs(4 * kT * 10019 / 10000, 240).lockRatio(kT),
                 int64_t(4));
        CHECK_EQ(FrameCadence::fromIntervalNs(4 * kT * 10025 / 10000, 240).lockRatio(kT),
                 int64_t(0));
    }

    SECTION("FrameCadence — not engaged, no whole number of periods, a ceiling: today's gate, "
            "call for call");
    {
        const GoldenTrain train;
        // A lattice never fed is never engaged.
        {
            FrameCadence locked(60, 240), plain(60, 240);
            const PresentLattice idle(kT);
            bool same = true;
            for (const Call& c : train.calls)
                same = same && locked.admit(c.nowUs, c.ownUs, idle.view()) == plain.admit(c.nowUs);
            CHECK(same);
            CHECK_EQ(locked.lockedCalls(), int64_t(0));
            CHECK_EQ(locked.skipped(), plain.skipped());
        }
        // An engaged lattice, intervals of no whole number of periods, and a
        // ceiling.
        const FrameCadence gates[] = {FrameCadence(50, 240), FrameCadence(72, 240),
                                      FrameCadence(90, 240),
                                      FrameCadence::ceiling(1000000000LL / 240, 240)};
        for (const FrameCadence& gate : gates) {
            FrameCadence locked = gate, plain = gate;
            PresentLattice lattice(kT);
            bool same = true;
            for (const Call& c : train.calls) {
                if (c.present) lattice.note(c.ownUs * 1000);
                same =
                    same && locked.admit(c.nowUs, c.ownUs, lattice.view()) == plain.admit(c.nowUs);
            }
            CHECK(same);
            CHECK_EQ(locked.lockedCalls(), int64_t(0));
            CHECK_EQ(lattice.engagements(), int64_t(2));
        }
    }

    SECTION("cadencelock= — the product's unless said, 0 and 1 named");
    {
        mw::native::EncoderTuning t;
        CHECK_EQ(t.cadenceLock, -1);
        CHECK(t.isDefault());
        CHECK_EQ(t.describe(), std::string());
        t.cadenceLock = 0;
        CHECK(!t.isDefault());
        CHECK_EQ(t.describe(), std::string("cadencelock=0"));
        t.cadenceLock = 1;
        CHECK_EQ(t.describe(), std::string("cadencelock=1"));
    }

    SECTION("cadenceLockArmed — the key, the product's cadence, Desktop Duplication, a period");
    {
        CHECK(cadenceLockArmed(1, true, true, kT));
        CHECK(!cadenceLockArmed(0, true, true, kT));
        // The product's: on since the bench (gate G2).
        CHECK_EQ(cadenceLockArmed(-1, true, true, kT), mw::native::kCadenceLockProduct);
        CHECK(cadenceLockArmed(-1, true, true, kT));
        CHECK(!cadenceLockArmed(1, false, true, kT));
        CHECK(!cadenceLockArmed(1, true, false, kT));
        CHECK(!cadenceLockArmed(1, true, true, 0));
    }

    SECTION("FrameCadence — the golden train: gatesim.py --selftest's counts");
    {
        const GoldenTrain train;
        CHECK_EQ(train.presents.size(), size_t(15647));
        CHECK_EQ(train.calls.size(), size_t(15940));
        CHECK_EQ(train.presents.back().second, int64_t(1097989828));

        const Golden lock60 = goldenRun(train, 60, true);
        CHECK_EQ(lock60.admitted, int64_t(5037));
        CHECK_EQ(lock60.indexSum, int64_t(44675457));
        CHECK_EQ(lock60.skipped, int64_t(10903));
        CHECK_EQ(lock60.lockedCalls, int64_t(15036));
        CHECK_EQ(lock60.window, int64_t(4775));
        CHECK_EQ(lock60.empty, int64_t(3));
        CHECK_EQ(lock60.pause, int64_t(2));
        CHECK_EQ(lock60.today, int64_t(257));
        CHECK_EQ(lock60.engagements, int64_t(2));
        CHECK_EQ(lock60.releases, int64_t(1));
        CHECK_EQ(lock60.resyncs, int64_t(1));
        CHECK_EQ(lock60.ignored, int64_t(267));
        CHECK_EQ(lock60.phaseNs, int64_t(1097989685040));
        CHECK_EQ(lock60.acc, int64_t(17453210));

        const Golden lock120 = goldenRun(train, 120, true);
        CHECK_EQ(lock120.admitted, int64_t(8977));
        CHECK_EQ(lock120.indexSum, int64_t(77601130));
        CHECK_EQ(lock120.skipped, int64_t(6963));
        CHECK_EQ(lock120.lockedCalls, int64_t(15036));
        CHECK_EQ(lock120.window, int64_t(7118));
        CHECK_EQ(lock120.empty, int64_t(1331));
        CHECK_EQ(lock120.pause, int64_t(57));
        CHECK_EQ(lock120.today, int64_t(471));
        CHECK_EQ(lock120.phaseNs, int64_t(1097989685040));
        CHECK_EQ(lock120.acc, int64_t(17453210));

        const Golden lock50 = goldenRun(train, 50, true);
        CHECK_EQ(lock50.admitted, int64_t(4200));
        CHECK_EQ(lock50.indexSum, int64_t(37247510));
        CHECK_EQ(lock50.skipped, int64_t(11740));
        CHECK_EQ(lock50.lockedCalls, int64_t(0));
        CHECK_EQ(lock50.today, int64_t(4200));

        const Golden today60 = goldenRun(train, 60, false);
        CHECK_EQ(today60.admitted, int64_t(5039));
        CHECK_EQ(today60.indexSum, int64_t(44690137));
        CHECK_EQ(today60.skipped, int64_t(10901));
        CHECK_EQ(today60.lockedCalls, int64_t(0));
        CHECK_EQ(today60.today, int64_t(5039));

        // Dense content while engaged: steps of 4 locked, 99.73 %; today's
        // gate on the same span slips, 8.8 % of its steps 3 or 5.
        CHECK_EQ(lock60.steps.size(), size_t(3));
        CHECK_EQ(lock60.steps.at(3), int64_t(3));
        CHECK_EQ(lock60.steps.at(4), int64_t(2586));
        CHECK_EQ(lock60.steps.at(5), int64_t(4));
        CHECK(shareOf(lock60.steps, 4) >= 0.995);
        CHECK(within(lock60.steps, 3, 5));
        CHECK_EQ(today60.steps.at(3), int64_t(115));
        CHECK_EQ(today60.steps.at(4), int64_t(2383));
        CHECK_EQ(today60.steps.at(5), int64_t(115));
        CHECK(shareOf(today60.steps, 4) <= 0.97);
        CHECK_EQ(lock120.steps.at(2), int64_t(5163));
        CHECK(shareOf(lock120.steps, 2) >= 0.995);
        CHECK(within(lock120.steps, 1, 3));
    }

    SECTION("FrameCadence — the guard: no window before the one after the picture (gatesim.py)");
    {
        // Today's gate restarted its grid on a call at 323.75 ms, before the
        // lattice engaged: its next window starts 0.7 of a period past a
        // present of the lattice. A present 0.4 of a period early on its
        // refresh comes in the window's last sliver; the halfway point
        // nearest one interval on lies before it.
        const int64_t t = PresentLattice::periodNsFromRational(240, 1);
        PresentLattice lattice(t);
        FrameCadence gate(60, 240);
        CHECK(gate.admit(323750));
        const int64_t before = gate.windowStartNs();
        CHECK_EQ(before, int64_t(336250000));
        for (int64_t k = 0; k < 80; ++k)
            lattice.note(k * t);
        const int64_t presentUs = (84 * t + 6 * t / 10) / 1000;
        lattice.note(presentUs * 1000);
        CHECK(lattice.engaged());
        CHECK(gate.admit(presentUs, presentUs, lattice.view()));
        CHECK(gate.lastLocked());
        CHECK(gate.lastRule() == FrameCadence::Rule::Window);
        const int64_t slot = lattice.view().slotNs(presentUs * 1000);
        const int64_t nearest = lattice.view().midNs(before + 4 * t);
        CHECK_EQ(slot, int64_t(354134057));
        CHECK_EQ(nearest, int64_t(352050724));
        CHECK(nearest < slot);
        CHECK_EQ(gate.windowStartNs(), slot + t / 2);
        CHECK_EQ(gate.windowStartNs(), int64_t(356217390));
    }

    SECTION("FrameCadence — locked: an empty window, the picture that ends it, then steps of 4");
    {
        Display d;
        FrameCadence gate(60, 240);
        PresentLattice lattice(kT);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 400)), out);
        const int64_t a = out.refreshes.back();
        CHECK(a >= 396);
        // Nothing presented from 400 to a + 7: the window from a + 3.5 to
        // a + 7.5 has nothing in it.
        const size_t from = out.refreshes.size() - 1;
        const int64_t empty = gate.admitted(FrameCadence::Rule::Empty);
        through(gate, lattice, stamp(d, every(a + 8, 40)), out);
        CHECK(gate.lastLocked());
        CHECK_EQ(out.refreshes[from + 1], a + 8); // it counts for the window it missed
        CHECK_EQ(out.refreshes[from + 2], a + 9); // the next opened half a period after it
        CHECK_EQ(out.refreshes[from + 3], a + 13);
        CHECK_EQ(out.refreshes[from + 4], a + 17);
        CHECK(within(stepsOf(out.refreshes, from + 2), 4, 4));
        CHECK_EQ(gate.admitted(FrameCadence::Rule::Empty), empty + 1);
    }

    SECTION("FrameCadence — locked: after a pause of 2 s, the second picture 4 refreshes after "
            "the first");
    {
        Display d;
        d.jitterNs = 350000;
        FrameCadence gate(60, 240);
        PresentLattice lattice(kT);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 400)), out);
        const size_t from = out.refreshes.size();
        const int64_t pauses = gate.admitted(FrameCadence::Rule::Pause);
        through(gate, lattice, stamp(d, every(880, 40)), out);
        CHECK_EQ(out.refreshes[from], int64_t(880));
        CHECK_EQ(out.refreshes[from + 1], int64_t(884));
        CHECK(within(stepsOf(out.refreshes, from), 4, 4));
        CHECK_EQ(gate.admitted(FrameCadence::Rule::Pause), pauses + 1);
    }

    SECTION("FrameCadence — locked at 120, 80 and 30 fps: steps of 2, 3 and 8");
    {
        const int fpsList[] = {120, 80, 30};
        const int64_t periods[] = {2, 3, 8};
        for (int i = 0; i < 3; ++i) {
            Display d;
            d.ppm = -20;
            d.wanderNs = 60000;
            d.jitterNs = 350000;
            d.farOdds = 250;
            FrameCadence gate(fpsList[i], 240);
            PresentLattice lattice(kT);
            Outcome out;
            through(gate, lattice, stamp(d, every(0, 4800)), out);
            const auto steps = stepsOf(out.refreshes, firstAfter(out, kStartNs / 1000 + 2000000));
            CHECK(shareOf(steps, periods[i]) >= 0.995);
            CHECK(within(steps, periods[i] - 1, periods[i] + 1));
            // All but the 64 presents the lattice takes to engage.
            CHECK(static_cast<double>(gate.lockedCalls()) / gate.calls() > 0.98);
        }
    }

    SECTION("FrameCadence — locked: a game at 60 fps, a frame a refresh early or late, every "
            "frame carried");
    {
        Display d;
        d.ppm = -20;
        d.jitterNs = 350000;
        SplitMix64 rng(5);
        std::vector<int64_t> game;
        for (int64_t f = 0; f < 1800; ++f) {
            const uint64_t u = rng.below(20);
            game.push_back(2404 + 4 * f + (u == 0 ? -1 : u == 1 ? 1 : 0));
        }
        FrameCadence gate(60, 240);
        PresentLattice lattice(kT);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 2400)), out);
        const size_t from = out.refreshes.size();
        through(gate, lattice, stamp(d, game), out);
        CHECK_EQ(out.refreshes.size() - from, game.size());
        CHECK(lattice.engaged());
        CHECK(gate.lastLocked());
    }

    SECTION("FrameCadence — locked: after a pause, a game's first frame a refresh early is "
            "skipped (risk 5), then early frames are carried");
    {
        Display d;
        FrameCadence gate(60, 240);
        PresentLattice lattice(kT);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 400)), out);
        const size_t from = out.refreshes.size();
        // 2 s later: s, s + 3 (early), s + 8, s + 11 (early), s + 16.
        const int64_t s = 880;
        through(gate, lattice, stamp(d, {s, s + 3, s + 8, s + 11, s + 16}), out);
        const std::vector<int64_t> carried(out.refreshes.begin() + from, out.refreshes.end());
        CHECK(carried == std::vector<int64_t>({s, s + 8, s + 11, s + 16}));
    }

    SECTION("FrameCadence — locked: content at 59.5 and 77 fps, at 65, 90, 120 and 240 into 60: "
            "never above 60.2");
    {
        const int64_t rates[] = {59500, 65000, 77000, 90000, 120000, 240000};
        for (int64_t milliFps : rates) {
            Display d;
            d.ppm = -20;
            d.jitterNs = 350000;
            FrameCadence gate(60, 240);
            PresentLattice lattice(kT);
            Outcome out;
            through(gate, lattice, stamp(d, every(0, 960)), out);
            const size_t from = out.refreshes.size();
            const std::vector<int64_t> content = atRate(1000, 7200, milliFps, 240000);
            through(gate, lattice, stamp(d, content), out);
            const double fps = static_cast<double>(out.refreshes.size() - from) / 30.0;
            CHECK(fps <= 60.2);
            CHECK(fps >= (milliFps < 60000 ? milliFps / 1000.0 : 60.0) - 0.3);
            CHECK(lattice.engaged());
        }
    }

    SECTION("FrameCadence — locked for 10 min at -28 ppm, the phase wandering ±100 µs");
    {
        Display d;
        d.ppm = -28;
        d.wanderNs = 100000;
        d.jitterNs = 350000;
        d.farOdds = 250;
        FrameCadence gate(60, 240);
        PresentLattice lattice(kT);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 144000)), out);
        CHECK(lattice.engaged());
        CHECK_EQ(lattice.engagements(), int64_t(1));
        CHECK_EQ(lattice.releases(), int64_t(0));
        const auto steps = stepsOf(out.refreshes, firstAfter(out, kStartNs / 1000 + 2000000));
        CHECK(shareOf(steps, 4) >= 0.995);
        CHECK(within(steps, 3, 5));
        const double fps = static_cast<double>(out.refreshes.size()) / 600.0;
        CHECK(fps > 59.9 && fps < 60.1);
    }

    SECTION("FrameCadence — locked: a new gate on the same lattice locks at once");
    {
        Display d;
        d.jitterNs = 350000;
        PresentLattice lattice(kT);
        FrameCadence gate(60, 240);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 1200)), out);
        // The client's screen changed: the gate is replaced, the lattice
        // stays (WindowsSession's m_Cadence = chosen).
        gate = FrameCadence(120, 240);
        const size_t from = out.refreshes.size();
        through(gate, lattice, stamp(d, every(1200, 1200)), out);
        CHECK_EQ(gate.lockedCalls(), gate.calls());
        CHECK_EQ(gate.admitted(FrameCadence::Rule::Pause), int64_t(1));
        CHECK(within(stepsOf(out.refreshes, from), 2, 2));
    }

    SECTION("FrameCadence — locked: a pointer's wake-up past the next present, which then skips");
    {
        Display d;
        PresentLattice lattice(kT);
        FrameCadence gate(60, 240);
        Outcome out;
        const std::vector<Present> dense = stamp(d, every(0, 400));
        through(gate, lattice, dense, out);
        const int64_t a = out.refreshes.back();
        const std::vector<Present> after = stamp(d, every(400, 40));
        // a + 4's present, 100 µs on: a pointer that moved alone.
        size_t i = 0;
        while (after[i].refresh < a + 4)
            ++i;
        const int64_t pointerUs = after[i].us + 100;
        // The presents before a + 4 first, as the loop takes them.
        Outcome rest;
        through(gate, lattice, std::vector<Present>(after.begin(), after.begin() + i), rest);
        CHECK(rest.refreshes.empty());
        CHECK(gate.admit(pointerUs, pointerUs, lattice.view()));
        CHECK(gate.lastLocked());
        // a + 4 comes after it, on an earlier time: it is skipped.
        lattice.note(after[i].us * 1000);
        CHECK(!gate.admit(after[i].us + 300, after[i].us, lattice.view()));
        CHECK(gate.lastRule() == FrameCadence::Rule::Skip);
        through(gate, lattice, std::vector<Present>(after.begin() + i + 1, after.end()), rest);
        CHECK_EQ(rest.refreshes.front(), a + 8);
        CHECK(within(stepsOf(rest.refreshes), 4, 4));
    }

    SECTION("FrameCadence — locked on a display at 239.757 Hz: 59.94 fps, steps of 4");
    {
        Display d;
        d.periodNs = PresentLattice::periodNsFromRational(239757, 1000);
        d.jitterNs = 350000;
        FrameCadence gate(60, 240);
        PresentLattice lattice(d.periodNs);
        Outcome out;
        through(gate, lattice, stamp(d, every(0, 14400)), out);
        const auto steps = stepsOf(out.refreshes, firstAfter(out, kStartNs / 1000 + 2000000));
        CHECK(shareOf(steps, 4) >= 0.995);
        CHECK(within(steps, 3, 5));
        const double seconds = static_cast<double>(out.us.back() - out.us.front()) / 1e6;
        const double fps = static_cast<double>(out.refreshes.size() - 1) / seconds;
        CHECK(fps > 59.92 && fps < 59.96);
    }

    SECTION("FrameCadence — locked: the same pictures whatever the clock's origin");
    {
        Display a, b;
        a.jitterNs = b.jitterNs = 350000;
        a.farOdds = b.farOdds = 250;
        b.startNs = kStartNs + 7123457000LL;
        FrameCadence gateA(60, 240), gateB(60, 240);
        PresentLattice latticeA(kT), latticeB(kT);
        Outcome outA, outB;
        through(gateA, latticeA, stamp(a, every(0, 4800)), outA);
        through(gateB, latticeB, stamp(b, every(0, 4800)), outB);
        CHECK(outA.refreshes == outB.refreshes);
        CHECK_EQ(latticeA.acc(), latticeB.acc());
        CHECK_EQ(latticeB.phaseNs() - latticeA.phaseNs(), int64_t(7123457000LL));
    }

    SECTION("cadenceLockText — the log's words");
    {
        const FrameCadence at60(60, 240);
        CHECK_EQ(cadenceLockText(1, true, true, kT, at60),
                 std::string("on (cadencelock=1) — 4 periods of 4166666 ns a picture, once the "
                             "display's presents keep to them"));
        CHECK_EQ(cadenceLockText(0, true, true, kT, at60),
                 std::string("off (cadencelock=0) — it would be 4 periods of 4166666 ns a "
                             "picture; the lattice is kept for the log"));
        CHECK_EQ(cadenceLockText(-1, true, true, kT, at60),
                 std::string("on — 4 periods of 4166666 ns a picture, once the display's presents "
                             "keep to them"));
        CHECK_EQ(cadenceLockText(1, true, false, kT, at60),
                 std::string("off under Windows.Graphics.Capture — it would be 4 periods of "
                             "4166666 ns a picture; the lattice is kept for the log"));
        CHECK_EQ(cadenceLockText(1, false, true, kT, at60),
                 std::string("off under a bench cadence — it would be 4 periods of 4166666 ns a "
                             "picture; the lattice is kept for the log"));
        CHECK_EQ(cadenceLockText(1, true, true, 0, at60),
                 std::string("off, the display's period is not known"));
        CHECK_EQ(cadenceLockText(1, true, true, kT, FrameCadence(50, 240)),
                 std::string("on (cadencelock=1) — never for this gate: an interval of 20000000 "
                             "ns is no whole number of periods of 4166666 ns; the lattice is "
                             "kept for the log"));
        CHECK_EQ(cadenceLockText(1, true, true, kT, FrameCadence::ceiling(1000000000LL / 240, 240)),
                 std::string("on (cadencelock=1) — never under a ceiling, which encodes every "
                             "refresh (periods of 4166666 ns); the lattice is kept for the log"));
        CHECK_EQ(cadenceLockText(1, true, true, kT, FrameCadence(0)),
                 std::string("on (cadencelock=1) — never for this gate, which encodes every "
                             "present; the lattice is kept for the log"));
        CHECK_EQ(cadenceLockState(1, true, true, kT), std::string("on (cadencelock=1)"));
        CHECK_EQ(cadenceLockState(-1, true, true, kT), std::string("on"));
        // gatesim.py's lock_line() reads this head, the aligned cadence's
        // exact interval with it.
        CHECK_EQ(cadenceLockHead(kT, at60), std::string("period 4166666 ns, interval 16666000 ns"));
        CHECK_EQ(cadenceLockHead(kT, FrameCadence::fromIntervalNs(16683333, 240)),
                 std::string("period 4166666 ns, interval 16683333 ns"));
    }
}
