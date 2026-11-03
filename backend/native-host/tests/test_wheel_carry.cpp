/*
 * MoonlightWeb — native capture & encoding engine, test suite.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>. GPLv3.
 */
#include "native_test_framework.h"

#include "input/WheelCarry.h"

using namespace mw::native::input;

// A notch the browser sends in pieces still scrolls by one notch on a Linux
// host. Each piece used to be divided by 120 on its own, came out 0 and was
// lost: the wheel moved about one turn in four (12/10/2026, UM790Pro from
// DualRTX). Pure integers, tested on every platform.

void run_wheel_carry_tests()
{
    SECTION("Wheel carry — a notch in pieces still scrolls a notch");

    // Whole notches go through as they come.
    {
        WheelCarry c;
        CHECK_EQ(c.add(120), 1);
        CHECK_EQ(c.add(240), 2);
        CHECK_EQ(c.add(-120), -1);
        CHECK_EQ(c.pending(), 0);
    }

    // Four pieces of 30 make one notch, on the fourth.
    {
        WheelCarry c;
        CHECK_EQ(c.add(30), 0);
        CHECK_EQ(c.add(30), 0);
        CHECK_EQ(c.add(30), 0);
        CHECK_EQ(c.add(30), 1);
        CHECK_EQ(c.pending(), 0);
    }

    // Ten pieces of 40 down: three notches, and 40 kept for the next.
    {
        WheelCarry c;
        int32_t total = 0;
        for (int i = 0; i < 10; ++i)
            total += c.add(-40);
        CHECK_EQ(total, -3);
        CHECK_EQ(c.pending(), -40);
    }

    // A piece larger than a notch keeps its own remainder.
    {
        WheelCarry c;
        CHECK_EQ(c.add(200), 1);
        CHECK_EQ(c.pending(), 80);
        CHECK_EQ(c.add(40), 1);
        CHECK_EQ(c.pending(), 0);
    }

    // Turning back drops what was left of the other way: the first notch up
    // after 100 down takes a whole notch up, not 220.
    {
        WheelCarry c;
        CHECK_EQ(c.add(-100), 0);
        CHECK_EQ(c.add(60), 0);
        CHECK_EQ(c.pending(), 60);
        CHECK_EQ(c.add(60), 1);
    }
}
