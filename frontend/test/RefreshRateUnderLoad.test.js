/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * A phone under a stream reads its screen low (util/RefreshRate.js, "Under
 * load"): the realme Note 60's 60 Hz as 35-39, the iPhone 13 Pro's 120 as
 * 112-116, and the host ran 56-58 fps off that (22/10/2026). A lower reading
 * whose deltas are not one tight cluster is the page, not the screen. One that
 * is — Chrome on the iPhone, held to 60 Hz, read 57.5, 44.0, 50.7 and 57.3 —
 * waits for twelve seconds of rAF on its grid: a window that really moved to
 * a slower screen gets them, and is believed; a loaded page does not.
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

/** The page's clock, on across the patterns a test switches between. */
let clock = 1000;

/** rAF handing out the deltas of `next()` on a clock coarsened to `grainMs`:
 *  one frame for all the callbacks waiting on it, with one timestamp, as a
 *  browser does for a quick reading and a precise one at once. */
function ticks(next, grainMs = 0) {
    /** @type {((t: number) => void)[]} */
    let waiting = [];
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((cb) => {
            waiting.push(cb);
            if (waiting.length > 1) return;
            Promise.resolve().then(() => {
                clock += next();
                const due = waiting;
                waiting = [];
                for (const f of due) f(grainMs ? Math.floor(clock / grainMs) * grainMs : clock);
            });
        }),
    );
}

/** A screen at `hz`, one refresh in `skipEvery` shown twice (0: none). */
function screenAt(hz, grainMs = 0, skipEvery = 0) {
    let i = 0;
    ticks(() => (skipEvery && ++i % skipEvery === 0 ? 2 : 1) * (1000 / hz), grainMs);
}

/** The same uniform [0, 1) draws on every run. */
function draws(seed = 7) {
    let s = seed;
    return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
}

/** A loaded page whose frames land where it lets them, deltas `next(u)`:
 *  clean as a 90-frame reading, on no grid over twelve seconds. */
function pageAt(next, grainMs = 1) {
    const u = draws();
    ticks(() => next(u()), grainMs);
}

describe('RefreshRate under load', () => {
    afterEach(() => {
        clock = 1000;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.doUnmock('../js/util/BrowserDetect.js');
        localStorage.clear();
    });

    it('keeps 60 Hz when most frames are skipped (the realme)', async () => {
        const rate = await load();
        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);

        // Two frames in three on the doubled period: read 37.5 Hz before.
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 1 : 2) * (1000 / 60));
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await rate.measureRefreshRate()).toBe(60000);
        expect(rate.currentRefreshMilliHz()).toBe(60000);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('read under load'));
        expect(rate.refreshConfirmation()).toBeNull();
    });

    it('keeps 120 Hz when frames land between two refreshes (the iPhone)', async () => {
        const rate = await load();
        screenAt(120, 1);
        const at120 = await rate.measureRefreshRate();
        expect(Math.abs(at120 - 120000)).toBeLessThan(600);

        // One delta in three at 12.5 ms: read 112 Hz before.
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 12.5 : 1000 / 120), 1);
        vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await rate.measureRefreshRate()).toBe(at120);
        expect(rate.refreshConfirmation()).toBeNull();
    });

    it('keeps 60 Hz when a loaded page reads low and clean (Chrome on the iPhone)', async () => {
        const rate = await load();
        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);
        const told = vi.fn();
        rate.onRefreshRateChange(told);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        // 44 Hz: every frame 20-26 ms after the last, as the page lets it.
        pageAt((u) => 20 + 6 * u);
        expect(await rate.measureRefreshRate()).toBe(60000);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('until twelve seconds'));
        expect(await rate.refreshConfirmation()).toBe(60000);
        expect(info).toHaveBeenCalledWith(expect.stringContaining('not confirmed, 60.0 Hz kept'));

        // 57 Hz: most frames on time, one in five 4-8 ms late.
        pageAt((u) => 1000 / 60 + (u < 0.2 ? 4 + 20 * u : 0));
        expect(await rate.measureRefreshRate()).toBe(60000);
        expect(await rate.refreshConfirmation()).toBe(60000);
        expect(rate.currentRefreshMilliHz()).toBe(60000);
        expect(told).not.toHaveBeenCalled();
    });

    it('believes a window that moved to a slower screen, twelve seconds later', async () => {
        const rate = await load();
        screenAt(165, 1);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(165);
        const told = vi.fn();
        rate.onRefreshRateChange(told);
        vi.spyOn(console, 'info').mockImplementation(() => {});

        // On a millisecond clock, with a skipped refresh now and then.
        screenAt(144, 1, 25);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(165);
        expect(told).not.toHaveBeenCalled();
        expect(Math.round((await rate.refreshConfirmation()) / 1000)).toBe(144);
        expect(told).toHaveBeenCalledTimes(1);
        expect(Math.round(told.mock.calls[0][0] / 1000)).toBe(144);
        // And kept for the next page on this screen, as a precise reading is.
        expect(Number(localStorage.getItem('mw_refresh_precise_mhz'))).toBe(
            rate.currentRefreshMilliHz(),
        );

        screenAt(60, 1);
        await rate.measureRefreshRate();
        expect(Math.round((await rate.refreshConfirmation()) / 1000)).toBe(60);
        expect(Math.round(rate.currentRefreshMilliHz() / 1000)).toBe(60);
    });

    it('drops a lower reading once twelve seconds sit on the old screen', async () => {
        const rate = await load();
        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);
        vi.spyOn(console, 'info').mockImplementation(() => {});

        // A precise reading holds rAF; meanwhile, for a moment, the page shows
        // every other refresh: 30 Hz, and clean.
        const precise = rate.measureRefreshRatePrecisely({ durationMs: 12000 });
        screenAt(30);
        expect(await rate.measureRefreshRate()).toBe(60000);
        expect(rate.refreshConfirmation()).toBeNull();
        screenAt(60);
        expect(Math.round((await precise) / 1000)).toBe(60);
        expect(rate.refreshConfirmation()).toBeNull();
        expect(Math.round(rate.currentRefreshMilliHz() / 1000)).toBe(60);
    });

    it('takes a 240 Hz panel on a millisecond clock as clean', async () => {
        const rate = await load();
        screenAt(240);
        expect(await rate.measureRefreshRate()).toBe(240000);
        screenAt(239, 1);
        expect(Math.round((await rate.measureRefreshRate()) / 1000)).toBe(239);
    });

    it('takes a first reading as it comes, and a higher one at once', async () => {
        const rate = await load();
        let i = 0;
        ticks(() => (++i % 3 === 0 ? 1 : 2) * (1000 / 60));
        const first = await rate.measureRefreshRate();
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(60000);

        screenAt(60);
        expect(await rate.measureRefreshRate()).toBe(60000);
    });
});
