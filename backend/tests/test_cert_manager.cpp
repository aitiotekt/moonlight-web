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

#include "test_framework.h"
#include "server/CertManager.h"

#include <QDir>
#include <QFile>
#include <QStandardPaths>

#include <openssl/pem.h>
#include <openssl/x509.h>

static QByteArray readAll(const QString& path)
{
    QFile f(path);
    return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}

/// Whether the cert file at @p certPath was signed for the key at @p keyPath
/// (what a TLS handshake needs; a mismatch is "key values mismatch").
static bool certMatchesKey(const QString& certPath, const QString& keyPath)
{
    const QByteArray certPem = readAll(certPath);
    const QByteArray keyPem = readAll(keyPath);
    BIO* certBio = BIO_new_mem_buf(certPem.constData(), static_cast<int>(certPem.size()));
    BIO* keyBio = BIO_new_mem_buf(keyPem.constData(), static_cast<int>(keyPem.size()));
    X509* cert = certBio ? PEM_read_bio_X509(certBio, nullptr, nullptr, nullptr) : nullptr;
    EVP_PKEY* key = keyBio ? PEM_read_bio_PrivateKey(keyBio, nullptr, nullptr, nullptr) : nullptr;
    const bool match = cert && key && X509_check_private_key(cert, key) == 1;
    if (cert) X509_free(cert);
    if (key) EVP_PKEY_free(key);
    if (certBio) BIO_free(certBio);
    if (keyBio) BIO_free(keyBio);
    return match;
}

void run_cert_manager_tests()
{
    SECTION("CertManager: local cert keeps its key across restarts");

    // The runner's own AppData (main() names the app), emptied before and after.
    const QString certDir =
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/cert/";
    const QString certPath = certDir + "local-cert.pem";
    const QString keyPath = certDir + "local-key.pem";
    QDir(certDir).removeRecursively();

    // First start: a new key and a cert signed with it.
    CertManager first;
    first.ensureLocalSslConfig();
    const QByteArray key1 = readAll(keyPath);
    const QByteArray cert1 = readAll(certPath);
    CHECK(!key1.isEmpty());
    CHECK(!cert1.isEmpty());
    CHECK(certMatchesKey(certPath, keyPath));
    CHECK(!first.localConfig().localCertificate().isNull());
    CHECK(!first.localConfig().privateKey().isNull());

    // A restart: the same key (what a client pinned), a new cert (fresh SANs and
    // validity), and the two still go together.
    CertManager second;
    second.ensureLocalSslConfig();
    CHECK(readAll(keyPath) == key1);
    CHECK(readAll(certPath) != cert1);
    CHECK(certMatchesKey(certPath, keyPath));
    CHECK(!second.localConfig().localCertificate().isNull());

    // A key file that cannot be read: a fresh key, never a server without TLS.
    {
        QFile f(keyPath);
        CHECK(f.open(QIODevice::WriteOnly | QIODevice::Truncate));
        f.write("not a key");
    }
    CertManager third;
    third.ensureLocalSslConfig();
    const QByteArray key3 = readAll(keyPath);
    CHECK(!key3.isEmpty());
    CHECK(key3 != key1);
    CHECK(certMatchesKey(certPath, keyPath));
    CHECK(!third.localConfig().privateKey().isNull());

    // The key file gone (the way to rotate it): a fresh key as well.
    QFile::remove(keyPath);
    CertManager fourth;
    fourth.ensureLocalSslConfig();
    CHECK(!readAll(keyPath).isEmpty());
    CHECK(readAll(keyPath) != key3);
    CHECK(certMatchesKey(certPath, keyPath));

    QDir(certDir).removeRecursively();
}
