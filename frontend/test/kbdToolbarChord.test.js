/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * A letter typed while a modifier of the touch keyboard bar is latched: a
 * chord, Ctrl+z or Shift+a.
 *
 * It went to the host as the US position of the letter alone, which an AZERTY
 * host reads as another key: Ctrl+z became Ctrl+W and closed the tab, Shift+a
 * typed Q (22/10/2026). The character now rides along, flagged as a chord, and
 * the host presses the key that carries it on its own layout.
 */
import { describe, it, expect, vi } from 'vitest';

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

describe('touch keyboard bar: chords', () => {
    it('Ctrl latched, then z: the key, with its character, as a chord', () => {
        const v = view();
        press(key(v, 'Ctrl'));
        v.sent.length = 0;
        type(v, 'z');
        const z = v.sent.filter((m) => m.keyCode === 0x5a);
        expect(z.map((m) => m.type)).toEqual(['keydown', 'keyup']);
        for (const m of z) {
            expect(m.char).toBe('z');
            expect(m.chord).toBe(true);
            expect(m.ctrlKey).toBe(true);
        }
        // The latch is one-shot: Ctrl goes up after the chord.
        expect(v.sent.some((m) => m.type === 'keyup' && m.keyCode === 0x11)).toBe(true);
    });

    it('Shift latched, then a: A on any host, not the key at the US A', () => {
        const v = view();
        press(key(v, 'Shift'));
        v.sent.length = 0;
        type(v, 'a');
        const a = v.sent.find((m) => m.type === 'keydown' && m.keyCode === 0x41);
        expect(a).toMatchObject({ char: 'a', chord: true, shiftKey: true });
    });

    it('a digit is a chord too', () => {
        const v = view();
        press(key(v, 'Ctrl'));
        v.sent.length = 0;
        type(v, '1');
        expect(v.sent.find((m) => m.type === 'keydown' && m.keyCode === 0x31)).toMatchObject({
            char: '1',
            chord: true,
        });
    });

    it('a bar key of its own carries no character', () => {
        const v = view();
        press(key(v, 'Tab'));
        const tab = v.sent.find((m) => m.type === 'keydown' && m.keyCode === 0x09);
        expect(tab.chord).toBeUndefined();
        expect(tab.char).toBeUndefined();
    });

    it('without a latched modifier, text stays text', () => {
        const v = view();
        type(v, 'z');
        expect(v.sent).toEqual([{ type: 'textinput', text: 'z' }]);
    });
});
