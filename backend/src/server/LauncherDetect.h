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

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QVector>

#include <functional>
#include <optional>

/**
 * @brief The game launchers installed on this PC that have a full-screen mode
 * of their own, made for a couch: each gets a card on the native host
 * (AppSettings::seedHostApps), as Sunshine's installer gives Steam one.
 *
 *  - Steam Big Picture, on every OS: steam://open/bigpicture, closed again by
 *    steam://close/bigpicture when the owner quits the card.
 *  - Playnite's full-screen mode, on Windows: Playnite.FullscreenApp.exe, a
 *    library that holds Steam, Epic, GOG, Xbox and the rest.
 *
 * Windows 11's "Xbox full screen experience" is not one of them: nothing
 * documented says whether a PC has it, nor opens it — Win+F11 switches the
 * whole session's shell, which no card can switch back.
 *
 * The lookups are injected so each rule is tested on any OS.
 */
namespace LauncherDetect {

struct Launcher
{
    QString source;      ///< "steam", "playnite" — AppSettings' source
    QString name;        ///< the card's name
    QString command;     ///< what opens its full-screen mode
    QString quitCommand; ///< what closes it again, or empty
    QString iconPath;    ///< the program whose icon the card shows
};

/// What the rules read from this machine.
struct Lookup
{
    /// A registry value (Windows): "HKCU\\Software\\Valve\\Steam", "SteamExe".
    /// An empty name reads the key's default value. Empty when absent.
    std::function<QString(const QString& key, const QString& name)> registry;
    /// The subkeys of a registry key, for the Uninstall lists.
    std::function<QStringList(const QString& key)> subkeys;
    /// Whether a file or a directory exists.
    std::function<bool(const QString& path)> exists;
    /// An environment variable, or empty.
    std::function<QString(const QString& name)> env;
};

/// The Lookup of this machine.
Lookup systemLookup();

/// Steam on Windows: the user's own install (HKCU's SteamExe), else the
/// machine's (the steam: protocol, then HKLM's InstallPath) — a server run as
/// SYSTEM reads no user's HKCU.
std::optional<Launcher> steamWindows(const Lookup& lookup);
/// Playnite on Windows: its playnite: protocol, then its uninstall entry,
/// then where its installer puts it by default.
std::optional<Launcher> playniteWindows(const Lookup& lookup);
/// Steam on macOS: Steam.app, in /Applications or the user's own.
std::optional<Launcher> steamMac(const Lookup& lookup);
/// Steam on Linux: a package, the Flatpak or the snap; its icon from the
/// desktop's icon theme.
std::optional<Launcher> steamLinux(const Lookup& lookup);

/// Every launcher of this OS found with @p lookup.
QVector<Launcher> detect(const Lookup& lookup);
/// Every launcher found on this machine.
QVector<Launcher> detect();

/// {source, name, command, quit_command?} — what AppSettings takes.
QJsonObject toJson(const Launcher& launcher);
QJsonArray toJson(const QVector<Launcher>& launchers);

/// The program a shell command line starts, such as a protocol handler's
/// ("\"C:\\Program Files (x86)\\Steam\\steam.exe\" -- \"%1\"").
QString programOf(const QString& commandLine);

} // namespace LauncherDetect
