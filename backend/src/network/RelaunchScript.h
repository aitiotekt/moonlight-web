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

/// The detached `sh -c` sequence a macOS/Linux self-update runs: install, stop
/// the running server, start the new one. Pure string assembly, so it can be
/// checked on any platform.
namespace relaunchscript {

/// Single-quote a value for `sh -c`.
inline QString shQuote(const QString& s)
{
    QString out = s;
    out.replace(QLatin1String("'"), QLatin1String("'\\''"));
    return QLatin1Char('\'') + out + QLatin1Char('\'');
}

/// `exe` is what starts the app (the binary, its launcher, or the AppImage);
/// `configOverride` the --config it runs on, empty for the default one.
/// `launchdService` is the LaunchAgent we run under (`gui/<uid>/<label>`),
/// empty when launchd did not start us.
inline QString build(const QString& install, qint64 pid, const QString& exe,
                     const QString& configOverride, const QString& launchdService = {})
{
    // Under launchd the job is what comes back: a crash-only KeepAlive already
    // restarts it once our kill lands, and the kickstart (no -k, so it never
    // stops a running one) covers a clean exit. Started by hand instead, the
    // new server would live outside its agent: launchd would report it stopped,
    // never restart it after a crash, and the next .pkg would not find it.
    if (!launchdService.isEmpty())
        return QStringLiteral("%1; kill %2 2>/dev/null; sleep 3; "
                              "/bin/launchctl kickstart %3 >/dev/null 2>&1")
            .arg(install, QString::number(pid), shQuote(launchdService));

    // --autostart: nobody clicked anything, so the app comes back as from the
    // login item, without opening its admin page in a browser on the host's
    // desktop. (On a .deb the maintainer scripts skip their own start while the
    // old app still runs, so this launch is the one that brings it back.)
    QString relaunch = shQuote(exe) + QStringLiteral(" --autostart");
    if (!configOverride.isEmpty())
        relaunch += QStringLiteral(" --config ") + shQuote(configOverride);

    // One multi-arg call, not chained .arg(): a path containing "%1" in an
    // earlier argument would otherwise swallow a later substitution.
    return QStringLiteral("%1; kill %2 2>/dev/null; sleep 3; %3 >/dev/null 2>&1 &")
        .arg(install, QString::number(pid), relaunch);
}

} // namespace relaunchscript
