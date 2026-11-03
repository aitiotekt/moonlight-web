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

#include "HidParkingTransfer.h"

#include "HidParkedJson.h"
#include "mw/native/HidPassthrough.h"

#include <QDebug>
#include <QJsonArray>

#include <vector>

#ifdef Q_OS_WIN
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

using mw::native::HidHandedDevice;
using mw::native::HidParkedState;
using mw::native::HidParking;

namespace HidParkingTransfer {

namespace {

QString handleText(uint64_t h)
{
    return QString::number(h);
}

uint64_t handleOf(const QJsonValue& v)
{
    bool ok = false;
    const uint64_t h = v.toString().toULongLong(&ok);
    return ok ? h : 0;
}

#ifdef Q_OS_WIN
void closeHandle(uint64_t h)
{
    if (h) ::CloseHandle(reinterpret_cast<HANDLE>(h));
}
#endif

} // namespace

QJsonObject handOut(uint64_t* batch)
{
    *batch = 0;
#ifdef Q_OS_WIN
    std::vector<HidHandedDevice> devices;
    *batch = HidParking::process().handOut(devices);
    if (!*batch) return {};
    QJsonArray list;
    for (const HidHandedDevice& d : devices)
        list.append(QJsonObject{{QStringLiteral("handle"), handleText(d.handle)},
                                {QStringLiteral("state"), hidParkedToJson(d.state)}});
    qInfo() << "[HID] handing" << list.size() << "kept device(s) to the next stream's worker";
    return QJsonObject{{QStringLiteral("devices"), list}};
#else
    return {};
#endif
}

void settle(uint64_t batch, bool taken)
{
    if (!batch) return;
    HidParking::process().settle(batch, taken);
    if (!taken) qInfo() << "[HID] the worker did not take the kept devices: kept here";
}

int takeIn(const QJsonObject& event)
{
    int kept = 0;
#ifdef Q_OS_WIN
    for (const QJsonValue& v : event[QLatin1String("devices")].toArray()) {
        const uint64_t handle = handleOf(v[QLatin1String("handle")]);
        if (!handle) continue;
        HidParkedState state;
        if (!hidParkedFromJson(v[QLatin1String("state")].toObject(), &state)) {
            // Ours now, whatever it is: never left open with nobody answering.
            closeHandle(handle);
            qWarning() << "[HID] a kept device came back unreadable: let go";
            continue;
        }
        const std::string why = HidParking::process().takeIn(handle, state, 0);
        if (why.empty())
            ++kept;
        else
            qWarning() << "[HID] a kept device could not be taken in:"
                       << QString::fromStdString(why);
    }
#else
    Q_UNUSED(event);
#endif
    return kept;
}

int adoptFromServer(const QJsonObject& parked, uint32_t serverPid)
{
    int taken = 0;
#ifdef Q_OS_WIN
    const QJsonArray devices = parked[QLatin1String("devices")].toArray();
    if (devices.isEmpty() || !serverPid) return 0;
    HANDLE server = ::OpenProcess(PROCESS_DUP_HANDLE, FALSE, serverPid);
    if (!server) {
        qWarning() << "[HID] cannot open the server for its kept devices, error"
                   << ::GetLastError();
        return 0;
    }
    for (const QJsonValue& v : devices) {
        HidParkedState state;
        const uint64_t remote = handleOf(v[QLatin1String("handle")]);
        if (!remote || !hidParkedFromJson(v[QLatin1String("state")].toObject(), &state)) continue;
        HANDLE local = nullptr;
        // A copy, not a move: the server keeps its own until hidAdopted, and
        // answers the game again if this worker never says it.
        if (!::DuplicateHandle(server, reinterpret_cast<HANDLE>(remote), ::GetCurrentProcess(),
                               &local, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            qWarning() << "[HID] cannot copy a kept device's handle, error" << ::GetLastError();
            continue;
        }
        // The server is the less privileged side: what it handed over is
        // checked to be one of the driver's devices before anything else
        // touches it (WinUHidAdoptDevice), and closed otherwise.
        const std::string why = HidParking::process().takeIn(reinterpret_cast<uint64_t>(local),
                                                             state, HidParking::kUnclaimedMs);
        if (why.empty())
            ++taken;
        else
            qWarning() << "[HID] a kept device was refused:" << QString::fromStdString(why);
    }
    ::CloseHandle(server);
#else
    Q_UNUSED(parked);
    Q_UNUSED(serverPid);
#endif
    return taken;
}

QJsonObject shipToServer(uint32_t serverPid)
{
#ifdef Q_OS_WIN
    if (!serverPid) return {};
    std::vector<HidHandedDevice> devices;
    const uint64_t batch = HidParking::process().handOut(devices);
    if (!batch) return {};
    HANDLE server = ::OpenProcess(PROCESS_DUP_HANDLE, FALSE, serverPid);
    if (!server) {
        qWarning() << "[HID] cannot open the server to keep the devices, error" << ::GetLastError();
        HidParking::process().settle(batch, false);
        return {};
    }
    QJsonArray list;
    for (const HidHandedDevice& d : devices) {
        HANDLE remote = nullptr;
        if (!::DuplicateHandle(::GetCurrentProcess(), reinterpret_cast<HANDLE>(d.handle), server,
                               &remote, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            qWarning() << "[HID] cannot hand a device to the server, error" << ::GetLastError();
            continue;
        }
        list.append(
            QJsonObject{{QStringLiteral("handle"), handleText(reinterpret_cast<uint64_t>(remote))},
                        {QStringLiteral("state"), hidParkedToJson(d.state)}});
    }
    ::CloseHandle(server);
    // Our copies go: the server holds the devices now (one that could not be
    // handed over goes away with them).
    HidParking::process().settle(batch, true);
    if (list.isEmpty()) return {};
    qInfo() << "[HID]" << list.size() << "device(s) kept by the server for the next stream";
    return QJsonObject{{QStringLiteral("event"), QStringLiteral("hidParked")},
                       {QStringLiteral("devices"), list}};
#else
    Q_UNUSED(serverPid);
    return {};
#endif
}

} // namespace HidParkingTransfer
