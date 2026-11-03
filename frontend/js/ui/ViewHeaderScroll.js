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
 * MoonlightWeb — the Settings / Admin title while the page scrolls.
 *
 * The title and its ✕ stick under the app header (settings.css). Over the first
 * pixels of scroll the row slides up a little, an opaque band fades in behind
 * it and a hairline grows from the centre. CSS draws all of it from two numbers
 * published here on the scroller, where they survive a view's re-render:
 *   --vh-p   0 → 1 over the first SLIDE_RUN px, eased (slide + hairline)
 *   --vh-pg  0 → 1 over the first GLASS_RUN px (the band is opaque before the
 *            first section reaches the title)
 * The scroller is #main-content, or the document under RemoteNav (TVs).
 */

export const SLIDE_RUN = 160;
export const GLASS_RUN = 40;

const smoothstep = (/** @type {number} */ t) => t * t * (3 - 2 * t);

/**
 * @param {number} scrollTop
 * @returns {{ p: number, pg: number }}
 */
export function headerProgress(scrollTop) {
    const s = Math.max(0, scrollTop);
    return { p: smoothstep(Math.min(1, s / SLIDE_RUN)), pg: Math.min(1, s / GLASS_RUN) };
}

/**
 * One capturing listener for the whole app (scroll does not bubble, capture
 * still sees it), so views can redraw their header as often as they like.
 * @param {Document} [doc]
 */
export function init(doc = document) {
    /** @type {HTMLElement | null} */
    let pending = null;
    let raf = 0;
    const apply = () => {
        raf = 0;
        const el = pending;
        pending = null;
        if (!el) return;
        const { p, pg } = headerProgress(el.scrollTop);
        el.style.setProperty('--vh-p', p.toFixed(4));
        el.style.setProperty('--vh-pg', pg.toFixed(4));
    };
    doc.addEventListener(
        'scroll',
        (e) => {
            const root = /** @type {HTMLElement | null} */ (doc.scrollingElement);
            const el = e.target === doc ? root : /** @type {HTMLElement} */ (e.target);
            if (!el || (el !== root && el.id !== 'main-content')) return;
            pending = el;
            if (!raf) raf = requestAnimationFrame(apply);
        },
        { capture: true, passive: true },
    );
}
