/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * A file of the application the browser refuses to cache: it is tried once more
 * after a pause, and if that fails too the entry page's failure names the file
 * and the storage error, where the browser's own message named neither (26/10,
 * "Entry already exists." for the whole interface).
 */

/* global Response */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { storeShellFile, SHELL_STORE_RETRY_MS } from '../../bootstrap/v1/tunnel.js';

/**
 * A cache whose puts answer @p outcomes in turn ('ok' or what to reject with).
 * Each put reads the body first, as the browser's does, so a body handed over
 * twice fails the second time.
 */
function fakeCache(...outcomes) {
    const calls = [];
    const bodies = [];
    return {
        calls,
        bodies,
        put: async (path, response) => {
            calls.push([path, response]);
            bodies.push(await response.text());
            const outcome = outcomes[calls.length - 1];
            if (outcome !== 'ok') throw outcome;
        },
    };
}

function entryExists() {
    const e = new Error("Failed to execute 'put' on 'Cache': Entry already exists.");
    e.name = 'InvalidStateError';
    return e;
}

/** Store, with the pause before the second try run out on the fake clock. */
async function store(cache, path, response) {
    const done = storeShellFile(cache, path, response);
    done.catch(() => {}); // awaited below; only keeps the rejection from looking unhandled
    await vi.advanceTimersByTimeAsync(SHELL_STORE_RETRY_MS);
    return done;
}

describe('storeShellFile', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('puts the response under its path, once when the browser takes it', async () => {
        const cache = fakeCache('ok');
        const response = new Response('x');
        await store(cache, '/js/app.js', response);
        expect(cache.calls).toEqual([['/js/app.js', response]]);
    });

    it('tries once more after the pause, and the file is stored', async () => {
        const cache = fakeCache(entryExists(), 'ok');
        const response = new Response('body');
        const done = storeShellFile(cache, '/js/app.js', response);
        await vi.advanceTimersByTimeAsync(SHELL_STORE_RETRY_MS - 1);
        expect(cache.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(cache.calls).toHaveLength(2);
        expect(cache.calls[1][0]).toBe('/js/app.js');
    });

    it('hands the second try a copy of the body, since the first one read it', async () => {
        const cache = fakeCache(entryExists(), 'ok');
        const response = new Response('body');
        await store(cache, '/js/app.js', response);
        expect(cache.bodies).toEqual(['body', 'body']);
        expect(cache.calls[1][1]).not.toBe(response);
    });

    it('names the file and the last storage error when both tries fail', async () => {
        const last = entryExists();
        const cache = fakeCache(new Error('first'), last);
        await expect(store(cache, '/js/ui/StreamView.js', new Response('x'))).rejects.toThrow(
            "the browser could not store /js/ui/StreamView.js (InvalidStateError: Failed to execute 'put' on 'Cache': Entry already exists.)",
        );
        expect(cache.calls).toHaveLength(2);
    });

    it('still names the file when what was thrown is not an Error', async () => {
        const cache = fakeCache('quota', 'quota');
        await expect(store(cache, '/css/base.css', new Response('x'))).rejects.toThrow(
            'the browser could not store /css/base.css (quota)',
        );
    });
});
