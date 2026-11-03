/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

#include "test_framework.h"
#include "streaming/HidParkedJson.h"

#include <QJsonArray>
#include <QJsonDocument>

using mw::native::HidFfb;
using mw::native::HidParkedState;
using mw::native::HidParking;

void run_hid_parked_json_tests()
{
    SECTION("HidParkedJson — an operation reads back as the page's hidffb has it");
    {
        HidFfb op;
        op.op = "effect";
        op.effect = 3;
        op.kind = "constant";
        op.fields = {{"duration", -1}, {"gain", 255}};
        QJsonObject j = hidFfbToJson(op);
        CHECK_EQ(j["op"].toString(), QStringLiteral("effect"));
        CHECK_EQ(j["kind"].toString(), QStringLiteral("constant"));
        CHECK_EQ(j["duration"].toInt(), -1);
        j["type"] = QStringLiteral("hidffb");
        j["slot"] = 2;
        const HidFfb back = hidFfbFromJson(j);
        CHECK_EQ(back.op, std::string("effect"));
        CHECK_EQ(back.effect, 3);
        CHECK_EQ(back.kind, std::string("constant"));
        CHECK_EQ(back.fields.size(), static_cast<size_t>(2)); // type and slot are not fields
    }

    SECTION("HidParkedJson — a kept wheel goes from one process to the next whole");
    {
        HidParkedState s;
        s.name = "G923 Racing Wheel for Xbox One and PC";
        s.vendorId = 0x046d;
        s.productId = 0xc26e;
        s.version = 0x2001;
        s.descriptor = {0x05, 0x01, 0x09, 0x04, 0xA1, 0x01, 0xC0};
        s.first = {{1, {0x08, 0x00, 0xff, 0xff}}};
        s.last = {{1, {0x08, 0x00, 0x80, 0xff}}, {17, std::vector<uint8_t>(19, 0x11)}};
        s.pidFirstId = 19;
        s.pidState = std::vector<uint8_t>(42, 0);
        s.pidState[2] = 1;
        HidFfb constant;
        constant.op = "constant";
        constant.effect = 1;
        constant.fields = {{"magnitude", -2500}};
        s.effects = {constant};
        s.keepMs = 123456;
        // Through text, as it travels on the worker's pipe.
        const QJsonObject j =
            QJsonDocument::fromJson(QJsonDocument(hidParkedToJson(s)).toJson()).object();
        HidParkedState r;
        CHECK(hidParkedFromJson(j, &r));
        CHECK_EQ(r.name, s.name);
        CHECK(r.vendorId == s.vendorId && r.productId == s.productId && r.version == s.version);
        CHECK(r.descriptor == s.descriptor);
        CHECK(r.first == s.first);
        CHECK(r.last == s.last);
        CHECK_EQ(static_cast<int>(r.pidFirstId), 19);
        CHECK(r.pidState == s.pidState);
        CHECK_EQ(r.effects.size(), static_cast<size_t>(1));
        if (!r.effects.empty()) {
            CHECK_EQ(r.effects[0].op, std::string("constant"));
            CHECK(r.effects[0].fields ==
                  (std::vector<std::pair<std::string, int32_t>>{{"magnitude", -2500}}));
        }
        CHECK_EQ(r.keepMs, int64_t{123456});
    }

    SECTION("HidParkedJson — what cannot be a kept device is refused");
    {
        HidParkedState s;
        s.descriptor = {0x05, 0x01};
        QJsonObject j = hidParkedToJson(s);
        HidParkedState r;
        CHECK(hidParkedFromJson(j, &r));

        QJsonObject none = j;
        none["descriptor"] = QString();
        CHECK(!hidParkedFromJson(none, &r));
        QJsonObject id = j;
        id["vendorId"] = 70000;
        CHECK(!hidParkedFromJson(id, &r));
        QJsonObject report = j;
        report["last"] = QJsonArray{QJsonObject{{"id", 300}, {"report", QString()}}};
        CHECK(!hidParkedFromJson(report, &r));
        QJsonObject huge = j;
        huge["descriptor"] = QString::fromLatin1(QByteArray(5000, 'x').toBase64());
        CHECK(!hidParkedFromJson(huge, &r));
        // Kept no longer than the parking keeps anything, nor less than nothing.
        QJsonObject longer = j;
        longer["keepMs"] = 1e12;
        CHECK(hidParkedFromJson(longer, &r));
        CHECK_EQ(r.keepMs, HidParking::kKeepMs);
        longer["keepMs"] = -5;
        CHECK(hidParkedFromJson(longer, &r));
        CHECK_EQ(r.keepMs, int64_t{0});
    }
}
