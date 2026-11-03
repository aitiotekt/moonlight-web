/* MoonlightWeb - clipboard support. GPLv3 - see repository LICENSE. */
#include "test_framework.h"
#include "streaming/ClipboardPolicy.h"

void run_clipboard_policy_tests()
{
    SECTION("Clipboard permissions and target paste chord");
    CHECK(ClipboardPolicy::enabled(true, false, true));
    CHECK(ClipboardPolicy::enabled(false, true, true));
    CHECK(!ClipboardPolicy::enabled(false, false, true));
    for (bool native : {false, true})
        for (bool local : {false, true})
            CHECK(!ClipboardPolicy::enabled(native, local, false));

    for (bool clientWrap : {false, true}) {
        const auto mac = ClipboardPolicy::pasteKeys(true, clientWrap);
        CHECK_EQ(mac.size(), size_t(4));
        CHECK_EQ(mac[0].key, short(0x5B));
        CHECK(mac[0].down);
        CHECK_EQ(mac[1].key, short(0x56));
        CHECK(mac[1].down);
        CHECK_EQ(mac[1].modifiers, char(0x08));
        CHECK(!mac[2].down);
        CHECK_EQ(mac[3].key, short(0x5B));
        CHECK(!mac[3].down);
        CHECK_EQ(mac[3].modifiers, char(0));
    }
    const auto windows = ClipboardPolicy::pasteKeys(false, true);
    CHECK_EQ(windows.size(), size_t(4));
    CHECK_EQ(windows[0].key, short(0x11));
    CHECK_EQ(windows[1].modifiers, char(0x02));
    CHECK(!windows[3].down);
    const auto heldControl = ClipboardPolicy::pasteKeys(false, false);
    CHECK_EQ(heldControl.size(), size_t(2));
    CHECK_EQ(heldControl[0].key, short(0x56));
    CHECK_EQ(heldControl[0].modifiers, char(0x02));

    ClipboardPolicy::SessionSettings session;
    CHECK(!session.send.load());
    CHECK(!session.receive.load());
    SECTION("Clipboard directions remain closed until configured and across reconnects");
    for (bool send : {false, true}) {
        for (bool receive : {false, true}) {
            session.configure({{"send", send}, {"receive", receive}});
            CHECK_EQ(session.send.load(), send);
            CHECK_EQ(session.receive.load(), receive);
            session.reset();
            CHECK(!session.send.load());
            CHECK(!session.receive.load());
        }
    }
    session.configure({{"send", true}, {"receive", true}});
    session.configure({});
    CHECK(!session.send.load());
    CHECK(!session.receive.load());
    session.configure({{"send", 1}, {"receive", "true"}});
    CHECK(!session.send.load());
    CHECK(!session.receive.load());
    ClipboardPolicy::SessionSettings standby;
    session.configure({{"send", true}, {"receive", true}});
    CHECK(!standby.send.load());
    CHECK(!standby.receive.load());
    standby.configure({{"send", false}, {"receive", true}});
    CHECK(!standby.send.load());
    CHECK(standby.receive.load());
    standby.configure({{"send", false}, {"receive", false}});
    CHECK(!standby.receive.load());
    session.configure({{"send", false}, {"receive", true}, {"pasteModifier", "meta"}});
    CHECK(!session.send.load());
    CHECK(session.receive.load());
    session.configure({{"send", true}, {"receive", false}, {"pasteModifier", "control"}});
    CHECK(session.send.load());
    CHECK(!session.receive.load());
    session.configure({{"send", "true"}, {"pasteModifier", "invalid"}});
    CHECK(!session.send.load());
    CHECK(!session.receive.load());

    SECTION("Shared relay clipboard dispatch never pastes or subscribes before opt-in");
    ClipboardPolicy::SessionSettings connection;
    int subscriptions = 0;
    int announcements = 0;
    int pastes = 0;
    bool subscribed = false;
    const auto subscribe = [&](bool receive) {
        ++subscriptions;
        subscribed = receive;
        if (receive) ++announcements;
    };
    const auto paste = [&](const QString& text, bool wrap) {
        CHECK_EQ(text, QString("synthetic clipboard"));
        CHECK(wrap);
        ++pastes;
    };
    const QJsonObject payload{{"text", "synthetic clipboard"}, {"injectCtrl", true}};
    CHECK(connection.handleMessage("clipboardpaste", payload, true, subscribe, paste));
    CHECK_EQ(pastes, 0);
    CHECK_EQ(subscriptions, 0);
    CHECK_EQ(announcements, 0);
    CHECK(!connection.handleMessage("keydown", {}, true, subscribe, paste));
    for (bool send : {false, true}) {
        for (bool receive : {false, true}) {
            const int before = pastes;
            const int announced = announcements;
            CHECK(connection.handleMessage(
                "clipboardconfig", {{"send", send}, {"receive", receive}}, true, subscribe, paste));
            CHECK_EQ(subscribed, receive);
            CHECK_EQ(announcements, announced + (receive ? 1 : 0));
            CHECK(connection.handleMessage("clipboardpaste", payload, true, subscribe, paste));
            CHECK_EQ(pastes, before + (send ? 1 : 0));
        }
    }
    connection.reset();
    const int before = pastes;
    CHECK(connection.handleMessage("clipboardpaste", payload, true, subscribe, paste));
    CHECK_EQ(pastes, before);
    const int subscribedBefore = subscriptions;
    CHECK(connection.handleMessage("clipboardconfig", {{"send", true}, {"receive", true}}, false,
                                   subscribe, paste));
    CHECK_EQ(subscriptions, subscribedBefore);
    CHECK(connection.handleMessage("clipboardpaste", payload, false, subscribe, paste));
    CHECK_EQ(pastes, before);
    CHECK(connection.handleMessage("clipboardconfig", {{"send", true}, {"receive", true}}, true,
                                   subscribe, paste));
    CHECK(connection.handleMessage("clipboardconfig", {}, true, subscribe, paste));
    CHECK(!subscribed);
    CHECK(connection.handleMessage("clipboardpaste", payload, true, subscribe, paste));
    CHECK_EQ(pastes, before);

    SECTION("Host clipboard delivery checks the current receive direction");
    int delivered = 0;
    const auto forward = [&](const QString& text) {
        CHECK_EQ(text, QString("host text"));
        ++delivered;
    };
    ClipboardPolicy::SessionSettings fresh;
    fresh.forwardHostText("host text", forward);
    CHECK_EQ(delivered, 0);
    fresh.configure({{"send", true}, {"receive", false}});
    fresh.forwardHostText("host text", forward);
    CHECK_EQ(delivered, 0);
    fresh.configure({{"send", false}, {"receive", true}});
    fresh.forwardHostText("host text", forward);
    CHECK_EQ(delivered, 1);
    // Model a queued notification whose receive setting changes before dispatch.
    const auto queued = [&]() { fresh.forwardHostText("host text", forward); };
    fresh.configure({{"send", false}, {"receive", false}});
    queued();
    CHECK_EQ(delivered, 1);
    fresh.configure({{"send", true}, {"receive", true}});
    fresh.reset();
    queued();
    CHECK_EQ(delivered, 1);
}
