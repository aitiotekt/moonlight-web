/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * The protocol below us is positional: the key's PHYSICAL position is sent as a
 * US virtual key, and the host resolves it through its own layout. That types
 * the wrong characters the moment the two layouts disagree — an AZERTY viewer
 * on a QWERTY host presses "azerty" and reads "qwerty".
 *
 * The client answers with two things it can actually know: `char`, the
 * character its layout produced, and `nonUs`, whether the US layout puts
 * something else at that position. It picks no mechanism — only the backend
 * knows what kind of host is listening (see InputMsg::resolveKey).
 */

const VK_Q = 0x51;
const VK_E = 0x45;
const VK_1 = 0x31;
const VK_SPACE = 0x20;

/** Minimal stand-in exposing just what the keyboard path touches. */
function keySink(overrides = {}) {
    const sent = [];
    return {
        sent,
        webrtc: { send: (m) => sent.push(m) },
        _sendToHost: (m) => sent.push(m),
        _heldPhysKeys: new Map(),
        _heldMouseButtons: new Set(),
        _metaTapCodes: new Set(),
        _appleKeyboard: false,
        _quitting: false,
        _pendingClipboardWrite: null,
        _kbdCapture: null,
        _locksSynced: true,
        _cssFullscreen: false,
        _clipboardEnabled: false,
        _layoutMap: null,
        _gamingMode: false,
        _gamepadManager: null,
        _pendingPasteKey: null,
        _suppressPasteKeyUpCode: null,
        handleKeyDown: StreamView.prototype.handleKeyDown,
        handleKeyUp: StreamView.prototype.handleKeyUp,
        _sendKeyEvent: StreamView.prototype._sendKeyEvent,
        _reconcileModifiers: StreamView.prototype._reconcileModifiers,
        _markAltGrCtrl: StreamView.prototype._markAltGrCtrl,
        _forgetHeldKey: StreamView.prototype._forgetHeldKey,
        _holdsThroughStall: StreamView.prototype._holdsThroughStall,
        _sendInputState: StreamView.prototype._sendInputState,
        handleKeyPress: StreamView.prototype.handleKeyPress,
        _deferComposedKey: StreamView.prototype._deferComposedKey,
        _flushComposedKey: StreamView.prototype._flushComposedKey,
        _dropComposedKey: StreamView.prototype._dropComposedKey,
        _deadPending: false,
        _composedKey: null,
        ...overrides,
    };
}

/** A KeyboardEvent-shaped plain object. */
function ev(code, key, mods = {}) {
    return {
        target: {},
        code,
        key,
        keyCode: 0,
        repeat: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        getModifierState: () => false,
        preventDefault() {},
        ...mods,
    };
}

describe('clientChar — what the client says it meant', () => {
    it('says nothing for a key that has a name rather than a character', () => {
        for (const key of ['Enter', 'ArrowUp', 'F1', 'Shift', 'Escape', 'Dead'])
            expect(StreamView.clientChar(ev('Whatever', key))).toBeNull();
    });

    it('reports the character on every printable key, a US client included', () => {
        // The native host resolves the CHARACTER in its own layout, so it needs
        // one even when nothing diverges: a US viewer on a French host presses
        // the key marked A, means 'q', and the position types 'a'. Nothing
        // about that keystroke differs from US, and it is wrong all the same.
        expect(StreamView.clientChar(ev('KeyQ', 'q'))).toEqual({ char: 'q', nonUs: false });
        expect(StreamView.clientChar(ev('Digit1', '1'))).toEqual({ char: '1', nonUs: false });
        expect(StreamView.clientChar(ev('Space', ' '))).toEqual({ char: ' ', nonUs: false });
    });

    it('marks a US client as agreeing, on every printable key', () => {
        // `nonUs` is what keeps the Sunshine path off a US viewer's keystrokes.
        for (const [code, plain, shifted] of [
            ['KeyQ', 'q', 'Q'],
            ['KeyA', 'a', 'A'],
            ['Digit1', '1', '!'],
            ['Slash', '/', '?'],
            ['Backquote', '`', '~'],
        ]) {
            expect(StreamView.clientChar(ev(code, plain)).nonUs).toBe(false);
            expect(StreamView.clientChar(ev(code, shifted, { shiftKey: true })).nonUs).toBe(false);
        }
    });

    it('marks an AZERTY key that disagrees with its US position', () => {
        expect(StreamView.clientChar(ev('KeyQ', 'a'))).toEqual({ char: 'a', nonUs: true });
        expect(StreamView.clientChar(ev('KeyW', 'z'))).toEqual({ char: 'z', nonUs: true });
        expect(StreamView.clientChar(ev('KeyA', 'q'))).toEqual({ char: 'q', nonUs: true });
        // The digit row is where AZERTY diverges the hardest: unshifted it types
        // symbols, and the shift state that reaches them differs per layout.
        expect(StreamView.clientChar(ev('Digit1', '&'))).toEqual({ char: '&', nonUs: true });
        expect(StreamView.clientChar(ev('Digit1', '1', { shiftKey: true }))).toEqual({
            char: '1',
            nonUs: true,
        });
    });

    it('leaves the keys AZERTY shares with US marked as agreeing', () => {
        for (const [code, key] of [
            ['KeyE', 'e'],
            ['KeyR', 'r'],
            ['KeyT', 't'],
            ['Space', ' '],
        ])
            expect(StreamView.clientChar(ev(code, key)).nonUs).toBe(false);
    });

    it('always marks an AltGr character, which no US position carries', () => {
        // Windows reports AltGr as Ctrl+Alt, so this has to be decided before
        // anything treats the keystroke as a chord.
        const e = ev('KeyE', '€', {
            ctrlKey: true,
            altKey: true,
            getModifierState: (name) => name === 'AltGraph',
        });
        expect(StreamView.clientChar(e)).toEqual({ char: '€', nonUs: true });
    });

    it('marks the letter of a Ctrl chord, which is the bug users actually hit', () => {
        // Ctrl+A on AZERTY sits at the US Q position: sent positionally it
        // reaches the host as Ctrl+Q.
        expect(StreamView.clientChar(ev('KeyQ', 'a', { ctrlKey: true }))).toEqual({
            char: 'a',
            nonUs: true,
        });
    });
});

describe('the wire message', () => {
    it('carries the character and the divergence flag on a divergent key', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));

        expect(v.sent).toHaveLength(1);
        expect(v.sent[0].type).toBe('keydown');
        expect(v.sent[0].code).toBe('KeyQ');
        // The position is still there: the backend needs it for a host that can
        // only be addressed positionally.
        expect(v.sent[0].keyCode).toBe(VK_Q);
        expect(v.sent[0].char).toBe('a');
        expect(v.sent[0].nonUs).toBe(true);
    });

    it('carries the character on an agreeing key too, flagged as agreeing', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyE', 'e'));
        expect(v.sent[0].keyCode).toBe(VK_E);
        expect(v.sent[0].char).toBe('e');
        expect(v.sent[0].nonUs).toBe(false);
    });

    it('carries no character at all for a named key', () => {
        const v = keySink();
        v.handleKeyDown(ev('ArrowUp', 'ArrowUp'));
        expect(v.sent[0].char).toBeNull();
        expect(v.sent[0].nonUs).toBe(false);
    });

    it('replays the press character on the release, never the release event', () => {
        // Releasing Shift before the letter changes what e.key reads. A release
        // resolved differently from its press is a different key to Sunshine —
        // which identifies one by (keyCode, flags) — so the press never comes
        // back up and the host holds it forever.
        const v = keySink();
        v.handleKeyDown(ev('Digit1', '1', { shiftKey: true }));
        expect(v.sent[0].char).toBe('1');

        v.sent.length = 0;
        v.handleKeyUp(ev('Digit1', '&')); // Shift already gone
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0].type).toBe('keyup');
        expect(v.sent[0].keyCode).toBe(VK_1);
        expect(v.sent[0].char).toBe('1');
        expect(v.sent[0].nonUs).toBe(true);
    });

    it('repeats the press the host received, character included', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));
        v.sent.length = 0;

        v.handleKeyDown(ev('KeyQ', 'a', { repeat: true }));
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0]).toMatchObject({
            type: 'keydown',
            keyCode: VK_Q,
            char: 'a',
            nonUs: true,
        });
    });

    it('reports the character in the held-input heartbeat', () => {
        // Same reason as the release: a re-press the watchdog resolves down a
        // different path than the original press would strand the key.
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));
        v.handleKeyDown(ev('Space', ' '));
        v.sent.length = 0;

        v._sendInputState();
        expect(v.sent).toHaveLength(1);
        const state = v.sent[0];
        expect(state.type).toBe('inputstate');
        expect(state.keys).toEqual([
            expect.objectContaining({ keyCode: VK_Q, char: 'a', nonUs: true }),
            expect.objectContaining({ keyCode: VK_SPACE, char: ' ', nonUs: false }),
        ]);
    });
});

describe('a dead key and what it composes', () => {
    // Chrome on Windows reports the keystroke after a dead key with the key's
    // own character — ' ' for the Space of "~", 'n' for the n of "ñ" — and puts
    // the composition in the keypress alone. The native host, which types
    // characters, got a space for every tilde (12/10/2026, AZERTY → UM790Pro).
    afterEach(() => vi.useRealTimers());

    const altGr = { ctrlKey: true, altKey: true, getModifierState: (n) => n === 'AltGraph' };

    function deadThen(v, code, key) {
        v.handleKeyDown(ev('Digit2', 'Dead', altGr));
        const next = ev(code, key);
        let prevented = false;
        next.preventDefault = () => (prevented = true);
        v.handleKeyDown(next);
        return () => prevented;
    }

    it('sends the composed tilde on the Space, and leaves the keydown to the browser', () => {
        const v = keySink();
        const prevented = deadThen(v, 'Space', ' ');
        // The dead key went out, flagged; the Space is held back, and its
        // keydown not cancelled — or the keypress would never fire.
        expect(v.sent).toHaveLength(1);
        expect(v.sent[0]).toMatchObject({ code: 'Digit2', dead: true });
        expect(prevented()).toBe(false);

        const press = ev('Space', '~');
        let cancelled = false;
        press.preventDefault = () => (cancelled = true);
        v.handleKeyPress(press);
        expect(cancelled).toBe(true);

        v.handleKeyUp(ev('Space', ' '));
        expect(v.sent.map((m) => [m.type, m.code, m.char])).toEqual([
            ['keydown', 'Digit2', null],
            ['keydown', 'Space', '~'],
            ['keyup', 'Space', '~'],
        ]);
        // The position is kept for a host that composes on its own side.
        expect(v.sent[1].keyCode).toBe(VK_SPACE);
        expect(v.sent[1].nonUs).toBe(true);
        expect(v.sent[1].dead).toBe(false);
    });

    it('sends ñ on the n', () => {
        const v = keySink();
        deadThen(v, 'KeyN', 'n');
        v.handleKeyPress(ev('KeyN', 'ñ'));
        v.handleKeyUp(ev('KeyN', 'n'));
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyN', char: 'ñ' });
    });

    it('keeps the key its own character when the pair does not compose', () => {
        const v = keySink();
        deadThen(v, 'KeyW', 'z');
        v.handleKeyPress(ev('KeyW', '~'));
        v.handleKeyPress(ev('KeyW', 'z'));
        v.handleKeyUp(ev('KeyW', 'z'));
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyW', char: 'z' });
    });

    it('sends the key as it read when no keypress comes', () => {
        // A browser that composes in the keydown itself (Firefox) and fires no
        // keypress the page can see: the timer lets the press go as it was.
        vi.useFakeTimers();
        const v = keySink();
        deadThen(v, 'KeyN', 'ñ');
        expect(v.sent).toHaveLength(1);
        vi.advanceTimersByTime(60);
        expect(v.sent[1]).toMatchObject({ type: 'keydown', code: 'KeyN', char: 'ñ' });
    });

    it('lets the held-back press go before the next one', () => {
        const v = keySink();
        deadThen(v, 'Space', ' ');
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyDown(ev('KeyE', 'e'));
        expect(v.sent.map((m) => m.code)).toEqual(['Digit2', 'Space', 'KeyE']);
    });

    it('holds back nothing once the composition is over', () => {
        const v = keySink();
        deadThen(v, 'Space', ' ');
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyUp(ev('Space', ' '));
        v.sent.length = 0;

        const e = ev('KeyE', 'e');
        let prevented = false;
        e.preventDefault = () => (prevented = true);
        v.handleKeyDown(e);
        expect(prevented).toBe(true);
        expect(v.sent).toHaveLength(1);
    });

    it('waits through the Shift of a capital: dead key, Shift, then the letter', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit2', 'Dead', altGr));
        v.handleKeyDown(ev('ShiftLeft', 'Shift', { shiftKey: true }));
        v.handleKeyDown(ev('KeyN', 'N', { shiftKey: true }));
        v.handleKeyPress(ev('KeyN', 'Ñ'));
        v.handleKeyUp(ev('KeyN', 'N', { shiftKey: true }));
        const n = v.sent.find((m) => m.type === 'keydown' && m.code === 'KeyN');
        expect(n.char).toBe('Ñ');
    });
});

describe("a Mac's dead key, composed in its key field", () => {
    // Recorded on a French Mac (24/10/2026). On the page itself, Chrome 126 and
    // Safari 27 never compose: Option+n reads 'Dead' and the Space after it ' ',
    // in every event, and the native host typed a space for every tilde. In a
    // text field the Space reads the composition itself, with an IME's keyCode
    // 229 — still composing in Chrome, composed already in Safari — and no
    // keypress follows.
    afterEach(() => vi.useRealTimers());

    const option = { altKey: true };

    function tilde(v, composing) {
        v.handleKeyDown(ev('AltLeft', 'Alt', option));
        v.handleKeyDown(ev('KeyN', 'Dead', { ...option, keyCode: 229 }));
        v.handleKeyUp(ev('KeyN', 'Dead', { ...option, keyCode: 192 }));
        v.handleKeyUp(ev('AltLeft', 'Alt'));
        const space = ev('Space', '~', { keyCode: 229, isComposing: composing });
        let prevented = false;
        space.preventDefault = () => (prevented = true);
        v.handleKeyDown(space);
        return () => prevented;
    }

    for (const [browser, composing] of [
        ['Chrome', true],
        ['Safari', false],
    ]) {
        it(`sends the ~ on the Space at once, as ${browser} composes it`, () => {
            const v = keySink({ _appleKeyboard: true });
            const prevented = tilde(v, composing);
            const downs = v.sent.filter((m) => m.type === 'keydown');
            expect(downs.map((m) => [m.code, m.char, m.dead])).toEqual([
                ['AltLeft', null, false],
                ['KeyN', null, true],
                ['Space', '~', false],
            ]);
            // Not held back for a keypress that never comes, and the IME's
            // keydown is left alone.
            expect(v._composedKey).toBeNull();
            expect(prevented()).toBe(false);
            v.handleKeyUp(ev('Space', ' ', { keyCode: 32 }));
            expect(v.sent.at(-1)).toMatchObject({ type: 'keyup', code: 'Space', char: '~' });
        });
    }

    it('sends ñ on the n', () => {
        const v = keySink({ _appleKeyboard: true });
        v.handleKeyDown(ev('AltLeft', 'Alt', option));
        v.handleKeyDown(ev('KeyN', 'Dead', { ...option, keyCode: 229 }));
        v.handleKeyUp(ev('AltLeft', 'Alt'));
        v.handleKeyUp(ev('KeyN', 'ñ', { keyCode: 78 }));
        v.handleKeyDown(ev('KeyN', 'ñ', { keyCode: 229, isComposing: true }));
        expect(v.sent.at(-1)).toMatchObject({
            type: 'keydown',
            code: 'KeyN',
            char: 'ñ',
            dead: false,
        });
    });

    it("takes the key field's keys as the stream's, and any other field's as the page's", () => {
        // A textarea, as far as isLocalKeyboardTarget can tell.
        const field = { closest: () => field };
        const v = keySink({ _keyField: field, _focusKeyField: () => {} });
        v.handleKeyDown(ev('KeyQ', 'a', { target: field }));
        v.handleKeyUp(ev('KeyQ', 'a', { target: field }));
        expect(v.sent.map((m) => m.type)).toEqual(['keydown', 'keyup']);

        const page = keySink();
        page.handleKeyDown(ev('KeyQ', 'a', { target: field }));
        expect(page.sent).toHaveLength(0);
    });

    it('takes the keyboard back to the field, not from a text field, not in gaming mode', () => {
        const focused = [];
        const field = { closest: () => field, focus: () => focused.push('field') };
        const focusKeyField = StreamView.prototype._focusKeyField;

        // A key that missed it (a toolbar button kept the focus).
        const v = keySink({ _keyField: field, _focusKeyField: focusKeyField });
        v.handleKeyDown(ev('KeyQ', 'a'));
        expect(focused).toEqual(['field']);
        expect(v.sent).toHaveLength(1);

        keySink({
            _keyField: field,
            _gamingMode: true,
            _focusKeyField: focusKeyField,
        }).handleKeyDown(ev('KeyQ', 'a'));
        expect(focused).toHaveLength(1);

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        try {
            focusKeyField.call({ _keyField: field, _gamingMode: false, _quitting: false });
            expect(focused).toHaveLength(1);
        } finally {
            input.remove();
        }
    });

    it('empties itself once a composition is in', () => {
        vi.useFakeTimers();
        const field = StreamView.createKeyField();
        const input = (props) => Object.assign(new Event('input'), props);

        field.value = '~';
        field.dispatchEvent(input({ isComposing: true, inputType: 'insertCompositionText' }));
        expect(field.value).toBe('~');
        field.dispatchEvent(new Event('compositionend'));
        vi.advanceTimersByTime(1);
        expect(field.value).toBe('');

        field.value = 'x';
        field.dispatchEvent(input({ isComposing: false, inputType: 'insertFromPaste' }));
        expect(field.value).toBe('');
    });
});

describe('an AltGr dead key that Chrome does not name', () => {
    // Recorded on Windows Chrome, AZERTY (12/10/2026): AltGr+2 reads 'é', the
    // key's plain character, with AltGraph set and neither Ctrl nor Alt; the
    // tilde comes with the Space, which reads '~'. 'Dead' only ever came for
    // the ^ key, which needs no AltGr. One tilde typed "é~" on the native host.
    const azerty = new Map([
        ['Digit2', 'é'],
        ['Digit3', '"'],
        ['Digit7', 'è'],
        ['KeyT', 't'],
    ]);
    const altGr = { getModifierState: (n) => n === 'AltGraph' };

    it('flags AltGr+2 as dead, without its plain é, and sends the ~ on the Space', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('ControlLeft', 'Control', { ctrlKey: true }));
        v.handleKeyDown(ev('AltRight', 'AltGraph', altGr));
        v.handleKeyDown(ev('Digit2', 'é', altGr));
        v.handleKeyUp(ev('Digit2', 'é', altGr));
        v.handleKeyUp(ev('ControlLeft', 'Control', altGr));
        v.handleKeyUp(ev('AltRight', 'AltGraph'));
        v.handleKeyDown(ev('Space', '~'));
        v.handleKeyPress(ev('Space', '~'));
        v.handleKeyUp(ev('Space', ' '));

        const digit2 = v.sent.find((m) => m.type === 'keydown' && m.code === 'Digit2');
        expect(digit2).toMatchObject({ dead: true, char: null, nonUs: false });
        const space = v.sent.find((m) => m.type === 'keydown' && m.code === 'Space');
        expect(space).toMatchObject({ char: '~', dead: false });
    });

    it('keeps a real AltGr character: # on AltGr+3', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('Digit3', '#', altGr));
        expect(v.sent[0]).toMatchObject({ code: 'Digit3', char: '#', dead: false });
    });

    it('keeps a left Ctrl+Alt shortcut a shortcut', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('KeyT', 't', { ctrlKey: true, altKey: true }));
        expect(v.sent[0]).toMatchObject({ code: 'KeyT', char: 't', dead: false });
    });

    it('changes nothing without a layout map to tell', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit2', 'é', altGr));
        expect(v.sent[0]).toMatchObject({ code: 'Digit2', char: 'é', dead: false });
    });
});

describe('the mouse mode of a key', () => {
    // Under keyboard_layout_fidelity "auto" (the default since 22/10/2026), the
    // host types the client's characters at the desktop and plays gaming mode
    // by key positions. Only the client knows its mouse mode, so each press
    // says it, and its release and the heartbeat replay the press's.
    it('marks a press in gaming mode, and one at the desktop', () => {
        const desk = keySink();
        desk.handleKeyDown(ev('KeyQ', 'a'));
        expect(desk.sent[0]).toMatchObject({ type: 'keydown', gaming: false, char: 'a' });

        const game = keySink({ _gamingMode: true });
        game.handleKeyDown(ev('KeyQ', 'a'));
        expect(game.sent[0]).toMatchObject({ type: 'keydown', gaming: true, char: 'a' });
    });

    it('releases a key by the mode it was pressed in', () => {
        // Pressed at the desktop, let go after a switch to gaming mode: the
        // host resolved the press by its character, the release must match.
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a'));
        v._gamingMode = true;
        v.sent.length = 0;
        v.handleKeyUp(ev('KeyQ', 'a'));
        expect(v.sent[0]).toMatchObject({ type: 'keyup', gaming: false, char: 'a' });
    });

    it('repeats a key held in gaming mode as the gaming key it was pressed as', () => {
        // The repeat used to drop the mode: after the first one the host
        // resolved the key by its character, and its release lost the key.
        const v = keySink({ _gamingMode: true });
        v.handleKeyDown(ev('KeyW', 'z'));
        v.handleKeyDown(ev('KeyW', 'z', { repeat: true }));
        v.handleKeyUp(ev('KeyW', 'z'));
        expect(v.sent.map((m) => [m.type, m.gaming])).toEqual([
            ['keydown', true],
            ['keydown', true],
            ['keyup', true],
        ]);
    });

    it('keeps the AltGr of a held key through its repeats', () => {
        const v = keySink({ _appleKeyboard: true });
        v.handleKeyDown(ev('Digit5', '{', { altKey: true }));
        v.handleKeyDown(ev('Digit5', '{', { altKey: true, repeat: true }));
        expect(v.sent[1]).toMatchObject({ type: 'keydown', char: '{', altGraph: true });
    });

    it('lets go of keys held under Cmd by the mode they were pressed in', () => {
        const v = keySink({
            _appleKeyboard: true,
            _gamingMode: true,
            _releaseKeysHeldUnderMeta: StreamView.prototype._releaseKeysHeldUnderMeta,
        });
        v.handleKeyDown(ev('KeyW', 'z'));
        v.sent.length = 0;
        v._releaseKeysHeldUnderMeta();
        expect(v.sent[0]).toMatchObject({ type: 'keyup', code: 'KeyW', gaming: true, char: 'z' });
    });

    it("says each held key's mode, and a chord, in the heartbeat", () => {
        const v = keySink({ _gamingMode: true });
        v.handleKeyDown(ev('KeyW', 'z'));
        v._sendKeyEvent({
            type: 'keydown',
            keyCode: 0x41,
            code: '',
            key: '',
            char: 'a',
            chord: true,
        });
        v.sent.length = 0;
        v._sendInputState();
        expect(v.sent[0].keys).toEqual([
            expect.objectContaining({ code: 'KeyW', gaming: true, chord: false }),
            expect.objectContaining({ keyCode: 0x41, gaming: false, chord: true }),
        ]);
    });

    it('never holds a key back after a dead key in gaming mode', () => {
        // At the desktop the key after a dead key waits up to 50 ms for the
        // browser's composition. A game's key does not wait: there the dead
        // key goes by its position, and the host composes.
        const v = keySink({ _gamingMode: true });
        v.handleKeyDown(ev('BracketLeft', 'Dead'));
        const next = ev('KeyE', 'e');
        let prevented = false;
        next.preventDefault = () => (prevented = true);
        v.handleKeyDown(next);
        expect(prevented).toBe(true);
        expect(v._composedKey).toBeNull();
        expect(v.sent.find((m) => m.type === 'keydown' && m.code === 'KeyE')).toMatchObject({
            gaming: true,
            char: 'e',
        });
    });
});

describe("a Mac's Option key", () => {
    // Option composes characters on a Mac as AltGr does on Windows ({ [ | ~ €
    // on the Mac's AZERTY). Sent as Alt and a character, a US host typed
    // Alt+Shift+[ — a shortcut — for "{". The press says Option chose it.
    it('marks a character Option composed', () => {
        const v = keySink({ _appleKeyboard: true });
        v.handleKeyDown(ev('Digit5', '{', { altKey: true }));
        expect(v.sent[0]).toMatchObject({ type: 'keydown', char: '{', altGraph: true });
        v.handleKeyUp(ev('Digit5', '(', { altKey: true }));
        expect(v.sent[1]).toMatchObject({ type: 'keyup', char: '{', altGraph: true });
    });

    it('leaves Option with a key that types nothing an Alt', () => {
        const v = keySink({ _appleKeyboard: true });
        v.handleKeyDown(ev('Tab', 'Tab', { altKey: true }));
        expect(v.sent[0].altGraph).toBe(false);
    });

    it('leaves Option with Cmd or Ctrl a shortcut', () => {
        const v = keySink({ _appleKeyboard: true });
        v.handleKeyDown(ev('KeyQ', 'a', { altKey: true, metaKey: true }));
        expect(v.sent[0]).toMatchObject({ char: 'a', altGraph: false });
    });
});

describe('AltGr chose the character', () => {
    // Its Ctrl and Alt are a level, which the host lets go when its own layout
    // does not need them: "@" from a French AltGr is Shift+2 on a US host. A
    // Ctrl+Alt that is no AltGr is a shortcut, kept whole: Ctrl+Alt+T.
    const azerty = new Map([
        ['KeyE', 'e'],
        ['KeyT', 't'],
        ['Digit0', 'à'],
    ]);

    it('marks a Windows AltGr, reported as Ctrl+Alt with AltGraph', () => {
        const v = keySink();
        v.handleKeyDown(
            ev('Digit0', '@', {
                ctrlKey: true,
                altKey: true,
                getModifierState: (n) => n === 'AltGraph',
            }),
        );
        expect(v.sent[0]).toMatchObject({ char: '@', altGraph: true });
    });

    it("marks Linux's AltGr, reported as AltGraph alone", () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit0', '@', { getModifierState: (n) => n === 'AltGraph' }));
        expect(v.sent[0]).toMatchObject({ char: '@', altGraph: true });
    });

    it('marks a left Ctrl+Alt that typed what AltGr types there', () => {
        // Windows takes Ctrl+Alt for AltGr: € on the E of an AZERTY.
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('KeyE', '€', { ctrlKey: true, altKey: true }));
        expect(v.sent[0]).toMatchObject({ char: '€', altGraph: true });
    });

    it('keeps Ctrl+Alt+T a shortcut, its letter included', () => {
        const v = keySink({ _layoutMap: azerty });
        v.handleKeyDown(ev('KeyT', 't', { ctrlKey: true, altKey: true }));
        expect(v.sent[0]).toMatchObject({ char: 't', altGraph: false });
    });

    it('takes a left Ctrl+Alt for a shortcut without a layout map to tell', () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyE', '€', { ctrlKey: true, altKey: true }));
        expect(v.sent[0]).toMatchObject({ code: 'KeyE', char: null, altGraph: false });
    });
});

describe('a shortcut', () => {
    // Ctrl, Cmd or an Alt that is no AltGr: the keystroke names a key. A
    // letter keeps its character, so the host presses its own A for Ctrl+A on
    // an AZERTY; everything else goes by position, as a keyboard plugged into
    // the host sends it: Ctrl+1 on an AZERTY was Ctrl+Shift+7 on a US host.
    it("sends a letter's character", () => {
        const v = keySink();
        v.handleKeyDown(ev('KeyQ', 'a', { ctrlKey: true }));
        expect(v.sent[0]).toMatchObject({ keyCode: VK_Q, char: 'a', nonUs: true });
        v.handleKeyDown(ev('KeyQ', 'A', { ctrlKey: true, shiftKey: true, repeat: false }));
        expect(v.sent[1]).toMatchObject({ char: 'A' });
    });

    it('sends a digit of the AZERTY row by its position', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit1', '&', { ctrlKey: true }));
        expect(v.sent[0]).toMatchObject({ keyCode: VK_1, char: null, nonUs: false });
    });

    it('sends what follows an Alt by position, and a Cmd tap too', () => {
        const alt = keySink();
        alt.handleKeyDown(ev('Digit1', '&', { altKey: true }));
        expect(alt.sent[0]).toMatchObject({ keyCode: VK_1, char: null });

        const mac = keySink({ _appleKeyboard: true });
        mac.handleKeyDown(ev('Digit1', '&', { metaKey: true }));
        expect(mac.sent.map((m) => [m.type, m.char])).toEqual([
            ['keydown', null],
            ['keyup', null],
        ]);
    });

    it('releases by the position it was pressed by, Ctrl let go first', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit1', '&', { ctrlKey: true }));
        v.handleKeyUp(ev('Digit1', '&'));
        expect(v.sent[1]).toMatchObject({ type: 'keyup', keyCode: VK_1, char: null });
        v.handleKeyDown(ev('Digit1', '&', { ctrlKey: true }));
        v.sent.length = 0;
        v._sendInputState();
        expect(v.sent[0].keys).toEqual([expect.objectContaining({ keyCode: VK_1, char: null })]);
    });

    it('leaves Shift alone a level: its digit is a character', () => {
        const v = keySink();
        v.handleKeyDown(ev('Digit1', '1', { shiftKey: true }));
        expect(v.sent[0]).toMatchObject({ char: '1' });
    });
});
