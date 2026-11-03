/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * Hosts kept to one session (SingleSessionHosts.h, issue #36).
 *
 * A host whose standby session never showed a picture is never asked for a
 * second one again — across a restart of the server too, which is the point
 * of keeping it on disk.
 */

#include "../src/server/SingleSessionHosts.h"

#include <QDir>
#include <QTemporaryDir>

#include "test_framework.h"

void run_single_session_hosts_tests()
{
    SECTION("SingleSessionHosts — an unknown host is assumed able");
    {
        SingleSessionHosts hosts;
        CHECK(!hosts.contains("A"));
        CHECK_EQ(hosts.size(), 0);
    }

    SECTION("SingleSessionHosts — a failure is remembered once");
    {
        SingleSessionHosts hosts;
        CHECK(hosts.add("A"));
        CHECK(!hosts.add("A"));
        CHECK(!hosts.add(""));
        CHECK(hosts.contains("A"));
        CHECK(!hosts.contains("B"));
        CHECK_EQ(hosts.size(), 1);
    }

    SECTION("SingleSessionHosts — the answer outlives a restart");
    {
        QTemporaryDir dir;
        const QString path = QDir(dir.path()).filePath("dual-support.json");
        {
            SingleSessionHosts first(path);
            first.add("A");
            first.add("B");
        }
        SingleSessionHosts again(path);
        CHECK(again.contains("A"));
        CHECK(again.contains("B"));
        CHECK_EQ(again.size(), 2);
    }

    SECTION("SingleSessionHosts — an unreadable file is an empty list");
    {
        QTemporaryDir dir;
        const QString path = QDir(dir.path()).filePath("dual-support.json");
        QFile f(path);
        CHECK(f.open(QIODevice::WriteOnly));
        f.write("not json");
        f.close();
        SingleSessionHosts hosts(path);
        CHECK_EQ(hosts.size(), 0);
        CHECK(hosts.add("A"));
        CHECK(SingleSessionHosts(path).contains("A"));
    }
}
