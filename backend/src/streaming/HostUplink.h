/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include <algorithm>
#include <cstdint>
#include <deque>
#include <optional>

// What the host PC sends besides the stream, once a second.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// 24/10/2026: a stream from DualRTX to a Wi-Fi client froze for 2 to 27 s
// whenever TeraBox uploaded 40-125 Mbit/s from DualRTX itself. Every packet of
// the stream left marked AF41, yet it waited behind the upload in a repeater
// that reads no mark. The log said "the video's send buffer not draining" and
// "the input link silent". Nothing in it said that the host itself was
// sending three times the stream's rate on the same path. Only a meter on the
// adapter, read by hand, showed it.
//
// ── What is measured ────────────────────────────────────────────────────────
//
// The adapter the stream leaves by: the one the route to the client's address
// takes (HostUplinkReader.h). Its sent-bytes counter covers everything the PC
// sends through it. The stream's share comes from libdatachannel's bytesSent,
// which counts the data channels' messages only. On the wire each ~1200-byte
// datagram also carries SCTP, DTLS, UDP, IP and Ethernet headers (about a
// tenth more), and the sound rides its own RTP track. kWireFactor covers both.
// Besides = adapter − stream × kWireFactor, never below zero: an estimate,
// good to a few Mbit/s, which is why the line's threshold also scales with the
// stream's own rate.
//
// Not separated: another stream from this same PC counts as "besides"; a
// Hyper-V VM leaves by the physical adapter, not by the host's virtual one,
// and is not seen at all.
namespace mw::hostuplink {

/// The stream's data-channel bytes times this ≈ its bytes on the wire.
constexpr double kWireFactor = 1.12;
/// The line's threshold: this much besides the stream, and at least
/// kStreamSharePercent of the stream's own rate (the estimate's error grows
/// with it).
constexpr int64_t kFloorKbps = 8000;
constexpr int64_t kStreamSharePercent = 20;

inline int64_t onKbps(int64_t streamKbps)
{
    return std::max(kFloorKbps, streamKbps * kStreamSharePercent / 100);
}
inline int64_t offKbps(int64_t streamKbps)
{
    return onKbps(streamKbps) / 2;
}

/// Bytes between two readings of a counter @p bits wide. A 32-bit counter
/// (macOS's if_data) wraps every 4 GiB, a few seconds of a busy gigabit link
/// at most, which a reading a second sees as one step back. A 64-bit counter
/// that goes back was reset: nothing is known.
inline std::optional<uint64_t> counterDelta(uint64_t prev, uint64_t cur, unsigned bits)
{
    if (bits >= 64) {
        if (cur < prev) return std::nullopt;
        return cur - prev;
    }
    const uint64_t mask = (uint64_t(1) << bits) - 1;
    return (cur - prev) & mask;
}

/// One second, or so, of upload.
struct Rate
{
    int64_t fromMs = 0;
    int64_t atMs = 0;
    int64_t adapterKbps = 0;
    int64_t streamKbps = 0; ///< the data channels' bytes, as counted
    int64_t besidesKbps = 0;
};

/// Fed each stats tick; keeps the last kKeepMs for the freezes' lines.
class Meter
{
public:
    static constexpr int64_t kKeepMs = 30000;

    /// A reading at @p atMs: the adapter's counter (@p adapterBits wide) and
    /// the stream's own bytes so far. Returns the rate since the previous
    /// reading, when there is one that can be trusted.
    std::optional<Rate> add(int64_t atMs, uint64_t adapterBytes, unsigned adapterBits,
                            uint64_t streamBytes)
    {
        std::optional<Rate> out;
        if (m_Has && atMs > m_PrevAtMs) {
            const auto a = counterDelta(m_PrevAdapter, adapterBytes, adapterBits);
            const auto s = counterDelta(m_PrevStream, streamBytes, 64);
            if (a && s) {
                const int64_t dt = atMs - m_PrevAtMs;
                Rate r;
                r.fromMs = m_PrevAtMs;
                r.atMs = atMs;
                r.adapterKbps = static_cast<int64_t>(*a * 8 / static_cast<uint64_t>(dt));
                r.streamKbps = static_cast<int64_t>(*s * 8 / static_cast<uint64_t>(dt));
                const double wire = static_cast<double>(r.streamKbps) * kWireFactor;
                r.besidesKbps = std::max<int64_t>(0, r.adapterKbps - static_cast<int64_t>(wire));
                m_Rates.push_back(r);
                while (!m_Rates.empty() && atMs - m_Rates.front().atMs > kKeepMs)
                    m_Rates.pop_front();
                out = r;
            }
        }
        m_Has = true;
        m_PrevAtMs = atMs;
        m_PrevAdapter = adapterBytes;
        m_PrevStream = streamBytes;
        return out;
    }

    struct Window
    {
        int samples = 0;
        int64_t meanKbps = 0;
        int64_t peakKbps = 0;
    };

    /// Besides the stream over the readings whose interval overlaps
    /// [@p startMs, @p endMs]: a freeze shorter than a tick still meets the
    /// one or two readings around it.
    Window around(int64_t startMs, int64_t endMs) const
    {
        Window w;
        int64_t sum = 0;
        for (const Rate& r : m_Rates) {
            if (r.fromMs >= endMs || r.atMs <= startMs) continue;
            ++w.samples;
            sum += r.besidesKbps;
            w.peakKbps = std::max(w.peakKbps, r.besidesKbps);
        }
        if (w.samples > 0) w.meanKbps = sum / w.samples;
        return w;
    }

private:
    bool m_Has = false;
    int64_t m_PrevAtMs = 0;
    uint64_t m_PrevAdapter = 0;
    uint64_t m_PrevStream = 0;
    std::deque<Rate> m_Rates;
};

/// When to say so in the log: an upload besides the stream above onKbps for
/// kOnReadings readings in a row starts an episode; below offKbps for
/// kOffReadings in a row ends it. In between, a line every kRepeatMs.
class Notice
{
public:
    static constexpr int kOnReadings = 3;
    static constexpr int kOffReadings = 5;
    static constexpr int64_t kRepeatMs = 30000;

    enum class Kind
    {
        None,
        Started,
        Still,
        Ended,
    };

    struct Event
    {
        Kind kind = Kind::None;
        int64_t sinceMs = 0;
        int64_t durationMs = 0;
        int64_t lastKbps = 0; ///< besides the stream, the latest reading
        int64_t meanKbps = 0; ///< over the episode so far
        int64_t peakKbps = 0;
        int64_t streamKbps = 0; ///< the stream's own data, mean over the episode
    };

    Event feed(const Rate& r)
    {
        Event ev;
        if (!m_Active) {
            if (r.besidesKbps < onKbps(r.streamKbps)) {
                m_Run = 0;
                return ev;
            }
            if (m_Run == 0) {
                m_SinceMs = r.fromMs;
                m_Sum = m_StreamSum = m_Count = m_Peak = 0;
            }
            ++m_Run;
            take(r);
            if (m_Run < kOnReadings) return ev;
            m_Active = true;
            m_Below = 0;
            m_EndMs = r.atMs;
            m_ToldMs = r.atMs;
            return event(Kind::Started, r);
        }
        if (r.besidesKbps < offKbps(r.streamKbps)) {
            if (++m_Below >= kOffReadings) {
                m_Active = false;
                m_Run = 0;
                return event(Kind::Ended, r);
            }
            return ev;
        }
        m_Below = 0;
        take(r);
        m_EndMs = r.atMs;
        if (r.atMs - m_ToldMs >= kRepeatMs) {
            m_ToldMs = r.atMs;
            return event(Kind::Still, r);
        }
        return ev;
    }

    /// The session is over: the episode still open, if any, ends here.
    Event finish()
    {
        if (!m_Active) return {};
        m_Active = false;
        m_Run = 0;
        Rate last;
        last.besidesKbps = m_LastKbps;
        return event(Kind::Ended, last);
    }

    bool active() const { return m_Active; }

private:
    void take(const Rate& r)
    {
        m_Sum += r.besidesKbps;
        m_StreamSum += r.streamKbps;
        ++m_Count;
        m_Peak = std::max(m_Peak, r.besidesKbps);
        m_LastKbps = r.besidesKbps;
    }

    Event event(Kind kind, const Rate& r) const
    {
        Event ev;
        ev.kind = kind;
        ev.sinceMs = m_SinceMs;
        ev.durationMs = m_EndMs - m_SinceMs;
        ev.lastKbps = r.besidesKbps;
        ev.meanKbps = m_Count > 0 ? m_Sum / m_Count : 0;
        ev.peakKbps = m_Peak;
        ev.streamKbps = m_Count > 0 ? m_StreamSum / m_Count : 0;
        return ev;
    }

    bool m_Active = false;
    int m_Run = 0;
    int m_Below = 0;
    int64_t m_SinceMs = 0;
    int64_t m_EndMs = 0;
    int64_t m_ToldMs = 0;
    int64_t m_Sum = 0;
    int64_t m_StreamSum = 0;
    int64_t m_Count = 0;
    int64_t m_Peak = 0;
    int64_t m_LastKbps = 0;
};

} // namespace mw::hostuplink
