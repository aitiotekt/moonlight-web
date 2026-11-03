/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The bench's silent video section, `rxbuf=1` (RxBufSection.h).
 *
 * Its payload types must not collide with the bundle's other sections, and
 * the log must say plainly whether a browser kept it: Safari, iOS and the TVs
 * have no console to ask.
 */

#include "../src/streaming/RxBufSection.h"

#include "test_framework.h"

#include <string>
#include <vector>

void run_rxbuf_section_tests()
{
    SECTION("rxbuf section — its payload types stay apart from the bundle's others");
    {
        // 96 the RTP video, 97 Ultra's VP8, 109 to 111 the Opus tracks.
        for (const int other : {96, 97, 109, 110, 111}) {
            CHECK(mw::rxbuf::kH264Pt != other);
            CHECK(mw::rxbuf::kVp8Pt != other);
        }
        CHECK(mw::rxbuf::kH264Pt != mw::rxbuf::kVp8Pt);
        // In the dynamic range (RFC 3551).
        CHECK(mw::rxbuf::kH264Pt >= 96 && mw::rxbuf::kH264Pt <= 127);
        CHECK(mw::rxbuf::kVp8Pt >= 96 && mw::rxbuf::kVp8Pt <= 127);
    }

    SECTION("rxbuf section — what the answer made of it");
    {
        using mw::rxbuf::kH264Pt;
        using mw::rxbuf::kVp8Pt;
        using mw::rxbuf::verdict;
        // Chrome keeps both, in its own order.
        CHECK_EQ(verdict(true, false, false, {kVp8Pt, kH264Pt}), std::string("taken, VP8 + H.264"));
        // A Firefox without OpenH264: VP8 alone.
        CHECK_EQ(verdict(true, false, false, {kVp8Pt}), std::string("taken, VP8"));
        // A page without RTCRtpScriptTransform sets it inactive.
        CHECK_EQ(verdict(true, false, true, {kH264Pt}), std::string("taken, inactive, H.264"));
        // No codec in common: port 0.
        CHECK_EQ(verdict(true, true, false, {}),
                 std::string("refused, no codec in common: the browser's buffer stays as it was"));
        CHECK_EQ(verdict(false, false, false, {}), std::string("missing from the answer"));
        // A payload type the offer never had is not named as one of ours.
        CHECK_EQ(verdict(true, false, false, {120}),
                 std::string("taken, none of its codecs named"));
    }

    SECTION("rxbuf section — a GameStream host's session: on unless rxbuf=0");
    {
        using mw::rxbuf::offeredFromSpec;
        CHECK(offeredFromSpec("")); // the product: no native_tuning at all
        CHECK(offeredFromSpec("rxbuf=1"));
        CHECK(!offeredFromSpec("rxbuf=0"));
        // Among the native host's keys, either separator, spaces and case.
        CHECK(!offeredFromSpec("preset=1,rxbuf=0;retrcut=3"));
        CHECK(!offeredFromSpec(" RxBuf = 0 "));
        // The last one said wins, as in the native host's parser.
        CHECK(offeredFromSpec("rxbuf=0,rxbuf=1"));
        // Nothing it cannot read turns it off: a value other than 0 or 1, a
        // native key that is not a pair, a key that only starts the same.
        CHECK(offeredFromSpec("rxbuf=2"));
        CHECK(offeredFromSpec("rxbuf=off"));
        CHECK(offeredFromSpec("rxbuf"));
        CHECK(offeredFromSpec("rxbuffer=0"));
        CHECK(offeredFromSpec("garbage,,;"));
    }
}
