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

#include "HostAppImage.h"

#include <QBuffer>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QImageReader>
#include <QLinearGradient>
#include <QPainter>
#include <QSaveFile>

#ifdef Q_OS_WIN
#include <windows.h>
#endif

namespace HostAppImage {

#ifdef Q_OS_MACOS
// HostAppImageMac.mm: NSWorkspace's icon of a file or a bundle.
QImage macIconOf(const QString& path, int size);
#endif

namespace {

QString fileOf(const QString& dir, const QString& id)
{
    return dir + QLatin1Char('/') + id + QStringLiteral(".png");
}

} // namespace

QImage cardFrom(const QImage& image)
{
    if (image.isNull()) return {};
    const QImage scaled =
        image.convertToFormat(QImage::Format_ARGB32)
            .scaled(kWidth, kHeight, Qt::KeepAspectRatioByExpanding, Qt::SmoothTransformation);
    const int x = (scaled.width() - kWidth) / 2;
    const int y = (scaled.height() - kHeight) / 2;
    return scaled.copy(x, y, kWidth, kHeight);
}

QImage cardFromIcon(const QImage& icon)
{
    QImage card(kWidth, kHeight, QImage::Format_ARGB32);
    QPainter painter(&card);
    // The grid's dark, a shade lighter at the top: the icon sits in a card,
    // not on a hole.
    QLinearGradient background(0, 0, 0, kHeight);
    background.setColorAt(0.0, QColor(0x22, 0x25, 0x2d));
    background.setColorAt(1.0, QColor(0x15, 0x17, 0x1c));
    painter.fillRect(card.rect(), background);
    if (!icon.isNull()) {
        const int side = kWidth * 45 / 100;
        const QImage scaled =
            icon.scaled(side, side, Qt::KeepAspectRatio, Qt::SmoothTransformation);
        painter.setRenderHint(QPainter::SmoothPixmapTransform);
        painter.drawImage((kWidth - scaled.width()) / 2, (kHeight - scaled.height()) / 2, scaled);
    }
    painter.end();
    return card;
}

bool decodeUpload(const QByteArray& png, QImage* out, QString* error)
{
    const auto fail = [error](const QString& why) {
        if (error) *error = why;
        return false;
    };
    if (png.isEmpty()) return fail(QStringLiteral("the image is empty"));
    if (png.size() > kMaxUploadBytes)
        return fail(
            QStringLiteral("the image is larger than %1 MB").arg(kMaxUploadBytes / (1024 * 1024)));
    QBuffer buffer;
    buffer.setData(png);
    buffer.open(QIODevice::ReadOnly);
    QImageReader reader(&buffer, "png");
    // The size is read from the header first: a small file that would
    // decode into a huge picture is refused before it is.
    const QSize size = reader.size();
    if (!size.isValid()) return fail(QStringLiteral("the image is not a PNG"));
    if (size.width() > kMaxUploadSide || size.height() > kMaxUploadSide)
        return fail(QStringLiteral("the image is larger than %1 pixels").arg(kMaxUploadSide));
    QImage image;
    if (!reader.read(&image) || image.isNull())
        return fail(QStringLiteral("the image is not a PNG"));
    *out = image;
    return true;
}

QString store(const QString& dir, const QString& id, const QImage& card, QString* error)
{
    QByteArray png;
    QBuffer buffer(&png);
    buffer.open(QIODevice::WriteOnly);
    if (card.isNull() || !card.save(&buffer, "PNG")) {
        if (error) *error = QStringLiteral("the image could not be encoded");
        return QString();
    }
    QDir().mkpath(dir);
    QSaveFile file(fileOf(dir, id));
    if (!file.open(QIODevice::WriteOnly) || file.write(png) != png.size() || !file.commit()) {
        if (error)
            *error = QStringLiteral("the image could not be written: %1").arg(file.errorString());
        return QString();
    }
    return QString::fromLatin1(
        QCryptographicHash::hash(png, QCryptographicHash::Sha256).toHex().left(16));
}

QByteArray read(const QString& dir, const QString& id)
{
    QFile file(fileOf(dir, id));
    if (!file.open(QIODevice::ReadOnly)) return {};
    return file.readAll();
}

void remove(const QString& dir, const QString& id)
{
    QFile::remove(fileOf(dir, id));
}

QImage iconOf(const QString& path, int size)
{
    if (path.isEmpty()) return {};
#if defined(Q_OS_WIN)
    if (path.endsWith(QStringLiteral(".exe"), Qt::CaseInsensitive)) {
        // The icon resource itself, read from the file: the shell's image
        // factories would load its extensions into this process instead.
        HICON icon = nullptr;
        UINT iconId = 0;
        const UINT got = ::PrivateExtractIconsW(reinterpret_cast<LPCWSTR>(path.utf16()), 0, size,
                                                size, &icon, &iconId, 1, 0);
        if (got == 0 || got == 0xFFFFFFFF || !icon) return {};
        QImage image = QImage::fromHICON(icon);
        ::DestroyIcon(icon);
        return image;
    }
#elif defined(Q_OS_MACOS)
    if (path.endsWith(QStringLiteral(".app"), Qt::CaseInsensitive)) return macIconOf(path, size);
#endif
    QImage image(path);
    if (image.isNull()) return {};
    return image.scaled(size, size, Qt::KeepAspectRatio, Qt::SmoothTransformation);
}

} // namespace HostAppImage
