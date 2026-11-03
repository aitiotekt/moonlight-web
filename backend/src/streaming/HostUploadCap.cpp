/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include "HostUploadCap.h"

#include <QByteArray>
#include <QCoreApplication>
#include <QDebug>
#include <QDir>
#include <QProcess>
#include <QString>
#include <QStringList>

#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

namespace mw::hostcap {

std::string capName(unsigned long pid)
{
    return "MoonlightWeb host cap " + std::to_string(pid);
}

std::string streamName(unsigned long pid)
{
    return "MoonlightWeb stream " + std::to_string(pid);
}

std::string psQuote(const std::string& s)
{
    std::string out = "'";
    for (const char c : s) {
        out += c;
        if (c == '\'') out += '\'';
    }
    out += '\'';
    return out;
}

std::string onScript(unsigned long pid, const std::string& exePath, unsigned mbps, unsigned dscp)
{
    const std::string cap = psQuote(capName(pid));
    const std::string stream = psQuote(streamName(pid));
    const unsigned long long bits = static_cast<unsigned long long>(mbps) * 1000000ull;
    std::string s;
    s += "$ErrorActionPreference = 'Stop'\n";
    // A worker that died with its cap on: its process id runs no more.
    s += "Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -match "
         "'^MoonlightWeb (host cap|stream) (\\d+)$' -and -not (Get-Process -Id ([int]$Matches[2]) "
         "-ErrorAction SilentlyContinue) } | ForEach-Object { Remove-NetQosPolicy -Name $_.Name "
         "-PolicyStore ActiveStore -Confirm:$false; \"swept $($_.Name)\" }\n";
    s += "foreach ($n in " + cap + ", " + stream +
         ") { if (Get-NetQosPolicy -PolicyStore "
         "ActiveStore | Where-Object Name -eq $n) { Remove-NetQosPolicy -Name $n -PolicyStore "
         "ActiveStore -Confirm:$false } }\n";
    // The highest precedence: at the default 127, the cap wins over it (S1 bis).
    s += "New-NetQosPolicy -Name " + stream +
         " -PolicyStore ActiveStore -AppPathNameMatchCondition " + psQuote(exePath) +
         " -IPProtocolMatchCondition Both -DSCPAction " + std::to_string(dscp) +
         " -Precedence 255 | Out-Null\n";
    s += "New-NetQosPolicy -Name " + cap +
         " -PolicyStore ActiveStore -IPProtocolMatchCondition Both "
         "-ThrottleRateActionBitsPerSecond " +
         std::to_string(bits) + " | Out-Null\n";
    s += "'set'\n";
    return s;
}

std::string offScript(unsigned long pid)
{
    std::string s;
    s += "$names = " + psQuote(capName(pid)) + ", " + psQuote(streamName(pid)) + "\n";
    s += "foreach ($round in 1, 2) {\n";
    s += "  foreach ($n in $names) { Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object Name "
         "-eq $n | ForEach-Object { Remove-NetQosPolicy -Name $n -PolicyStore ActiveStore "
         "-Confirm:$false } }\n";
    s += "  if ($round -eq 1) { Start-Sleep -Seconds 5 }\n";
    s += "}\n";
    return s;
}

std::string encodedCommand(const std::string& script)
{
    const QString text = QString::fromUtf8(script.data(), static_cast<qsizetype>(script.size()));
    QByteArray utf16le;
    utf16le.reserve(text.size() * 2);
    for (const QChar c : text) {
        const char16_t u = c.unicode();
        utf16le.append(static_cast<char>(u & 0xff));
        utf16le.append(static_cast<char>(u >> 8));
    }
    return utf16le.toBase64().toStdString();
}

#ifdef _WIN32
namespace {

/// The worker's token may set QoS policies: an administrator's, elevated, or
/// SYSTEM's.
bool elevated()
{
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION e{};
    DWORD size = 0;
    bool yes = GetTokenInformation(token, TokenElevation, &e, sizeof e, &size) && e.TokenIsElevated;
    if (!yes) {
        // SYSTEM, whatever its token says of elevation.
        alignas(TOKEN_USER) unsigned char buf[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE] = {};
        BYTE system[SECURITY_MAX_SID_SIZE] = {};
        DWORD systemSize = sizeof system;
        if (GetTokenInformation(token, TokenUser, buf, sizeof buf, &size) &&
            CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &systemSize))
            yes = EqualSid(reinterpret_cast<TOKEN_USER*>(buf)->User.Sid, system) != FALSE;
    }
    CloseHandle(token);
    return yes;
}

/// Windows PowerShell by its full path: a SYSTEM process does not look it up
/// on the PATH.
QString powershell()
{
    wchar_t dir[MAX_PATH] = {};
    const UINT n = GetSystemDirectoryW(dir, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return {};
    return QString::fromWCharArray(dir, static_cast<int>(n)) +
           QStringLiteral("\\WindowsPowerShell\\v1.0\\powershell.exe");
}

QStringList argumentsFor(const std::string& script)
{
    return {QStringLiteral("-NoProfile"),       QStringLiteral("-NonInteractive"),
            QStringLiteral("-ExecutionPolicy"), QStringLiteral("Bypass"),
            QStringLiteral("-EncodedCommand"),  QString::fromStdString(encodedCommand(script))};
}

} // namespace
#endif

void Cap::start(unsigned mbps, unsigned dscp)
{
    if (mbps == 0) return;
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (m_Started) return;
#ifdef _WIN32
    if (!elevated()) {
        qWarning().noquote() << QStringLiteral(
                                    "[HostCap] hostcap=%1 asked for, but this worker has no "
                                    "administrator rights (the launcher service's SYSTEM worker "
                                    "has them): nothing capped")
                                    .arg(mbps);
        return;
    }
    const QString program = powershell();
    if (program.isEmpty()) return;
    const unsigned long pid = GetCurrentProcessId();
    const std::string exe =
        QDir::toNativeSeparators(QCoreApplication::applicationFilePath()).toStdString();
    const QStringList args = argumentsFor(onScript(pid, exe, mbps, dscp));
    m_Started = true;
    qInfo().noquote() << QStringLiteral("[HostCap] capping every other upload of this PC at %1 "
                                        "Mbit/s during the stream (hostcap=; ActiveStore policies "
                                        "\"%2\", \"%3\" for %4, DSCP %5)")
                             .arg(mbps)
                             .arg(QString::fromStdString(capName(pid)),
                                  QString::fromStdString(streamName(pid)),
                                  QString::fromStdString(exe))
                             .arg(dscp);
    // Off the caller's thread: PowerShell and its NetQos module take a second
    // or two to start. The thread holds nothing of this object.
    std::thread([program, args]() {
        QProcess p;
        p.start(program, args);
        const bool done = p.waitForFinished(30000);
        const QString out = QString::fromLocal8Bit(p.readAllStandardOutput()).trimmed();
        const QString err = QString::fromLocal8Bit(p.readAllStandardError()).trimmed();
        if (done && p.exitStatus() == QProcess::NormalExit && p.exitCode() == 0 &&
            out.endsWith(QLatin1String("set"))) {
            qInfo().noquote() << "[HostCap] cap set:" << out.simplified();
        } else {
            qWarning().noquote() << "[HostCap] cap NOT set (exit" << p.exitCode()
                                 << (done ? "" : ", timed out")
                                 << "):" << err.left(400).simplified()
                                 << out.left(200).simplified();
        }
    }).detach();
#else
    (void)dscp;
    qWarning().noquote() << QStringLiteral("[HostCap] hostcap=%1 asked for: Windows only for now, "
                                           "nothing capped")
                                .arg(mbps);
#endif
}

void Cap::stop()
{
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (!m_Started) return;
    m_Started = false;
#ifdef _WIN32
    // Detached: it finishes after this worker has gone.
    const unsigned long pid = GetCurrentProcessId();
    if (QProcess::startDetached(powershell(), argumentsFor(offScript(pid))))
        qInfo().noquote() << "[HostCap] removing the cap (a detached PowerShell, twice 5 s apart)";
    else
        qWarning().noquote() << QStringLiteral("[HostCap] could not start the removal: the "
                                               "policies \"%1\" and \"%2\" stay until the next "
                                               "worker sweeps them, or a reboot")
                                    .arg(QString::fromStdString(capName(pid)),
                                         QString::fromStdString(streamName(pid)));
#endif
}

} // namespace mw::hostcap
