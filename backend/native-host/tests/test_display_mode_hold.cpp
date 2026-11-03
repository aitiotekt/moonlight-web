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

#include "native_test_framework.h"

#include "platform/windows/DisplayModeHold.h"

#include <cctype>
#include <string>

using namespace mw::native::platform::modehold;

// Which session a display's "Match my screen" mode belongs to
// (DisplayModeHold.h). The N95 bench of 16/10/2026 is the case: a client
// relaunched, its new session found the display in its mode already, and the
// old session's end put the display's own mode back under the new stream.

namespace {

const std::string kOwnerVddPath =
    "\\\\?\\DISPLAY#MTT1337#1&15ecd195&0&UID256#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";

} // namespace

void run_display_mode_hold_tests()
{
    SECTION("Display mode hold — one name per display, any case, no backslash past Local\\");
    {
        const std::string name = objectName(kOwnerVddPath);
        const std::string prefix = "Local\\MoonlightWeb-ModeHold-";
        CHECK_EQ(name.compare(0, prefix.size(), prefix), 0);
        CHECK_EQ(name.size(), prefix.size() + 16);
        CHECK_EQ(name.find('\\', prefix.size()), std::string::npos);
        std::string upper = kOwnerVddPath;
        for (char& c : upper)
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        CHECK_EQ(objectName(upper), name);
        CHECK(objectName("\\\\.\\DISPLAY1") != name);
        CHECK(objectName("\\\\.\\DISPLAY1") != objectName("\\\\.\\DISPLAY2"));
    }

    SECTION("Display mode hold — a relaunch: the new session takes the mode over");
    {
        uint64_t slot = 0;
        // The old session (pid 100) puts the display in the client's mode.
        CHECK(!heldByAnother(slot, 0));
        const uint64_t old = claimed(slot, 100);
        slot = old;
        CHECK(holds(slot, old));
        CHECK_EQ(pidOf(slot), 100u);
        // The new one (pid 200) finds that mode, held by another: it sets it
        // again and claims it.
        CHECK(heldByAnother(slot, 0));
        const uint64_t next = claimed(slot, 200);
        slot = next;
        CHECK(holds(slot, next));
        // The old session's end: no longer the holder, it leaves the mode,
        // and its letting go changes nothing.
        CHECK(!holds(slot, old));
        CHECK_EQ(released(slot, old), slot);
        // The new session's end: the holder, it puts the display's own mode
        // back and lets go.
        CHECK_EQ(released(slot, next), 0u);
    }

    SECTION("Display mode hold — two sessions of one process are told apart");
    {
        const uint64_t first = claimed(0, 300);
        const uint64_t second = claimed(first, 300);
        CHECK(first != second);
        CHECK(!holds(second, first));
        CHECK(heldByAnother(first, 0));
        CHECK(!heldByAnother(first, first));
        // The generation wraps without ever making the word "nobody".
        CHECK(claimed(word(300, 0xffffffffu), 300) != 0u);
    }

    SECTION("Display mode hold — a mode in one word, and back");
    {
        const uint64_t m = mode(2560, 1440, 120, 32);
        CHECK_EQ(widthOf(m), 2560u);
        CHECK_EQ(heightOf(m), 1440u);
        CHECK_EQ(hzOf(m), 120u);
        CHECK_EQ(bitsPerPixelOf(m), 32u);
        CHECK_EQ(mode(0, 1440, 120, 32), 0u);
        CHECK_EQ(mode(70000, 1440, 120, 32), 0u);
    }

    SECTION("Display mode hold — the own mode: the first change's, through a takeover");
    {
        // The N95 of 16/10/2026: the owner's virtual display in 2560x1440 at
        // 120 Hz, Windows' registry mode 800x600 at 30 Hz while ours is on.
        const uint64_t own = mode(2560, 1440, 120, 32);
        const uint64_t registry = mode(800, 600, 30, 32);
        const uint64_t client = mode(1920, 1080, 120, 32);
        // The first session changes the display: its mode before is the own.
        uint64_t slot = 0, kept = 0;
        const uint64_t first = claimed(slot, 100);
        kept = ownAfterClaim(slot, kept, own);
        slot = first;
        CHECK_EQ(kept, own);
        // A relaunch to another size: the mode before is the first's client
        // mode, and the own one stays.
        const uint64_t second = claimed(slot, 200);
        kept = ownAfterClaim(slot, kept, client);
        slot = second;
        CHECK_EQ(kept, own);
        // A takeover keeps it too (no mode before).
        const uint64_t third = claimed(slot, 300);
        kept = ownAfterClaim(slot, kept, 0);
        slot = third;
        CHECK_EQ(kept, own);
        // An old session's end keeps it; the holder's end puts it back itself
        // — Windows' registry has 800x600 — and clears it.
        CHECK_EQ(ownAfterRelease(slot, kept, second), own);
        CHECK(putsOwnBackItself(kept, registry));
        CHECK_EQ(ownAfterRelease(slot, kept, third), 0u);
        CHECK_EQ(released(slot, third), 0u);
    }

    SECTION("Display mode hold — the registry's mode is the own one: Windows puts it back");
    {
        const uint64_t own = mode(1920, 1080, 60, 32);
        CHECK(!putsOwnBackItself(own, mode(1920, 1080, 60, 32)));
        CHECK(!putsOwnBackItself(own, mode(1920, 1080, 59, 32)));
        CHECK(putsOwnBackItself(own, mode(1920, 1080, 30, 32)));
        CHECK(putsOwnBackItself(own, mode(1280, 720, 60, 32)));
        // The registry unread, or the own mode unknown.
        CHECK(putsOwnBackItself(own, 0));
        CHECK(!putsOwnBackItself(0, mode(800, 600, 30, 32)));
    }

    SECTION("Display mode hold — the client's mode set again once the display is in another size");
    {
        // The N95 of 19/10/2026: Display 2 in the client's 1920x1080 at
        // 244 Hz, put back in 2560x1440 at 120 Hz by our virtual display
        // turning off under the stream.
        const uint64_t set = mode(1920, 1080, 244, 32);
        CHECK(setsClientModeAgain(set, mode(2560, 1440, 120, 32)));
        CHECK(setsClientModeAgain(set, mode(1920, 1200, 244, 32)));
        // The same size: the picture is still the client's, whatever the rate.
        CHECK(!setsClientModeAgain(set, mode(1920, 1080, 244, 32)));
        CHECK(!setsClientModeAgain(set, mode(1920, 1080, 120, 32)));
        // No mode set, or the display's unread.
        CHECK(!setsClientModeAgain(0, mode(2560, 1440, 120, 32)));
        CHECK(!setsClientModeAgain(set, 0));
    }

    SECTION("Display mode hold — nobody holds, or no claim made: nothing to keep");
    {
        CHECK(!holds(0, 0));
        CHECK(!heldByAnother(0, 0));
        CHECK_EQ(released(0, 0), 0u);
        CHECK_EQ(released(claimed(0, 7), 0), claimed(0, 7));
    }
}
