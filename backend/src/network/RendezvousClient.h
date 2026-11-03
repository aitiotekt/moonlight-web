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

#include <QObject>
#include <QHostAddress>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QString>
#include <QTimer>
#include <QUrlQuery>
#include <QVersionNumber>
#include <QWebSocket>

class AddressRace;
class AppSettings;
class QHostInfo;

/**
 * @brief Holds this instance's line to the rendezvous server.
 *
 * What it is for
 * --------------
 * An instance used to be reachable because it published an A record pointing at
 * a home IP address. It no longer does. What makes it reachable now is this:
 * one outbound WebSocket, held open, over which the rendezvous server can reach
 * it at any moment. The line IS the reachability — there is nothing to publish
 * and nothing to poll.
 *
 * The reason it has to be a held connection rather than a periodic announcement
 * is that the address a browser actually needs — the reflexive candidate — is a
 * port that only exists while a connection is being made. It cannot be stored
 * and it cannot be re-used, so there is nothing an instance could usefully
 * announce in advance.
 *
 * What crosses it
 * ---------------
 * WebRTC signalling, and nothing else. No media, no input, no credentials. The
 * payloads are opaque to the server, which copies them between this line and
 * the browser that asked for this instance by identifier.
 *
 * Reaching the server
 * -------------------
 * Where Qt allows it, the line is not opened by name. The name is resolved,
 * its addresses are raced (AddressRace), and the line is opened on the one
 * that answered first, carrying the name where the server and the certificate
 * expect it. An IPv6 that silently drops packets then costs a quarter of a
 * second instead of the 21 to 30 s Qt spends on it before trying the IPv4.
 *
 * Qt allows it from 6.10.3 and 6.11.1 on (canPinLine()). Before, and in
 * 6.11.0, QWebSocket loses the name on the way to an address (QTBUG-141396),
 * and the server refuses the line. There it goes by name, as it always did,
 * and Qt walks the addresses itself. The Qt that decides is the one loaded at
 * run time: a build against 6.10.3 runs on the 6.11.0 libraries as well.
 *
 * Each attempt, from openLine() to connected, is bounded by an open timeout:
 * past it the attempt counts as a failure like a refusal would, and the family
 * that had won the race is not the one to lead with next time.
 *
 * Noticing a dead line
 * --------------------
 * A line cut in silence, a NAT entry dropped upstream, a Wi-Fi gone away: the
 * socket still looks connected. The client pings every 20 s and gives the pong
 * 15 s, so such a cut is noticed within 35 s at worst, and the line is rebuilt.
 * A machine that sleeps stops those timers with it: a coarse clock watch sees
 * the wall clock jump at wake-up and pings at once, rather than when the
 * keep-alive timer, resumed where it stopped, would have got round to it.
 *
 * Threading: Qt main thread only, like the rest of the network layer.
 */
class RendezvousClient : public QObject
{
    Q_OBJECT

public:
    explicit RendezvousClient(AppSettings* settings, QObject* parent = nullptr);
    ~RendezvousClient() override;

    /// Base URL of the rendezvous server: MW_RENDEZVOUS_URL, else
    /// "https://stream.{MW_DOMAIN}".
    static QString baseUrl();

    /// The address to hand a user: "{baseUrl}/{id}". Empty until claimed —
    /// an unclaimed id is an address that answers to nobody, and showing it
    /// would be worse than showing nothing.
    QString entryUrl() const;

    /// Draw an identity if needed, claim it, then hold the line. Safe to call
    /// repeatedly; a second call while running is a no-op.
    void start();

    /// Deliberate shutdown: drop the line and do NOT reconnect.
    void stop();

    bool isOnline() const { return m_Online; }

    /// Why this client stopped trying, in one sentence — empty while it is
    /// still trying or the line is up. Today the only cause is the server
    /// refusing this build's protocol revision: the admin page shows it,
    /// because "the address is right and answers to nobody" would otherwise
    /// look exactly like a network problem.
    QString lastError() const { return m_LastError; }

    /// How long one attempt to bring the line up may take, from openLine() to
    /// connected: name lookup, the race, TLS and the upgrade. The claim's
    /// transfer timeout follows it. The default suits production; tests shorten it.
    /// A line that goes by name keeps its own, longer bound: Qt's walk through
    /// the addresses must have the time to reach the second one.
    void setOpenTimeoutMs(int ms);

    /// Whether QWebSocket, in the Qt version `qt`, carries the name to a line
    /// opened on an address: the TLS server name and the one Host header.
    static bool canPinLine(const QVersionNumber& qt);

    /// Open the line by name whatever Qt is loaded, as a Qt without the fix
    /// does. Tests only.
    void forceLineByName();

    /// The keep-alive: how often the line is pinged once up, and how long the
    /// pong is given before the line is rebuilt. The defaults suit production;
    /// tests shorten them.
    void setKeepAliveMs(int ms);
    void setPongTimeoutMs(int ms);
    int keepAliveMs() const { return m_KeepAliveMs; }
    int pongTimeoutMs() const { return m_PongTimeoutMs; }

    /// The clock watch: how often the wall clock is looked at, and how far
    /// ahead it must have jumped between two looks for the process to count as
    /// having slept. Tests only.
    void setClockWatch(int tickMs, int jumpMs);

    /// How many pings this client has sent since it was created. For tests and
    /// diagnostics.
    int pingsSent() const { return m_PingsSent; }

signals:
    /// A browser arrived and the server opened a session for it.
    void sessionOpened(const QString& sessionId);

    /// That session is finished — the browser left, or the server dropped it.
    void sessionClosed(const QString& sessionId);

    /// One signalling payload, verbatim as the browser sent it.
    void signalReceived(const QString& sessionId, const QJsonObject& payload);

    /// The held line came up or went down.
    void onlineChanged(bool online);

    /// The identifier changed (first claim, or a forced redraw). Entry points —
    /// tray menu, desktop shortcut, admin page — follow this.
    void identityChanged(const QString& id);

public slots:
    /// Send one signalling payload toward the browser on `sessionId`.
    void sendSignal(const QString& sessionId, const QJsonObject& payload);

    /// Tell the server this session is over.
    void closeSession(const QString& sessionId);

private slots:
    void onConnected();
    void onDisconnected();
    void onTextMessage(const QString& text);
    void onSocketError(QAbstractSocket::SocketError error);
    void onPong(quint64 elapsed, const QByteArray& payload);
    void onKeepAlive();
    void onWatchdog();
    void onClockTick();
    void onOpenTimeout();
    void onRaceWon(const QHostAddress& address, qint64 elapsedMs);
    void onRaceLost(qint64 elapsedMs);

private:
    void ensureIdentity();
    void claim();
    void openLine();
    void onResolved(int attempt, const QHostInfo& info);
    /// Open the line on one address, with the name kept for Host and the certificate.
    void openLineOn(const QHostAddress& address);
    /// The one exit of an attempt that never came up. Counts once per attempt.
    void attemptFailed(const char* why);
    /// Forget the attempt in progress: its timeout, lookup and race. Counts nothing.
    void abandonAttempt();
    void scheduleRetry(const char* why);
    void setOnline(bool online);
    void sendFrame(const QJsonObject& frame);
    /// Stop retrying for good (until stop()/start()): the server said no retry
    /// will be served. Records `why` for lastError().
    void halt(const QString& why);
    /// `?v=<revision>`, the same on the claim and on the line.
    static QUrlQuery protoQuery();

    AppSettings* m_Settings = nullptr;
    QNetworkAccessManager* m_Net = nullptr;
    AddressRace* m_Race = nullptr;
    QWebSocket m_Socket;

    QTimer m_RetryTimer;     // reconnect / re-claim backoff
    QTimer m_KeepAliveTimer; // our own ping, so a dead line is noticed
    QTimer m_Watchdog;       // fires when a pong never came back
    QTimer m_ClockTick;      // the clock watch, start() to stop()
    QTimer m_OpenTimer;      // bounds one attempt, openLine() to connected
    int m_OpenTimeoutMs;
    int m_KeepAliveMs;
    int m_PongTimeoutMs;
    int m_ClockJumpMs;
    qint64 m_LastTickMs = 0; // the wall clock at the last tick
    int m_PingsSent = 0;

    /// Whether a named line is raced and opened on the winning address, or
    /// goes by name: canPinLine() of the Qt loaded at run time.
    bool m_PinLine;

    /// The attempt in progress, if any: true from openLine() until the line is
    /// up or attemptFailed() has counted it. Attempts are numbered so that a
    /// name lookup answering late is recognised as the previous one's.
    bool m_Opening = false;
    int m_Attempt = 0;
    int m_Lookup = -1; // QHostInfo lookup id, -1 when none is pending

    /// The request as it would be sent by name: URL, revision, owner header.
    QNetworkRequest m_LineRequest;

    /// Which family won this attempt's race, unknown until it has or when the
    /// URL named an address; and which family the next race should lead with,
    /// set by a timed-out attempt, cleared once the line is up.
    QAbstractSocket::NetworkLayerProtocol m_RaceWinner =
        QAbstractSocket::UnknownNetworkLayerProtocol;
    QAbstractSocket::NetworkLayerProtocol m_LeadFamily =
        QAbstractSocket::UnknownNetworkLayerProtocol;

    bool m_Running = false;
    bool m_Online = false;
    bool m_Claiming = false;
    int m_RetryCount = 0;

    /// Set by halt(). Distinct from !m_Running: the switch is still on, the
    /// retrying is what stopped.
    bool m_Halted = false;
    QString m_LastError;

    /// Whether the CURRENT attempt ever reached the connected state. It is what
    /// separates "the line was working and dropped" from "the server refuses to
    /// let us on", which need opposite responses.
    bool m_LineEverUp = false;

    /// Consecutive attempts that never came up. Past a threshold the client
    /// stops trusting its own claim and goes through the claim endpoint again —
    /// see the note in onDisconnected().
    int m_LineFailures = 0;

    /// How many times this process has been allowed to redraw its identity.
    /// Bounded on purpose: a redraw loop would burn through the server's
    /// per-address claim budget and leave orphaned entries behind it.
    int m_IdentityRedraws = 0;
};
