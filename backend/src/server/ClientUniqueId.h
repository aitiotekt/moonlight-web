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

#include <QString>

/// The browser's per-device id (`client_uniqueid`), as every route must read
/// it: upper-case hex, at most 32 characters — what reaches a GameStream
/// launch URL, and what a MultiSeat seat is owned by.
///
/// One function for every route. /start and /quit cleaned it this way while
/// /apps took it raw, so a device whose id was not already upper-case hex
/// claimed a seat under one spelling and launched under another, and was told
/// "No free seat" for its own (MultiSeat bench, 05/10/2026).
inline QString sanitizeClientUniqueId(const QString& raw)
{
    QString out;
    for (const QChar& c : raw) {
        const QChar u = c.toUpper();
        if (u.isDigit() || (u >= QLatin1Char('A') && u <= QLatin1Char('F'))) out += u;
        if (out.size() >= 32) break;
    }
    return out;
}
