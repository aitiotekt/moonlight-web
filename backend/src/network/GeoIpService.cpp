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

#include "GeoIpService.h"

#include "AddressRace.h"
#include "server/AppSettings.h"
#include "common/Logger.h"

#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUrl>
#include <QUrlQuery>

GeoIpService::GeoIpService(AppSettings* settings, QObject* parent)
    : QObject(parent)
    , m_settings(settings)
    , m_nam(new QNetworkAccessManager(this))
{}

QNetworkRequest GeoIpService::lookupRequest(const QString& ip)
{
    // HTTPS provider (ipwho.is): free, no API key, and crucially encrypted so a
    // network observer cannot harvest the client IPs we look up or tamper with
    // the geo result. Returns {success, city, country}.
    QUrl url(QStringLiteral("https://ipwho.is/%1").arg(ip));
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("fields"), QStringLiteral("success,city,country"));
    url.setQuery(query);

    QNetworkRequest req(url);
    req.setRawHeader("User-Agent", "MoonlightWeb/1.0");
    // The provider has IPv6 addresses. Over HTTP/2, behind an IPv6 that drops
    // packets, the lookup would fail at its timeout, and that empty answer is
    // cached for a day.
    AddressRace::enableOn(req);
    req.setTransferTimeout(5000); // 5s timeout
    return req;
}

bool GeoIpService::worthLocating(const QString& ip)
{
    QHostAddress address(ip.trimmed());
    if (address.isNull()) return false;
    bool mapped = false;
    const quint32 v4 = address.toIPv4Address(&mapped);
    if (mapped) address = QHostAddress(v4);
    if (!address.isGlobal() || address.isPrivateUse() || address.isUniqueLocalUnicast())
        return false;
    return !address.isInSubnet(QHostAddress(QStringLiteral("100.64.0.0")), 10);
}

void GeoIpService::lookupIp(const QString& ip, const GeoCallback& callback)
{
    if (!callback) return;

    // Only a global address is worth asking about, and only one may leave this
    // machine: a private, link-local or loopback one locates nothing, and an
    // IPv6 unique-local one (fc00::/7) or a carrier-grade NAT one (100.64/10,
    // Tailscale's) names a network of the viewer's to a third party. Parsed,
    // so an IPv4 address that arrives mapped (::ffff:a.b.c.d) is judged as the
    // IPv4 address it is.
    if (!worthLocating(ip)) {
        callback(QString(), QString());
        return;
    }

    // Check cache
    auto it = m_cache.find(ip);
    if (it != m_cache.end()) {
        callback(it->first, it->second);
        return;
    }

    // Check if there's already a pending request for this IP
    auto pendingIt = m_pending.find(ip);
    if (pendingIt != m_pending.end()) {
        pendingIt->append(callback);
        return;
    }

    // Asked last, and on purpose: the private-address and cache checks above
    // answer without telling anyone anything, so the setting only has to gate
    // the one path that leaves this machine. Reading it here also means a
    // switch flipped mid-session takes effect on the next lookup.
    if (!m_settings || !m_settings->sessionLocationEnabled()) {
        callback(QString(), QString());
        return;
    }

    // Start new request
    m_pending[ip].append(callback);

    QNetworkReply* reply = m_nam->get(lookupRequest(ip));

    connect(reply, &QNetworkReply::finished, this, [this, ip, reply]() {
        reply->deleteLater();

        QString city;
        QString country;

        if (reply->error() == QNetworkReply::NoError) {
            QByteArray data = reply->readAll();
            QJsonDocument doc = QJsonDocument::fromJson(data);
            if (doc.isObject()) {
                QJsonObject obj = doc.object();
                if (obj.value("success").toBool()) {
                    city = obj.value("city").toString();
                    country = obj.value("country").toString();
                }
            }
        } else {
            Logger::warning(
                QString("[GeoIp] Failed to lookup %1: %2").arg(ip, reply->errorString()));
        }

        // Cache result (even empty — avoids re-fetching unreachable IPs)
        m_cache[ip] = qMakePair(city, country);

        // Fire all pending callbacks for this IP
        auto pendingIt = m_pending.find(ip);
        if (pendingIt != m_pending.end()) {
            for (const auto& cb : pendingIt.value()) {
                if (cb) cb(city, country);
            }
            m_pending.erase(pendingIt);
        }
    });
}

QPair<QString, QString> GeoIpService::cachedLocation(const QString& ip) const
{
    auto it = m_cache.find(ip);
    if (it != m_cache.end()) return *it;
    return {};
}

void GeoIpService::clearCache()
{
    m_cache.clear();
    Logger::info("[GeoIp] Cache cleared");
}
