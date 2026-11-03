/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The attempts left before a lockout, on the PIN screen: said once a PIN was
 * wrong, and not before. A count of tries shown to someone who has typed nothing
 * yet reads as a warning about something they did not do (Bruno, 27/10/2026).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getAuthStatus: vi.fn(),
        validatePin: vi.fn(),
        validateCertificate: vi.fn(async () => ({ status: 'ok' })),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({
    Toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({
    t: (key, vars) => (vars && 'count' in vars ? `${key}:${vars.count}` : key),
}));
vi.mock('../js/net/tunnelBridge.js', () => ({
    tunnelHostId: () => null,
}));

import { LoginView } from '../js/ui/LoginView.js';
import { BackendClient } from '../js/api/BackendClient.js';

describe('the attempts left on the PIN screen', () => {
    let view;

    const open = async () => {
        document.body.innerHTML = '<div id="host"></div>';
        view = new LoginView(document.getElementById('host'), () => {});
        await view.start();
    };
    const said = () => document.getElementById('login-remaining').textContent;
    const typeWrongPin = async (remaining) => {
        const err = new Error('Invalid PIN');
        err.statusCode = 401;
        err.responseBody = { remaining };
        BackendClient.validatePin.mockRejectedValueOnce(err);
        const pin = /** @type {HTMLInputElement} */ (document.getElementById('login-pin-input'));
        pin.value = '000000';
        pin.dispatchEvent(new Event('input'));
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(BackendClient.validatePin).toHaveBeenCalled());
        await vi.waitFor(() =>
            expect(document.getElementById('login-error').textContent).not.toBe(''),
        );
    };

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });
    afterEach(() => view && view.destroy());

    it('are not said to someone who has not been wrong yet', async () => {
        BackendClient.getAuthStatus.mockResolvedValue({ authenticated: false, remaining: 3 });
        await open();
        expect(said()).toBe('');
    });

    it('are said once a PIN typed here was wrong', async () => {
        BackendClient.getAuthStatus.mockResolvedValue({ authenticated: false, remaining: 3 });
        await open();
        await typeWrongPin(2);
        expect(said()).toBe('login.attemptsRemaining:2');
    });

    it('are said when the host already counted a wrong PIN from here', async () => {
        BackendClient.getAuthStatus.mockResolvedValue({ authenticated: false, remaining: 2 });
        await open();
        expect(said()).toBe('login.attemptsRemaining:2');
    });
});
