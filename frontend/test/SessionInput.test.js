/* MoonlightWeb — input regression tests. GPLv3. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SessionKeyMapper,
    normalizeInput,
    clipboardDirections,
    inputStorageKey,
    loadInput,
    saveInput,
} from '../js/util/SessionInput.js';
import { t } from '../js/i18n/i18n.js';
import { StreamView } from '../js/ui/StreamView.js';
import { openSessionInputPanel, openKeyMappingDialog } from '../js/ui/SessionInputPanel.js';

const ALT_META_SWAP = { AltLeft: 'MetaLeft', MetaLeft: 'AltLeft' };

const event = (type, code, flags = {}) => ({
    type,
    code,
    keyCode: StreamView.codeToWindowsVk(code),
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...flags,
});
const mapper = (map = ALT_META_SWAP) => new SessionKeyMapper(map, StreamView.codeToWindowsVk);
const sink = () => {
    const v = Object.create(StreamView.prototype);
    v.sent = [];
    v.webrtc = { send: (m) => v.sent.push(m) };
    v._heldPhysKeys = new Map();
    v._heldMouseButtons = new Set();
    v._inputPreferences = normalizeInput({ mappings: ALT_META_SWAP });
    v._keyMapper = mapper();
    v._clipboardEnabled = true;
    v._clipboardConfigSupported = true;
    return v;
};

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('session key mappings', () => {
    it('swaps only left Alt/Meta, including flags on following letters', () => {
        const m = mapper();
        expect(m.send(event('keydown', 'AltLeft', { altKey: true }))).toMatchObject({
            code: 'MetaLeft',
            metaKey: true,
            altKey: false,
        });
        expect(m.send(event('keydown', 'KeyC', { altKey: true }))).toMatchObject({
            code: 'KeyC',
            metaKey: true,
            altKey: false,
        });
        expect(m.send(event('keyup', 'AltLeft'))).toMatchObject({
            code: 'MetaLeft',
            metaKey: false,
        });
        expect(m.send(event('keydown', 'MetaLeft', { metaKey: true }))).toMatchObject({
            code: 'AltLeft',
            altKey: true,
            metaKey: false,
        });
        expect(m.send(event('keydown', 'AltRight', { altKey: true, metaKey: true }))).toMatchObject(
            { code: 'AltRight', altKey: true, metaKey: false },
        );
    });
    it('uses the target physical key, not the original layout character', () => {
        const m = mapper({ KeyA: 'KeyB' });
        const down = m.send(event('keydown', 'KeyA', { char: 'a', nonUs: true }));
        expect(down).toMatchObject({ code: 'KeyB', keyCode: 0x42, char: null, nonUs: false });
        expect(m.send(event('keydown', 'KeyA', { char: 'A', shiftKey: true }))).toMatchObject({
            code: 'KeyB',
            char: null,
        });
        expect(m.send(event('keyup', 'KeyA'))).toMatchObject({ code: 'KeyB', keyCode: 0x42 });
    });
    it('does not release a target still held by another physical key', () => {
        const m = mapper({ KeyA: 'KeyB' });
        m.send(event('keydown', 'KeyA'));
        m.send(event('keydown', 'KeyB'));
        expect(m.send(event('keyup', 'KeyA'))).toBe(null);
        expect(m.send(event('keyup', 'KeyB')).type).toBe('keyup');
    });
    it('maps held-input heartbeats without reapplying the swap', () => {
        const m = mapper();
        const raw = event('keydown', 'AltLeft', { altKey: true });
        m.send(raw);
        expect(m.held([raw])[0]).toMatchObject({ code: 'MetaLeft', metaKey: true, altKey: false });
    });
    it('releases the mapped key on focus loss and before preferences change', () => {
        const v = sink();
        v._sendKeyEvent(event('keydown', 'AltLeft', { altKey: true }));
        v._setInputPreferences({ mappings: {} }, false);
        expect(v.sent[1]).toMatchObject({ type: 'keyup', code: 'MetaLeft', metaKey: false });
        expect(v._heldPhysKeys.size).toBe(0);
        expect(v._keyMapper.pressed.size).toBe(0);
    });
    it('keeps synthesized toolbar shortcuts unchanged', () => {
        const m = mapper();
        const msg = { type: 'keydown', keyCode: 0x11, code: '', ctrlKey: true };
        expect(m.send(msg)).toBe(msg);
    });
});

describe('session clipboard and persistence', () => {
    it.each(['off', 'send', 'receive', 'both'])(
        'negotiates direction %s with the server',
        (clipboard) => {
            const v = sink();
            v._setInputPreferences({ clipboard }, false);
            expect(v.sent.at(-1)).toEqual({
                type: 'clipboardconfig',
                ...clipboardDirections({ clipboard }),
            });
        },
    );
    it('does not write incoming text after receive is disabled', () => {
        const v = sink();
        v._inputPreferences.clipboard = 'send';
        v._applyHostClipboard('private');
        expect(v._pendingClipboardWrite).toBeUndefined();
        expect(v._lastHostClipboard).toBeUndefined();
    });
    it('cancels pending paste and queued clipboard writes on settings change', () => {
        const v = sink();
        const timer = setTimeout(() => {}, 5000);
        v._pendingPasteKey = { timer };
        v._pendingClipboardWrite = 'pending';
        v._setInputPreferences({ clipboard: 'off' }, false);
        expect(v._pendingPasteKey).toBeNull();
        expect(v._pendingClipboardWrite).toBeNull();
        v._pasteSessionText('must not send');
        expect(v.sent.every((m) => m.type !== 'clipboardpaste')).toBe(true);
    });
    it('releases mapped modifiers before injecting a complete paste chord', () => {
        const v = sink();
        v._sendKeyEvent(event('keydown', 'AltLeft', { altKey: true }));
        v._pasteSessionText('hello');
        expect(v.sent.slice(-2)).toMatchObject([
            { type: 'keyup', code: 'MetaLeft' },
            { type: 'clipboardpaste', text: 'hello', injectCtrl: true },
        ]);
    });
    it('only persists explicitly remembered host settings and isolates guests', () => {
        const key = inputStorageKey({ uuid: 'host-1' });
        const settings = normalizeInput({ mappings: ALT_META_SWAP, remember: true });
        saveInput(key, settings);
        expect(loadInput(key).mappings).toEqual(ALT_META_SWAP);
        expect(loadInput(inputStorageKey({ uuid: 'host-1' }, true)).mappings).toEqual({});
        saveInput(key, { ...settings, remember: false });
        expect(localStorage.getItem(key)).toBe(null);
    });
    it('ignores corrupt storage and invalid key codes', () => {
        localStorage.setItem('bad', 'not-json');
        expect(loadInput('bad').clipboard).toBe('both');
        expect(
            normalizeInput(
                { mappings: { Bad: 'KeyA', KeyA: 'Bad', AltLeft: 'MetaLeft' } },
                (c) => !!StreamView.codeToWindowsVk(c),
            ).mappings,
        ).toEqual({ AltLeft: 'MetaLeft' });
    });
    it('carries session settings across view replacement without storing clipboard contents', () => {
        const v = sink();
        v._lastHostClipboard = 'secret';
        const state = v.captureViewState();
        expect(state.inputPreferences.mappings).toEqual(ALT_META_SWAP);
        expect(JSON.stringify(state)).not.toContain('secret');
        const next = sink();
        next._adoptOverlayDismissals = () => {};
        next.restoreViewState(state);
        expect(next._inputPreferences).toEqual(v._inputPreferences);
    });
    it('offers native controls without forwarding panel keyboard events', () => {
        const v = sink();
        v.streamEl = document.createElement('div');
        document.body.append(v.streamEl);
        HTMLDialogElement.prototype.showModal = vi.fn();
        openSessionInputPanel(v);
        expect(v._inputDialog.querySelector('[role=switch]')).not.toBeNull();
        const touch = vi.fn();
        v.streamEl.addEventListener('touchstart', touch);
        v._inputDialog.dispatchEvent(new Event('touchstart', { bubbles: true }));
        expect(touch).not.toHaveBeenCalled();
        expect(v._inputDialog.querySelector('details').open).toBe(false);
        expect(StreamView.isLocalKeyboardTarget(v._inputDialog.querySelector('button'))).toBe(true);
    });
});

describe('host shortcuts after mapping', () => {
    const key = (code, flags = {}) => ({
        target: {},
        code,
        key: code === 'KeyV' ? 'v' : code,
        repeat: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        ...flags,
    });
    const view = () => {
        const v = sink();
        v._clipboardPasteModifier = 'meta';
        v._appleKeyboard = false;
        v._locksSynced = true;
        v._metaTapCodes = new Set();
        v._swallowKeyUpCodes = new Set();
        return v;
    };
    it.each(['KeyC', 'KeyZ'])('sends Windows Alt+%s as a physical Command chord', (code) => {
        const v = view();
        v.handleKeyDown(key('AltLeft', { altKey: true }));
        v.handleKeyDown(key(code, { key: code.slice(-1).toLowerCase(), altKey: true }));
        expect(v.sent.at(-1)).toMatchObject({
            type: 'keydown',
            code,
            char: null,
            metaKey: true,
            altKey: false,
        });
        v._sendInputState(true);
        expect(v.sent.at(-1).keys.find((k) => k.code === code)).toMatchObject({
            char: null,
            metaKey: true,
            altKey: false,
        });
        v.handleKeyUp(key('AltLeft'));
        v.handleKeyUp(key(code));
        expect(v.sent.at(-1)).toMatchObject({ type: 'keyup', code, char: null, metaKey: false });
    });
    it('preserves mapped Option and Shift instead of reinterpreting the client character', () => {
        const v = view();
        v.handleKeyDown(key('MetaLeft', { metaKey: true }));
        v.handleKeyDown(key('KeyC', { key: 'C', metaKey: true, shiftKey: true }));
        expect(v.sent.at(-1)).toMatchObject({
            code: 'KeyC',
            char: null,
            altKey: true,
            shiftKey: true,
            metaKey: false,
        });
    });
    it.each(['KeyC', 'KeyZ'])(
        'keeps the held left Alt mapping for %s after paste',
        async (code) => {
            const v = view();
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { readText: vi.fn().mockResolvedValue('local text') },
            });
            v.handleKeyDown(key('AltLeft', { altKey: true }));
            v.handleKeyDown(key('KeyV', { altKey: true }));
            await Promise.resolve();
            v.handleKeyUp(key('KeyV', { altKey: true }));
            v.handleKeyDown(key(code, { key: code.slice(-1).toLowerCase(), altKey: true }));
            expect(v.sent.at(-1)).toMatchObject({ code, char: null, metaKey: true, altKey: false });
            v._sendInputState(true);
            expect(v.sent.at(-1).keys.find((k) => k.code === code)).toMatchObject({
                char: null,
                metaKey: true,
                altKey: false,
            });
            v.handleKeyUp(key(code, { altKey: true }));
            v.handleKeyUp(key('AltLeft'));
            v.handleKeyDown(key('AltRight', { altKey: true }));
            v.handleKeyDown(key(code, { key: code.slice(-1).toLowerCase(), altKey: true }));
            expect(v.sent.at(-1)).toMatchObject({ code, metaKey: false, altKey: true });
            v._releaseAllPhysKeys();
            expect(v._keyMapper.physicalModifiers.size).toBe(0);
        },
    );
    it('does not replace Ctrl+V with Command+V on a Mac host', () => {
        const v = view();
        v.handleKeyDown(key('ControlLeft', { ctrlKey: true }));
        v.handleKeyDown(key('KeyV', { ctrlKey: true }));
        expect(v.sent.at(-1)).toMatchObject({
            type: 'keydown',
            code: 'KeyV',
            ctrlKey: true,
            metaKey: false,
        });
        expect(v._pendingPasteKey).toBeUndefined();
    });
    it('reads local clipboard for Alt+V mapped to host Command+V', async () => {
        const v = view();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { readText: vi.fn().mockResolvedValue('local text') },
        });
        v.handleKeyDown(key('AltLeft', { altKey: true }));
        v.handleKeyDown(key('KeyV', { altKey: true }));
        await Promise.resolve();
        expect(v.sent.at(-1)).toEqual({
            type: 'clipboardpaste',
            text: 'local text',
            injectCtrl: true,
        });
        expect(v._heldPhysKeys.size).toBe(0);
        expect(v.sent.some((m) => m.type === 'keydown' && m.code === 'KeyV')).toBe(false);
    });
    it('drops an in-flight browser read if clipboard sharing is switched off', async () => {
        const v = view();
        let resolve;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                readText: () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            },
        });
        v._readClipboardForHost('KeyV');
        v._setInputPreferences({ clipboard: 'off' }, false);
        resolve('secret');
        await Promise.resolve();
        expect(v.sent.some((m) => m.type === 'clipboardpaste')).toBe(false);
    });
    it('ignores keys mapped to an empty target, including heartbeats', () => {
        const m = mapper({ AltLeft: '' });
        const e = event('keydown', 'AltLeft', { altKey: true });
        expect(m.send(e)).toBe(null);
        expect(m.held([e])).toEqual([]);
        expect(m.send(event('keydown', 'KeyV', { altKey: true })).altKey).toBe(false);
        expect(m.send(event('keyup', 'AltLeft'))).toBe(null);
    });
    it('provides independent from/to rows and no preset button', () => {
        const v = sink();
        v.streamEl = document.createElement('div');
        document.body.append(v.streamEl);
        HTMLDialogElement.prototype.showModal = vi.fn();
        openKeyMappingDialog(v, structuredClone(v._inputPreferences));
        const dialog = document.querySelector('dialog');
        expect(dialog.querySelectorAll('tbody tr').length).toBe(2);
        expect(dialog.querySelectorAll('tbody input').length).toBe(4);
        expect(dialog.querySelectorAll('tbody select').length).toBe(0);
        expect(dialog.querySelector('.session-input-info').getAttribute('title')).toBeTruthy();
        expect(dialog.querySelector('details').open).toBe(false);
        expect(dialog.querySelector('details button')).not.toBeNull();
    });
});

it('holds mapped movement keys through a gaming stall using the target key', () => {
    const m = new SessionKeyMapper(
        { KeyI: 'KeyW', KeyW: 'KeyB' },
        StreamView.codeToWindowsVk,
        (code) => StreamView.HOLD_THROUGH_STALL_CODES.has(code),
    );
    expect(m.send(event('keydown', 'KeyI')).hold).toBe(true);
    expect(m.send(event('keydown', 'KeyW', { hold: true })).hold).toBe(false);
});

describe('session input draft transactions', () => {
    let v;
    const buttons = (dialog, label) =>
        [...dialog.querySelectorAll('button')].find((b) => b.textContent === label);
    const check = (dialog, label) =>
        [...dialog.querySelectorAll('label')]
            .find((l) => l.textContent === label)
            .querySelector('input');
    const mapping = () => {
        buttons(v._inputDialog, t('sessionInput.mapping')).click();
        return document.querySelector('dialog:last-child');
    };
    beforeEach(() => {
        HTMLDialogElement.prototype.showModal = function () {
            this.open = true;
        };
        HTMLDialogElement.prototype.close = function () {
            this.open = false;
            this.dispatchEvent(new Event('close'));
        };
        v = sink();
        v._inputStorageKey = 'test-session-draft';
        v.streamEl = document.createElement('div');
        document.body.append(v.streamEl);
        openSessionInputPanel(v);
    });
    it('discards confirmed child edits when the parent is closed', () => {
        const original = structuredClone(v._inputPreferences);
        const child = mapping();
        child.querySelectorAll('tbody input')[1].value = 'ControlLeft';
        buttons(child, t('sessionInput.confirm')).click();
        expect(v._inputPreferences).toEqual(original);
        buttons(v._inputDialog, t('sessionInput.close')).click();
        expect(v._inputPreferences).toEqual(original);
        expect(localStorage.getItem(v._inputStorageKey)).toBeNull();
    });
    it('applies and remembers clipboard and confirmed mappings together', () => {
        check(v._inputDialog, t('sessionInput.remember')).checked = true;
        check(v._inputDialog, t('sessionInput.receive')).checked = false;
        const child = mapping();
        child.querySelectorAll('tbody input')[1].value = 'ControlLeft';
        buttons(child, t('sessionInput.confirm')).click();
        expect(localStorage.getItem(v._inputStorageKey)).toBeNull();
        buttons(v._inputDialog, t('sessionInput.apply')).click();
        expect(v._inputPreferences).toMatchObject({
            clipboard: 'send',
            remember: true,
            mappings: { AltLeft: 'ControlLeft' },
        });
        expect(JSON.parse(localStorage.getItem(v._inputStorageKey))).toEqual(v._inputPreferences);
    });
    it.each(['close', 'escape'])(
        'discards child edits on %s while retaining earlier confirmed edits',
        (action) => {
            let child = mapping();
            child.querySelectorAll('tbody input')[1].value = 'ControlLeft';
            buttons(child, t('sessionInput.confirm')).click();
            child = mapping();
            child.querySelectorAll('tbody input')[1].value = 'ShiftLeft';
            if (action === 'close') buttons(child, t('sessionInput.close')).click();
            else {
                child.dispatchEvent(new Event('cancel'));
                child.close();
            }
            buttons(v._inputDialog, t('sessionInput.apply')).click();
            expect(v._inputPreferences.mappings.AltLeft).toBe('ControlLeft');
        },
    );
    it('rejects identical source/target codes but permits an empty target', () => {
        const child = mapping();
        child.querySelectorAll('tbody input')[1].value = 'AltLeft';
        buttons(child, t('sessionInput.confirm')).click();
        expect(child.open).toBe(true);
        expect(child.querySelector('[role=status]').textContent).toBe(t('sessionInput.sameCode'));
        child.querySelectorAll('tbody input')[1].value = '';
        buttons(child, t('sessionInput.confirm')).click();
        buttons(v._inputDialog, t('sessionInput.apply')).click();
        expect(v._inputPreferences.mappings.AltLeft).toBe('');
    });
    it('does not report an empty paste as sent and accepts whitespace', () => {
        const panel = v._inputDialog;
        const text = panel.querySelector('textarea');
        const paste = buttons(panel, t('sessionInput.paste'));
        expect(paste.disabled).toBe(true);
        paste.dispatchEvent(new Event('click'));
        expect(v.sent.some((m) => m.type === 'clipboardpaste')).toBe(false);
        text.value = ' ';
        text.dispatchEvent(new Event('input'));
        expect(paste.disabled).toBe(false);
        paste.click();
        expect(v.sent.at(-1)).toMatchObject({ type: 'clipboardpaste', text: ' ' });
        expect(v._pasteSessionText('')).toBe(false);
    });
    it('keeps manual paste on applied settings while the clipboard draft is off', () => {
        const panel = v._inputDialog;
        const master = panel.querySelector('[role=switch]');
        master.checked = false;
        master.dispatchEvent(new Event('change'));
        const text = panel.querySelector('textarea');
        text.value = 'manual';
        text.dispatchEvent(new Event('input'));
        buttons(panel, t('sessionInput.paste')).click();
        expect(v.sent.at(-1)).toMatchObject({ type: 'clipboardpaste', text: 'manual' });
        expect(v._inputPreferences.clipboard).toBe('both');
    });
    it('does not configure a standby until it becomes active', () => {
        v._standby = true;
        v._syncClipboardPreferences();
        expect(v.sent.some((m) => m.type === 'clipboardconfig')).toBe(false);
        v._standby = false;
        v._syncClipboardPreferences();
        expect(v.sent.at(-1)).toMatchObject({ type: 'clipboardconfig', send: true, receive: true });
    });
});
