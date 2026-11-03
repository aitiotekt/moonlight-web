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

#include <QProcess>
#include <QString>
#include <QStringList>
#include <QtGlobal>

namespace mw {

/// Ask a child process to start without our open descriptors.
///
/// On Unix a child inherits every descriptor not marked close-on-exec, and
/// the network libraries open most of their sockets without that mark. A
/// child holding one keeps its port bound after we close it: the update's
/// pkexec, waiting on a polkit prompt nobody was at the host to answer, held
/// the tunnel's UDP 3481 for as long as it waited, and every browser that
/// came back through the internet was refused (UM790Pro, 18/10/2026). A
/// browser started by xdg-open, a game, or our own relaunched server would
/// hold them for as long as it runs. Qt 6.6 and later close them for us.
inline void closeInheritedDescriptors(QProcess& process)
{
#if defined(Q_OS_UNIX) && QT_VERSION >= QT_VERSION_CHECK(6, 6, 0)
    process.setUnixProcessParameters(QProcess::UnixProcessFlag::CloseFileDescriptors);
#else
    Q_UNUSED(process);
#endif
}

/// QProcess::startDetached, without our open descriptors (see above).
inline bool startDetached(const QString& program, const QStringList& arguments,
                          qint64* pid = nullptr)
{
    QProcess process;
    process.setProgram(program);
    process.setArguments(arguments);
    closeInheritedDescriptors(process);
    return process.startDetached(pid);
}

} // namespace mw
