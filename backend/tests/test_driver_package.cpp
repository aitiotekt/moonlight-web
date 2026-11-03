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

#include "backend/DriverPackage.h"
#include "backend/VirtualHidApply.h"
#include "test_framework.h"

#include <QFile>
#include <QRegularExpression>
#include <QTemporaryDir>

// The gate in front of SetupAPI for the drivers MoonlightWeb bundles: a file
// that does not hash to its pin is never installed. And the pins of
// "MoonlightWeb Virtual HID", which stay empty until the product signature
// exists — an installer must then set nothing up rather than half of it.

namespace {

bool isHex(const QString& s, int len)
{
    static const QRegularExpression re(QStringLiteral("^[0-9a-f]+$"));
    return s.size() == len && re.match(s).hasMatch();
}

void write(const QString& path, const QByteArray& bytes)
{
    QFile f(path);
    if (f.open(QIODevice::WriteOnly)) f.write(bytes);
}

} // namespace

void run_driver_package_tests()
{
    SECTION("DriverPackage — a file is installed only when it hashes to its pin");
    {
        QTemporaryDir tmp;
        CHECK(tmp.isValid());
        write(tmp.filePath(QStringLiteral("x.inf")), "inf");
        write(tmp.filePath(QStringLiteral("x.cat")), "cat");
        // Lowercase hex, as the pins are written.
        CHECK_EQ(
            DriverPackage::fileSha256(tmp.filePath(QStringLiteral("x.inf"))),
            QStringLiteral("e99270c4fa9f6ea70486c8a763d7519b57ce1a4a9a0c6e0ca3bec74a82e38c24"));
        const DriverPackage::File good[] = {
            {"x.inf", "e99270c4fa9f6ea70486c8a763d7519b57ce1a4a9a0c6e0ca3bec74a82e38c24"},
            {"x.cat", "77af778b51abd4a3c51c5ddd97204a9c3ae614ebccb75a606c3b6865aed6744e"}};
        QString inf, cat;
        CHECK(DriverPackage::checkFiles(tmp.path(), good, 2, &inf, &cat).isEmpty());
        CHECK(inf.endsWith(QLatin1String("/x.inf")));
        CHECK(cat.endsWith(QLatin1String("/x.cat")));

        // One byte off, or a file gone: refused, and the file is named.
        write(tmp.filePath(QStringLiteral("x.cat")), "cat!");
        QString why = DriverPackage::checkFiles(tmp.path(), good, 2, &inf, &cat);
        CHECK(why.contains(QLatin1String("x.cat")));
        QFile::remove(tmp.filePath(QStringLiteral("x.inf")));
        why = DriverPackage::checkFiles(tmp.path(), good, 2, &inf, &cat);
        CHECK(why.contains(QLatin1String("x.inf")));
        CHECK(DriverPackage::fileSha256(tmp.filePath(QStringLiteral("x.inf"))).isEmpty());
    }

    SECTION("VirtualHid — the driver is pinned whole, or not at all");
    {
        using namespace VirtualHidApply;
        const auto& files = driverFiles();
        const QString signer = catalogSignerThumbprint();
        // Both or neither: a half-filled pin set would let the helper trust a
        // publisher for a package it cannot check, or the reverse.
        CHECK_EQ(files.empty(), signer.isEmpty());
        if (!files.empty()) {
            CHECK_EQ(int(files.size()), 3);
            bool inf = false, cat = false, dll = false;
            for (const DriverPackage::File& f : files) {
                CHECK(isHex(QString::fromLatin1(f.sha256), 64));
                const QString name = QString::fromLatin1(f.name);
                CHECK(!name.contains(QLatin1Char('/')) && !name.contains(QLatin1Char('\\')));
                inf = inf || name == QLatin1String("MoonlightWebVHid.inf");
                cat = cat || name == QLatin1String("MoonlightWebVHid.cat");
                dll = dll || name == QLatin1String("MoonlightWebVHid.dll");
            }
            CHECK(inf && cat && dll);
            CHECK(isHex(signer, 40));
            // The package the installer bundles is the one pinned: a driver
            // rebuilt without new pins would be refused on every machine.
            QString infPath, catPath;
            CHECK(DriverPackage::checkFiles(QStringLiteral(MW_INSTALLER_DRIVERS_DIR "/vhid"),
                                            files.data(), files.size(), &infPath, &catPath)
                      .isEmpty());
            CHECK(!infPath.isEmpty() && !catPath.isEmpty());
        }
        // The id the INF binds to (native-host/drivers/vhid) and install.ps1
        // uses: ours alone, never WinUHid's.
        CHECK_EQ(hardwareId(), QStringLiteral("Root\\MoonlightWebVHid"));
    }
}
