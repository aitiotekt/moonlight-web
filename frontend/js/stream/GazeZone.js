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
 * GazeZone — the motion level the mwsr kernel's gaze zone follows (the
 * `gaze` uniform of MwsrShader.js; docs/design/upscaler-mwsr.md §15.2).
 *
 * Bruno's rule of 23/10/2026: the zone — a sharper centre, the table's values
 * at the border — for the pictures that move, a game most likely; a desktop
 * that holds still keeps one quality over the whole screen. The signal is the
 * stream's own: the size of the delta frames the host encodes. A picture that
 * moves fills the encoder's budget; a desktop that does not costs a few
 * hundred bytes per frame, whatever the setting. Read in bits per pixel per
 * second, so that neither the bitrate setting nor the resolution moves the
 * thresholds: a 1080p game at 5 Mbit/s is 2.4, a still desktop 0.05, a cursor
 * moving over it about 0.7. Key frames say nothing of motion and are left
 * out; their time counts, so a still stream with periodic key frames stays
 * at 0.
 *
 * The level eases towards the motion — up in about a second, down in three —
 * so the zone never pops in or out; the renderer reads it per draw, in steps
 * of 1/64, so that its uniform block is rewritten only when it moves.
 */
export class GazeZone {
    /**
     * @param {{lo?: number, hi?: number, upMs?: number, downMs?: number, windowMs?: number}} [opts]
     *   `lo`, `hi`: the rates (bits per pixel per second) below which the
     *   motion is 0 and above which it is 1; `upMs`, `downMs`: the time
     *   constants of the easing; `windowMs`: the window the rate is read over.
     */
    constructor({ lo = 0.25, hi = 1.0, upMs = 1000, downMs = 3000, windowMs = 1000 } = {}) {
        this._lo = lo;
        this._hi = hi;
        this._upMs = upMs;
        this._downMs = downMs;
        this._windowMs = windowMs;
        /** @type {Array<{t: number, bytes: number}>} the window's frames, a key frame at 0 bytes */
        this._frames = [];
        this._level = 0;
        this._lastMs = -1;
    }

    /**
     * An encoded frame of the stream, before its decode.
     * @param {number} bytes its size
     * @param {boolean} key a key frame: its size is left out
     * @param {number} now ms, any monotonic clock, the one level() reads
     */
    note(bytes, key, now) {
        const fr = this._frames;
        // A clock that went back (a new stream on the same renderer): start over.
        if (fr.length > 0 && now < fr[fr.length - 1].t) fr.length = 0;
        fr.push({ t: now, bytes: key ? 0 : Math.max(0, bytes | 0) });
        this._trim(now);
    }

    _trim(now) {
        const fr = this._frames;
        const start = now - this._windowMs;
        let drop = 0;
        while (drop < fr.length && fr[drop].t < start) drop++;
        if (drop > 0) fr.splice(0, drop);
    }

    /**
     * The picture's motion now, 0 to 1: the window's delta bytes as bits per
     * pixel per second, between the two thresholds.
     * @param {number} now ms
     * @param {number} area the frame's pixels
     * @returns {number}
     */
    motion(now, area) {
        this._trim(now);
        if (!(area > 0) || this._frames.length === 0) return 0;
        let bytes = 0;
        for (const f of this._frames) bytes += f.bytes;
        const rate = (bytes * 8) / (this._windowMs / 1000) / area;
        return Math.min(Math.max((rate - this._lo) / (this._hi - this._lo), 0), 1);
    }

    /**
     * The zone's weight for a draw now: the level eased towards the motion,
     * in steps of 1/64.
     * @param {number} now ms
     * @param {number} area the frame's pixels
     * @returns {number}
     */
    level(now, area) {
        const m = this.motion(now, area);
        const dt = this._lastMs < 0 ? 0 : Math.min(Math.max(now - this._lastMs, 0), 1000);
        this._lastMs = now;
        const tc = m > this._level ? this._upMs : this._downMs;
        this._level += (m - this._level) * (1 - Math.exp(-dt / tc));
        return Math.round(this._level * 64) / 64;
    }

    reset() {
        this._frames.length = 0;
        this._level = 0;
        this._lastMs = -1;
    }
}
