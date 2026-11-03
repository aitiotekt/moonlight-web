/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The admin button after a PIN login, on a machine that offers its admin page
 * behind the remote admin password: there from the first visit. The host
 * offers that page to signed-in sessions only, and the application read the
 * offer once, before the login, so the button showed only after a reload
 * (27/10/2026).
 */

// Not localhost, where every browser has the admin page.
// @vitest-environment-options {"url": "https://stream.moonlightweb.top/"}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonlightApp } from '../js/app.js';
import { BackendClient } from '../js/api/BackendClient.js';
import { Toast } from '../js/ui/Toast.js';

describe('the admin button after a PIN login', () => {
    let signedIn;
    let offered;
    let saved;

    beforeEach(() => {
        saved = {
            loginView: MoonlightApp.loginView,
            state: MoonlightApp.state,
            _hasAdminAccess: MoonlightApp._hasAdminAccess,
            _isRealHostMachine: MoonlightApp._isRealHostMachine,
            _adminUnlockAvailable: MoonlightApp._adminUnlockAvailable,
        };
        signedIn = false;
        offered = false;
        localStorage.clear();
        document.body.innerHTML =
            '<button id="btn-admin" style="display: none"></button>' +
            '<button id="btn-settings" style="display: none"></button>' +
            '<div id="main-content"></div>';
        // What the host answers: the offer depends on the session.
        vi.spyOn(BackendClient, 'getAuthStatus').mockImplementation(async () => ({
            authenticated: signedIn,
            is_localhost: false,
            remaining: 3,
            admin_unlock_available: signedIn && offered,
        }));
        vi.spyOn(BackendClient, 'validatePin').mockImplementation(async () => {
            signedIn = true;
            return { status: 'ok' };
        });
        vi.spyOn(Toast, 'success').mockImplementation(() => {});
        // The rest of the start is not what this is about.
        for (const step of ['_offerHomeScreenHandoff', '_initRouter', '_initAsync'])
            vi.spyOn(MoonlightApp, step).mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Object.assign(MoonlightApp, saved);
        document.body.innerHTML = '';
    });

    /** The login page, a right PIN, and the start that follows. */
    async function signIn() {
        expect(await MoonlightApp._checkAuth()).toBe(false);
        await vi.waitFor(() => expect(document.getElementById('login-pin-input')).not.toBe(null));
        const pin = /** @type {HTMLInputElement} */ (document.getElementById('login-pin-input'));
        pin.value = '123456';
        pin.dispatchEvent(new Event('input'));
        document.getElementById('btn-login-unlock').click();
        await vi.waitFor(() => expect(MoonlightApp._initRouter).toHaveBeenCalled());
    }

    it('is there from the first visit when the machine offers its admin page', async () => {
        offered = true;
        await signIn();
        expect(document.getElementById('btn-admin').style.display).toBe('');
    });

    it('stays hidden where the machine does not offer it', async () => {
        await signIn();
        expect(document.getElementById('btn-admin').style.display).toBe('none');
    });
});
