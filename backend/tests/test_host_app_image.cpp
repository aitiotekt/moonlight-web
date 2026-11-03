/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 */
#include "test_framework.h"
#include "server/HostAppImage.h"

#include <QBuffer>
#include <QFile>
#include <QTemporaryDir>

namespace {

QByteArray pngOf(const QImage& image)
{
    QByteArray png;
    QBuffer buffer(&png);
    buffer.open(QIODevice::WriteOnly);
    image.save(&buffer, "PNG");
    return png;
}

} // namespace

void run_host_app_image_tests()
{
    SECTION("HostAppImage");

    // A landscape picture is cropped to the card's portrait, from its middle:
    // red left, green middle, blue right — the card is all green.
    {
        QImage wide(1200, 400, QImage::Format_ARGB32);
        wide.fill(Qt::green);
        for (int y = 0; y < 400; ++y)
            for (int x = 0; x < 300; ++x) {
                wide.setPixelColor(x, y, Qt::red);
                wide.setPixelColor(1199 - x, y, Qt::blue);
            }
        const QImage card = HostAppImage::cardFrom(wide);
        CHECK_EQ(card.width(), HostAppImage::kWidth);
        CHECK_EQ(card.height(), HostAppImage::kHeight);
        CHECK(card.pixelColor(0, 400) == QColor(Qt::green));
        CHECK(card.pixelColor(599, 400) == QColor(Qt::green));
    }

    // An icon card: the card's size, dark at its corner, the icon in the middle.
    {
        QImage icon(64, 64, QImage::Format_ARGB32);
        icon.fill(Qt::white);
        const QImage card = HostAppImage::cardFromIcon(icon);
        CHECK_EQ(card.size(), QSize(HostAppImage::kWidth, HostAppImage::kHeight));
        CHECK(card.pixelColor(2, 2).lightness() < 60);
        CHECK(card.pixelColor(300, 400) == QColor(Qt::white));
        CHECK(!HostAppImage::cardFromIcon(QImage()).isNull());
    }

    // Uploads: a PNG within the limits only.
    {
        QImage small(30, 40, QImage::Format_ARGB32);
        small.fill(Qt::black);
        QImage decoded;
        QString why;
        CHECK(HostAppImage::decodeUpload(pngOf(small), &decoded, &why));
        CHECK_EQ(decoded.size(), QSize(30, 40));
        CHECK(!HostAppImage::decodeUpload(QByteArray(), &decoded, &why));
        CHECK(!HostAppImage::decodeUpload("GIF89a not a png", &decoded, &why));
        CHECK(why.contains("PNG"));
        QImage huge(HostAppImage::kMaxUploadSide + 1, 2, QImage::Format_ARGB32);
        huge.fill(Qt::black);
        CHECK(!HostAppImage::decodeUpload(pngOf(huge), &decoded, &why));
        CHECK(why.contains("pixels"));
        CHECK(!HostAppImage::decodeUpload(QByteArray(HostAppImage::kMaxUploadBytes + 1, 'x'),
                                          &decoded, &why));
    }

    // Stored under the app's id, its hash changing with its pixels.
    {
        QTemporaryDir tmp;
        QImage a(HostAppImage::kWidth, HostAppImage::kHeight, QImage::Format_ARGB32);
        a.fill(Qt::red);
        QString why;
        const QString hashA = HostAppImage::store(tmp.path(), "id-1", a, &why);
        CHECK_EQ(hashA.size(), 16);
        CHECK(!HostAppImage::read(tmp.path(), "id-1").isEmpty());
        a.fill(Qt::blue);
        const QString hashB = HostAppImage::store(tmp.path(), "id-1", a, &why);
        CHECK(hashA != hashB);
        HostAppImage::remove(tmp.path(), "id-1");
        CHECK(HostAppImage::read(tmp.path(), "id-1").isEmpty());
        CHECK(HostAppImage::read(tmp.path(), "missing").isEmpty());
    }

    // An icon read from an image file anywhere; nothing from nothing.
    {
        QTemporaryDir tmp;
        QImage icon(512, 512, QImage::Format_ARGB32);
        icon.fill(Qt::yellow);
        const QString path = tmp.path() + "/steam.png";
        CHECK(icon.save(path, "PNG"));
        const QImage read = HostAppImage::iconOf(path, 256);
        CHECK_EQ(read.size(), QSize(256, 256));
        CHECK(HostAppImage::iconOf(QString()).isNull());
        CHECK(HostAppImage::iconOf(tmp.path() + "/missing.png").isNull());
    }
}
