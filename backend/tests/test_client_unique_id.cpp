/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The browser's per-device id, read the same way by every route. /apps took
 * it raw while /start and /quit kept its upper-case hex only, so a MultiSeat
 * device claimed a seat under one spelling and launched under another, and
 * was refused its own seat (bench, 05/10/2026).
 */
#include "test_framework.h"
#include "server/ClientUniqueId.h"

void run_client_unique_id_tests()
{
    SECTION("ClientUniqueId");

    // What a browser sends already: unchanged.
    CHECK(sanitizeClientUniqueId(QStringLiteral("3D57AC4C9497130E")) ==
          QStringLiteral("3D57AC4C9497130E"));
    // Lower case is the same device.
    CHECK(sanitizeClientUniqueId(QStringLiteral("3d57ac4c9497130e")) ==
          QStringLiteral("3D57AC4C9497130E"));
    // Anything but hex is dropped, as /start always did.
    CHECK(sanitizeClientUniqueId(QStringLiteral("msbench0000000001")) ==
          QStringLiteral("BEC0000000001"));
    // At most 32 characters reach a launch URL.
    CHECK(sanitizeClientUniqueId(QString(40, QLatin1Char('a'))).size() == 32);
    CHECK(sanitizeClientUniqueId(QString()).isEmpty());
}
