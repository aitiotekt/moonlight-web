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

#include "network/LinkAddresses.h"

#include <QFile>
#include <QHostAddress>
#include <QSet>
#include <QUdpSocket>

#include <vector>

#ifdef Q_OS_WIN
#include <winsock2.h>
#include <iphlpapi.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#endif

namespace LinkAddresses {

namespace {

// The source address the OS would use to reach the internet: connecting a UDP
// socket runs the routing table without sending a packet.
QString defaultRouteAddress()
{
    QUdpSocket probe;
    probe.connectToHost(QHostAddress(QStringLiteral("8.8.8.8")), 53);
    const QHostAddress local = probe.localAddress();
    probe.close();
    return local.isNull() ? QString() : local.toString();
}

} // namespace

QList<Adapter> readAdapters()
{
    QList<Adapter> out;
    const QString defaultRoute = defaultRouteAddress();

#ifdef Q_OS_WIN
    // GAA_FLAG_INCLUDE_GATEWAYS fills FirstGatewayAddress, which is what tells
    // the real LAN apart from a host-only switch (isHostInternal()).
    const DWORD flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER |
                        GAA_FLAG_INCLUDE_GATEWAYS;
    ULONG buflen = 0;
    GetAdaptersAddresses(AF_INET, flags, nullptr, nullptr, &buflen);
    if (buflen == 0) return out;
    std::vector<unsigned char> buf(buflen);
    auto* list = reinterpret_cast<PIP_ADAPTER_ADDRESSES>(buf.data());
    if (GetAdaptersAddresses(AF_INET, flags, nullptr, list, &buflen) != ERROR_SUCCESS) return out;

    for (PIP_ADAPTER_ADDRESSES aa = list; aa; aa = aa->Next) {
        if (aa->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
        if (aa->OperStatus != IfOperStatusUp) continue;
        for (PIP_ADAPTER_UNICAST_ADDRESS ua = aa->FirstUnicastAddress; ua; ua = ua->Next) {
            if (ua->Address.lpSockaddr->sa_family != AF_INET) continue;
            char ipBuf[INET_ADDRSTRLEN] = {};
            auto* sa = reinterpret_cast<sockaddr_in*>(ua->Address.lpSockaddr);
            if (!inet_ntop(AF_INET, &sa->sin_addr, ipBuf, sizeof(ipBuf))) continue;
            Adapter a;
            a.name = QString::fromWCharArray(aa->FriendlyName);
            a.description = QString::fromWCharArray(aa->Description);
            a.ip = QString::fromLatin1(ipBuf);
            a.hasGateway = aa->FirstGatewayAddress != nullptr;
            a.isDefaultRoute = a.ip == defaultRoute;
            a.metric = static_cast<quint32>(aa->Ipv4Metric);
            out.append(a);
        }
    }
#else
    // Linux lists a 0.0.0.0 destination in /proc/net/route for every interface
    // that carries a default route. macOS has no such file: there only the
    // default-route address ranks the LAN first.
    QSet<QString> gatewayIfaces;
    QFile routes(QStringLiteral("/proc/net/route"));
    if (routes.open(QIODevice::ReadOnly | QIODevice::Text)) {
        while (!routes.atEnd()) {
            const QList<QByteArray> fields = routes.readLine().simplified().split(' ');
            if (fields.size() >= 3 && fields[1] == "00000000")
                gatewayIfaces.insert(QString::fromLatin1(fields[0]));
        }
    }

    struct ifaddrs* ifaddr = nullptr;
    if (getifaddrs(&ifaddr) == -1) return out;
    for (struct ifaddrs* ifa = ifaddr; ifa; ifa = ifa->ifa_next) {
        if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
        if (ifa->ifa_flags & IFF_LOOPBACK) continue;
        if (!(ifa->ifa_flags & IFF_UP) || !(ifa->ifa_flags & IFF_RUNNING)) continue;
        char ipBuf[INET_ADDRSTRLEN] = {};
        auto* sa = reinterpret_cast<struct sockaddr_in*>(ifa->ifa_addr);
        if (!inet_ntop(AF_INET, &sa->sin_addr, ipBuf, sizeof(ipBuf))) continue;
        Adapter a;
        a.name = QString::fromLocal8Bit(ifa->ifa_name);
        a.ip = QString::fromLatin1(ipBuf);
        a.hasGateway = gatewayIfaces.contains(a.name);
        a.isDefaultRoute = a.ip == defaultRoute;
        out.append(a);
    }
    freeifaddrs(ifaddr);
#endif
    return out;
}

} // namespace LinkAddresses
