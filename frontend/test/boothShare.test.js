/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../js/ui/ShareMenu.js', () => ({
    ShareMenu: class {
        mount() {
            return Promise.resolve(true);
        }
    },
}));

import { BackendClient } from '../js/api/BackendClient.js';
import { StreamView } from '../js/ui/StreamView.js';

/**
 * Booth mode (--noadmin) and Share (issue #40).
 *
 * A booth lets no guest in, so the stream offers no Share — unless the owner
 * set share_in_booth_mode, which the server reports as booth_share. Outside
 * booth mode the field means nothing and Share is there as before.
 */

function authStatus(body) {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
        }),
    );
    return BackendClient.getAuthStatus();
}

/** Just what _mountShareMenu reads: a header and the Quit button beside it. */
function view() {
    const root = document.createElement('div');
    root.innerHTML = '<div class="stream-header"><button id="btn-stream-quit"></button></div>';
    return {
        _playerMode: false,
        _shareMenu: null,
        _rootEl: root,
        host: { supportsLobbies: false },
    };
}

const mount = (v) => StreamView.prototype._mountShareMenu.call(v);

describe('booth mode and Share', () => {
    beforeEach(() => {
        BackendClient._hadSession = false;
    });

    it('reads booth_share only under admin_locked', async () => {
        await authStatus({ authenticated: true, admin_locked: true });
        expect(BackendClient.boothShare).toBe(false);
        await authStatus({ authenticated: true, admin_locked: true, booth_share: false });
        expect(BackendClient.boothShare).toBe(false);
        await authStatus({ authenticated: true, admin_locked: true, booth_share: true });
        expect(BackendClient.boothShare).toBe(true);
        await authStatus({ authenticated: true, admin_locked: false, booth_share: true });
        expect(BackendClient.boothShare).toBe(false);
    });

    it('a booth offers no Share by default', async () => {
        await authStatus({ authenticated: true, admin_locked: true });
        const v = view();
        mount(v);
        expect(v._shareMenu).toBeNull();
    });

    it('a booth with share_in_booth_mode offers Share', async () => {
        await authStatus({ authenticated: true, admin_locked: true, booth_share: true });
        const v = view();
        mount(v);
        expect(v._shareMenu).not.toBeNull();
    });

    it('outside booth mode, Share is there as before', async () => {
        await authStatus({ authenticated: true, admin_locked: false });
        const v = view();
        mount(v);
        expect(v._shareMenu).not.toBeNull();
    });
});
