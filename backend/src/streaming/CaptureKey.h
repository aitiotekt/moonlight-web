/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#pragma once

#include <cctype>
#include <string>

/// `capture=` (plan « Gels du lien », route B, 22/10/2026): which capture a
/// native session is asked for, read by the server before it starts the
/// worker — the one key of the spec the launch depends on.
///
/// Windows.Graphics.Capture exists for no SYSTEM process: it rests on the
/// per-user CaptureService, which has no instance for SYSTEM's logon session.
/// The probe of 21/10/2026 saw its IsSupported fail with 0x80070424
/// (ERROR_SERVICE_DOES_NOT_EXIST) from a SYSTEM task started again in the
/// console session, the user's token impersonated or not (bench §8y.1). So
/// the worker asked for WGC is started on the user's token — the elevated
/// task, or a plain child — never through the launcher service, and the
/// secure desktop is out of its reach for that stream.
namespace mw::capturekey {

/// Whether @p spec (settings.json's native_tuning, or MW_NATIVE_TUNING) asks
/// for Windows.Graphics.Capture: its `capture=wgc` alone, items split on
/// commas or semicolons, the last one said winning, spaces and case ignored,
/// as in the native host's parser. The spec's other keys are the native
/// host's: one the server cannot read changes nothing here, and a value it
/// does not know asks for nothing.
inline bool asksWgc(const std::string& spec)
{
    auto trim = [](std::string s) {
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front())))
            s.erase(0, 1);
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
            s.pop_back();
        return s;
    };
    auto lower = [](std::string s) {
        for (char& c : s)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return s;
    };
    bool wgc = false;
    std::size_t at = 0;
    while (at <= spec.size()) {
        std::size_t end = spec.find_first_of(",;", at);
        if (end == std::string::npos) end = spec.size();
        const std::string item = spec.substr(at, end - at);
        const std::size_t eq = item.find('=');
        if (eq != std::string::npos && lower(trim(item.substr(0, eq))) == "capture") {
            const std::string value = lower(trim(item.substr(eq + 1)));
            if (value == "wgc")
                wgc = true;
            else if (value == "auto" || value == "dda")
                wgc = false;
        }
        at = end + 1;
    }
    return wgc;
}

} // namespace mw::capturekey
