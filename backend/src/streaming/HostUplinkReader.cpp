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

#include "HostUplinkReader.h"

#include <cstring>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef __APPLE__
#include <net/if_var.h> // struct if_data
#else
#include <fstream>
#endif
#endif

namespace mw::hostuplink {
namespace {

#ifdef _WIN32
using Socket = SOCKET;
using SockLen = int;
const Socket kNoSocket = INVALID_SOCKET;
void closeSocket(Socket s)
{
    closesocket(s);
}

/// getaddrinfo and socket want Winsock up; the server has it, a test may not.
/// WSAStartup counts its callers, so one more pair is harmless.
struct WinsockScope
{
    bool ok = false;
    WinsockScope()
    {
        WSADATA data;
        ok = WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }
    ~WinsockScope()
    {
        if (ok) WSACleanup();
    }
};

std::string narrow(const wchar_t* w)
{
    if (!w || !*w) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string out(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
    return out;
}
#else
using Socket = int;
using SockLen = socklen_t;
const Socket kNoSocket = -1;
void closeSocket(Socket s)
{
    close(s);
}
#endif

/// The local address the route to @p remote sends from. connect() on a UDP
/// socket only picks the route: nothing goes on the wire.
bool localAddressTowards(const std::string& remote, sockaddr_storage* local)
{
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_flags = AI_NUMERICHOST;
    addrinfo* res = nullptr;
    if (getaddrinfo(remote.c_str(), "9", &hints, &res) != 0 || !res) return false;
    bool ok = false;
    const Socket s = socket(res->ai_family, SOCK_DGRAM, IPPROTO_UDP);
    if (s != kNoSocket) {
        if (connect(s, res->ai_addr, static_cast<SockLen>(res->ai_addrlen)) == 0) {
            SockLen len = sizeof(*local);
            ok = getsockname(s, reinterpret_cast<sockaddr*>(local), &len) == 0;
        }
        closeSocket(s);
    }
    freeaddrinfo(res);
    return ok;
}

bool sameAddress(const sockaddr* a, const sockaddr_storage& b)
{
    if (!a || a->sa_family != b.ss_family) return false;
    if (a->sa_family == AF_INET) {
        return std::memcmp(&reinterpret_cast<const sockaddr_in*>(a)->sin_addr,
                           &reinterpret_cast<const sockaddr_in*>(&b)->sin_addr,
                           sizeof(in_addr)) == 0;
    }
    if (a->sa_family == AF_INET6) {
        return std::memcmp(&reinterpret_cast<const sockaddr_in6*>(a)->sin6_addr,
                           &reinterpret_cast<const sockaddr_in6*>(&b)->sin6_addr,
                           sizeof(in6_addr)) == 0;
    }
    return false;
}

} // namespace

#ifdef _WIN32

Adapter adapterTowards(const std::string& remote)
{
    WinsockScope wsa;
    if (!wsa.ok) return {};
    sockaddr_storage local{};
    if (!localAddressTowards(remote, &local)) return {};

    const ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    ULONG len = 16 * 1024;
    std::vector<unsigned char> buf;
    ULONG ret = ERROR_BUFFER_OVERFLOW;
    for (int attempt = 0; attempt < 3 && ret == ERROR_BUFFER_OVERFLOW; ++attempt) {
        buf.resize(len);
        ret = GetAdaptersAddresses(local.ss_family, flags, nullptr,
                                   reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()), &len);
    }
    if (ret != NO_ERROR) return {};
    for (auto* aa = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data()); aa; aa = aa->Next) {
        for (auto* ua = aa->FirstUnicastAddress; ua; ua = ua->Next) {
            if (!sameAddress(ua->Address.lpSockaddr, local)) continue;
            Adapter a;
            a.name = narrow(aa->FriendlyName);
            if (a.name.empty()) a.name = aa->AdapterName ? aa->AdapterName : "?";
            a.luid = aa->Luid.Value;
            a.bits = 64;
            return a;
        }
    }
    return {};
}

std::optional<uint64_t> sentBytes(const Adapter& adapter)
{
    if (!adapter.valid()) return std::nullopt;
    MIB_IF_ROW2 row{};
    row.InterfaceLuid.Value = adapter.luid;
    if (GetIfEntry2(&row) != NO_ERROR) return std::nullopt;
    return static_cast<uint64_t>(row.OutOctets);
}

#else

Adapter adapterTowards(const std::string& remote)
{
    sockaddr_storage local{};
    if (!localAddressTowards(remote, &local)) return {};
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0) return {};
    Adapter a;
    for (ifaddrs* ifa = list; ifa; ifa = ifa->ifa_next) {
        if (!ifa->ifa_name || !sameAddress(ifa->ifa_addr, local)) continue;
        a.name = ifa->ifa_name;
        a.sysName = ifa->ifa_name;
#ifdef __APPLE__
        a.bits = 32; // if_data's ifi_obytes
#else
        a.bits = 64;
#endif
        break;
    }
    freeifaddrs(list);
    return a;
}

std::optional<uint64_t> sentBytes(const Adapter& adapter)
{
    if (!adapter.valid() || adapter.sysName.empty()) return std::nullopt;
#ifdef __APPLE__
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0) return std::nullopt;
    std::optional<uint64_t> out;
    for (ifaddrs* ifa = list; ifa; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_LINK || !ifa->ifa_data) continue;
        if (!ifa->ifa_name || adapter.sysName != ifa->ifa_name) continue;
        out = static_cast<uint64_t>(static_cast<const struct if_data*>(ifa->ifa_data)->ifi_obytes);
        break;
    }
    freeifaddrs(list);
    return out;
#else
    // 64-bit, unlike the rtnl_link_stats getifaddrs hands out.
    if (adapter.sysName.find('/') != std::string::npos) return std::nullopt;
    std::ifstream f("/sys/class/net/" + adapter.sysName + "/statistics/tx_bytes");
    uint64_t v = 0;
    if (!(f >> v)) return std::nullopt;
    return v;
#endif
}

#endif

} // namespace mw::hostuplink
