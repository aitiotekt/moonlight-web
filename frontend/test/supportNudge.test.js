/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    GOOD_SESSION_SECONDS,
    SUPPORT_BUTTON_AT,
    SUPPORT_CHANGED_EVENT,
    SUPPORT_URL,
    goodSessionCount,
    isSupportHidden,
    noteGoodSession,
    openSupportPage,
    setSupportHidden,
    showSupportButton,
    takeSupportIntroduction,
} from '../js/util/supportNudge.js';

const KEY = 'mw-support';

function play(n) {
    for (let i = 0; i < n; i++) noteGoodSession(GOOD_SESSION_SECONDS);
}

afterEach(() => {
    globalThis.localStorage.removeItem(KEY);
    vi.restoreAllMocks();
});

describe('supportNudge', () => {
    it('counts only streams of ten minutes or more', () => {
        expect(noteGoodSession(GOOD_SESSION_SECONDS - 1)).toBe(false);
        expect(noteGoodSession(Number.NaN)).toBe(false);
        expect(noteGoodSession(undefined)).toBe(false);
        expect(goodSessionCount()).toBe(0);
        expect(noteGoodSession(GOOD_SESSION_SECONDS)).toBe(true);
        expect(goodSessionCount()).toBe(1);
    });

    it('shows the button from the 10th good session, for good', () => {
        play(SUPPORT_BUTTON_AT - 1);
        expect(showSupportButton()).toBe(false);
        play(1);
        expect(showSupportButton()).toBe(true);
        play(100);
        expect(showSupportButton()).toBe(true);
    });

    it('glows on the visit it first appears, and never again', () => {
        play(SUPPORT_BUTTON_AT - 1);
        expect(takeSupportIntroduction()).toBe(false);
        play(1);
        expect(takeSupportIntroduction()).toBe(true);
        expect(takeSupportIntroduction()).toBe(false);
        play(30);
        expect(takeSupportIntroduction()).toBe(false);
    });

    it('the Settings switch hides it everywhere, and gives it back', () => {
        play(SUPPORT_BUTTON_AT);
        setSupportHidden(true);
        expect(isSupportHidden()).toBe(true);
        expect(showSupportButton()).toBe(false);
        expect(takeSupportIntroduction()).toBe(false);
        setSupportHidden(false);
        expect(isSupportHidden()).toBe(false);
        expect(showSupportButton()).toBe(true);
        // Hidden before it ever showed: it still gets its one glow later.
        expect(takeSupportIntroduction()).toBe(true);
    });

    it('tells the page when the button may have come or gone', () => {
        const seen = vi.fn();
        globalThis.window.addEventListener(SUPPORT_CHANGED_EVENT, seen);
        noteGoodSession(GOOD_SESSION_SECONDS);
        setSupportHidden(true);
        noteGoodSession(1); // too short: nothing changed, nothing said
        globalThis.window.removeEventListener(SUPPORT_CHANGED_EVENT, seen);
        expect(seen).toHaveBeenCalledTimes(2);
    });

    it('starts over on a corrupt record instead of guessing', () => {
        globalThis.localStorage.setItem(KEY, '{not json');
        expect(goodSessionCount()).toBe(0);
        globalThis.localStorage.setItem(
            KEY,
            JSON.stringify({ count: -3, hidden: 'yes', introduced: 1 }),
        );
        expect(goodSessionCount()).toBe(0);
        expect(isSupportHidden()).toBe(false);
        play(SUPPORT_BUTTON_AT);
        expect(showSupportButton()).toBe(true);
        expect(takeSupportIntroduction()).toBe(true);
    });

    it('stays silent when storage refuses', () => {
        vi.spyOn(globalThis.Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(globalThis.Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        play(40);
        expect(showSupportButton()).toBe(false);
        expect(takeSupportIntroduction()).toBe(false);
    });

    it('opens the page in a new tab, without opener or referrer', () => {
        const open = vi.spyOn(globalThis.window, 'open').mockImplementation(() => null);
        openSupportPage();
        expect(open).toHaveBeenCalledWith(SUPPORT_URL, '_blank', 'noopener,noreferrer');
    });
});
