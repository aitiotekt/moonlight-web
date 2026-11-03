/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * Link freezes counted for the stats card (LinkFreezeLog.h).
 *
 * One freeze is seen twice — the video backlog going down, the client's
 * silence coming up — and again on every frame shed while it lasts. What
 * matters is that all of that reads as ONE freeze with its real length, and
 * that two freezes seconds apart stay two.
 */

#include "../src/streaming/LinkFreezeLog.h"

#include "test_framework.h"

void run_link_freeze_log_tests()
{
    SECTION("LinkFreezeLog — nothing noted, nothing to show");
    {
        LinkFreezeLog log;
        const LinkFreezeLog::Snapshot s = log.snapshot();
        CHECK_EQ(s.count, 0);
        CHECK_EQ(s.maxMs, int64_t(0));
        CHECK_EQ(s.lastMs, int64_t(0));
    }

    SECTION("LinkFreezeLog — both directions and every shed frame are one freeze");
    {
        // The corporate Wi-Fi of 16/09/2026, 15:47:26: the backlog aged past
        // its tolerance, frames were shed as it kept growing, and the client
        // went silent over the same second.
        LinkFreezeLog log;
        log.note(10000, 10261); // first shed frame, backlog 261 ms
        log.note(10000, 10310); // the next ones stretch it
        log.note(10050, 10407); // the client's silence, up
        log.note(10000, 11232); // the last shed keyframe
        const LinkFreezeLog::Snapshot s = log.snapshot();
        CHECK_EQ(s.count, 1);
        CHECK_EQ(s.maxMs, int64_t(1232));
        CHECK_EQ(s.lastMs, int64_t(1232));
    }

    SECTION("LinkFreezeLog — freezes seconds apart stay apart");
    {
        LinkFreezeLog log;
        log.note(10000, 10900);
        // Within a second of the end: still the same one.
        log.note(11800, 11900);
        CHECK_EQ(log.snapshot().count, 1);
        CHECK_EQ(log.snapshot().maxMs, int64_t(1900));
        // Past it: a second freeze, shorter — the longest stays.
        log.note(20000, 20300);
        const LinkFreezeLog::Snapshot s = log.snapshot();
        CHECK_EQ(s.count, 2);
        CHECK_EQ(s.maxMs, int64_t(1900));
        CHECK_EQ(s.lastMs, int64_t(300));
    }

    SECTION("LinkFreezeLog — a span that ends before it starts is ignored");
    {
        LinkFreezeLog log;
        log.note(500, 400);
        CHECK_EQ(log.snapshot().count, 0);
        CHECK(log.takeClosed(100000, true).empty());
    }

    SECTION("LinkFreezeLog — each freeze is told once it can no longer stretch");
    {
        // The N95 of 19/10/2026, 15:19:25: the backlog shed a frame at 262 ms
        // and drained 743 ms later; the page's reports stopped over it.
        LinkFreezeLog log;
        log.note(25234, 25496, LinkFreezeLog::Backlog);
        log.note(25234, 26200, LinkFreezeLog::Backlog);
        log.note(25600, 26100, LinkFreezeLog::Reports, 12);
        // Still within kMergeMs of its end: it may stretch yet.
        CHECK(log.takeClosed(27000).empty());
        const std::vector<LinkFreezeLog::Episode> told = log.takeClosed(27201);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].number, 1);
        CHECK_EQ(told[0].endMs - told[0].startMs, int64_t(966));
        CHECK_EQ(told[0].sources, unsigned(LinkFreezeLog::Backlog | LinkFreezeLog::Reports));
        CHECK_EQ(told[0].pageLateMs, int64_t(12));
        CHECK(!told[0].stretched);
        // Handed out once.
        CHECK(log.takeClosed(30000).empty());
        CHECK(log.takeClosed(30000, true).empty());
    }

    SECTION("LinkFreezeLog — no report gap, no page delay; the latest one kept");
    {
        LinkFreezeLog log;
        log.note(1000, 1300, LinkFreezeLog::InputSilent);
        std::vector<LinkFreezeLog::Episode> told = log.takeClosed(5000);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].pageLateMs, int64_t(-1));
        CHECK_EQ(told[0].sources, unsigned(LinkFreezeLog::InputSilent));
        // Two gaps in one freeze: the page's latest delay is the one told.
        LinkFreezeLog two;
        two.note(1000, 2000, LinkFreezeLog::Reports, 0);
        two.note(2500, 3500, LinkFreezeLog::Reports, 900);
        two.note(3600, 3700, LinkFreezeLog::Reports, 40);
        told = two.takeClosed(10000);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].pageLateMs, int64_t(900));
    }

    SECTION("LinkFreezeLog — two freezes between two ticks are both told, in order");
    {
        LinkFreezeLog log;
        log.note(1000, 1400, LinkFreezeLog::Backlog);
        log.note(3000, 3200, LinkFreezeLog::Reports, 0); // the first is closed by now
        // A tick inside the second's merge window: only the first.
        std::vector<LinkFreezeLog::Episode> told = log.takeClosed(3500);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].number, 1);
        CHECK_EQ(told[0].sources, unsigned(LinkFreezeLog::Backlog));
        told = log.takeClosed(4300);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].number, 2);
        CHECK_EQ(log.snapshot().count, 2);
    }

    SECTION("LinkFreezeLog — a span reaching back into a told freeze tells it again");
    {
        LinkFreezeLog log;
        log.note(1000, 1500, LinkFreezeLog::Backlog);
        CHECK_EQ(log.takeClosed(2600).size(), size_t(1));
        // A report gap measured when it ended, begun inside the merge window.
        log.note(2400, 4000, LinkFreezeLog::Reports, 0);
        CHECK_EQ(log.snapshot().count, 1);
        const std::vector<LinkFreezeLog::Episode> told = log.takeClosed(5100);
        CHECK_EQ(told.size(), size_t(1));
        CHECK_EQ(told[0].number, 1);
        CHECK(told[0].stretched);
        CHECK_EQ(told[0].endMs - told[0].startMs, int64_t(3000));
    }

    SECTION("LinkFreezeLog — the session's end tells the one still open");
    {
        LinkFreezeLog log;
        log.note(1000, 1200, LinkFreezeLog::Backlog);
        CHECK(log.takeClosed(1500).empty());
        CHECK_EQ(log.takeClosed(1500, true).size(), size_t(1));
        CHECK(log.takeClosed(1500, true).empty());
    }

    SECTION("LinkFreezeLog — a report gap the page made itself is not the link's");
    {
        // The idle desktop of 25/10/2026: the browser held the page at one
        // timer a second, so every report came 1 s after the last one and
        // said it left 500 ms late. Nothing was wrong on the wire.
        CHECK_EQ(LinkFreezeLog::reportsGapOnLink(1001, 500), int64_t(501));
        CHECK(LinkFreezeLog::reportsGapOnLink(1001, 500) < 1000);
        // On time, held up on the way: all of it is the link's.
        CHECK_EQ(LinkFreezeLog::reportsGapOnLink(1800, 0), int64_t(1800));
        // Both: the page's part comes out, the link keeps the rest.
        CHECK_EQ(LinkFreezeLog::reportsGapOnLink(2500, 400), int64_t(2100));
        // A page that does not say (before `late`) is counted as before.
        CHECK_EQ(LinkFreezeLog::reportsGapOnLink(1200, -1), int64_t(1200));
    }
}
