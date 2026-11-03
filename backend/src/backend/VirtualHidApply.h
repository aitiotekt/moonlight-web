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

#include "backend/DriverPackage.h"

#include <QString>

#include <vector>

/**
 * @brief The `--vhid-apply` mode: the installer's elevated half of
 * "MoonlightWeb Virtual HID", the Windows driver the HID passthrough recreates
 * wheels and radios with (backend/native-host/drivers/vhid, WinUHid's UMDF2
 * driver over the inbox Virtual HID Framework).
 *
 *   install    re-hash the bundled package ({app}\drivers\vhid) against the
 *              constants below, trust the catalog's signer for the duration
 *              (our own certificate: Root and Trusted Publishers, out of both
 *              again before it returns), create the root-enumerated System
 *              node Root\MoonlightWebVHid if there is none, and install the
 *              package on it, so an update brings a newer driver — unless
 *              the node's driver is already these very files: an update
 *              that brings none restarts nothing. The node stays enabled: it
 *              only offers \\.\MoonlightWebVHid, and nothing appears to a
 *              game until a stream attaches a device.
 *   uninstall  forget this edition; when it had installed the driver and no
 *              other MoonlightWeb edition is left using it, remove the node
 *              and the package. A driver put there by hand (install.ps1, on
 *              a bench machine in test mode) belongs to no edition and stays.
 *
 * Nothing to do is not a failure: a build that pins no package, or an
 * installer that bundled none (Windows on ARM: the driver is x64 only), exits
 * 0 with "skipped". The engine's probe then reports the passthrough
 * unavailable, as on any machine without the driver.
 *
 * Prints one JSON line on stdout. Exit 0 done or skipped, 1 failed, 3010 done
 * but Windows wants a reboot: a game still held a device made through the old
 * driver, which stays loaded until then. The engine works with either (the
 * client library asks the driver which fixes it has).
 */
namespace VirtualHidApply {

/// The hardware id the INF binds to: ours alone (never WinUHid's own).
inline QString hardwareId()
{
    return QStringLiteral("Root\\MoonlightWebVHid");
}

/// The node's name in Device Manager.
inline QString deviceName()
{
    return QStringLiteral("MoonlightWeb Virtual HID");
}

/// The package under backend/installer/drivers/vhid, as build.ps1 -Sign Own
/// made it on 19/10/2026 (driver 0.1.2.0: the host's own mouse, after the
/// event wakeup of 0.1.1.0), pinned file by file: any other bytes, and the
/// install refuses. A new driver means a new package there, a higher -Version,
/// and new pins here, all printed by build.ps1. A test-signed package is never
/// bundled. x64 only: Windows on ARM takes a driver package only signed by
/// Microsoft (0x800b0109, "Code Integrity is enforced", mw-arm, 20/10/2026),
/// so an ARM64 build bundles none, and the helper finds nothing to install.
inline const std::vector<DriverPackage::File>& driverFiles()
{
    static const std::vector<DriverPackage::File> files = {
        {"MoonlightWebVHid.inf",
         "c9b5843f81fd8e3e128c90eaac76b7724760862812b97acc2f212e8f6db75544"},
        {"MoonlightWebVHid.cat",
         "b680ce2a6b8be715228b391e9c492f5d7e7f3e5ba068b9e805fea3800534b1db"},
        {"MoonlightWebVHid.dll",
         "0a603918f1b9321badfb1dceaa56fb53c3cfec749db06634d03a3bdb1f2ec1c1"},
    };
    return files;
}

/// SHA-1 thumbprint of the certificate that signs the catalog, the only
/// publisher the install ever trusts: MoonlightWeb's own, self-signed
/// ("MoonlightWeb Virtual HID", code signing only, not a CA). Its private key
/// stays on the release maintainer's machine, outside the repository.
inline QString catalogSignerThumbprint()
{
    return QStringLiteral("1dd1af0ceb20f734dcfef39267de14ec3bffbc8d");
}

/// {app}\drivers\vhid: derived from the exe's own location, never from a
/// request.
QString bundledDriverDir();

/// @param action "install" | "uninstall"
/// @param dir    the package's directory; empty = bundledDriverDir()
/// @return process exit code: 0 ok or skipped, 1 failed, 3010 ok but reboot required
int run(const QString& action, const QString& dir);

} // namespace VirtualHidApply
