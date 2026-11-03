/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * Whether a lost frame is healed by a delta (EncoderTuning.h,
 * healsByReference): the answer /start gives the browser as
 * `ref_invalidation`, and the relay's question before it names a loss to the
 * encoder. A client that refused the repairs hears false on every encoder:
 * one reference alone leaves NVENC and VA-API invalidating, and an Apple
 * decoder told true decoded on through gaps that VideoToolbox then rejected
 * (25/10/2026).
 */

#include "mw/native/EncoderTuning.h"

#include "test_framework.h"

void run_reference_repairs_tests()
{
    using mw::native::healsByReference;

    SECTION("healsByReference — an encoder that invalidates, a client that takes it: a delta");
    CHECK(healsByReference(true, true));

    SECTION("healsByReference — the client refused: a keyframe, whatever the encoder can do");
    {
        // NVENC at one reference still says it invalidates
        // (SessionInfo::referenceInvalidation): the refusal wins over it.
        mw::native::EncoderTuning t;
        CHECK(mw::native::refuseReferenceRepairs(t));
        CHECK_EQ(t.dpbFrames, 1);
        CHECK(!healsByReference(true, false));
    }

    SECTION("healsByReference — an encoder without it: a keyframe, as before");
    {
        CHECK(!healsByReference(false, true));
        CHECK(!healsByReference(false, false));
    }
}
