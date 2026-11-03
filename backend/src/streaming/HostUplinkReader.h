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

#include <cstdint>
#include <optional>
#include <string>

// The adapter a stream leaves by, and its sent-bytes counter (HostUplink.h).
//
// The adapter is the one the route to the client's address takes: a UDP
// socket connected to that address (connect() on UDP sends nothing) names the
// local address the system would send from, and the adapter that owns it is
// the one. For a client on the LAN that is the LAN adapter; for one across the
// Internet, the adapter of the default route. On DualRTX it is
// "vEthernet (LAN)", the Hyper-V switch's host adapter: it counts the host's
// own traffic, not its VMs'.
//
// Read-only, no elevation: GetAdaptersAddresses and GetIfEntry2 on Windows,
// getifaddrs plus /sys/class/net on Linux, getifaddrs' link data on macOS
// (32-bit counters there, see counterDelta).
namespace mw::hostuplink {

struct Adapter
{
    /// For the log: the friendly name on Windows, the interface name elsewhere.
    std::string name;
    /// The interface name (Linux, macOS) the counter is read by.
    std::string sysName;
    /// The interface LUID (Windows) the counter is read by.
    uint64_t luid = 0;
    /// The counter's width.
    unsigned bits = 64;

    bool valid() const { return !name.empty(); }
};

/// The adapter the route to @p remote (an IPv4 or IPv6 literal) leaves by;
/// invalid when there is no route, the address does not parse, or no adapter
/// owns the local address.
Adapter adapterTowards(const std::string& remote);

/// The adapter's sent-bytes counter now; nullopt when it cannot be read.
std::optional<uint64_t> sentBytes(const Adapter& adapter);

} // namespace mw::hostuplink
