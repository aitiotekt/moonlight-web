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

#include <QByteArray>
#include <QImage>
#include <QString>

/**
 * @brief The image on a card of the native host's apps (AppSettings::hostApps).
 *
 * One PNG per app, host-app-images/<id>.png beside settings.json, always the
 * card's own shape: 600×800, the 3:4 portrait the grid shows (apps.css). What
 * the owner sends is decoded, cropped to cover that shape and encoded again —
 * which also drops whatever the file carried besides pixels. A launcher
 * MoonlightWeb found on this PC (LauncherDetect) gets its program's icon on a
 * dark card instead: no brand's artwork ships with MoonlightWeb.
 *
 * The file is named by the app's id, never by anything a request says; its
 * hash is what the settings record, and what the card's URL carries so a
 * browser can keep it for good.
 */
namespace HostAppImage {

constexpr int kWidth = 600;
constexpr int kHeight = 800;
/// The largest PNG the admin page may send, and the largest side it may have.
constexpr int kMaxUploadBytes = 3 * 1024 * 1024;
constexpr int kMaxUploadSide = 4096;

/// @p image cropped to cover the card's shape, centred, at its size.
QImage cardFrom(const QImage& image);

/// A dark card with @p icon in its middle, for a launcher found on this PC.
QImage cardFromIcon(const QImage& icon);

/// Decodes the PNG the admin page sent: false with @p error when it is not
/// one, or larger than the limits above.
bool decodeUpload(const QByteArray& png, QImage* out, QString* error);

/// Writes @p card (already the card's shape) as the image of app @p id in
/// @p dir. Its hash, or empty with @p error.
QString store(const QString& dir, const QString& id, const QImage& card, QString* error);

/// The PNG of app @p id, or empty when it has none.
QByteArray read(const QString& dir, const QString& id);

/// Deletes the image of app @p id, if any.
void remove(const QString& dir, const QString& id);

/// The icon of the program at @p path, at up to @p size pixels, or a null
/// image: an .exe's own icon on Windows, an .app's on macOS, an image file
/// as it is anywhere. Never through the shell's extensions: the server may
/// run elevated, and loads no code of the user's (6f351e57).
QImage iconOf(const QString& path, int size = 256);

} // namespace HostAppImage
