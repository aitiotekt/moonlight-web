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

#include "capture/windows/OutputMatch.h"

#include <cctype>
#include <string>
#include <vector>

using namespace mw::native::capture;

// Which output of its adapter a session's display is after Windows renumbered
// them (OutputMatch.h). The N95 bench of 16/10/2026 is the first case: the
// virtual display turned primary took index 0, and the Mac's stream of
// Display 1 must follow Display 1 to index 1, not stay on index 0.

namespace {

const std::string kDisplay1Path =
    "\\\\?\\DISPLAY#MS_0001#5&2f3d4c1&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";
const std::string kVirtualPath =
    "\\\\?\\DISPLAY#MTT1337#1&15ecd195&0&UID256#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";

OutputIdentity output(const char* gdiName, std::vector<std::string> paths)
{
    OutputIdentity o;
    o.gdiName = gdiName;
    o.monitorPaths = std::move(paths);
    return o;
}

} // namespace

void run_output_match_tests()
{
    SECTION("Output match — the display, not its place among the outputs");

    // Before the iPhone: Display 1 alone, primary, at index 0.
    {
        const std::vector<OutputIdentity> outputs = {output("\\\\.\\DISPLAY1", {kDisplay1Path})};
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 0);
    }

    // The virtual display made primary is listed first: Display 1 is at 1 now.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY9", {kVirtualPath}),
            output("\\\\.\\DISPLAY1", {kDisplay1Path}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
        // And the iPhone's own stream, on the virtual display, stays at 0.
        CHECK_EQ(outputIndexOf(outputs, kVirtualPath, "\\\\.\\DISPLAY9"), 0);
    }

    // The path holds even if the GDI name passed to another monitor: the
    // name is not taken where a path says otherwise.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY1", {kVirtualPath}),
            output("\\\\.\\DISPLAY2", {kDisplay1Path}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
    }

    // Gone: no output carries the path. Not the output that has its old name.
    {
        const std::vector<OutputIdentity> outputs = {output("\\\\.\\DISPLAY1", {kVirtualPath})};
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), -1);
        CHECK_EQ(outputIndexOf({}, kDisplay1Path, "\\\\.\\DISPLAY1"), -1);
    }

    // Windows spells paths in either case.
    {
        std::string upper = kDisplay1Path;
        for (char& c : upper)
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY9", {kVirtualPath}),
            output("\\\\.\\DISPLAY1", {upper}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
    }

    // A clone group: one output, two monitors. Either one names it.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY9", {kVirtualPath}),
            output("\\\\.\\DISPLAY1", {"\\\\?\\DISPLAY#GSM5B7F#other", kDisplay1Path}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
    }

    // The probe had no path: the key is the GDI name, and the name decides.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY9", {kVirtualPath}),
            output("\\\\.\\DISPLAY1", {}),
        };
        CHECK_EQ(outputIndexOf(outputs, "\\\\.\\DISPLAY1", "\\\\.\\DISPLAY1"), 1);
        CHECK_EQ(outputIndexOf(outputs, "\\\\.\\display1", "\\\\.\\DISPLAY1"), 1);
    }

    // QueryDisplayConfig said nothing this time: the GDI name stands in.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY9", {}),
            output("\\\\.\\DISPLAY1", {}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
    }

    // A path beats a name: the output with the path wins over an earlier one
    // that only shares the name.
    {
        const std::vector<OutputIdentity> outputs = {
            output("\\\\.\\DISPLAY1", {}),
            output("\\\\.\\DISPLAY3", {kDisplay1Path}),
        };
        CHECK_EQ(outputIndexOf(outputs, kDisplay1Path, "\\\\.\\DISPLAY1"), 1);
    }

    // Nothing to go by at all.
    {
        const std::vector<OutputIdentity> outputs = {output("\\\\.\\DISPLAY1", {})};
        CHECK_EQ(outputIndexOf(outputs, "", ""), -1);
    }
}
