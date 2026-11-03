/*
 * MoonlightWeb - browser-based Sunshine/GameStream client.
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

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QString>

// The hosts that proved unable to run a second session of one app, kept on
// disk so they are never asked again (issue #36).
//
// The seamless quality switch opens a standby session beside the live one. On
// some Sunshine hosts the standby is answered as streaming and then never
// carries a picture - and the failed attempt can leave the running app unable
// to stream at all until it is quit. One such failure is proof enough: the
// cost of asking again is the user locked out of their game, so the answer
// outlives a restart of this server. A host that was never seen failing is
// assumed able, as before.
//
// One small file of its own (dual-support.json beside settings.json): host
// uuids only, nothing about the viewer.
class SingleSessionHosts
{
public:
    explicit SingleSessionHosts(QString path = QString())
        : m_Path(std::move(path))
    {
        load();
    }

    bool contains(const QString& hostUuid) const { return m_Hosts.contains(hostUuid); }

    /// Remember @p hostUuid for good. Returns true when it was not known yet.
    bool add(const QString& hostUuid)
    {
        if (hostUuid.isEmpty() || m_Hosts.contains(hostUuid)) return false;
        m_Hosts.insert(hostUuid);
        save();
        return true;
    }

    int size() const { return m_Hosts.size(); }

private:
    void load()
    {
        if (m_Path.isEmpty()) return;
        QFile f(m_Path);
        if (!f.open(QIODevice::ReadOnly)) return; // none yet
        const QJsonArray arr =
            QJsonDocument::fromJson(f.readAll()).object().value("single_session_hosts").toArray();
        for (const QJsonValue& v : arr) {
            const QString uuid = v.toString();
            if (!uuid.isEmpty()) m_Hosts.insert(uuid);
        }
    }

    void save() const
    {
        if (m_Path.isEmpty()) return;
        QJsonArray arr;
        for (const QString& uuid : m_Hosts)
            arr.append(uuid);
        QFile f(m_Path);
        if (f.open(QIODevice::WriteOnly | QIODevice::Truncate))
            f.write(QJsonDocument(QJsonObject{{"single_session_hosts", arr}})
                        .toJson(QJsonDocument::Indented));
    }

    QString m_Path;
    QSet<QString> m_Hosts;
};
