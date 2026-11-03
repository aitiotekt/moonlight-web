/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * What the host sends besides the stream (HostUplink.h, HostUplinkReader.h).
 *
 * The case behind it: 24/10/2026, TeraBox uploading ~100 Mbit/s from the host
 * while a ~40 Mbit/s stream froze. What matters is that the upload reads as
 * ~100 besides the stream, that the stream's own bytes are not taken for it,
 * that a counter which wraps or resets never reads as a burst, and that the
 * log says it once when it starts, now and then while it lasts, once when it
 * ends.
 */

#include "../src/streaming/HostUplink.h"
#include "../src/streaming/HostUplinkReader.h"

#include "test_framework.h"

using namespace mw::hostuplink;

namespace {

/// Bytes in @p ms at @p kbps.
uint64_t bytesOf(int64_t kbps, int64_t ms)
{
    return static_cast<uint64_t>(kbps * ms / 8);
}

/// One reading a second: the adapter carries the stream on the wire plus
/// @p besidesKbps, the stream's data channels @p streamKbps.
struct Feed
{
    Meter meter;
    int64_t atMs = 1000000;
    uint64_t adapter = 5000000000ull;
    uint64_t stream = 0;
    unsigned bits = 64;

    std::optional<Rate> second(int64_t streamKbps, int64_t besidesKbps)
    {
        atMs += 1000;
        const int64_t wireKbps =
            static_cast<int64_t>(static_cast<double>(streamKbps) * kWireFactor);
        adapter += bytesOf(wireKbps + besidesKbps, 1000);
        if (bits < 64) adapter &= (uint64_t(1) << bits) - 1;
        stream += bytesOf(streamKbps, 1000);
        return meter.add(atMs, adapter, bits, stream);
    }
};

} // namespace

void run_host_uplink_tests()
{
    SECTION("HostUplink — counterDelta: 64 bits, 32 bits wrapping, a reset");
    {
        CHECK(counterDelta(100, 250, 64).value_or(0) == 150);
        // A 64-bit counter that goes back was reset: nothing is known.
        CHECK(!counterDelta(250, 100, 64).has_value());
        // macOS's 32-bit if_data wraps: one step back is a wrap, not a reset.
        CHECK(counterDelta(0xFFFFFF00ull, 0x100ull, 32).value_or(0) == 0x200);
        CHECK(counterDelta(10, 10, 32).value_or(1) == 0);
    }

    SECTION("HostUplink — the first reading gives no rate, the second does");
    {
        Feed f;
        CHECK(!f.second(40000, 0).has_value());
        const auto r = f.second(40000, 0);
        CHECK(r.has_value());
        CHECK_EQ(r->streamKbps, int64_t(40000));
        // The stream's own wire bytes are not taken for an upload besides it.
        CHECK(r->besidesKbps < 100);
    }

    SECTION("HostUplink — TeraBox's ~100 Mbit/s read as ~100 besides a 40 Mbit/s stream");
    {
        Feed f;
        f.second(40000, 100000);
        const auto r = f.second(40000, 100000);
        CHECK(r.has_value());
        CHECK(r->besidesKbps > 99000 && r->besidesKbps < 101000);
        CHECK(r->adapterKbps > 140000);
    }

    SECTION("HostUplink — never below zero, and a reset counter skips one reading");
    {
        Meter m;
        m.add(1000, 1000000, 64, 0);
        // Less on the adapter than the stream says it sent: the estimate's
        // headers overshoot, the result stays at zero.
        auto r = m.add(2000, 1000000 + bytesOf(30000, 1000), 64, bytesOf(30000, 1000));
        CHECK(r.has_value());
        CHECK_EQ(r->besidesKbps, int64_t(0));
        // The adapter came back up after a driver reset: no rate this time…
        CHECK(!m.add(3000, 500, 64, bytesOf(60000, 1000)).has_value());
        // …and the next reading starts from the new values.
        r = m.add(4000, 500 + bytesOf(50000, 1000), 64, bytesOf(90000, 1000));
        CHECK(r.has_value());
        CHECK(r->besidesKbps > 15000 && r->besidesKbps < 17000);
    }

    SECTION("HostUplink — a 32-bit counter that wraps mid-stream reads as a plain second");
    {
        Feed f;
        f.bits = 32;
        // 144.8 Mbit/s on the wire: the first second stays under 2^32, the
        // second one crosses it.
        f.adapter = 0xFFFFFFFFull - bytesOf(144800, 1000) * 3 / 2;
        f.second(40000, 100000);
        CHECK(f.adapter > 0xF0000000ull);
        const auto r = f.second(40000, 100000);
        CHECK(r.has_value());
        CHECK(r->besidesKbps > 99000 && r->besidesKbps < 101000);
    }

    SECTION("HostUplink — the window around a freeze takes the readings it overlaps");
    {
        Feed f;
        f.second(40000, 0);
        f.second(40000, 0);      // (1001000, 1002000]
        f.second(40000, 90000);  // (1002000, 1003000]
        f.second(40000, 120000); // (1003000, 1004000]
        f.second(40000, 0);      // (1004000, 1005000]
        // A 600 ms freeze inside the third second.
        Meter::Window w = f.meter.around(1002200, 1002800);
        CHECK_EQ(w.samples, 1);
        CHECK(w.peakKbps > 89000 && w.peakKbps < 91000);
        // One that spans the second and the third: both readings.
        w = f.meter.around(1002500, 1003500);
        CHECK_EQ(w.samples, 2);
        CHECK(w.peakKbps > 119000);
        CHECK(w.meanKbps > 104000 && w.meanKbps < 106000);
        // Before any reading: nothing.
        CHECK_EQ(f.meter.around(900000, 950000).samples, 0);
    }

    SECTION("HostUplink — the threshold scales with the stream");
    {
        CHECK_EQ(onKbps(0), kFloorKbps);
        CHECK_EQ(onKbps(20000), kFloorKbps);
        CHECK_EQ(onKbps(150000), int64_t(30000));
        CHECK_EQ(offKbps(150000), int64_t(15000));
    }

    SECTION("HostUplink — Notice: started after three readings, still every 30 s, ended after five "
            "quiet ones");
    {
        Feed f;
        Notice n;
        f.second(40000, 0);
        int started = 0, still = 0, ended = 0;
        Notice::Event last;
        auto step = [&](int64_t besides) {
            const auto r = f.second(40000, besides);
            if (!r) return;
            const Notice::Event ev = n.feed(*r);
            if (ev.kind == Notice::Kind::Started) ++started;
            if (ev.kind == Notice::Kind::Still) ++still;
            if (ev.kind == Notice::Kind::Ended) ++ended;
            if (ev.kind != Notice::Kind::None) last = ev;
        };
        // Two seconds above, one below: no episode.
        step(100000);
        step(100000);
        step(0);
        CHECK_EQ(started, 0);
        CHECK(!n.active());
        // Three above: started, dated from the first of them.
        step(100000);
        step(100000);
        step(100000);
        CHECK_EQ(started, 1);
        CHECK(n.active());
        CHECK_EQ(last.durationMs, int64_t(3000));
        CHECK(last.meanKbps > 99000 && last.meanKbps < 101000);
        CHECK_EQ(last.streamKbps, int64_t(40000));
        // 61 more seconds: two "still" lines, 30 s apart.
        for (int i = 0; i < 61; ++i)
            step(i == 10 ? 125000 : 100000);
        CHECK_EQ(still, 2);
        // Four quiet seconds are not enough, and a busy one restarts the count.
        for (int i = 0; i < 4; ++i)
            step(1000);
        step(100000);
        CHECK_EQ(ended, 0);
        for (int i = 0; i < 5; ++i)
            step(1000);
        CHECK_EQ(ended, 1);
        CHECK(!n.active());
        CHECK(last.peakKbps > 124000 && last.peakKbps < 126000);
        // 3 + 61 + 4 + 1 seconds above the off threshold or within its grace:
        // the episode ends at the last busy reading.
        CHECK_EQ(last.durationMs, int64_t((3 + 61 + 4 + 1) * 1000));
        // Between the two thresholds, nothing starts.
        for (int i = 0; i < 10; ++i)
            step(6000);
        CHECK_EQ(started, 1);
    }

    SECTION("HostUplink — Notice: finish() ends the episode still open, and only that");
    {
        Feed f;
        Notice n;
        CHECK(n.finish().kind == Notice::Kind::None);
        f.second(40000, 0);
        for (int i = 0; i < 4; ++i)
            if (const auto r = f.second(40000, 80000)) n.feed(*r);
        CHECK(n.active());
        const Notice::Event ev = n.finish();
        CHECK(ev.kind == Notice::Kind::Ended);
        CHECK_EQ(ev.durationMs, int64_t(4000));
        CHECK(!n.active());
        CHECK(n.finish().kind == Notice::Kind::None);
    }

    SECTION("HostUplinkReader — the loopback's adapter is found and read");
    {
        // connect() on UDP picks a route and sends nothing; the loopback is on
        // every machine the tests run on.
        const Adapter a = adapterTowards("127.0.0.1");
        CHECK(a.valid());
        CHECK(sentBytes(a).has_value());
        CHECK(!adapterTowards("not an address").valid());
        CHECK(!sentBytes(Adapter{}).has_value());
    }
}
