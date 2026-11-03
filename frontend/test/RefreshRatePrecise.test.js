/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * This screen to the millihertz (util/RefreshRate.js, "To the millihertz"):
 * the slope of rAF over twelve seconds tells a panel at 119.872 Hz from one
 * at 120, which ninety refreshes on a coarsened clock barely do — and the
 * host may match its virtual display to it (`vddmatch`, plan glissade).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function load() {
    vi.resetModules();
    vi.doMock('../js/util/BrowserDetect.js', async () => ({
        ...(await vi.importActual('../js/util/BrowserDetect.js')),
        IS_TV: false,
    }));
    return import('../js/util/RefreshRate.js');
}

/** A screen at `hz`, its rAF stamps coarsened to `grainMs`, one refresh in
 *  `skipEvery` skipped (0: none). */
function screenAt(hz, grainMs = 0.1, skipEvery = 0) {
    const period = 1000 / hz;
    let i = 0;
    // A microtask, not a timer: twelve seconds of refreshes in no time.
    const raf = vi.fn((cb) =>
        Promise.resolve().then(() => {
            i += skipEvery && i % skipEvery === skipEvery - 1 ? 2 : 1;
            const t = 1000 + i * period;
            cb(Math.floor(t / grainMs) * grainMs);
        }),
    );
    vi.stubGlobal('requestAnimationFrame', raf);
}

function pageHidden(hidden) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

/** Stamps of a screen at `hz` over `ms`, coarsened, some skipped. */
function stamps(hz, ms, grainMs = 1, skipEvery = 0) {
    const out = [];
    const period = 1000 / hz;
    for (let i = 0; i * period < ms; i++) {
        if (skipEvery && i % skipEvery === 1) continue;
        out.push(Math.floor((5000 + i * period) / grainMs) * grainMs);
    }
    return out;
}

describe('RefreshRate to the millihertz', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock('../js/util/BrowserDetect.js');
        delete document.hidden;
        localStorage.clear();
    });

    it('reads 119.872 Hz from twelve seconds on a millisecond clock', async () => {
        const { slopePeriodMs } = await load();
        const period = slopePeriodMs(stamps(119.872, 12000, 1), 1000 / 120);
        expect(Math.round(1e6 / period)).toBeGreaterThanOrEqual(119862);
        expect(Math.round(1e6 / period)).toBeLessThanOrEqual(119882);
    });

    it('lets a skipped refresh skip its index, not the period', async () => {
        const { slopePeriodMs } = await load();
        const period = slopePeriodMs(stamps(59.94, 12000, 1, 7), 1000 / 60);
        expect(Math.abs(1e6 / period - 59940)).toBeLessThan(10);
    });

    it('refuses a run too short, too sparse, or off one grid', async () => {
        const { slopePeriodMs } = await load();
        expect(slopePeriodMs(stamps(120, 5000), 1000 / 120)).toBe(0);
        // Every third refresh only.
        const sparse = stamps(120, 12000).filter((_t, i) => i % 3 === 0);
        expect(slopePeriodMs(sparse, 1000 / 120)).toBe(0);
        // Half at 120, half at 144: no one grid.
        const a = stamps(120, 6000);
        const b = stamps(144, 6000).map((t) => t + a[a.length - 1] - 5000 + 7);
        expect(slopePeriodMs(a.concat(b), 1000 / 120)).toBe(0);
    });

    it('replaces the quick reading with the precise one, and keeps it here', async () => {
        const rate = await load();
        pageHidden(false);
        screenAt(119.872, 1);
        const quick = await rate.measureRefreshRate({ frames: 90 });
        expect(Math.abs(quick - 120000)).toBeLessThan(400);
        const precise = await rate.measureRefreshRatePrecisely({ durationMs: 12000 });
        expect(Math.abs(precise - 119872)).toBeLessThanOrEqual(10);
        expect(rate.currentRefreshMilliHz()).toBe(precise);
        expect(Number(localStorage.getItem('mw_refresh_precise_mhz'))).toBe(precise);
        // A quick reading of the same screen later — a stream's start —
        // leaves the precise one standing.
        screenAt(119.872, 1);
        expect(await rate.measureRefreshRate({ frames: 90 })).toBe(precise);
    });

    it('starts the next page on the precise reading this browser kept', async () => {
        localStorage.setItem('mw_refresh_precise_mhz', '119872');
        const rate = await load();
        pageHidden(false);
        screenAt(119.872, 1);
        expect(await rate.measureRefreshRate({ frames: 90 })).toBe(119872);
        // Another screen: the kept reading is not this one's.
        screenAt(144, 1);
        expect(Math.abs((await rate.measureRefreshRate({ frames: 90 })) - 144000)).toBeLessThan(
            500,
        );
    });
});
