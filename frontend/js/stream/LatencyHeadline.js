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

/**
 * The stats card's headline latency: the figure that reads the picture's real
 * delay.
 *
 * The card used to show the sum of its legs: the host's time, half a ping, the
 * link's queue, then the browser's decode, wait and draw. Each leg is a mean
 * over the frames that arrive and the pings that come back, so a backlog shows
 * in none of them. On 25/10/2026 (plan « le stream passe avant un gros envoi
 * du PC hôte », S3), a Mac on a stalling repeater showed 78 ms while its
 * pictures came 2 to 7 s late; the frame log's own measure
 * (stream/FrameLog.js, the host's stamp to the end of the draw) read the 4 s.
 *
 * So, in order:
 *   - frozen: nothing drawn for FROZEN_AFTER_MS while the link is silent, or
 *     while frames come in and none is drawn (a decoder waiting for a
 *     keyframe). The picture on screen gets older every moment: its age when
 *     drawn plus the time since. A still screen is not frozen: no frame comes
 *     in that is not drawn, and the host's stats, every second, keep the link
 *     from going silent;
 *   - measured: the frame log's ages over its window;
 *   - sum: the legs, when nothing measures the whole way (the decode worker,
 *     the native media track, a clock not known yet).
 */

/** No draw for longer than this, while the stream is stuck, is a freeze. */
export const FROZEN_AFTER_MS = 500;

/**
 * @typedef {object} HeadlineInput
 * @property {number} sumMs            the legs' sum (NaN when none counts)
 * @property {number} sumP99Ms         the same sum on the legs' tails
 * @property {{count: number, avg: number, p99: number}|null} measured
 *           the frame log's ages over their window, null where not measured
 * @property {number} lastE2eMs        the last drawn frame's age (NaN if unknown)
 * @property {number} sinceDrawMs      since that frame's draw ended
 * @property {number} sinceRxMs        since anything came over the link
 * @property {number} silentAfterMs    how long a silent link takes to count
 * @property {boolean} framesSinceDraw a frame came in after that draw
 * @property {boolean} [hidden]        the page is hidden: no draws, no freeze
 */

/**
 * @param {HeadlineInput} s
 * @returns {{ms: number, p99Ms: number, source: 'frozen'|'measured'|'sum'|'none'}}
 */
export function latencyHeadline(s) {
    const stuck = s.sinceRxMs > s.silentAfterMs || s.framesSinceDraw === true;
    if (s.lastE2eMs >= 0 && !s.hidden && s.sinceDrawMs > FROZEN_AFTER_MS && stuck) {
        const ms = s.lastE2eMs + s.sinceDrawMs;
        return { ms, p99Ms: ms, source: 'frozen' };
    }
    const m = s.measured;
    if (m && m.count > 0 && m.avg >= 0) {
        return { ms: m.avg, p99Ms: m.p99 >= m.avg ? m.p99 : m.avg, source: 'measured' };
    }
    if (s.sumMs >= 0) return { ms: s.sumMs, p99Ms: s.sumP99Ms, source: 'sum' };
    return { ms: NaN, p99Ms: NaN, source: 'none' };
}
