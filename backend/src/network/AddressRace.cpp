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

#include "AddressRace.h"

#include <QNetworkRequest>
#include <QTcpSocket>

#include <utility>

namespace {

// RFC 8305 section 5, the recommended Connection Attempt Delay. Long enough
// for a healthy address across an ocean to answer first, short enough that a
// dropped one costs nothing a user would notice.
constexpr int kDefaultStaggerMs = 250;

/// The production leg: one TCP connection, hung up the moment it is made.
class TcpLeg final : public AddressRaceLeg
{
public:
    explicit TcpLeg(QObject* parent)
        : AddressRaceLeg(parent)
        , m_Socket(new QTcpSocket(this))
    {
        connect(m_Socket, &QTcpSocket::connected, this, [this]() {
            if (m_Answered) return;
            m_Answered = true;
            // Answered. Nothing travels on this socket: the caller opens its
            // own connection to the address, with everything that one needs.
            m_Socket->disconnectFromHost();
            emit connected();
        });
        connect(m_Socket, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
            if (m_Answered) return;
            m_Answered = true;
            emit failed(m_Socket->errorString());
        });
    }

    void connectTo(const QHostAddress& address, quint16 port) override
    {
        m_Socket->connectToHost(address, port);
    }

    void abort() override
    {
        m_Answered = true;
        m_Socket->abort();
    }

private:
    QTcpSocket* m_Socket;
    bool m_Answered = false;
};

} // namespace

AddressRace::AddressRace(QObject* parent)
    : QObject(parent)
    , m_LegFactory([](QObject* owner) -> AddressRaceLeg* { return new TcpLeg(owner); })
    , m_StaggerMs(kDefaultStaggerMs)
{
    m_Stagger.setSingleShot(true);
    connect(&m_Stagger, &QTimer::timeout, this, &AddressRace::launchNext);
}

AddressRace::~AddressRace()
{
    cancel();
}

void AddressRace::setStaggerMs(int ms)
{
    m_StaggerMs = qMax(0, ms);
}

void AddressRace::setLegFactory(LegFactory factory)
{
    if (factory) m_LegFactory = std::move(factory);
}

QList<QHostAddress> AddressRace::interleave(const QList<QHostAddress>& addresses,
                                            QAbstractSocket::NetworkLayerProtocol lead)
{
    if (addresses.isEmpty()) return {};

    // The resolver already sorted by preference (RFC 6724), so its first
    // address names the family that leads, unless the caller asks for the
    // other one and that one is there to ask for.
    QAbstractSocket::NetworkLayerProtocol first = addresses.first().protocol();
    if (lead != QAbstractSocket::UnknownNetworkLayerProtocol) {
        for (const QHostAddress& address : addresses) {
            if (address.protocol() == lead) {
                first = lead;
                break;
            }
        }
    }

    QList<QHostAddress> leading, trailing;
    for (const QHostAddress& address : addresses)
        (address.protocol() == first ? leading : trailing).append(address);

    QList<QHostAddress> out;
    out.reserve(addresses.size());
    for (qsizetype i = 0; i < qMax(leading.size(), trailing.size()); ++i) {
        if (i < leading.size()) out.append(leading.at(i));
        if (i < trailing.size()) out.append(trailing.at(i));
    }
    return out;
}

void AddressRace::enableOn(QNetworkRequest& request)
{
    request.setAttribute(QNetworkRequest::Http2AllowedAttribute, false);
}

void AddressRace::start(const QList<QHostAddress>& addresses, quint16 port,
                        QAbstractSocket::NetworkLayerProtocol lead)
{
    cancel();
    m_Pending = interleave(addresses, lead);
    m_Port = port;
    m_Running = true;
    m_Clock.start();

    if (m_Pending.isEmpty()) {
        // Nothing to race is still answered, and still later: a caller that
        // hears lost() from inside start() is a caller mid-sentence.
        QMetaObject::invokeMethod(
            this,
            [this]() {
                if (m_Running && m_Pending.isEmpty() && m_Live.isEmpty()) finishLost();
            },
            Qt::QueuedConnection);
        return;
    }
    launchNext();
}

void AddressRace::cancel()
{
    m_Stagger.stop();
    m_Pending.clear();
    for (const Live& live : std::as_const(m_Live)) {
        live.leg->disconnect(this);
        live.leg->abort();
        live.leg->deleteLater();
    }
    m_Live.clear();
    m_Running = false;
}

void AddressRace::launchNext()
{
    if (!m_Running || m_Pending.isEmpty()) return;

    const QHostAddress address = m_Pending.takeFirst();
    AddressRaceLeg* leg = m_LegFactory(this);
    m_Live.append({leg, address});
    connect(leg, &AddressRaceLeg::connected, this, [this, leg]() { onLegConnected(leg); });
    connect(leg, &AddressRaceLeg::failed, this, [this, leg](const QString&) { onLegFailed(leg); });
    leg->connectTo(address, m_Port);

    // A leg may have answered from inside connectTo() and ended the race.
    if (m_Running && !m_Pending.isEmpty()) m_Stagger.start(m_StaggerMs);
}

void AddressRace::onLegConnected(AddressRaceLeg* leg)
{
    if (!m_Running) return;

    QHostAddress winner;
    for (const Live& live : std::as_const(m_Live)) {
        if (live.leg == leg) winner = live.address;
    }
    const qint64 elapsed = m_Clock.elapsed();

    // Everyone else loses, the winner included: it has said what it had to.
    m_Running = false;
    m_Stagger.stop();
    m_Pending.clear();
    for (const Live& live : std::as_const(m_Live)) {
        live.leg->disconnect(this);
        if (live.leg != leg) live.leg->abort();
        live.leg->deleteLater();
    }
    m_Live.clear();

    emit won(winner, elapsed);
}

void AddressRace::onLegFailed(AddressRaceLeg* leg)
{
    if (!m_Running) return;

    for (qsizetype i = 0; i < m_Live.size(); ++i) {
        if (m_Live.at(i).leg != leg) continue;
        leg->disconnect(this);
        leg->deleteLater();
        m_Live.removeAt(i);
        break;
    }

    // A failure frees the delay: the next address is tried now, not when the
    // stagger would have got round to it.
    if (!m_Pending.isEmpty()) {
        m_Stagger.stop();
        launchNext();
        return;
    }
    if (m_Live.isEmpty()) finishLost();
}

void AddressRace::finishLost()
{
    m_Running = false;
    m_Stagger.stop();
    emit lost(m_Clock.elapsed());
}
