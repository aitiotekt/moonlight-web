/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
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
#include <string_view>

/// The debug switch "debug_ice_drop_udp" (AppSettings::debugIceDropUdp): a bench
/// that has to prove passive ICE-TCP from a network that does let UDP out.
///
/// Neither end may then learn a UDP address from the other. Our UDP candidates
/// are kept from the browser, the browser's from our agent, in both the
/// trickled lines and the descriptions, so that the only pair left to form is
/// the browser dialling our passive TCP candidate (docs/design/ice-tcp-passive.md).
namespace mw::ice {

/// Whether an ICE candidate line, bare ("candidate:…") or an SDP attribute
/// ("a=candidate:…"), is over UDP: its third field, in any case.
inline bool isUdpCandidate(std::string_view line)
{
    if (line.substr(0, 2) == "a=") line.remove_prefix(2);
    if (line.substr(0, 10) != "candidate:") return false;
    size_t pos = 0;
    for (int field = 0; field < 2; ++field) {
        pos = line.find(' ', pos);
        if (pos == std::string_view::npos) return false;
        ++pos;
    }
    const size_t end = line.find(' ', pos);
    const std::string_view transport =
        line.substr(pos, end == std::string_view::npos ? std::string_view::npos : end - pos);
    if (transport.size() != 3) return false;
    for (size_t i = 0; i < 3; ++i)
        if (std::tolower(static_cast<unsigned char>(transport[i])) != "udp"[i]) return false;
    return true;
}

/// The same description without its UDP candidate lines; every other line, and
/// its line ending, as it was.
inline std::string stripUdpCandidates(const std::string& sdp)
{
    std::string out;
    out.reserve(sdp.size());
    size_t start = 0;
    while (start < sdp.size()) {
        size_t next = sdp.find('\n', start);
        next = next == std::string::npos ? sdp.size() : next + 1;
        const std::string_view line(sdp.data() + start, next - start);
        if (!isUdpCandidate(line)) out.append(line);
        start = next;
    }
    return out;
}

} // namespace mw::ice
