/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The sender's pacing (SendPacer.h, `pace=`; plan « Wi-Fi : la vidéo qui
 * attend dans SCTP », W2 A).
 *
 * What the bench relies on: off, nothing ever waits; on, a burst leaves at
 * once and what follows leaves at the rate, never faster; a pause refills the
 * bucket to one burst and no more; a clock that goes back costs no wait.
 */

#include "../src/streaming/AroadPacer.h"
#include "../src/streaming/SendPacer.h"

#include "test_framework.h"

void run_send_pacer_tests()
{
    SECTION("SendPacer — off, nothing waits");
    {
        SendPacer p;
        CHECK(!p.active());
        CHECK_EQ(p.waitUs(16000, 0), int64_t(0));
        p.configure(0, 16384);
        CHECK(!p.active());
        for (int64_t t = 0; t < 10; ++t) {
            CHECK_EQ(p.waitUs(16000, t), int64_t(0));
            p.sent(16000, t);
        }
    }

    SECTION("SendPacer — a burst at once, then the rate");
    {
        SendPacer p;
        p.configure(1'000'000, 16384); // 1 MB/s, 16 KB at a time
        CHECK_EQ(p.waitUs(16000, 0), int64_t(0));
        p.sent(16000, 0);
        // 384 bytes left: the next 16,000 wait for 15,616 more, 15.616 ms.
        CHECK_EQ(p.waitUs(16000, 0), int64_t(15616));
        CHECK_EQ(p.waitUs(16000, 15615), int64_t(1));
        CHECK_EQ(p.waitUs(16000, 15616), int64_t(0));
        p.sent(16000, 15616);
        CHECK(p.waitUs(16000, 15616) > 15000);
    }

    SECTION("SendPacer — a chunk bigger than the burst waits for a burst, and its debt is paid");
    {
        SendPacer p;
        p.configure(1'000'000, 4096);
        CHECK_EQ(p.waitUs(16000, 0), int64_t(0));
        p.sent(16000, 0); // 4,096 - 16,000: 11,904 owed
        // Back to a full burst: 11,904 + 4,096 = 16,000 bytes of time.
        CHECK_EQ(p.waitUs(16000, 0), int64_t(16000));
        CHECK_EQ(p.waitUs(16000, 16000), int64_t(0));
    }

    SECTION("SendPacer — a pause refills one burst, and no more");
    {
        SendPacer p;
        p.configure(1'000'000, 16384);
        p.sent(16384, 0);
        CHECK_EQ(p.tokens(), int64_t(0));
        CHECK_EQ(p.waitUs(1, 500'000), int64_t(0)); // half a second: full again
        CHECK_EQ(p.tokens(), int64_t(16384));
        CHECK_EQ(p.waitUs(16384, 900'000), int64_t(0));
        p.sent(16384, 900'000);
        p.sent(16384, 900'000); // two bursts back to back: one owed
        CHECK_EQ(p.waitUs(16384, 900'000), int64_t(32768));
        // A long pause, a second or more: full, whatever was owed.
        CHECK_EQ(p.waitUs(16384, 5'000'000), int64_t(0));
        CHECK_EQ(p.tokens(), int64_t(16384));
    }

    SECTION("SendPacer — a clock that goes back costs no wait");
    {
        SendPacer p;
        p.configure(1'000'000, 16384);
        CHECK_EQ(p.waitUs(1000, 1'000'000), int64_t(0));
        CHECK_EQ(p.waitUs(1000, 10), int64_t(0));
        CHECK_EQ(p.tokens(), int64_t(16384));
    }

    SECTION("SendPacer — a 47 KB frame at four times 45 Mbit/s leaves within 1.5 ms");
    {
        // The Mac's case of 03/10/2026: 45 Mbit/s, 120 fps, ~47 KB a frame, in
        // three chunks of 16 KB.
        SendPacer p;
        const int64_t rate = 45'000'000 / 8 * 4;
        p.configure(rate, 16384);
        int64_t now = 0;
        const size_t chunks[] = {16017, 16017, 15000};
        for (size_t c : chunks) {
            now += p.waitUs(c, now);
            CHECK_EQ(p.waitUs(c, now), int64_t(0));
            p.sent(c, now);
        }
        CHECK(now > 1300 && now < 1500);
        // The next frame, 8.3 ms later: a full burst again, no wait.
        CHECK_EQ(p.waitUs(16017, now + 8333), int64_t(0));
    }

    SECTION("AroadPacer — the rate follows what the road carries, above its floor");
    {
        // Off: everything at once.
        CHECK_EQ(AroadPacer::rateFor(0, 6'250'000, 2'500'000), int64_t(0));
        // 10 Mbit/s of HEVC at 3x: under the 50 Mbit/s floor.
        CHECK_EQ(AroadPacer::rateFor(3, 6'250'000, 1'250'000), int64_t(6'250'000));
        // 20 Mbit/s at 3x: 60 Mbit/s, over it.
        CHECK_EQ(AroadPacer::rateFor(3, 6'250'000, 2'500'000), int64_t(7'500'000));
        // 122 Mbit/s of Ultra at 3x: 366 Mbit/s.
        CHECK_EQ(AroadPacer::rateFor(3, 6'250'000, 15'250'000), int64_t(45'750'000));
        // Nothing carried yet: the floor.
        CHECK_EQ(AroadPacer::rateFor(3, 6'250'000, 0), int64_t(6'250'000));
    }

    SECTION("AroadWindow — off, or no ack yet: never held");
    {
        AroadWindow off(0);
        for (uint32_t i = 0; i < 100; ++i) {
            CHECK(off.mayPass(1112, 0));
            off.sent(i, 1112);
        }
        AroadWindow silent(48 * 1024);
        for (uint32_t i = 0; i < 100; ++i) {
            CHECK(silent.mayPass(1112, 0));
            silent.sent(i, 1112);
        }
        CHECK_EQ(silent.inFlight(), int64_t(111'200));
    }

    SECTION("AroadWindow — an ack moves it, a lost chunk leaves it");
    {
        AroadWindow w(4000);
        w.sent(1u << 16 | 0, 1000);
        w.acked(1u << 16 | 0, 0); // heard: the window holds from now on
        CHECK_EQ(w.inFlight(), int64_t(0));
        w.sent(1u << 16 | 1, 1000);
        w.sent(1u << 16 | 2, 1000); // lost
        w.sent(1u << 16 | 3, 1000);
        CHECK(w.mayPass(1000, 1000));
        w.sent(1u << 16 | 4, 1000);
        CHECK(!w.mayPass(1000, 1000));
        // Chunk 3 came: 1, 2 (lost) and 3 have left; 4 is in flight.
        w.acked(1u << 16 | 3, 2000);
        CHECK_EQ(w.inFlight(), int64_t(1000));
        CHECK(w.mayPass(1000, 2000));
        // An older ack, or one never sent, moves nothing back.
        w.acked(1u << 16 | 1, 3000);
        w.acked(9u << 16 | 9, 3000);
        CHECK_EQ(w.inFlight(), int64_t(1000));
        // The first chunk always goes, whatever its size.
        AroadWindow small(100);
        small.acked(0, 0);
        CHECK(small.mayPass(1112, 0));
    }

    SECTION("AroadWindow — a page silent for 150 ms with the window full opens it");
    {
        AroadWindow w(2000);
        w.sent(0, 1000);
        w.acked(0, 0);
        w.sent(1, 1000);
        w.sent(2, 1000);
        CHECK(!w.mayPass(1000, 149'999));
        CHECK_EQ(w.resets(), 0);
        CHECK(w.mayPass(1000, 150'000));
        CHECK_EQ(w.resets(), 1);
        CHECK_EQ(w.inFlight(), int64_t(0));
    }

    SECTION("AroadResendBudget — a fifth of what was sent, a floor under it");
    {
        AroadResendBudget b(0.2, 1000);
        // Nothing sent yet: the floor.
        CHECK(b.mayResend(1000, 1));
        CHECK(!b.mayResend(1, 1));
        CHECK_EQ(b.refused(), int64_t(1));
        // 100 KB sent in the next period: (100,000 + 0) / 2 x 0.2 = 10,000.
        b.sent(100'000, 100'001);
        CHECK(b.mayResend(10'000, 100'002));
        CHECK(!b.mayResend(1, 100'003));
        // The period after: the previous one still counts, its resends do not.
        b.sent(100'000, 200'001);
        CHECK(b.mayResend(20'000, 200'002));
        CHECK(!b.mayResend(1, 200'003));
        // A long silence: back to the floor.
        CHECK(b.mayResend(1000, 900'000));
        CHECK(!b.mayResend(1, 900'001));
    }

    SECTION("AroadPacer — the latest frame wins: unsent delta frames older than the newest go");
    {
        const auto job = [](uint16_t seq, uint16_t index, bool key = false, bool resend = false) {
            AroadPacer::Job j;
            j.seq = seq;
            j.index = index;
            j.keyframe = key;
            j.resend = resend;
            return j;
        };
        std::deque<AroadPacer::Job> q;
        q.push_back(job(4, 7, false, true)); // a resend: kept
        q.push_back(job(5, 3));              // frame 5 begun: kept
        q.push_back(job(5, 4));
        q.push_back(job(6, 0, true)); // a keyframe: kept
        q.push_back(job(6, 1, true));
        q.push_back(job(7, 0)); // unsent delta, older than 8: dropped
        q.push_back(job(7, 1));
        q.push_back(job(8, 0)); // the newest: kept
        q.push_back(job(8, 1));
        CHECK_EQ(AroadPacer::dropOlderFrames(q), 1);
        CHECK_EQ(q.size(), size_t(7));
        for (const auto& j : q)
            CHECK(j.seq != 7);
        // Only the newest frame left: nothing goes.
        std::deque<AroadPacer::Job> one;
        one.push_back(job(9, 0));
        one.push_back(job(9, 1));
        CHECK_EQ(AroadPacer::dropOlderFrames(one), 0);
        CHECK_EQ(one.size(), size_t(2));
    }
}
