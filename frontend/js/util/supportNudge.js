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
 * MoonlightWeb — when the "Buy me a coffee" button shows, and when it does not.
 *
 * The project is free and carries no ads; a coffee is how someone who gets a
 * lot out of it can say thanks. So the button waits until it has been earned
 * and never asks twice:
 *
 *   - a GOOD SESSION is an owner's stream that lasted at least ten minutes. A
 *     launch that failed, a quick look, an invited player: none of them count;
 *   - from the 10th good session the button sits in the header, beside Admin
 *     and Settings, and in the stream's bar — for good;
 *   - the visit it first appears on, the header button glows; never again;
 *   - one switch in Settings hides it everywhere, for good.
 *
 * Per browser, in localStorage: nothing about it is sent anywhere, and the
 * count belongs to the person in front of this browser, like the host ranking
 * next door (hostUsage.js). A browser that refuses storage never counts, so it
 * never shows the button.
 *
 * The page opens in a NEW tab, always — the app stays where it was, and a
 * stream keeps running behind it.
 */

/** The page, in ONE place for the whole application. */
export const SUPPORT_URL = 'https://buymeacoffee.com/brunoocto';

const SUPPORT_KEY = 'mw-support';

/** Shorter than this, a stream says nothing about whether the app is useful. */
export const GOOD_SESSION_SECONDS = 10 * 60;

/** Good sessions after which the button shows. */
export const SUPPORT_BUTTON_AT = 10;

/** Fired on window whenever the button may have come or gone. */
export const SUPPORT_CHANGED_EVENT = 'mw-support-changed';

function readState() {
    let parsed = null;
    try {
        const raw = localStorage.getItem(SUPPORT_KEY);
        parsed = raw ? JSON.parse(raw) : null;
    } catch {
        // Unreadable or corrupt: start over rather than guess.
    }
    const s = parsed && typeof parsed === 'object' ? parsed : {};
    return {
        count: Number.isFinite(s.count) && s.count > 0 ? Math.floor(s.count) : 0,
        hidden: s.hidden === true,
        introduced: s.introduced === true,
    };
}

function writeState(state) {
    try {
        localStorage.setItem(SUPPORT_KEY, JSON.stringify(state));
    } catch {
        // Nothing to remember it with: the count stays where it was.
    }
}

function announce() {
    try {
        window.dispatchEvent(new Event(SUPPORT_CHANGED_EVENT));
    } catch {
        // No window (tests without a DOM): nobody is listening anyway.
    }
}

/**
 * One stream has ended. Counts it when it lasted long enough to mean something.
 * @param {number} seconds how long it lasted
 * @returns {boolean} whether it counted
 */
export function noteGoodSession(seconds) {
    if (!(seconds >= GOOD_SESSION_SECONDS)) return false;
    const state = readState();
    state.count += 1;
    writeState(state);
    announce();
    return true;
}

/** Good sessions so far. */
export function goodSessionCount() {
    return readState().count;
}

/** Does this browser get the button (header and stream bar)? */
export function showSupportButton() {
    const state = readState();
    return !state.hidden && state.count >= SUPPORT_BUTTON_AT;
}

/**
 * True exactly once: on the visit the header button first appears, so it can
 * glow that one time. Spends the turn as it answers.
 */
export function takeSupportIntroduction() {
    const state = readState();
    if (state.introduced || state.hidden || state.count < SUPPORT_BUTTON_AT) return false;
    state.introduced = true;
    writeState(state);
    // Read back: a browser that cannot store would otherwise glow every visit.
    return readState().introduced;
}

/** The Settings switch: hide the button everywhere, or bring it back. */
export function isSupportHidden() {
    return readState().hidden;
}

export function setSupportHidden(hidden) {
    const state = readState();
    state.hidden = hidden === true;
    writeState(state);
    announce();
}

/**
 * Open the page in a new tab, for a control that cannot be a plain link (the
 * stream's touch layer only lets <button> elements through). noopener and
 * noreferrer: the page gets no handle on this one, and is not told the
 * address this app was reached on.
 */
export function openSupportPage() {
    window.open(SUPPORT_URL, '_blank', 'noopener,noreferrer');
}
