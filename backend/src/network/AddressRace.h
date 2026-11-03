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

#include <QAbstractSocket>
#include <QElapsedTimer>
#include <QHostAddress>
#include <QList>
#include <QObject>
#include <QTimer>

#include <functional>

class QNetworkRequest;

/**
 * @brief One leg of an address race: a single try at reaching one address.
 *
 * The production leg is a plain TCP connection. Tests inject legs they answer
 * by hand, which is how an address that silently drops packets gets staged
 * without a network. A leg answers at most once, with connected() or failed().
 */
class AddressRaceLeg : public QObject
{
    Q_OBJECT

public:
    using QObject::QObject;

    virtual void connectTo(const QHostAddress& address, quint16 port) = 0;

    /// Stop at once and stay silent: the race has no use for this leg any more.
    virtual void abort() = 0;

signals:
    void connected();
    void failed(const QString& why);
};

/**
 * @brief Which of a host's addresses answers first (RFC 8305, "Happy Eyeballs").
 *
 * Why it exists
 * -------------
 * Qt opens a connection by name one address at a time: the resolver's first,
 * and the next only once that one has failed. An address that silently drops
 * packets never fails quickly. A home IPv6 the router advertises but that goes
 * nowhere is exactly that, and it holds every attempt for 21 s on Windows and
 * 30 s on Linux before the IPv4 is so much as tried. Browsers solved this years
 * ago by trying both families at once; QWebSocket (Qt 6.10) has not.
 *
 * What it does
 * ------------
 * One bare TCP connection per address, families alternated, each started a
 * quarter of a second after the previous one, or at once when the previous one
 * has failed. The first to connect wins; the others are aborted. The winner is
 * hung up on the moment it has answered: it was a question, not a connection,
 * and the caller opens its real one on the address it names. A dropped IPv6 now
 * costs the stagger, and a healthy one still wins, since it starts first.
 *
 * Threading: Qt main thread only, like the rest of the network layer.
 */
class AddressRace : public QObject
{
    Q_OBJECT

public:
    using LegFactory = std::function<AddressRaceLeg*(QObject* parent)>;

    explicit AddressRace(QObject* parent = nullptr);
    ~AddressRace() override;

    /// RFC 8305's "Connection Attempt Delay": how long the leader gets before
    /// the next address is tried alongside it. Its recommended 250 ms by default.
    void setStaggerMs(int ms);
    int staggerMs() const { return m_StaggerMs; }

    /// Replaces the TCP legs. Tests only.
    void setLegFactory(LegFactory factory);

    /// Race `addresses` on `port`, in the order interleave() gives them. Exactly
    /// one of won() or lost() follows, always later, never from inside this
    /// call. A race still running is cancelled first.
    void start(
        const QList<QHostAddress>& addresses, quint16 port,
        QAbstractSocket::NetworkLayerProtocol lead = QAbstractSocket::UnknownNetworkLayerProtocol);

    /// Abort every leg. No signal follows.
    void cancel();

    bool isRunning() const { return m_Running; }

    /// RFC 8305 section 4: the two families alternate, each keeping the order
    /// the resolver gave, starting with `lead`. When `lead` is unknown, or has
    /// no address in the list, the resolver's first address starts.
    static QList<QHostAddress> interleave(
        const QList<QHostAddress>& addresses,
        QAbstractSocket::NetworkLayerProtocol lead = QAbstractSocket::UnknownNetworkLayerProtocol);

    /// The same cure for a QNetworkAccessManager request bound for the Internet.
    /// QNAM does race the families on its own, but only over HTTP/1.1: with
    /// HTTP/2 allowed, which it is by default on https, it opens a single
    /// channel and walks the addresses one by one, 30 s each. Nothing this
    /// program fetches is big enough for HTTP/2 to earn its keep.
    static void enableOn(QNetworkRequest& request);

signals:
    /// `address` connected, `elapsedMs` after start().
    void won(const QHostAddress& address, qint64 elapsedMs);

    /// Every address failed.
    void lost(qint64 elapsedMs);

private:
    struct Live
    {
        AddressRaceLeg* leg;
        QHostAddress address;
    };

    void launchNext();
    void onLegConnected(AddressRaceLeg* leg);
    void onLegFailed(AddressRaceLeg* leg);
    void finishLost();

    LegFactory m_LegFactory;
    QList<QHostAddress> m_Pending; // not started yet, in race order
    QList<Live> m_Live;            // started, no answer yet
    QTimer m_Stagger;
    QElapsedTimer m_Clock;
    quint16 m_Port = 0;
    int m_StaggerMs;
    bool m_Running = false;
};
