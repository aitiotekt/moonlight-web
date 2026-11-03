/*
 * MoonlightWeb — native capture & encoding engine.
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

#include "audio/AudioPacer.h"
#include "native_test_framework.h"

#ifdef MW_NATIVE_TESTS_HAVE_OPUS
#include "audio/OpusEncoder.h"

#include <opus.h>

#include <cstdint>
#include <string>
#endif

#include <vector>

using mw::native::audio::AudioPacer;

namespace {

/// `frames` stereo samples where every float carries `value`.
std::vector<float> tone(size_t frames, float value)
{
    return std::vector<float>(frames * AudioPacer::kChannels, value);
}

bool allEqual(const std::vector<float>& v, float value)
{
    for (float f : v)
        if (f != value) return false;
    return true;
}

} // namespace

void run_audio_pacer_tests()
{
    SECTION("AudioPacer — one frame due every 5 ms, none before the clock starts");
    {
        AudioPacer pacer(4);
        CHECK_EQ(pacer.dueFrames(1'000'000), 0); // not started: nothing owed
        pacer.start(1'000'000);
        CHECK_EQ(pacer.dueFrames(1'004'999), 0);
        CHECK_EQ(pacer.dueFrames(1'005'000), 1);
        std::vector<float> out(AudioPacer::kFrameFloats, 1.0f);
        pacer.pop(out.data());
        CHECK_EQ(pacer.nextDueUs(), int64_t(1'010'000));
        // 17 ms after the start: the frames due at 10 and 15 ms are both owed.
        CHECK_EQ(pacer.dueFrames(1'017'000), 2);
    }

    SECTION("AudioPacer — a 10 ms WASAPI burst becomes two 5 ms frames, in order");
    {
        AudioPacer pacer(4);
        pacer.start(0);
        std::vector<float> a = tone(240, 0.25f);
        std::vector<float> b = tone(240, 0.5f);
        std::vector<float> burst;
        burst.insert(burst.end(), a.begin(), a.end());
        burst.insert(burst.end(), b.begin(), b.end());
        pacer.push(burst.data(), 480);
        CHECK_EQ(pacer.queuedFrames(), size_t(2));

        std::vector<float> out(AudioPacer::kFrameFloats);
        CHECK(pacer.pop(out.data()));
        CHECK(allEqual(out, 0.25f));
        CHECK(pacer.pop(out.data()));
        CHECK(allEqual(out, 0.5f));
        CHECK_EQ(pacer.queuedFrames(), size_t(0));
        CHECK_EQ(pacer.underruns(), int64_t(0));
    }

    SECTION("AudioPacer — an empty queue sends silence and counts the underrun");
    {
        AudioPacer pacer(4);
        pacer.start(0);
        std::vector<float> out(AudioPacer::kFrameFloats, 9.0f);
        CHECK(!pacer.pop(out.data()));
        CHECK(allEqual(out, 0.0f));
        CHECK_EQ(pacer.underruns(), int64_t(1));
        // A partial frame is kept for the next tick, not sent as a hole.
        std::vector<float> half = tone(120, 0.7f);
        pacer.push(half.data(), 120);
        CHECK(!pacer.pop(out.data()));
        CHECK_EQ(pacer.underruns(), int64_t(2));
        pacer.push(half.data(), 120);
        CHECK(pacer.pop(out.data()));
        CHECK(allEqual(out, 0.7f));
    }

    SECTION("AudioPacer — the queue cap drops the OLDEST frames, whole frames only");
    {
        AudioPacer pacer(2); // 10 ms of latency at most
        pacer.start(0);
        std::vector<float> one = tone(240, 1.0f);
        std::vector<float> two = tone(240, 2.0f);
        std::vector<float> three = tone(240, 3.0f);
        pacer.push(one.data(), 240);
        pacer.push(two.data(), 240);
        pacer.push(three.data(), 240);
        CHECK_EQ(pacer.queuedFrames(), size_t(2));
        CHECK_EQ(pacer.droppedFrames(), int64_t(1));
        std::vector<float> out(AudioPacer::kFrameFloats);
        pacer.pop(out.data());
        CHECK(allEqual(out, 2.0f)); // the oldest (1.0) is what went
        pacer.pop(out.data());
        CHECK(allEqual(out, 3.0f));
    }

    SECTION("AudioPacer::peakOf — the largest absolute sample, a negative one included");
    {
        std::vector<float> frame(AudioPacer::kFrameFloats, 0.0f);
        CHECK_EQ(AudioPacer::peakOf(frame.data()), 0.0f);
        frame[3] = 0.25f;
        frame[AudioPacer::kFrameFloats - 1] = -0.5f; // the last float counts
        CHECK_EQ(AudioPacer::peakOf(frame.data()), 0.5f);
        CHECK_EQ(AudioPacer::peakOf(nullptr), 0.0f);
    }

    SECTION("AudioPacer — silence pushed by the endpoint is queued like any sample");
    {
        AudioPacer pacer(4);
        pacer.start(0);
        pacer.pushSilence(240);
        std::vector<float> out(AudioPacer::kFrameFloats, 5.0f);
        CHECK(pacer.pop(out.data())); // real (silent) data, not an underrun
        CHECK(allEqual(out, 0.0f));
        CHECK_EQ(pacer.underruns(), int64_t(0));
    }

    SECTION("AudioPacer — take() waits for a late capture, then sends silence past the grace");
    {
        AudioPacer pacer(8);
        pacer.start(0);
        std::vector<float> out(AudioPacer::kFrameFloats, 9.0f);
        // Owed at 5 ms, nothing queued, 3 ms late: wait, and the clock stays.
        CHECK(pacer.take(out.data(), 8'000) == AudioPacer::Take::Deferred);
        CHECK_EQ(pacer.nextDueUs(), int64_t(5'000));
        CHECK_EQ(pacer.underruns(), int64_t(0));
        CHECK_EQ(pacer.deferrals(), int64_t(1));
        CHECK(allEqual(out, 9.0f)); // untouched
        // Still nothing at 14.9 ms: still waiting. At 15 ms the grace is spent.
        CHECK(pacer.take(out.data(), 14'999) == AudioPacer::Take::Deferred);
        CHECK(pacer.take(out.data(), 15'000) == AudioPacer::Take::Silence);
        CHECK(allEqual(out, 0.0f));
        CHECK_EQ(pacer.nextDueUs(), int64_t(10'000));
        CHECK_EQ(pacer.underruns(), int64_t(1));
        // The burst arrives: the frame owed at 10 ms goes out with real audio.
        std::vector<float> burst = tone(960, 0.3f);
        pacer.push(burst.data(), 960);
        CHECK(pacer.take(out.data(), 15'500) == AudioPacer::Take::Frame);
        CHECK(allEqual(out, 0.3f));
        CHECK_EQ(pacer.nextDueUs(), int64_t(15'000));
    }

    SECTION("AudioPacer — another grace than two periods (audiograce= on Windows)");
    {
        AudioPacer pacer(8);
        CHECK_EQ(pacer.underrunGraceUs(), int64_t(10'000));
        pacer.setUnderrunGraceUs(2'500);
        CHECK_EQ(pacer.underrunGraceUs(), int64_t(2'500));
        pacer.start(0);
        std::vector<float> out(AudioPacer::kFrameFloats);
        // Owed at 5 ms: waits until 7.5 ms, not 15.
        CHECK(pacer.take(out.data(), 7'499) == AudioPacer::Take::Deferred);
        CHECK(pacer.take(out.data(), 7'500) == AudioPacer::Take::Silence);
        // The partial frame does not count as a frame, but is held all the same.
        std::vector<float> half = tone(100, 0.2f);
        pacer.push(half.data(), 100);
        CHECK_EQ(pacer.queuedFrames(), size_t(0));
        CHECK_EQ(pacer.queuedSamples(), size_t(100));
        pacer.setUnderrunGraceUs(-1);
        CHECK_EQ(pacer.underrunGraceUs(), int64_t(10'000));
    }

    SECTION("AudioPacer — 20 ms bursts with 9 ms of jitter: no silence, no drop (the macOS case)");
    {
        // What ScreenCaptureKit does: 960 samples every 20 ms, delivered a
        // few ms early or late by the dispatch queue. Played against a 5 ms
        // tick for two seconds. With pop() every late burst cost a silence
        // frame AND, later, a dropped one (see the class comment); take()
        // must cost neither.
        AudioPacer pacer(8);
        pacer.start(0);
        const int64_t jitterUs[] = {6'000, -2'000, 9'000, 0, 3'000, -1'000, 8'000, 1'000};
        std::vector<float> burst = tone(960, 0.5f);
        std::vector<float> out(AudioPacer::kFrameFloats);
        int frames = 0, burstsPushed = 0;
        for (int64_t t = 0; t <= 2'000'000; t += 250) {
            const int64_t k = burstsPushed;
            const int64_t at = 20'000 * k + 5'000 + jitterUs[k % 8];
            if (t >= at) {
                pacer.push(burst.data(), 960);
                burstsPushed++;
            }
            const int due = pacer.dueFrames(t);
            for (int i = 0; i < due; ++i) {
                const AudioPacer::Take got = pacer.take(out.data(), t);
                if (got == AudioPacer::Take::Deferred) break;
                frames++;
            }
        }
        CHECK_EQ(pacer.underruns(), int64_t(0));
        CHECK_EQ(pacer.droppedFrames(), int64_t(0));
        CHECK_EQ(pacer.reanchors(), int64_t(0));
        CHECK(pacer.deferrals() > 0); // the grace was what did it
        // 100 bursts of 4 frames, all but the last few (still queued) sent.
        CHECK(frames >= 392 && frames <= 400);
    }

    SECTION("AudioPacer — a thread asleep for a second re-anchors instead of bursting");
    {
        AudioPacer pacer(4);
        pacer.start(0);
        // Woke up 1 s late: 200 frames owed on paper, 4 (the queue depth) in
        // fact, and the clock now runs from the present.
        CHECK_EQ(pacer.dueFrames(1'000'000), 4);
        CHECK_EQ(pacer.reanchors(), int64_t(1));
        std::vector<float> out(AudioPacer::kFrameFloats);
        for (int i = 0; i < 4; ++i)
            pacer.pop(out.data());
        // The next frame is due one period after the wake-up, not 995 ms ago.
        CHECK_EQ(pacer.nextDueUs(), int64_t(1'005'000));
        CHECK_EQ(pacer.dueFrames(1'004'000), 0);
        CHECK_EQ(pacer.dueFrames(1'005'000), 1);
    }

    // `audioframe=10|20` (plan audio + DSCP, A3 L2): the same pacer, a longer
    // frame — its period, its size, its grace and its cap all follow.
    SECTION("AudioPacer — 20 ms frames: one due every 20 ms, 960 samples each, in order");
    {
        AudioPacer pacer(2, 960);
        CHECK_EQ(pacer.frameSamples(), 960);
        CHECK_EQ(pacer.frameFloats(), size_t(1920));
        CHECK_EQ(pacer.framePeriodUs(), int64_t(20'000));
        CHECK_EQ(pacer.underrunGraceUs(), int64_t(40'000));
        pacer.start(0);
        CHECK_EQ(pacer.dueFrames(19'999), 0);
        CHECK_EQ(pacer.dueFrames(20'000), 1);
        // Two 10 ms WASAPI bursts make one frame.
        std::vector<float> a = tone(480, 0.25f);
        pacer.push(a.data(), 480);
        CHECK_EQ(pacer.queuedFrames(), size_t(0));
        pacer.push(a.data(), 480);
        CHECK_EQ(pacer.queuedFrames(), size_t(1));
        std::vector<float> out(pacer.frameFloats());
        CHECK(pacer.pop(out.data()));
        CHECK(allEqual(out, 0.25f));
        CHECK_EQ(pacer.nextDueUs(), int64_t(40'000));
        // The cap counts these frames: two of them, 40 ms.
        std::vector<float> one = tone(960, 1.0f), two = tone(960, 2.0f), three = tone(960, 3.0f);
        pacer.push(one.data(), 960);
        pacer.push(two.data(), 960);
        pacer.push(three.data(), 960);
        CHECK_EQ(pacer.queuedFrames(), size_t(2));
        CHECK_EQ(pacer.droppedFrames(), int64_t(1));
        CHECK(pacer.pop(out.data()));
        CHECK(allEqual(out, 2.0f));
        // The grace is two of these periods.
        AudioPacer late(2, 960);
        late.start(0);
        std::vector<float> o(late.frameFloats());
        CHECK(late.take(o.data(), 20'000 + 39'999) == AudioPacer::Take::Deferred);
        CHECK(late.take(o.data(), 20'000 + 40'000) == AudioPacer::Take::Silence);
    }

    SECTION("AudioPacer — 10 ms frames; a frame size Opus cannot take falls back to 5 ms");
    {
        AudioPacer ten(4, 480);
        CHECK_EQ(ten.framePeriodUs(), int64_t(10'000));
        ten.start(0);
        CHECK_EQ(ten.dueFrames(25'000), 2);
        AudioPacer odd(4, 300);
        CHECK_EQ(odd.frameSamples(), 240);
        CHECK_EQ(odd.framePeriodUs(), int64_t(5'000));
        CHECK(AudioPacer::isFrameSamples(960));
        CHECK(!AudioPacer::isFrameSamples(120));
        // peakOf reads a longer frame to its end when told its size.
        std::vector<float> f(1920, 0.0f);
        f[1919] = -0.75f;
        CHECK_EQ(AudioPacer::peakOf(f.data()), 0.0f); // a 5 ms frame's worth only
        CHECK_EQ(AudioPacer::peakOf(f.data(), f.size()), 0.75f);
    }

#ifdef MW_NATIVE_TESTS_HAVE_OPUS
    SECTION("OpusEncoder — 5, 10 and 20 ms frames decode to as many samples; others refused");
    {
        int decodeErr = 0;
        OpusDecoder* dec = opus_decoder_create(48000, 2, &decodeErr);
        CHECK(dec != nullptr);
        for (int samples : {240, 480, 960}) {
            mw::native::audio::OpusEncoder enc;
            std::string error;
            CHECK(enc.open(error, samples));
            CHECK_EQ(enc.frameSamples(), samples);
            std::vector<float> pcm = tone(static_cast<size_t>(samples), 0.25f);
            std::vector<uint8_t> packet;
            const size_t n = enc.encode(pcm.data(), packet);
            CHECK(n > 0);
            if (dec && n > 0) {
                std::vector<float> back(static_cast<size_t>(960) * 2);
                CHECK_EQ(opus_decode_float(dec, packet.data(), static_cast<opus_int32>(n),
                                           back.data(), 960, 0),
                         samples);
            }
        }
        if (dec) opus_decoder_destroy(dec);
        mw::native::audio::OpusEncoder odd;
        std::string error;
        CHECK(!odd.open(error, 300));
        CHECK(!error.empty());
    }
#endif
}
