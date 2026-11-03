/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The bench's audio log (AudioPathLog.h, `audiolog=1`; plan « le son et la
 * priorité des paquets », A0).
 *
 * What a pass relies on: nothing is kept while it is off; the relay's n-th
 * packet carries the engine's n-th, first in, first out; a packet the engine
 * never named keeps -1 on its side; the engine's side cannot grow without end
 * when no relay takes it; and the CSV holds one line per packet.
 */

#include "../src/streaming/AudioPathLog.h"

#include "test_framework.h"

#include <cstdio>
#include <fstream>
#include <string>

namespace {
using Outcome = AudioPathLog::Outcome;
} // namespace

void run_audio_path_log_tests()
{
    SECTION("AudioPathLog — nothing kept while off");
    {
        AudioPathLog log(16);
        log.emitted(1000, 1100, 2, 0.5f, false, 120);
        log.relayed(120, 1200, 1300, Outcome::Sent, 0);
        CHECK_EQ(log.count(), size_t(0));
        CHECK(log.records().empty());
    }

    SECTION("AudioPathLog — the relay's packets pair with the engine's, in order");
    {
        AudioPathLog log(16);
        log.start();
        log.emitted(10'000, 10'050, 3, 0.25f, false, 100);
        log.emitted(15'000, 15'040, 2, 0.0f, true, 90);
        log.relayed(100, 10'300, 10'350, Outcome::Sent, 0);
        log.relayed(90, 15'200, 0, Outcome::NotReady, 240);
        const auto rs = log.records();
        CHECK_EQ(rs.size(), size_t(2));
        CHECK_EQ(rs[0].capturedUs, int64_t(10'000));
        CHECK_EQ(rs[0].emitUs, int64_t(10'050));
        CHECK_EQ(rs[0].queued, 3);
        CHECK_EQ(rs[0].peak, 0.25f);
        CHECK(!rs[0].silence);
        CHECK_EQ(rs[0].inUs, int64_t(10'300));
        CHECK_EQ(rs[0].sentUs, int64_t(10'350));
        CHECK(rs[0].outcome == Outcome::Sent);
        CHECK_EQ(rs[1].capturedUs, int64_t(15'000));
        CHECK(rs[1].silence);
        CHECK(rs[1].outcome == Outcome::NotReady);
        CHECK_EQ(rs[1].rtpTs, uint32_t(240));
        const std::string s = log.summary();
        CHECK(s.find("2 packets: 1 sent, 1 track not open, 0 errors, 1 silence") == 0);
        // engine -> relay thread: 250 and 160 µs
        CHECK(s.find("p50 0.25") != std::string::npos || s.find("p50 0.16") != std::string::npos);
    }

    SECTION("AudioPathLog — a packet the engine never named keeps -1 on its side");
    {
        AudioPathLog log(16);
        log.start();
        log.relayed(80, 500, 600, Outcome::Sent, 0);
        const auto rs = log.records();
        CHECK_EQ(rs.size(), size_t(1));
        CHECK_EQ(rs[0].capturedUs, int64_t(-1));
        CHECK_EQ(rs[0].emitUs, int64_t(-1));
        CHECK_EQ(rs[0].queued, -1);
        CHECK_EQ(rs[0].bytes, uint32_t(80));
    }

    SECTION("AudioPathLog — the engine's side is bounded when no relay takes it");
    {
        AudioPathLog log(16);
        log.start();
        for (int i = 0; i < 500; ++i)
            log.emitted(i, i, 0, 0.0f, false, 10);
        // The oldest went: the first packet relayed now carries a recent one.
        log.relayed(10, 1, 2, Outcome::Sent, 0);
        const auto rs = log.records();
        CHECK(rs[0].capturedUs >= 300);
        CHECK(log.summary().find("never paired") != std::string::npos);
    }

    SECTION("AudioPathLog — start() begins anew, and the ring keeps the newest");
    {
        AudioPathLog log(4);
        log.start();
        for (int i = 0; i < 10; ++i)
            log.relayed(10, i, i + 1, Outcome::Sent, static_cast<uint32_t>(i));
        auto rs = log.records();
        CHECK_EQ(rs.size(), size_t(4));
        CHECK_EQ(rs.front().rtpTs, uint32_t(6));
        log.start();
        CHECK_EQ(log.count(), size_t(0));
        log.stop();
        CHECK(!log.enabled());
    }

    SECTION("AudioPathLog — the CSV: a header, then one line per packet");
    {
        AudioPathLog log(16);
        log.start();
        log.emitted(1000, 1010, 1, 0.75f, false, 64);
        log.relayed(64, 1100, 1150, Outcome::Sent, 480);
        const std::string path = "test_audio_path_log.csv";
        CHECK(log.writeCsv(path));
        std::ifstream in(path);
        std::string header, row, extra;
        std::getline(in, header);
        std::getline(in, row);
        CHECK_EQ(header, std::string(AudioPathLog::csvHeader()));
        CHECK_EQ(row, std::string("1000,1010,1,0.7500,0,64,1100,1150,sent,480"));
        CHECK(!std::getline(in, extra) || extra.empty());
        in.close();
        std::remove(path.c_str());
    }
}
