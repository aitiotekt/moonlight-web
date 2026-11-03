/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The wait for the browser to open the signalling socket (SignalingWait.h).
 *
 * A browser killed between /start and that socket left the session encoding
 * for nobody (20/10, 11 min): the wait must give up exactly once when nobody
 * came, never when the browser did, and never after the session is gone.
 */

#include "../src/streaming/SignalingWait.h"

#include "test_framework.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QObject>
#include <QThread>

namespace {

/// Pump this thread's events for @p ms.
void pump(int ms)
{
    QElapsedTimer t;
    t.start();
    while (t.elapsed() < ms) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
        QThread::msleep(1);
    }
}

} // namespace

void run_signaling_wait_tests()
{
    using mw::signaling::armClientWait;
    using mw::signaling::kClientWaitMs;

    SECTION("signaling wait — Bruno's 30 to 60 s");
    {
        CHECK(kClientWaitMs >= 30000);
        CHECK(kClientWaitMs <= 60000);
    }

    SECTION("signaling wait — nobody came: gives up once");
    {
        QObject session;
        int gaveUp = 0;
        armClientWait(&session, 20, [] { return false; }, [&] { ++gaveUp; });
        CHECK_EQ(gaveUp, 0); // not before its time
        pump(120);
        CHECK_EQ(gaveUp, 1);
        pump(60);
        CHECK_EQ(gaveUp, 1); // single shot
    }

    SECTION("signaling wait — the browser came: nothing ends");
    {
        QObject session;
        bool arrived = false;
        int gaveUp = 0;
        armClientWait(&session, 20, [&] { return arrived; }, [&] { ++gaveUp; });
        arrived = true; // the socket opened before the deadline
        pump(120);
        CHECK_EQ(gaveUp, 0);
    }

    SECTION("signaling wait — the session went first (take-over): nothing runs");
    {
        int gaveUp = 0;
        {
            QObject session;
            armClientWait(&session, 20, [] { return false; }, [&] { ++gaveUp; });
        } // torn down before the deadline
        pump(120);
        CHECK_EQ(gaveUp, 0);
    }
}
