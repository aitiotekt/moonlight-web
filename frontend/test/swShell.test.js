/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The service worker where the interface check is enforced (bootstrap/sw.js,
 * D26): it serves the files the entry page checked and nothing else.
 *
 * The entry page holds every file a machine sends against the official
 * interface before storing it. That is only worth something if what the page
 * then runs comes from that store and nowhere else: a file the cache lacks must
 * not be asked of the machine, which could answer anything; what the machine
 * answers on /api/ must never be taken as code; the policy that keeps a checked
 * page from loading anything unchecked must be the bootstrap's, not the
 * machine's; and a request must never be carried by another tab, whose line
 * goes to another machine. Where the check is not enforced, everything stays as
 * it was.
 */

/* global Response, Headers */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(REPO, 'bootstrap', 'sw.js'), 'utf8');

const STAGING = 'stream.dev.example.top';
const PRODUCTION = 'stream.example.top';

/** A Cache, enough of one: entries by path, each a Response the test built. */
function memoryCache(entries = {}) {
    const map = new Map(Object.entries(entries));
    const keyOf = (r) => new URL(typeof r === 'string' ? r : r.url, 'https://x').pathname;
    return {
        map,
        match: async (r) => map.get(keyOf(r))?.clone(),
        put: async (r, response) => void map.set(keyOf(r), response),
        delete: async (r) => map.delete(keyOf(r)),
    };
}

/** A window that holds a line: it answers what the worker hands it. */
function page(
    id,
    answer = { status: 200, headers: [['content-type', 'application/json']], body: '{}' },
) {
    const asked = [];
    return {
        id,
        asked,
        postMessage(message, ports) {
            if (message.type !== 'mw-tunnel-request') return;
            asked.push(message);
            ports[0].postMessage(answer);
        },
    };
}

/**
 * The worker, loaded as the browser would: its listeners registered on a
 * `self` of the given name. With @p enforced the production switch is forced
 * either way, so these cases stay true on the day it is flipped.
 */
function loadWorker({ hostname = STAGING, shell = {}, windows = [page('tab')], production } = {}) {
    const listeners = {};
    const self = {
        location: new URL(`https://${hostname}/sw.js`),
        addEventListener: (type, fn) => void (listeners[type] = fn),
        skipWaiting: () => {},
        clients: {
            get: async (id) => windows.find((w) => w.id === id),
            matchAll: async () => windows,
            claim: async () => {},
        },
    };
    const cache = memoryCache(shell);
    const caches = { open: async (name) => (name === 'mw-shell' ? cache : memoryCache()) };
    const network = vi.fn(async () => new Response('the entry page', { status: 200 }));
    let source = SOURCE;
    if (production !== undefined)
        source = source.replace(
            /const PRODUCTION_ENFORCES = \w+;/,
            `const PRODUCTION_ENFORCES = ${production};`,
        );
    new Function('self', 'caches', 'fetch', source)(self, caches, network);

    return {
        cache,
        network,
        windows,
        tell: (data) => listeners.message({ data, ports: [] }),
        ask(data) {
            return new Promise((resolve) => {
                const channel = new MessageChannel();
                channel.port1.onmessage = (event) => {
                    channel.port1.close();
                    resolve(event.data);
                };
                listeners.message({ data, ports: [channel.port2] });
            });
        },
        /** The worker's answer, or null when it leaves the request to the network. */
        async get(
            path,
            { mode = 'cors', destination = '', clientId = 'tab', method = 'GET' } = {},
        ) {
            const url = new URL(path, `https://${hostname}`).href;
            const request = {
                url,
                mode,
                destination,
                method,
                headers: new Headers(),
                clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
            };
            let answer = null;
            listeners.fetch({ request, clientId, respondWith: (p) => void (answer = p) });
            return answer ? await answer : null;
        },
    };
}

/**
 * The policy the host sends with its pages (HttpServer::securityHeaders), read
 * from its source: the worker's must be the same text, or an interface that
 * needs what the host allows would break on the tunnel alone.
 */
function hostPolicy(host) {
    const cpp = readFileSync(join(REPO, 'backend', 'src', 'server', 'HttpServer.cpp'), 'utf8');
    const block = /headers\["Content-Security-Policy"\] =([\s\S]*?)\.arg\(connectSrc\);/.exec(
        cpp,
    )[1];
    const text = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    return text.replace('%1', `'self' wss://${host}`);
}

/** What a machine left in the cache: its own type and its own policy. */
const hostFile = (body, type = 'text/html') =>
    new Response(body, {
        headers: {
            'Content-Type': type,
            'Content-Security-Policy': "script-src * 'unsafe-inline'",
        },
    });

/** The mark of an application that checks its own version (v0.3.1 on): no trip back. */
const shellOf = (files) => ({ '/js/util/VersionGuard.js': hostFile('mw-shell-recheck'), ...files });

describe('where the interface check is enforced', () => {
    it('says its revision, which the entry page waits for before it hands over', async () => {
        expect(await loadWorker().ask({ type: 'mw-sw-revision' })).toEqual({ revision: 2 });
    });

    it('opens the cached interface only after the entry page said it checked it', async () => {
        const w = loadWorker({ shell: shellOf({ '/index.html': hostFile('<html>') }) });
        await w.get('/', { mode: 'navigate', destination: 'document', clientId: '' });
        expect(w.network).toHaveBeenCalledWith('/?mw=pick', { cache: 'no-store' });

        // The word of an entry page that checked against the machine's own hashes
        // is not enough here.
        w.tell({ type: 'mw-shell-checked' });
        await w.get('/', { mode: 'navigate', destination: 'document', clientId: '' });
        expect(w.network).toHaveBeenCalledTimes(2);

        w.tell({ type: 'mw-shell-verified' });
        const shell = await w.get('/admin', {
            mode: 'navigate',
            destination: 'document',
            clientId: '',
        });
        expect(await shell.text()).toBe('<html>');
        expect(w.network).toHaveBeenCalledTimes(2);
    });

    it("serves a checked file under the bootstrap's policy, not the one the machine sent", async () => {
        const w = loadWorker({
            shell: shellOf({
                '/index.html': hostFile('<html>'),
                '/js/app.js': hostFile('x', 'text/html'),
            }),
        });
        w.tell({ type: 'mw-shell-verified' });
        const shell = await w.get('/', { mode: 'navigate', destination: 'document', clientId: '' });
        const policy = shell.headers.get('Content-Security-Policy');
        expect(policy).toBe(hostPolicy(STAGING));
        expect(shell.headers.get('Content-Type')).toBe('text/html; charset=utf-8');

        const app = await w.get('/js/app.js', { destination: 'script' });
        expect(app.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
        expect(app.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(app.headers.get('Content-Security-Policy')).toBe(policy);
    });

    it('never asks the machine for a file the cache lacks', async () => {
        const w = loadWorker({ shell: shellOf({ '/index.html': hostFile('<html>') }) });
        const miss = await w.get('/js/lazy.js', { destination: 'script' });
        expect(miss.status).toBe(404);
        expect(w.windows[0].asked).toHaveLength(0);
    });

    it("carries the machine's API and version, never from the cache", async () => {
        const w = loadWorker({
            shell: {
                '/version.json': hostFile('{"version":"planted"}'),
                '/api/hosts': hostFile('[]'),
            },
        });
        expect((await w.get('/api/hosts')).status).toBe(200);
        expect((await w.get('/version.json')).status).toBe(200);
        expect(
            (await w.get('/api/hosts/x/appasset?appid=1', { destination: 'image' })).status,
        ).toBe(200);
        expect(w.windows[0].asked.map((m) => new URL(m.url).pathname)).toEqual([
            '/api/hosts',
            '/version.json',
            '/api/hosts/x/appasset',
        ]);
    });

    it("refuses to carry an answer of the machine's that would run as code", async () => {
        const w = loadWorker();
        for (const destination of [
            'script',
            'worker',
            'style',
            'sharedworker',
            'json',
            'audioworklet',
        ]) {
            expect((await w.get('/api/evil', { destination })).status).toBe(403);
            expect((await w.get('/version.json', { destination })).status).toBe(403);
        }
        expect(w.windows[0].asked).toHaveLength(0);
    });

    it('serves the web manifest as a manifest only', async () => {
        const w = loadWorker({ shell: { '/manifest.webmanifest': hostFile('{}', 'text/html') } });
        const manifest = await w.get('/manifest.webmanifest', { destination: 'manifest' });
        expect(manifest.headers.get('Content-Type')).toBe('application/manifest+json');
        expect((await w.get('/manifest.webmanifest', { destination: 'script' })).status).toBe(404);
    });

    it("does not hand a request whose page has gone to another tab, another machine's line", async () => {
        const other = page('other');
        const w = loadWorker({ windows: [other] });
        expect((await w.get('/api/hosts/x/quit', { clientId: 'closed' })).status).toBe(503);
        expect(other.asked).toHaveLength(0);
    });

    it('hands a request the browser named no page for only to the one page there is', async () => {
        const one = loadWorker({ windows: [page('only')] });
        expect((await one.get('/api/health', { clientId: '' })).status).toBe(200);
        const two = loadWorker({ windows: [page('a'), page('b')] });
        expect((await two.get('/api/health', { clientId: '' })).status).toBe(503);
    });

    it("leaves the bootstrap's own files and the identifier's address to the network", async () => {
        const w = loadWorker();
        for (const path of [
            '/sw.js',
            '/tunnel.js',
            '/v1/boot.js',
            '/v1/interfaces/0.4.0.json',
            '/?mw=pick',
        ]) {
            expect(await w.get(path)).toBeNull();
        }
        expect(await w.get(`/${'a'.repeat(26)}`, { mode: 'navigate' })).toBeNull();
    });
});

describe('where it is not enforced, everything as it was', () => {
    const production = { hostname: PRODUCTION, production: false };

    it('opens the cached interface on the word of an entry page of any revision', async () => {
        for (const type of ['mw-shell-checked', 'mw-shell-verified']) {
            const w = loadWorker({
                ...production,
                shell: shellOf({ '/index.html': hostFile('<html>') }),
            });
            w.tell({ type });
            const shell = await w.get('/', {
                mode: 'navigate',
                destination: 'document',
                clientId: '',
            });
            expect(await shell.text()).toBe('<html>');
            // As the machine sent it.
            expect(shell.headers.get('Content-Security-Policy')).toBe(
                "script-src * 'unsafe-inline'",
            );
        }
    });

    it('asks the machine for a file the cache lacks', async () => {
        const w = loadWorker(production);
        expect((await w.get('/js/lazy.js', { destination: 'script' })).status).toBe(200);
        expect(w.windows[0].asked).toHaveLength(1);
    });

    it('hands a request whose page has gone to whichever window there is', async () => {
        const other = page('other');
        const w = loadWorker({ ...production, windows: [other] });
        expect((await w.get('/api/hosts/x/quit', { clientId: 'closed' })).status).toBe(200);
        expect(other.asked).toHaveLength(1);
    });

    it('is the staging server alone until production is switched over', async () => {
        const w = loadWorker({ hostname: PRODUCTION, production: true, shell: {} });
        expect((await w.get('/js/lazy.js', { destination: 'script' })).status).toBe(404);
    });
});
