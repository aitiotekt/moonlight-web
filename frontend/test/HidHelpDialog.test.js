/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/i18n/i18n.js', () => ({ t: (key) => key }));

const { HID_HELP_URL, openHidHelp } = await import('../js/ui/HidHelpDialog.js');

afterEach(() => {
    document.body.innerHTML = '';
});

describe('HidHelpDialog (« As itself » on a host that cannot)', () => {
    it('says why for this host, and both ways out with the wiki link', () => {
        openHidHelp('macos');
        const box = document.querySelector('.hid-help');
        expect(box.querySelector('.hid-help-lead').textContent).toBe('settings.hidHelpMac');
        expect(box.querySelector('[data-way="linux"]')).not.toBeNull();
        const link = box.querySelector('[data-way="windows"] a');
        expect(link.getAttribute('href')).toBe(HID_HELP_URL);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('words a Windows host without the driver, and a page without a native host', () => {
        openHidHelp('windows');
        expect(document.querySelector('.hid-help-lead').textContent).toBe(
            'settings.hidHelpWindows',
        );
        document.body.innerHTML = '';
        openHidHelp('none');
        expect(document.querySelector('.hid-help-lead').textContent).toBe('settings.hidHelpNone');
    });

    it('closes on its button and on Escape', async () => {
        let closed = openHidHelp('windows');
        /** @type {HTMLElement} */ (document.querySelector('[data-close]')).click();
        await closed;
        expect(document.querySelector('.hid-help')).toBeNull();

        closed = openHidHelp('windows');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await closed;
        expect(document.querySelector('.hid-help')).toBeNull();
    });
});
