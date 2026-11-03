/*
 * MoonlightWeb — native capture & encoding engine.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#include "core/FrameCadence.h"
#include "core/InputAdmit.h"
#include "native_test_framework.h"

#include <algorithm>
#include <vector>

using mw::native::FrameCadence;
using mw::native::InputAdmit;
using mw::native::InputEvent;
using mw::native::PressFilter;

namespace {

InputEvent key(InputEvent::Type type, int vk, bool resync = false)
{
    InputEvent e;
    e.type = type;
    e.keyCode = static_cast<int16_t>(vk);
    e.resync = resync;
    return e;
}

InputEvent button(InputEvent::Type type, int b, bool resync = false)
{
    InputEvent e;
    e.type = type;
    e.button = b;
    e.resync = resync;
    return e;
}

InputEvent pad(int number, int32_t buttons, uint8_t left = 0, uint8_t right = 0)
{
    InputEvent e;
    e.type = InputEvent::Type::ControllerState;
    e.controllerNumber = static_cast<uint8_t>(number);
    e.buttonFlags = buttons;
    e.leftTrigger = left;
    e.rightTrigger = right;
    return e;
}

/// A present every 1/240 s, the loop waking 100 µs after each, as on the
/// product's virtual display. A press at each of @p presses (µs), noted as the
/// session does when its SendInput begins. Returns, per present, the verdict:
/// 0 skipped, 1 the grid's, 2 the window's.
struct Run
{
    std::vector<int64_t> present;
    std::vector<int> verdict;
    int grid = 0;
    int window = 0;
};

Run run(InputAdmit& admit, int fps, const std::vector<int64_t>& presses, double seconds,
        bool linkOk = true, bool encoderOk = true, int64_t gapUs = 0, double displayHz = 240)
{
    FrameCadence gate(fps, static_cast<int>(displayHz));
    Run r;
    size_t next = 0;
    const double step = 1e6 / displayHz;
    for (double t = 1000; t < seconds * 1e6; t += step) {
        const auto presentUs = static_cast<int64_t>(t);
        const int64_t wakeUs = presentUs + 100;
        while (next < presses.size() && presses[next] <= wakeUs)
            admit.notePress(presses[next++]);
        const bool grid = gate.admit(wakeUs);
        const InputAdmit::Verdict v =
            admit.admit(grid, presentUs, wakeUs, gapUs, linkOk, encoderOk);
        int kind = 0;
        if (v == InputAdmit::Verdict::Grid) kind = 1;
        if (v == InputAdmit::Verdict::Window) kind = 2;
        r.present.push_back(presentUs);
        r.verdict.push_back(kind);
        if (kind == 1) r.grid++;
        if (kind == 2) r.window++;
    }
    return r;
}

/// Armed as the session arms it, for a stream at @p intervalUs.
void arm(InputAdmit& a, int64_t intervalUs = 16666, InputAdmit::Settings s = {})
{
    a.configure(s, intervalUs);
}

/// The first present admitted at or after @p fromUs.
int64_t firstAdmitted(const Run& r, int64_t fromUs)
{
    for (size_t i = 0; i < r.present.size(); ++i)
        if (r.present[i] >= fromUs && r.verdict[i] != 0) return r.present[i];
    return -1;
}

int64_t firstPresent(const Run& r, int64_t fromUs)
{
    for (int64_t p : r.present)
        if (p >= fromUs) return p;
    return -1;
}

} // namespace

void run_input_admit_tests()
{
    SECTION("PressFilter — a key goes down once; the browser's repeats are no press");
    {
        PressFilter f;
        CHECK(f.isPress(key(InputEvent::Type::KeyDown, 0x57)));
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 0x57)));
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 0x57)));
        CHECK(!f.isPress(key(InputEvent::Type::KeyUp, 0x57)));
        CHECK(f.isPress(key(InputEvent::Type::KeyDown, 0x57)));
        // Another key, held with the first: a press of its own.
        CHECK(f.isPress(key(InputEvent::Type::KeyDown, 0x41)));
        // Out of range: nothing.
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 0)));
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 300)));
    }

    SECTION("PressFilter — the heartbeat's re-presses are never a press");
    {
        PressFilter f;
        // A stall made the host let go; the heartbeat presses it again. Held
        // from now on, so the browser's next repeat is no press either.
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 0x44, true)));
        CHECK(!f.isPress(key(InputEvent::Type::KeyDown, 0x44)));
        CHECK(!f.isPress(button(InputEvent::Type::MouseButtonDown, 1, true)));
        CHECK(!f.isPress(button(InputEvent::Type::MouseButtonDown, 1)));
        CHECK(!f.isPress(button(InputEvent::Type::MouseButtonUp, 1)));
        CHECK(f.isPress(button(InputEvent::Type::MouseButtonDown, 1)));
        InputEvent held = pad(0, 0x1000);
        held.resync = true;
        CHECK(!f.isPress(held));
    }

    SECTION("PressFilter — mouse buttons, characters, text");
    {
        PressFilter f;
        CHECK(f.isPress(button(InputEvent::Type::MouseButtonDown, 1)));
        CHECK(!f.isPress(button(InputEvent::Type::MouseButtonDown, 1)));
        CHECK(f.isPress(button(InputEvent::Type::MouseButtonDown, 3)));
        CHECK(!f.isPress(button(InputEvent::Type::MouseButtonDown, 0)));

        InputEvent c;
        c.type = InputEvent::Type::CharDown;
        c.text = "é";
        CHECK(f.isPress(c));
        CHECK(!f.isPress(c));
        c.type = InputEvent::Type::CharUp;
        CHECK(!f.isPress(c));
        c.type = InputEvent::Type::CharDown;
        CHECK(f.isPress(c));

        InputEvent text;
        text.type = InputEvent::Type::Utf8Text;
        text.text = "bonjour";
        CHECK(f.isPress(text));
        text.text.clear();
        CHECK(!f.isPress(text));
    }

    SECTION("PressFilter — motion, the wheel, the sticks and releases are no press");
    {
        PressFilter f;
        for (InputEvent::Type t :
             {InputEvent::Type::MouseMoveRelative, InputEvent::Type::MouseMoveAbsolute,
              InputEvent::Type::MouseScrollVertical, InputEvent::Type::MouseScrollHorizontal,
              InputEvent::Type::KeyUp, InputEvent::Type::MouseButtonUp,
              InputEvent::Type::LockKeySync, InputEvent::Type::SecureAttention}) {
            InputEvent e;
            e.type = t;
            e.keyCode = 0x41;
            e.button = 1;
            e.deltaX = 4;
            e.scrollAmount = 120;
            CHECK(!f.isPress(e));
        }
        InputEvent stick = pad(0, 0);
        stick.leftStickX = 30000;
        stick.rightStickY = -30000;
        CHECK(!f.isPress(stick));
    }

    SECTION("PressFilter — a pad: a button that goes down, a trigger past a quarter");
    {
        PressFilter f;
        CHECK(f.isPress(pad(0, 0x1000)));          // A
        CHECK(!f.isPress(pad(0, 0x1000)));         // the same state again
        CHECK(f.isPress(pad(0, 0x1000 | 0x2000))); // B, A still held
        CHECK(!f.isPress(pad(0, 0x2000)));         // A let go
        CHECK(!f.isPress(pad(0, 0x2000, 30)));     // a trigger touched
        CHECK(f.isPress(pad(0, 0x2000, 80)));      // and pulled
        CHECK(!f.isPress(pad(0, 0x2000, 255)));
        CHECK(!f.isPress(pad(0, 0x2000, 10)));
        CHECK(f.isPress(pad(0, 0x2000, 10, 200))); // the other one
        // Each pad its own: the second pad's A is a press.
        CHECK(f.isPress(pad(1, 0x1000)));
        CHECK(!f.isPress(pad(PressFilter::kPads, 0x1000)));
        // A pad that comes again starts from nothing held.
        InputEvent gone = pad(1, 0);
        gone.type = InputEvent::Type::ControllerRemoval;
        CHECK(!f.isPress(gone));
        CHECK(f.isPress(pad(1, 0x1000)));
    }

    SECTION("InputAdmit — with no press, exactly the gate's pictures");
    {
        InputAdmit a;
        arm(a);
        FrameCadence gate(60, 240);
        Run r = run(a, 60, {}, 5.0);
        int gateOnly = 0;
        for (size_t i = 0; i < r.present.size(); ++i) {
            const bool g = gate.admit(r.present[i] + 100);
            gateOnly += g;
            CHECK_EQ(r.verdict[i] != 0, g);
        }
        CHECK_EQ(r.grid, gateOnly);
        CHECK_EQ(r.window, 0);
        CHECK_EQ(a.windows(), int64_t(0));
    }

    SECTION("InputAdmit — a press: every present of its window, three at most, the grid untouched");
    {
        InputAdmit a;
        arm(a);
        InputAdmit none;
        arm(none);
        const int64_t press = 1003210;
        Run r = run(a, 60, {press}, 2.0);
        Run base = run(none, 60, {}, 2.0);
        // The grid's own pictures are the same ones, with the window or without.
        for (size_t i = 0; i < r.present.size(); ++i)
            CHECK_EQ(r.verdict[i] == 1, base.verdict[i] == 1);
        // The window's: presents made after the press, within its 33 ms, the
        // first three the gate skipped.
        CHECK_EQ(r.window, 3);
        CHECK_EQ(a.frames(), int64_t(3));
        CHECK_EQ(a.windows(), int64_t(1));
        int counted = 0;
        for (size_t i = 0; i < r.present.size(); ++i) {
            if (r.verdict[i] != 2) continue;
            CHECK(r.present[i] >= press);
            CHECK(r.present[i] < press + InputAdmit::kWindowUs);
            counted++;
        }
        CHECK_EQ(counted, 3);
        // Every present after the press goes until the cap: a picture drawn
        // 1 to 12 ms after it waits for nothing.
        for (int64_t react : {1000, 4000, 8000, 12000})
            CHECK_EQ(firstAdmitted(r, firstPresent(r, press + react)),
                     firstPresent(r, press + react));
        CHECK(a.capped() > 0);
    }

    SECTION("InputAdmit — a picture composed before the press does not carry it");
    {
        InputAdmit a;
        arm(a);
        a.notePress(20000);
        // The loop takes, a millisecond after the press, a present composed a
        // millisecond before it: no. The next one, composed after it: yes.
        CHECK(a.admit(false, 19000, 21000, 0, true, true) == InputAdmit::Verdict::Skip);
        CHECK(a.admit(false, 20500, 21100, 0, true, true) == InputAdmit::Verdict::Window);
        CHECK_EQ(a.windows(), int64_t(1));
    }

    SECTION("InputAdmit — presses taken together, a press inside a window carries it on");
    {
        InputAdmit a;
        arm(a);
        // Two presses between two calls of the loop: one window, from the
        // first to 33 ms after the second.
        a.notePress(100000);
        a.notePress(102000);
        CHECK(a.admit(false, 103000, 103100, 0, true, true) == InputAdmit::Verdict::Window);
        CHECK_EQ(a.windows(), int64_t(1));
        CHECK_EQ(a.presses(), int64_t(2));
        CHECK(a.admit(false, 134500, 134600, 0, true, true) == InputAdmit::Verdict::Window);
        // A press inside the window: carried on, no token.
        a.notePress(130000);
        CHECK(a.admit(false, 138000, 138100, 0, true, true) == InputAdmit::Verdict::Window);
        CHECK_EQ(a.windows(), int64_t(1));
        CHECK_EQ(a.carried(), int64_t(1));
        // The cap holds over the window carried on: a fourth is refused.
        CHECK(a.admit(false, 150000, 150100, 0, true, true) == InputAdmit::Verdict::Skip);
        CHECK_EQ(a.frames(), int64_t(3));
        // The window ends 33 ms after the last press.
        CHECK(a.admit(false, 163100, 163200, 0, true, true) == InputAdmit::Verdict::Skip);
    }

    SECTION("InputAdmit — a press the loop takes after its window opens nothing");
    {
        InputAdmit a;
        arm(a);
        a.notePress(100000);
        CHECK(a.admit(false, 140000, 140100, 0, true, true) == InputAdmit::Verdict::Skip);
        CHECK_EQ(a.windows(), int64_t(0));
        CHECK_EQ(a.late(), int64_t(1));
        // The token is still there: three windows in a row.
        for (int i = 0; i < 3; ++i) {
            a.notePress(200000 + i * 100000);
            CHECK(a.admit(false, 201000 + i * 100000, 201100 + i * 100000, 0, true, true) ==
                  InputAdmit::Verdict::Window);
        }
        CHECK_EQ(a.windows(), int64_t(3));
    }

    SECTION("InputAdmit — the bucket holds under a stream of presses; the refused wait no longer");
    {
        InputAdmit a;
        arm(a);
        InputAdmit none;
        arm(none);
        std::vector<int64_t> presses;
        for (int64_t t = 500000; t < 10500000; t += 33333)
            presses.push_back(t); // 30 a second for 10 s
        Run r = run(a, 60, presses, 11.0);
        Run base = run(none, 60, {}, 11.0);
        // Three ahead and two a second: 23 windows in 10 s at most, three
        // pictures each.
        CHECK(a.windows() <= 3 + 20 + 1);
        CHECK(a.windows() >= 20);
        CHECK(a.refused() > 250);
        CHECK(r.window <= 3 * static_cast<int>(a.windows()));
        CHECK_EQ(r.grid, base.grid);
        // Every press: never later than the gate alone would have carried it.
        for (int64_t t : presses) {
            const int64_t p = firstPresent(r, t + 10000);
            CHECK(firstAdmitted(r, p) <= firstAdmitted(base, p));
        }
    }

    SECTION("InputAdmit — the link and the encoder's guards");
    {
        InputAdmit link;
        arm(link);
        Run r = run(link, 60, {500000, 1500000}, 2.0, false, true);
        CHECK_EQ(r.window, 0);
        CHECK(link.linkRefused() > 0);
        InputAdmit enc;
        arm(enc);
        r = run(enc, 60, {500000, 1500000}, 2.0, true, false);
        CHECK_EQ(r.window, 0);
        CHECK(enc.encoderRefused() > 0);
    }

    SECTION("InputAdmit — the gap: half an interval for a client at 60 Hz on its vsync");
    {
        InputAdmit a;
        arm(a);
        CHECK_EQ(a.gapFor(60000, true, 16666), int64_t(8333));
        CHECK_EQ(a.gapFor(59940, true, 16666), int64_t(8333));
        CHECK_EQ(a.gapFor(100000, true, 16666), int64_t(8333));
        CHECK_EQ(a.gapFor(120000, true, 16666), int64_t(0)); // twice the rate
        CHECK_EQ(a.gapFor(144000, true, 16666), int64_t(0));
        CHECK_EQ(a.gapFor(60000, false, 16666), int64_t(0)); // it tears
        CHECK_EQ(a.gapFor(0, true, 16666), int64_t(0));      // not said
        CHECK_EQ(a.gapFor(120000, true, 8333), int64_t(4166));
        InputAdmit::Settings s;
        s.gapUs = 5000;
        InputAdmit set;
        arm(set, 16666, s);
        CHECK_EQ(set.gapFor(144000, false, 16666), int64_t(5000));

        // With it, no two pictures closer than the gap.
        InputAdmit g;
        arm(g);
        Run r = run(g, 60, {500000, 1500000, 2500000}, 3.0, true, true, 8333);
        int64_t last = -1000000;
        for (size_t i = 0; i < r.present.size(); ++i) {
            if (r.verdict[i] != 2) {
                if (r.verdict[i] == 1) last = r.present[i];
                continue;
            }
            CHECK(r.present[i] - last >= 8333 - 1);
            last = r.present[i];
        }
        CHECK(g.gapped() > 0);
        CHECK(r.window > 0);
    }

    SECTION("InputAdmit — never shorter than the stream's interval; the settings");
    {
        InputAdmit::Settings s;
        s.windowUs = 8000;
        InputAdmit a;
        arm(a, 16666, s);
        CHECK_EQ(a.windowUs(), int64_t(16666));
        a.setIntervalUs(8333);
        CHECK_EQ(a.windowUs(), int64_t(8333));
        a.setIntervalUs(4166);
        CHECK_EQ(a.windowUs(), int64_t(8000));
        InputAdmit d;
        arm(d, 16666);
        CHECK_EQ(d.windowUs(), InputAdmit::kWindowUs);
        CHECK_EQ(d.maxExtra(), InputAdmit::kMaxExtra);
        s = InputAdmit::Settings{};
        s.maxExtra = 1;
        s.burst = 1;
        s.perSecond = 0.5;
        InputAdmit one;
        arm(one, 16666, s);
        Run r = run(one, 60, {500000, 1000000, 3500000}, 4.0);
        // One window ahead, half a window a second: the press at 1 s waits.
        CHECK_EQ(one.windows(), int64_t(2));
        CHECK_EQ(one.refused(), int64_t(1));
        CHECK_EQ(r.window, 2);
    }

    SECTION("InputAdmit — at 120 fps the window still carries a reaction of 12 ms");
    {
        InputAdmit a;
        arm(a, 8333);
        Run r = run(a, 120, {700000}, 1.5);
        for (int64_t react : {1000, 6000, 12000})
            CHECK_EQ(firstAdmitted(r, firstPresent(r, 700000 + react)),
                     firstPresent(r, 700000 + react));
        CHECK(r.window <= 3);
    }

    SECTION("InputAdmit — the product's client: real tearing, not on its vsync");
    {
        // The product (-1): Chromium on Windows that tears, and nothing else.
        CHECK(InputAdmit::forClient(-1, true, false));
        CHECK(!InputAdmit::forClient(-1, true, true));
        CHECK(!InputAdmit::forClient(-1, false, false));
        CHECK(!InputAdmit::forClient(-1, false, true));
        // The bench's keys: every client, or none.
        for (bool real : {false, true})
            for (bool vsync : {false, true}) {
                CHECK(InputAdmit::forClient(1, real, vsync));
                CHECK(!InputAdmit::forClient(0, real, vsync));
            }
    }
}
