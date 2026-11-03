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

#include "ClipboardBridge.h"
#include "ClipboardPolicy.h"
#ifdef Q_OS_MACOS
#include "ClipboardMac.h"
#endif
#include "IMediaEngine.h"

#include <QClipboard>
#include <QCoreApplication>
#include <QGuiApplication>
#include <QHostAddress>
#include <QHostInfo>
#include <QMetaMethod>
#include <QNetworkInterface>
#include <QPointer>
#include <QtDebug>
#include <QTimer>

namespace {
constexpr bool kMacHost =
#ifdef Q_OS_MACOS
    true;
#else
    false;
#endif

QString clipboardText()
{
#ifdef Q_OS_MACOS
    // Cocoa's Qt clipboard notifications follow application activation; the
    // stream worker stays in the background while another app owns focus.
    return macClipboardText();
#else
    return QGuiApplication::clipboard()->text();
#endif
}
} // namespace

ClipboardBridge* ClipboardBridge::instance()
{
    // Parented to the app so it dies with the main event loop. Thread-safe
    // static init; first caller's thread becomes the object's thread — see
    // header contract (first call is from Session on the main thread).
    static ClipboardBridge* s_Instance = new ClipboardBridge(QCoreApplication::instance());
    return s_Instance;
}

ClipboardBridge::ClipboardBridge(QObject* parent)
    : QObject(parent)
{
    connect(QGuiApplication::clipboard(), &QClipboard::dataChanged, this,
            &ClipboardBridge::onClipboardChanged);
#ifdef Q_OS_MACOS
    m_PollTimer = new QTimer(this);
    m_PollTimer->setInterval(250);
    connect(m_PollTimer, &QTimer::timeout, this, &ClipboardBridge::onClipboardChanged);
#endif
    qInfo() << "[ClipboardBridge] Created (host clipboard monitor active)";
}

const char* ClipboardBridge::capabilitiesMessage()
{
    if (kMacHost)
        return "{\"type\":\"clipboardcaps\",\"available\":true,\"sessionConfig\":true,"
               "\"pasteModifier\":\"meta\"}";
    return "{\"type\":\"clipboardcaps\",\"available\":true,\"sessionConfig\":true,"
           "\"pasteModifier\":\"control\"}";
}

bool ClipboardBridge::isSelfAddress(const QString& address)
{
    if (address.isEmpty()) return false;
    if (address.compare(QStringLiteral("localhost"), Qt::CaseInsensitive) == 0) return true;
    if (address.compare(QHostInfo::localHostName(), Qt::CaseInsensitive) == 0) return true;

    const QHostAddress addr(address);
    if (addr.isNull()) return false; // hostname we can't cheaply resolve — assume remote
    if (addr.isLoopback()) return true;

    const QList<QHostAddress> locals = QNetworkInterface::allAddresses();
    for (const QHostAddress& local : locals) {
        if (addr.isEqual(local, QHostAddress::TolerantConversion)) return true;
    }
    return false;
}

void ClipboardBridge::pasteFromClient(IMediaEngine* engine, const QString& text, bool wrapCtrl)
{
    // The shim is Qt-parented to its relay and dies on the relay thread; the
    // lambda runs on the main thread — guard with a QPointer so a teardown
    // racing this queued call degrades to a no-op instead of a dangling call.
    QPointer<IMediaEngine> shimGuard(engine);
    QMetaObject::invokeMethod(
        this,
        [this, shimGuard, text, wrapCtrl]() {
            if (!shimGuard) return;
            const QString t = text.left(kMaxTextChars);
            if (!t.isEmpty() && t != clipboardText()) {
                m_LastText = t;
                QGuiApplication::clipboard()->setText(t);
            }
            // Inject the chord only AFTER the clipboard is committed — same
            // main-thread hop, so ordering is structural. Li input calls are
            // thread-safe (guarded by the shim's connected atomic).
            IMediaEngine* s = shimGuard.data();
            if (!s) return;
            for (const auto& key : ClipboardPolicy::pasteKeys(kMacHost, wrapCtrl))
                s->sendKeyEvent(key.key, key.down, key.modifiers, 0);
        },
        Qt::QueuedConnection);
}

void ClipboardBridge::requestAnnounce()
{
    QMetaObject::invokeMethod(
        this,
        [this]() {
            if (m_Subscribers.isEmpty()) return;
            const QString text = clipboardText().left(kMaxTextChars);
            if (text.isEmpty()) return;
            m_LastText = text;
            emit hostTextChanged(text);
        },
        Qt::QueuedConnection);
}

void ClipboardBridge::onClipboardChanged()
{
    if (m_Subscribers.isEmpty()) return;
#ifdef Q_OS_MACOS
    const qint64 changeCount = macClipboardChangeCount();
    if (changeCount == m_ChangeCount) return;
    m_ChangeCount = changeCount;
#endif
    // Don't even read the clipboard while no session is listening.
    static const QMetaMethod changedSignal =
        QMetaMethod::fromSignal(&ClipboardBridge::hostTextChanged);
    if (!isSignalConnected(changedSignal)) return;

    const QString text = clipboardText().left(kMaxTextChars);
    // Empty = cleared or non-text content (image/files) — text-only bridge.
    // Identical text = echo of our own setText() or a no-op copy.
    if (text.isEmpty() || text == m_LastText) return;

    m_LastText = text;
    emit hostTextChanged(text);
}

void ClipboardBridge::setSubscription(QObject* consumer, bool enabled)
{
    const QPointer<QObject> guard(consumer);
    QMetaObject::invokeMethod(
        this,
        [this, guard, enabled]() {
            if (!guard) return;
            QObject* consumer = guard.data();
            if (!m_Consumers.contains(consumer)) {
                m_Consumers.insert(consumer);
                connect(consumer, &QObject::destroyed, this, [this, consumer]() {
                    m_Consumers.remove(consumer);
                    m_Subscribers.remove(consumer);
                    if (m_PollTimer && m_Subscribers.isEmpty()) m_PollTimer->stop();
                });
            }
            if (enabled)
                m_Subscribers.insert(consumer);
            else
                m_Subscribers.remove(consumer);
            if (m_PollTimer) {
                if (m_Subscribers.isEmpty())
                    m_PollTimer->stop();
                else if (!m_PollTimer->isActive()) {
                    m_ChangeCount = -1;
                    m_PollTimer->start();
                }
            }
        },
        Qt::QueuedConnection);
}
