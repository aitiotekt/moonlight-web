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

#include "server/NetClassify.h"

#include <QList>
#include <QRegularExpression>
#include <QString>
#include <QUrl>

#include <algorithm>
#include <optional>

/// The addresses a guest link can carry, as the sharing board offers them.
///
/// Automatic is the rendezvous link when this machine has a line out. Without
/// one it is the owner's own domain when settings.json names one, then the
/// address the owner opened the board on, then the LAN address. The owner can
/// also pin a link to that domain, to the LAN, to Tailscale or to any other
/// network this PC sits on: a guest of the house, a friend on the owner's
/// tailnet, with internet access left off.
///
/// What is never offered is a network that exists only inside this PC: the
/// switches Hyper-V, WSL, VirtualBox, VMware, Docker and libvirt create between
/// the machine and its own guests. No other device can reach them, so a link
/// carrying one fails for every guest.
///
/// The choice logic is pure, over a list of adapters read elsewhere
/// (readAdapters()), so it is tested without the machine's own cards.
namespace LinkAddresses {

/// One IPv4 address of one up adapter.
struct Adapter
{
    QString name;        ///< Friendly name ("Ethernet", "Tailscale", "eth0").
    QString description; ///< Windows' adapter description; empty elsewhere.
    QString ip;
    bool hasGateway = false;     ///< The adapter carries a default gateway.
    bool isDefaultRoute = false; ///< The source address the OS picks for the internet.
    quint32 metric = 0;          ///< Windows interface metric, lower first.
};

enum class Kind
{
    Lan,       ///< The house network: the address a guest of the LAN reaches.
    Tailscale, ///< A mesh VPN address (100.64.0.0/10).
    Other,     ///< Any other network a guest could reach (VPN, second card).
    Domain,    ///< The owner's own name (settings.json "domain"), served on 443.
};

struct Choice
{
    QString id; ///< "domain", "lan", "tailscale" or "iface:<adapter name>".
    Kind kind = Kind::Other;
    QString address;
    QString adapter;
};

inline const char* kindName(Kind k)
{
    switch (k) {
    case Kind::Lan: return "lan";
    case Kind::Tailscale: return "tailscale";
    case Kind::Other: return "other";
    case Kind::Domain: return "domain";
    }
    return "other";
}

/// A network that lives inside this PC. Only an adapter without a gateway can
/// be one: Hyper-V's external switch ("vEthernet (LAN)" on DualRTX) has the
/// same description as its Default Switch, and the gateway is what tells the
/// real LAN apart. A mesh VPN has no gateway either, and matches no name here.
inline bool isHostInternal(const Adapter& a)
{
    if (a.hasGateway) return false;
    static const QRegularExpression kInternal(
        QStringLiteral("Hyper-V Virtual Ethernet|Default Switch|\\bWSL\\b|VirtualBox Host-Only|"
                       "VMware Virtual Ethernet|VMnet|^docker|^br-|^veth|^virbr|^vboxnet|^vmnet|"
                       "^lxcbr|^lxdbr|^podman|^cni|^bridge\\d"),
        QRegularExpression::CaseInsensitiveOption);
    return kInternal.match(a.name).hasMatch() || kInternal.match(a.description).hasMatch();
}

/// Usable as a link at all: an IPv4 another machine could aim at.
inline bool isUsable(const Adapter& a)
{
    const QHostAddress addr(a.ip);
    if (addr.isNull() || addr.protocol() != QAbstractSocket::IPv4Protocol) return false;
    return !addr.isLoopback() && !addr.isLinkLocal() && addr.toIPv4Address() != 0;
}

/// The choices besides Automatic, LAN first, then Tailscale, then the rest.
///
/// The LAN is ranked like UPNPClient::getLocalIPs(): the default-route address
/// first, then an adapter that has a gateway, then the interface metric — but
/// a mesh VPN is never the LAN, even on a machine with no route out.
inline QList<Choice> choices(QList<Adapter> adapters)
{
    adapters.erase(
        std::remove_if(adapters.begin(), adapters.end(),
                       [](const Adapter& a) { return !isUsable(a) || isHostInternal(a); }),
        adapters.end());
    std::stable_sort(adapters.begin(), adapters.end(), [](const Adapter& a, const Adapter& b) {
        if (a.isDefaultRoute != b.isDefaultRoute) return a.isDefaultRoute;
        if (a.hasGateway != b.hasGateway) return a.hasGateway;
        return a.metric < b.metric;
    });

    QList<Choice> out;
    QList<Choice> others;
    bool haveLan = false;
    bool haveTailscale = false;
    for (const Adapter& a : adapters) {
        const bool tunnel = NetClassify::classify(a.ip) == NetClassify::Kind::Tunnel;
        if (tunnel && !haveTailscale) {
            haveTailscale = true;
            out.append({QStringLiteral("tailscale"), Kind::Tailscale, a.ip, a.name});
        } else if (!tunnel && !haveLan) {
            haveLan = true;
            out.prepend({QStringLiteral("lan"), Kind::Lan, a.ip, a.name});
        } else {
            const QString id = QStringLiteral("iface:") + a.name;
            const bool seen = std::any_of(others.begin(), others.end(),
                                          [&id](const Choice& c) { return c.id == id; });
            if (!seen) others.append({id, Kind::Other, a.ip, a.name});
        }
    }
    out.append(others);
    return out;
}

/// @p list with the owner's own domain ahead of the networks, when there is one.
/// Its address is the name alone: the forward to 443 is part of serving a
/// domain at all, so the link carries no port.
inline QList<Choice> withDomain(QList<Choice> list, const QString& domain)
{
    if (!domain.isEmpty()) list.prepend({QStringLiteral("domain"), Kind::Domain, domain, {}});
    return list;
}

/// Where a guest link built on the board's own address leads.
struct BoardOrigin
{
    QString origin; ///< "https://name[:port]", no trailing slash.
    QString reach;  ///< "lan", "tailscale", "other", or "direct" when nothing says.
};

/// The address the owner opened the board on, as a guest link could carry it,
/// or nothing when it is no use to a guest.
///
/// @p authority is the Host the owner's browser sent (or the one a reverse
/// proxy on this machine forwarded): a name the owner reached this PC under is
/// a name that leads to it. Never loopback, which leads every guest to their
/// own machine. An address of this PC is judged by the network it belongs to,
/// among @p list; a private one that is not there lives inside the PC (a
/// Hyper-V or WSL switch) or on another machine, and is dropped. A public one
/// came through a forward, like a name nothing more is known about: "direct",
/// for which the board claims nothing.
inline std::optional<BoardOrigin> boardOrigin(const QString& authority, const QList<Choice>& list)
{
    if (authority.isEmpty() || authority.contains(QLatin1Char('@')) ||
        authority.contains(QLatin1Char('/')))
        return std::nullopt;
    const QUrl url(QStringLiteral("https://") + authority, QUrl::StrictMode);
    const QString host = url.host().toLower();
    if (!url.isValid() || host.isEmpty() || !url.path().isEmpty()) return std::nullopt;
    const int port = url.port();
    const QString origin =
        QStringLiteral("https://") + host +
        (port > 0 && port != 443 ? QLatin1Char(':') + QString::number(port) : QString());

    // IPv4 only, like the networks the board offers.
    const QHostAddress addr(host);
    if (!addr.isNull()) {
        if (addr.protocol() != QAbstractSocket::IPv4Protocol || addr.isLoopback() ||
            addr.isLinkLocal())
            return std::nullopt;
        for (const Choice& c : list)
            if (c.kind != Kind::Domain && c.address == host)
                return BoardOrigin{origin, QString::fromLatin1(kindName(c.kind))};
        if (NetClassify::classify(host) == NetClassify::Kind::Public)
            return BoardOrigin{origin, QStringLiteral("direct")};
        return std::nullopt;
    }

    static const QRegularExpression kName(
        QStringLiteral("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"));
    if (!kName.match(host).hasMatch()) return std::nullopt;
    if (host == QLatin1String("localhost") || host.endsWith(QLatin1String(".localhost")))
        return std::nullopt;
    // Names only one of the owner's networks resolves: the tailnet's, the house's.
    if (host.endsWith(QLatin1String(".ts.net")))
        return BoardOrigin{origin, QStringLiteral("tailscale")};
    static const QRegularExpression kLanName(
        QStringLiteral("^[^.]+$|\\.(local|lan|home|home\\.arpa|internal|localdomain)$"));
    if (kLanName.match(host).hasMatch()) return BoardOrigin{origin, QStringLiteral("lan")};
    return BoardOrigin{origin, QStringLiteral("direct")};
}

/// The choice @p id names among @p list, if it is still there.
inline std::optional<Choice> find(const QList<Choice>& list, const QString& id)
{
    for (const Choice& c : list)
        if (c.id == id) return c;
    return std::nullopt;
}

/// A choice id the board may store: Automatic or one of the forms above.
inline bool isValidId(const QString& id)
{
    if (id == QLatin1String("auto") || id == QLatin1String("domain") ||
        id == QLatin1String("lan") || id == QLatin1String("tailscale"))
        return true;
    return id.startsWith(QLatin1String("iface:")) && id.size() > 6 && id.size() <= 6 + 128;
}

/// This machine's up adapters with an IPv4, as the OS lists them.
QList<Adapter> readAdapters();

} // namespace LinkAddresses
