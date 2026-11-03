/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The bench's `capture=` key as the server reads it before a launch
 * (CaptureKey.h): a worker asked for Windows.Graphics.Capture must not be
 * SYSTEM, and the one key is read out of a spec the server otherwise never
 * parses.
 */

#include "../src/streaming/CaptureKey.h"

#include "test_framework.h"

#include <string>

void run_capture_key_tests()
{
    SECTION("capture key — wgc asks for the user's token, nothing else does");
    {
        using mw::capturekey::asksWgc;
        CHECK(!asksWgc("")); // the product: no native_tuning at all
        CHECK(!asksWgc("capture=auto"));
        CHECK(!asksWgc("capture=dda"));
        CHECK(asksWgc("capture=wgc"));
        // Among the native host's keys, either separator, spaces and case.
        CHECK(asksWgc("preset=1,capture=wgc;retrcut=3"));
        CHECK(asksWgc(" Capture = WGC "));
        // The last one said wins, as in the native host's parser.
        CHECK(!asksWgc("capture=wgc,capture=dda"));
        CHECK(asksWgc("capture=dda,capture=wgc"));
        // Nothing it cannot read asks for it: a value it does not know, a key
        // that is not a pair, a key that only starts the same.
        CHECK(!asksWgc("capture=portal"));
        CHECK(!asksWgc("capture"));
        CHECK(!asksWgc("captureapi=wgc"));
        CHECK(!asksWgc("garbage,,;"));
        // A value it does not know after wgc leaves the last word said.
        CHECK(asksWgc("capture=wgc,capture=portal"));
    }
}
