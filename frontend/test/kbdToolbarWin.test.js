/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The Win key of the touch keyboard bar latches, as Shift, Ctrl and Alt do.
 *
 * It was a single press, which opened Start and nothing else: Win+L to lock
 * the host, Win+R, Win+E could not be typed from a phone (P4, 24/10/2026).
 * Bruno chose the latch (26/10/2026): one tap holds it for the next key, a
 * fast double tap locks it, and latched then let go alone it is the bare press
 * that opens Start.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../js/ui/Toast.js', () => ({ Toast: { warning: () => {} } }));
vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key, applyTranslations: () => {} }));

const { StreamViewKeyboard } = await import('../js/ui/StreamViewKeyboard.js');

/** The bar and the capture field, on a stand-in for the StreamView. */
function view() {
    const v = Object.create(StreamViewKeyboard.prototype);
    v._rootEl = document.createElement('div');
    v.sent = [];
    v.webrtc = { send: (m) => v.sent.push(m) };
    v._sendKeyEvent = (m) => v.sent.push(m);
    v._buildKbToolbar();
    v._kbdCapture = document.createElement('div');
    v._kbdCapture.contentEditable = 'true';
    v._setupKeyboardCapture();
    return v;
}

const key = (v, label) =>
    [...v._kbToolbar.querySelectorAll('button')].find((b) => b.textContent === label);
const press = (btn) =>
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
/** What the phone's keyboard does for one character. */
function type(v, ch) {
    const e = new Event('input', { bubbles: true });
    Object.assign(e, { inputType: 'insertText', data: ch });
    v._kbdCapture.dispatchEvent(e);
}
/** A tap on the bar at a given time, for the double-tap window. */
function tapAt(v, label, ms) {
    vi.spyOn(performance, 'now').mockReturnValue(ms);
    press(key(v, label));
}
const WIN = 0x5b;
const winEvents = (v) => v.sent.filter((m) => m.keyCode === WIN).map((m) => m.type);

afterEach(() => vi.restoreAllMocks());

describe('touch keyboard bar: Win latches', () => {
    it('is a modifier of the bar, as Shift, Ctrl and Alt are', () => {
        const v = view();
        expect(key(v, 'Win').classList.contains('is-mod')).toBe(true);
    });

    it('Win latched, then l: Win+L as a chord, and Win goes up after it', () => {
        const v = view();
        tapAt(v, 'Win', 1000);
        expect(v.sent).toEqual([
            {
                type: 'keydown',
                keyCode: WIN,
                code: '',
                key: '',
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                metaKey: true,
            },
        ]);
        expect(key(v, 'Win').classList.contains('active')).toBe(true);
        v.sent.length = 0;
        type(v, 'l');
        const l = v.sent.filter((m) => m.keyCode === 0x4c);
        expect(l.map((m) => m.type)).toEqual(['keydown', 'keyup']);
        for (const m of l) expect(m).toMatchObject({ char: 'l', chord: true, metaKey: true });
        // One-shot: Win goes up after the chord, and the button lets go.
        expect(winEvents(v)).toEqual(['keyup']);
        expect(key(v, 'Win').classList.contains('active')).toBe(false);
    });

    it('a bar key under a latched Win carries it too: Win+Tab', () => {
        const v = view();
        tapAt(v, 'Win', 1000);
        v.sent.length = 0;
        press(key(v, 'Tab'));
        expect(v.sent.find((m) => m.type === 'keydown' && m.keyCode === 0x09)).toMatchObject({
            metaKey: true,
        });
        expect(winEvents(v)).toEqual(['keyup']);
    });

    it('latched, then let go with nothing between: the bare press that opens Start', () => {
        const v = view();
        tapAt(v, 'Win', 1000);
        tapAt(v, 'Win', 2000);
        expect(winEvents(v)).toEqual(['keydown', 'keyup']);
        expect(v.sent).toHaveLength(2);
        expect(key(v, 'Win').classList.contains('active')).toBe(false);
    });

    it('a fast double tap locks it: held across keys until tapped off', () => {
        const v = view();
        tapAt(v, 'Win', 1000);
        tapAt(v, 'Win', 1100);
        expect(key(v, 'Win').classList.contains('locked')).toBe(true);
        type(v, 'e');
        type(v, 'r');
        expect(winEvents(v)).toEqual(['keydown']);
        tapAt(v, 'Win', 5000);
        expect(winEvents(v)).toEqual(['keydown', 'keyup']);
        expect(key(v, 'Win').classList.contains('locked')).toBe(false);
    });

    it('closing the keyboard lets a locked Win go', () => {
        const v = view();
        tapAt(v, 'Win', 1000);
        tapAt(v, 'Win', 1100);
        v.sent.length = 0;
        v._releaseAllMods();
        expect(winEvents(v)).toEqual(['keyup']);
    });
});
