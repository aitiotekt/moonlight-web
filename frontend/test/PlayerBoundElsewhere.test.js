/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * An invitation whose PIN another browser already spent. The guest who reads
 * this is usually the same person in a private tab or a second browser: the
 * page must tell them the link is taken and where it lives, not that it died,
 * and it must still offer no PIN form to guess against.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        playerInfo: vi.fn(),
        playerPin: vi.fn(),
    },
}));
vi.mock('../js/i18n/i18n.js', () => ({
    t: (key) => 'text:' + key,
}));

import { PlayerJoinView } from '../js/ui/PlayerJoinView.js';
import { BackendClient } from '../js/api/BackendClient.js';

function refusal(error, statusCode = 404) {
    const err = /** @type {any} */ (new Error(error));
    err.statusCode = statusCode;
    err.responseBody = { error };
    return err;
}

describe('PlayerJoinView on a link bound elsewhere', () => {
    let view;
    let container;

    const title = () => container.querySelector('.player-card h1').textContent;

    beforeEach(() => {
        document.body.innerHTML = '<div id="player"></div>';
        container = document.getElementById('player');
        vi.clearAllMocks();
        view = new PlayerJoinView(container, 'tok', async () => {});
    });

    it('says the invitation is already used, and where to reopen it', async () => {
        BackendClient.playerInfo.mockRejectedValue(refusal('bound_elsewhere'));
        await view.refresh();
        expect(title()).toBe('text:player.boundTitle');
        expect(container.textContent).toContain('text:player.boundBody');
        expect(container.textContent).toContain('text:player.boundHint');
        expect(container.querySelector('.player-pin-form')).toBeNull();
    });

    it('keeps the dead page for a link that is gone', async () => {
        BackendClient.playerInfo.mockRejectedValue(refusal('dead_link'));
        await view.refresh();
        expect(title()).toBe('text:player.deadTitle');
    });

    it('keeps the dead page when the server cannot be reached', async () => {
        BackendClient.playerInfo.mockRejectedValue(new Error('Failed to fetch'));
        await view.refresh();
        expect(title()).toBe('text:player.deadTitle');
    });
});
