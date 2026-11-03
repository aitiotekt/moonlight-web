/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The PIN page's two small promises: the session name typed once comes back
 * the next time this browser has to unlock (the host lists the device by it),
 * and a digit always lands right after the last one typed, where a mouse's
 * caret is kept and a finger's is not taken away from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getAuthStatus: vi.fn(),
        validatePin: vi.fn(async () => ({ status: 'ok' })),
        validateCertificate: vi.fn(async () => ({ status: 'ok' })),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({
    Toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({
    t: (key) => key,
}));
vi.mock('../js/net/tunnelBridge.js', () => ({
    tunnelHostId: () => null,
}));

import { LoginView } from '../js/ui/LoginView.js';
import { BackendClient } from '../js/api/BackendClient.js';

describe('LoginView session name and PIN caret', () => {
    let view;

    const open = async () => {
        document.body.innerHTML = '<div id="host"></div>';
        view = new LoginView(document.getElementById('host'), () => {});
        await view.start();
    };
    const nameInput = () =>
        /** @type {HTMLInputElement} */ (document.getElementById('login-machine-input'));
    const pinInput = () =>
        /** @type {HTMLInputElement} */ (document.getElementById('login-pin-input'));
    const type = (el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input'));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        BackendClient.getAuthStatus.mockResolvedValue({ authenticated: false, remaining: 3 });
    });
    afterEach(() => view && view.destroy());

    it('offers the name signed in under last time', async () => {
        await open();
        expect(nameInput().value).toBe(LoginView.suggestedMachineName());

        type(nameInput(), 'Living-room tablet');
        type(pinInput(), '123456');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(BackendClient.validatePin).toHaveBeenCalled());
        await Promise.resolve();
        view.destroy();

        await open();
        expect(nameInput().value).toBe('Living-room tablet');
    });

    it('keeps following the browser when the suggestion was left as it was', async () => {
        localStorage.setItem('mw-session-name', 'Old name');
        await open();
        type(nameInput(), LoginView.suggestedMachineName());
        type(pinInput(), '123456');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(BackendClient.validatePin).toHaveBeenCalled());
        await Promise.resolve();
        expect(localStorage.getItem('mw-session-name')).toBeNull();
    });

    it('keeps the typed name through a wrong PIN', async () => {
        BackendClient.validatePin.mockRejectedValueOnce(
            Object.assign(new Error('nope'), { statusCode: 401, responseBody: { remaining: 2 } }),
        );
        await open();
        type(nameInput(), 'Phone');
        type(pinInput(), '111111');
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() =>
            expect(document.getElementById('login-error').textContent).not.toBe(''),
        );
        expect(nameInput().value).toBe('Phone');
        expect(localStorage.getItem('mw-session-name')).toBeNull();
    });

    it('puts the caret back right after the last digit', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        expect(pin.value).toBe('34- ---');

        pin.setSelectionRange(1, 1); // "3|4"
        document.dispatchEvent(new Event('selectionchange'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([2, 2]);

        pin.setSelectionRange(6, 6); // among the dashes
        pin.dispatchEvent(new Event('click'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([2, 2]);
    });

    it("leaves a finger's caret where it landed, so a tap on it brings Paste", async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        const down = new Event('pointerdown');
        Object.defineProperty(down, 'pointerType', { value: 'touch' });
        pin.dispatchEvent(down);
        pin.setSelectionRange(6, 6); // tapped among the dashes
        document.dispatchEvent(new Event('selectionchange'));
        pin.dispatchEvent(new Event('click'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([6, 6]);
    });

    it('puts a digit typed or erased away from the slot after the last one', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        const edit = (inputType, data, cancelable = true) => {
            const e = new Event('beforeinput', { cancelable });
            Object.defineProperty(e, 'inputType', { value: inputType });
            Object.defineProperty(e, 'data', { value: data });
            pin.dispatchEvent(e);
            return e;
        };

        pin.setSelectionRange(1, 1); // "3|4"
        expect(edit('insertText', '5').defaultPrevented).toBe(true);
        expect(pin.value).toBe('345 ---');

        pin.setSelectionRange(0, 0);
        edit('deleteContentBackward', null);
        expect(pin.value).toBe('34- ---');

        // A browser that will not let it be cancelled types it where the
        // caret was; the input that follows puts it in its place.
        pin.setSelectionRange(1, 1);
        edit('insertText', '7', false);
        type(pin, '374- ---');
        expect(pin.value).toBe('347 ---');
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([3, 3]);
    });

    it('leaves a long-press selection alone, so the Paste menu stays', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '3456');
        pin.setSelectionRange(0, 7);
        document.dispatchEvent(new Event('selectionchange'));
        expect([pin.selectionStart, pin.selectionEnd]).toEqual([0, 7]);
    });

    it('reads a pasted PIN whole, wherever the caret was', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        type(pin, '34');
        const paste = (text) => {
            const e = new Event('paste', { cancelable: true });
            Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
            pin.dispatchEvent(e);
            return e;
        };
        expect(paste('702 502').defaultPrevented).toBe(true);
        expect(pin.value).toBe('702 502');

        type(pin, '12');
        paste('34');
        expect(pin.value).toBe('123 4--');
    });

    it('swallows the keys that walk the caret', async () => {
        await open();
        const pin = pinInput();
        pin.focus();
        const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
        pin.dispatchEvent(left);
        expect(left.defaultPrevented).toBe(true);
    });
});
