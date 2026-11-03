/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { headerProgress, init, SLIDE_RUN, GLASS_RUN } from '../js/ui/ViewHeaderScroll.js';

/**
 * The Settings / Admin title slides and draws its hairline over the first
 * SLIDE_RUN px of scroll, while the band behind it is opaque after GLASS_RUN px,
 * before the first section reaches the title.
 */

describe('headerProgress', () => {
    it('is at rest before any scroll, and past the runs stays done', () => {
        expect(headerProgress(0)).toEqual({ p: 0, pg: 0 });
        expect(headerProgress(-30)).toEqual({ p: 0, pg: 0 }); // iOS rubber band
        expect(headerProgress(SLIDE_RUN)).toEqual({ p: 1, pg: 1 });
        expect(headerProgress(5000)).toEqual({ p: 1, pg: 1 });
    });

    it('covers the options before the slide is over', () => {
        const { p, pg } = headerProgress(GLASS_RUN);
        expect(pg).toBe(1);
        expect(p).toBeLessThan(0.3);
    });

    it('starts and ends the slide slowly', () => {
        expect(headerProgress(SLIDE_RUN / 2).p).toBeCloseTo(0.5);
        expect(headerProgress(SLIDE_RUN * 0.1).p).toBeLessThan(0.1);
        expect(headerProgress(SLIDE_RUN * 0.9).p).toBeGreaterThan(0.9);
    });
});

describe('init', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('publishes the progress on the scroller, once per frame', () => {
        /** @type {FrameRequestCallback[]} */
        const frames = [];
        vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ cb) => {
            frames.push(cb);
            return frames.length;
        });
        const doc = document.implementation.createHTMLDocument('');
        doc.body.innerHTML = '<main id="main-content"></main><div id="other"></div>';
        init(doc);
        const main = /** @type {HTMLElement} */ (doc.getElementById('main-content'));

        main.scrollTop = 20;
        main.dispatchEvent(new Event('scroll'));
        main.dispatchEvent(new Event('scroll'));
        expect(frames).toHaveLength(1);
        frames[0](0);
        expect(main.style.getPropertyValue('--vh-pg')).toBe((20 / GLASS_RUN).toFixed(4));
        expect(main.style.getPropertyValue('--vh-p')).toBe(headerProgress(20).p.toFixed(4));

        // Another scroller (a dialog, a list) leaves the title alone.
        const other = /** @type {HTMLElement} */ (doc.getElementById('other'));
        other.dispatchEvent(new Event('scroll'));
        expect(frames).toHaveLength(1);
    });
});
