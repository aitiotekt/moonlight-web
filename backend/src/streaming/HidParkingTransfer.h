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

#include <QJsonObject>

#include <cstdint>

/**
 * The recreated wheels kept between two streams (mw::native::HidParking), as
 * they go from a stream's worker to the server and on to the next worker.
 *
 * Each stream has a worker process of its own, and a device made by the
 * "MoonlightWeb Virtual HID" driver lives exactly as long as some process
 * holds a handle to it. So:
 *
 *   worker, stream over   its devices, paused, are duplicated INTO the server
 *                         (the worker is the elevated or SYSTEM side, the one
 *                         that may open the server), then let go:
 *                         {"event":"hidParked","devices":[…]};
 *   server                takes them in and answers the game until a stream
 *                         wants them, or HidParking::kKeepMs is over;
 *   next worker           gets the list in its config ("hidParked"), pulls a
 *                         copy of each handle out of the server it already
 *                         checked is this executable (ConsoleSession), checks
 *                         each one is the driver's (WinUHidAdoptDevice) and
 *                         answers {"event":"hidAdopted"}; the server then
 *                         closes its copies — or, if the worker never says,
 *                         answers the game again itself.
 *
 * Only workers started through the elevated task or the SYSTEM service take
 * part: they alone can make the devices, and open the server. Windows only:
 * a uhid or uinput device stays in the process that made it.
 */
namespace HidParkingTransfer {

/// Server: the parked devices for a new worker's config, paused here until
/// settle(). Empty with `*batch` 0 when there are none.
QJsonObject handOut(uint64_t* batch);
/// Server: the worker took the batch (closes our copies), or never will
/// (answers the game here again).
void settle(uint64_t batch, bool taken);
/// Server: a worker's hidParked event — its devices' handles are already
/// ours. Returns how many were kept.
int takeIn(const QJsonObject& event);

/// Worker: the config's "hidParked", pulled out of the server process
/// `serverPid`. Returns how many were taken; the caller answers hidAdopted.
int adoptFromServer(const QJsonObject& parked, uint32_t serverPid);
/// Worker, stream over: every parked device pushed into the server. The
/// hidParked event to send, or empty when there is nothing to send.
QJsonObject shipToServer(uint32_t serverPid);

} // namespace HidParkingTransfer
