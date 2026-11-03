/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * HidHelpDialog — what « As itself » needs, when this page's host cannot.
 *
 * The HID passthrough recreates the device on MoonlightWeb's own host: Linux
 * does it out of the box (uhid, uinput); Windows needs the "MoonlightWeb
 * Virtual HID" driver, which the installer sets up on x64 — a host without it
 * runs an older MoonlightWeb, or Windows on ARM; macOS cannot. Settings opens
 * this instead of Chrome's chooser when no native host this page knows can
 * take the device (hidHelpFor()).
 */

import { t } from '../i18n/i18n.js';
import { escapeHtml } from '../util/escapeHtml.js';

/** The wiki's section: which hosts take a device as itself, and how. */
export const HID_HELP_URL =
    'https://github.com/linckosz/moonlight-web/blob/main/docs/wiki/04-Frontend.md#49-wheels-and-radios-as-themselves';

/**
 * @param {'windows'|'macos'|'none'} kind why this page's host cannot
 * @returns {Promise<void>} once closed
 */
export function openHidHelp(kind) {
    return new Promise((resolve) => {
        const lead = {
            windows: 'settings.hidHelpWindows',
            macos: 'settings.hidHelpMac',
            none: 'settings.hidHelpNone',
        };
        const el = document.createElement('div');
        el.className = 'share-popin-overlay hid-help-overlay';
        el.innerHTML = `
            <div class="share-popin hid-help" role="dialog" aria-modal="true" aria-labelledby="hid-help-title">
                <h3 id="hid-help-title">${escapeHtml(t('settings.hidHelpTitle'))}</h3>
                <p class="hid-help-lead">${escapeHtml(t(lead[kind] || lead.none))}</p>
                <div class="hid-help-way" data-way="linux">
                    <div class="hid-help-way-title">${escapeHtml(t('settings.hidHelpLinuxTitle'))}</div>
                    <div class="hid-help-way-text">${escapeHtml(t('settings.hidHelpLinux'))}</div>
                </div>
                <div class="hid-help-way" data-way="windows">
                    <div class="hid-help-way-title">${escapeHtml(t('settings.hidHelpWindowsTitle'))}</div>
                    <div class="hid-help-way-text">${escapeHtml(t('settings.hidHelpWindowsInstall'))}</div>
                    <a class="hid-help-link" href="${HID_HELP_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('settings.hidHelpLink'))}</a>
                </div>
                <p class="hid-help-meanwhile">${escapeHtml(t('settings.hidHelpMeanwhile'))}</p>
                <div class="share-popin-actions">
                    <button type="button" class="btn" data-close data-nav-initial>${escapeHtml(t('common.close'))}</button>
                </div>
            </div>
        `;
        const done = () => {
            document.removeEventListener('keydown', onKey, true);
            el.remove();
            resolve();
        };
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            done();
        };
        el.addEventListener('click', (e) => {
            const target = /** @type {Element} */ (e.target);
            if (target === el || target.closest('[data-close]')) done();
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(el);
        /** @type {HTMLElement|null} */ (el.querySelector('[data-close]'))?.focus();
    });
}
