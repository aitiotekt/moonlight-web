/*
 * MoonlightWeb — native capture & encoding engine, test suite.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>. GPLv3.
 */
#include "native_test_framework.h"

#include "core/PointerPresence.h"

using namespace mw::native;

// Mouse Keys on a host with no pointing device, so that Windows draws its
// pointer during a stream, and put back exactly as they were after it.
//
// The fake behaves as Windows did on the N95 bench (16/10/2026): Mouse Keys
// turned on count as a pointing device at once, and Windows adds a bit of its
// own (MKF_LEFTBUTTONSEL) to the flags it was given.

namespace {

constexpr uint32_t kLeftButtonSel = 0x10000000;
// What the N95 had before anything was changed: Windows' defaults, off.
const MouseKeysState kDefaults{0x1000003E, 80, 3000, 0};

struct FakeSystem : PointerSystem
{
    bool physicalMouse = false;
    MouseKeysState keys = kDefaults;
    bool readFails = false;
    bool writeFails = false;
    int reads = 0;
    int writes = 0;

    bool mousePresent() override
    {
        return physicalMouse || (keys.flags & PointerPresence::kOn) != 0;
    }
    bool readMouseKeys(MouseKeysState& out) override
    {
        ++reads;
        if (readFails) return false;
        out = keys;
        return true;
    }
    bool writeMouseKeys(const MouseKeysState& state) override
    {
        ++writes;
        if (writeFails) return false;
        keys = state;
        if (keys.flags & PointerPresence::kOn) keys.flags |= kLeftButtonSel;
        return true;
    }
};

constexpr int64_t kSecond = PointerPresence::kIntervalUs;

} // namespace

void run_pointer_presence_tests()
{
    SECTION("Pointer presence — Mouse Keys on a host with no pointing device");

    // ── A mouse is there: nothing is ever written ───────────────────────────
    {
        FakeSystem sys;
        sys.physicalMouse = true;
        PointerPresence p(sys);
        for (int i = 0; i < 5; ++i)
            CHECK(p.poll(i * kSecond) == PointerPresence::Step::None);
        CHECK(sys.writes == 0);
        CHECK(!p.engaged());
        CHECK(p.release() == PointerPresence::Step::None);
        CHECK(sys.keys == kDefaults);
    }

    // ── No mouse: turned on at the first look, put back exactly ─────────────
    {
        FakeSystem sys;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::TurnedOn);
        CHECK(p.engaged());
        CHECK(p.saved() == kDefaults);
        CHECK(PointerPresence::isOurs(sys.keys));
        // On and available, and nothing else that was asked: no indicator, no
        // hotkey, no sound.
        CHECK((sys.keys.flags & 0x0000003F) ==
              (PointerPresence::kOn | PointerPresence::kAvailable));
        CHECK(sys.mousePresent());
        // Looked at once a second, and while they hold nothing changes.
        const int reads = sys.reads;
        CHECK(p.poll(kSecond / 2) == PointerPresence::Step::None);
        CHECK(sys.reads == reads);
        CHECK(p.poll(kSecond) == PointerPresence::Step::None);
        CHECK(p.poll(2 * kSecond) == PointerPresence::Step::None);
        CHECK(sys.writes == 1);
        CHECK(p.release() == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
        CHECK(!sys.mousePresent());
        // Idempotent.
        CHECK(p.release() == PointerPresence::Step::None);
        CHECK(sys.writes == 2);
    }

    // ── The user's own Mouse Keys are left alone ────────────────────────────
    {
        FakeSystem sys;
        sys.keys = MouseKeysState{0x1000003F, 80, 3000, 0}; // on, their way
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::None);
        CHECK(!PointerPresence::isOurs(sys.keys));
        CHECK(p.release() == PointerPresence::Step::None);
        CHECK(sys.writes == 0);
    }

    // ── Changed during the stream: not put back over the user's choice ──────
    {
        FakeSystem sys;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::TurnedOn);
        sys.keys.maxSpeed = 200; // the user sped them up in Settings
        CHECK(p.poll(kSecond) == PointerPresence::Step::None);
        CHECK(p.release() == PointerPresence::Step::LeftAlone);
        CHECK(sys.keys.maxSpeed == 200);
        CHECK(sys.writes == 1);
    }

    // ── A mouse plugged in mid-stream changes nothing until the end ─────────
    {
        FakeSystem sys;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::TurnedOn);
        sys.physicalMouse = true;
        CHECK(p.poll(kSecond) == PointerPresence::Step::None);
        CHECK(p.release() == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
        CHECK(sys.mousePresent());
    }

    // ── The only mouse unplugged mid-stream: turned on within a second ──────
    {
        FakeSystem sys;
        sys.physicalMouse = true;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::None);
        sys.physicalMouse = false;
        CHECK(p.poll(kSecond / 2) == PointerPresence::Step::None); // not due yet
        CHECK(p.poll(kSecond) == PointerPresence::Step::TurnedOn);
        CHECK(p.saved() == kDefaults);
    }

    // ── Two streams on one host: the first to end puts them back, the other
    //    turns them on again a second later, and the end leaves the defaults ─
    {
        FakeSystem sys;
        PointerPresence first(sys);
        PointerPresence second(sys);
        CHECK(first.poll(0) == PointerPresence::Step::TurnedOn);
        // Mouse Keys count as a mouse: the second stream has nothing to do.
        CHECK(second.poll(100) == PointerPresence::Step::None);
        CHECK(!second.engaged());
        CHECK(first.release() == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
        CHECK(second.poll(kSecond + 100) == PointerPresence::Step::TurnedOn);
        CHECK(second.saved() == kDefaults);
        CHECK(second.release() == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
    }

    // ── Turned off under a stream that holds them: Lost, then on again at
    //    once, with what is there now as the thing to put back ───────────────
    {
        FakeSystem sys;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::TurnedOn);
        sys.keys = kDefaults; // another stream, or the user, turned them off
        CHECK(p.poll(kSecond) == PointerPresence::Step::Lost);
        CHECK(!p.engaged());
        CHECK(p.poll(kSecond) == PointerPresence::Step::TurnedOn);
        CHECK(p.saved() == kDefaults);
        CHECK(p.release() == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
    }

    // ── A refusal changes nothing and is reported once ──────────────────────
    {
        FakeSystem sys;
        sys.writeFails = true;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::Failed);
        CHECK(!p.engaged());
        CHECK(p.poll(kSecond) == PointerPresence::Step::None);
        CHECK(p.poll(2 * kSecond) == PointerPresence::Step::None);
        CHECK(p.release() == PointerPresence::Step::None);
        CHECK(sys.keys == kDefaults);
    }
    {
        FakeSystem sys;
        sys.readFails = true;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::Failed);
        CHECK(sys.writes == 0);
        CHECK(p.poll(kSecond) == PointerPresence::Step::None);
    }

    // ── The parent's restore, after a worker that died holding them ─────────
    {
        FakeSystem sys;
        PointerPresence p(sys);
        CHECK(p.poll(0) == PointerPresence::Step::TurnedOn);
        const MouseKeysState saved = p.saved();
        // The worker is gone without a release(); its parent knows `saved`.
        CHECK(PointerPresence::restoreIfOurs(sys, saved) == PointerPresence::Step::Restored);
        CHECK(sys.keys == kDefaults);
        // Twice is harmless: what is there now is not a stream's.
        CHECK(PointerPresence::restoreIfOurs(sys, saved) == PointerPresence::Step::LeftAlone);
        CHECK(sys.writes == 2);
    }
}
