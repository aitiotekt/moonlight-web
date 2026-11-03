/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 */
#include "test_framework.h"
#include "network/MdnsAdvertiser.h"

// The name the TV app lists this server under. A dot would make the instance
// two labels, a name over 63 bytes is refused by the responder, and a --dev
// instance on the same PC must not collide with the production one.
void run_mdns_advertiser_tests()
{
    SECTION("MdnsAdvertiser");

    CHECK_EQ(MdnsAdvertiser::instanceName(QStringLiteral("DualRTX"), false),
             QStringLiteral("DualRTX"));
    CHECK_EQ(MdnsAdvertiser::instanceName(QStringLiteral("DualRTX"), true),
             QStringLiteral("DualRTX DEV"));
    CHECK_EQ(MdnsAdvertiser::instanceName(QStringLiteral("pc.home.lan"), false),
             QStringLiteral("pc"));
    CHECK_EQ(MdnsAdvertiser::instanceName(QStringLiteral("  "), false),
             QStringLiteral("MoonlightWeb"));

    const QString longName(80, QLatin1Char('x'));
    CHECK_EQ(MdnsAdvertiser::instanceName(longName, false).toUtf8().size(), 63);
    const QString dev = MdnsAdvertiser::instanceName(longName, true);
    CHECK(dev.endsWith(QStringLiteral(" DEV")));
    CHECK_EQ(dev.toUtf8().size(), 63);

    // UTF-8 is cut on a character, never inside one.
    const QString accents(40, QChar(0x00E9)); // 80 bytes
    const QString cut = MdnsAdvertiser::instanceName(accents, false);
    CHECK_EQ(cut.size(), 31);
    CHECK_EQ(cut.toUtf8().size(), 62);
}
