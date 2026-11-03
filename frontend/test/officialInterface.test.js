/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The official interfaces, and how the entry page holds a machine's files
 * against them (bootstrap/v1/official.js, D26).
 *
 * Every machine reached through the introduction server shares one origin, so
 * an interface a machine modified would run beside every other machine's keys
 * and sessions. The entry page compares each file with the list of the release
 * the machine says it runs. What these tests pin is that a genuine machine
 * always passes — the line endings of a Windows install and the name it writes
 * into its main page included — and that a changed file never does.
 */

/* global Response, Request */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';

import {
    appVersionOf,
    cacheMatchesList,
    cacheMatchesManifest,
    canonicalBytes,
    fetchList,
    interfacePolicy,
    isRelease,
    judgeFile,
    officialDigest,
    PRODUCTION_ENFORCES,
    WEB_MANIFEST,
} from '../../bootstrap/v1/official.js';

if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'https://stream.example.top';

const bytesOf = (text) => new TextEncoder().encode(text);
const textOf = (bytes) => new TextDecoder().decode(bytes);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const crlf = (text) => text.replace(/\n/g, '\r\n');

/** The main page as a machine of that version serves it from disk. */
function servedIndex(version = '0.4.1') {
    return readFileSync(join(REPO, 'frontend', 'index.html'), 'utf8')
        .split('__MW_VERSION__')
        .join(version);
}

/**
 * mw::homescreen::shell, mirrored (HomeScreenShell.cpp): the title HTML-escaped
 * into the home-screen name, the icon inlined as a data: URL, first match each.
 */
function personalise(html, title, icon) {
    const escaped = title
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const splice = (page, pattern, value) => {
        const m = pattern.exec(page);
        if (!m) return page;
        const end = m.index + m[0].length - 1;
        return page.slice(0, end - m[1].length) + value + page.slice(end);
    };
    let page = splice(
        html,
        /<meta\s+name="apple-mobile-web-app-title"\s+content="([^"]*)"/,
        escaped,
    );
    page = splice(
        page,
        /<link\s+rel="apple-touch-icon"[^>]*\shref="([^"]*)"/,
        `data:image/png;base64,${Buffer.from(icon).toString('base64')}`,
    );
    return page;
}

describe('the version a machine announces', () => {
    it('is read off the manifest, through the tunnel and without it', () => {
        expect(appVersionOf('0.4.1-0123456789ab')).toBe('0.4.1');
        expect(appVersionOf('0.4.1-0123456789ab-89abcdef')).toBe('0.4.1');
        expect(appVersionOf('0.4.1-dev-0123456789ab-89abcdef')).toBe('0.4.1-dev');
        expect(appVersionOf('0.4.0.g412-stg-0123456789ab')).toBe('0.4.0.g412-stg');
    });

    it('is nothing when the manifest is not shaped as a host writes it', () => {
        expect(appVersionOf('0.4.1')).toBeNull();
        expect(appVersionOf('-0123456789ab')).toBeNull();
        expect(appVersionOf(undefined)).toBeNull();
        expect(appVersionOf({})).toBeNull();
    });

    it('names a list only when it is a release', () => {
        expect(isRelease('0.4.1')).toBe(true);
        expect(isRelease('10.0.12')).toBe(true);
        for (const v of [
            '0.4.1-dev',
            '0.4.0.g412',
            '0.4.0.g412-stg',
            '0.0.0-dev',
            '0.4',
            '../0.4.1',
            null,
        ]) {
            expect(isRelease(v)).toBe(false);
        }
    });
});

describe('where the check is enforced', () => {
    it('refuses on the staging server, and lets the builds between releases through there', () => {
        expect(interfacePolicy('stream.dev.moonlightweb.top')).toEqual({
            enforce: true,
            unreleasedAllowed: true,
        });
    });

    it('holds production to every release, refusing once it is switched over', () => {
        expect(interfacePolicy('stream.moonlightweb.top')).toEqual({
            enforce: PRODUCTION_ENFORCES,
            unreleasedAllowed: false,
        });
        expect(interfacePolicy('stream.dev.example.top.evil')).toEqual({
            enforce: true,
            unreleasedAllowed: true,
        });
        expect(interfacePolicy(undefined).unreleasedAllowed).toBe(false);
    });

    it('is the same switch in the service worker, which cannot import it', () => {
        const sw = readFileSync(join(REPO, 'bootstrap', 'sw.js'), 'utf8');
        expect(sw).toMatch(new RegExp(`const PRODUCTION_ENFORCES = ${PRODUCTION_ENFORCES};`));
        expect(sw).toContain('/^stream\\.dev\\./.test(self.location.hostname)');
    });
});

describe('the bytes a digest is taken over', () => {
    it('are the text with LF endings, as a Windows install serves it with CRLF', () => {
        const css = 'a {\n  color: red;\n}\n';
        expect(textOf(canonicalBytes('/css/base.css', bytesOf(crlf(css))))).toBe(css);
        expect(textOf(canonicalBytes('/locales/en.json', bytesOf(crlf('{\n"a": 1\n}\n'))))).toBe(
            '{\n"a": 1\n}\n',
        );
    });

    it('keep a carriage return that ends no line', () => {
        expect(textOf(canonicalBytes('/js/app.js', bytesOf('a\rb\r\nc')))).toBe('a\rb\nc');
    });

    it('are a binary file exactly as it is', () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(canonicalBytes('/assets/icon-180.png', png)).toEqual(png);
        expect(canonicalBytes('/assets/fonts/x.woff2', png)).toEqual(png);
    });

    it('are the same for the main page whatever name and icon its machine writes in', () => {
        const plain = canonicalBytes('/index.html', bytesOf(servedIndex()));
        for (const title of ['MoonlightWeb', 'MoonlightWeb [DualRTX]', 'A&B [\\1 "x" <b>] é']) {
            const page = personalise(servedIndex(), title, new Uint8Array([1, 2, 3, 250]));
            expect(sha(canonicalBytes('/index.html', bytesOf(page)))).toBe(sha(plain));
            expect(sha(canonicalBytes('/index.html', bytesOf(crlf(page))))).toBe(sha(plain));
        }
        // And under '/', the copy the navigation is answered from.
        expect(sha(canonicalBytes('/', bytesOf(crlf(servedIndex()))))).toBe(sha(plain));
    });

    it('differ for a main page changed anywhere else', () => {
        const plain = sha(canonicalBytes('/index.html', bytesOf(servedIndex())));
        const page = servedIndex().replace('</head>', '<script src="/js/x.js"></script></head>');
        expect(sha(canonicalBytes('/index.html', bytesOf(page)))).not.toBe(plain);
        expect(sha(canonicalBytes('/index.html', bytesOf(servedIndex('0.4.2'))))).not.toBe(plain);
    });

    it('cannot be had for a value no genuine machine writes', () => {
        const markup = servedIndex().replace(
            'content="MoonlightWeb"',
            'content="x"><script src="/js/x.js"></script><meta content="',
        );
        // The pattern stops at the first quote; what follows is a changed page.
        const plain = sha(canonicalBytes('/index.html', bytesOf(servedIndex())));
        expect(sha(canonicalBytes('/index.html', bytesOf(markup)))).not.toBe(plain);
        const delimiters = servedIndex().replace('content="MoonlightWeb"', 'content="<b>"');
        expect(() => canonicalBytes('/index.html', bytesOf(delimiters))).toThrow();
        for (const href of ['https://evil.example/i.png', '//evil.example/i.png', 'javascript:x']) {
            const icon = servedIndex().replace('href="/assets/icon-180.png"', `href="${href}"`);
            expect(() => canonicalBytes('/index.html', bytesOf(icon))).toThrow();
        }
    });

    it('cannot be had for a main page that is not UTF-8', () => {
        const bad = new Uint8Array([...bytesOf('<html>'), 0xff, 0xfe, ...bytesOf('</html>')]);
        expect(() => canonicalBytes('/index.html', bad)).toThrow();
    });

    it('give an empty digest, which matches nothing, where they cannot be had', async () => {
        const bad = servedIndex().replace('content="MoonlightWeb"', 'content="<b>"');
        expect(await officialDigest('/index.html', bytesOf(bad))).toBe('');
        expect(await officialDigest('/js/a.js', bytesOf('x'))).toBe(sha(bytesOf('x')));
    });
});

describe('a file held against its list', () => {
    const list = new Map([
        ['/index.html', 'i'.repeat(64)],
        ['/js/app.js', 'a'.repeat(64)],
    ]);

    it('is official when it is the same, and differs otherwise', () => {
        expect(judgeFile(list, '/js/app.js', 'a'.repeat(64))).toBe('official');
        expect(judgeFile(list, '/js/app.js', 'b'.repeat(64))).toBe('differs');
        expect(judgeFile(list, '/js/app.js', '')).toBe('differs');
        expect(judgeFile(list, '/', 'i'.repeat(64))).toBe('official');
    });

    it('is no part of the interface when the list does not name it', () => {
        expect(judgeFile(list, '/js/extra.js', 'a'.repeat(64))).toBe('unlisted');
        expect(judgeFile(list, '/js/app.js?x', 'a'.repeat(64))).toBe('unlisted');
    });

    it('is data when it is the web manifest', () => {
        expect(judgeFile(list, WEB_MANIFEST, '')).toBe('data');
    });
});

describe('the list of a release', () => {
    const answer = (status, body) => async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    const files = { '/index.html': 'c'.repeat(64), '/js/app.js': 'd'.repeat(64), '/x': 'nothex' };

    it('is read from the introduction server, digests only', async () => {
        const seen = [];
        const fetchImpl = async (url, init) => {
            seen.push([url, init]);
            return answer(200, { version: '0.4.1', files })();
        };
        const list = await fetchList('0.4.1', fetchImpl);
        expect(seen).toEqual([['/v1/interfaces/0.4.1.json', { cache: 'no-cache' }]]);
        expect([...list.keys()]).toEqual(['/index.html', '/js/app.js']);
    });

    it('is none for a version that was never released, without asking for one', async () => {
        const fetchImpl = vi.fn(answer(200, {}));
        expect(await fetchList('0.4.0.g412-dev', fetchImpl)).toBeNull();
        expect(await fetchList(null, fetchImpl)).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await fetchList('9.9.9', answer(404, {}))).toBeNull();
    });

    it('is a failure of the page, not a verdict, when it cannot be read', async () => {
        await expect(fetchList('0.4.1', answer(502, {}))).rejects.toThrow('answered 502');
        await expect(fetchList('0.4.1', answer(200, { version: '0.4.0', files }))).rejects.toThrow(
            'malformed',
        );
        await expect(
            fetchList(
                '0.4.1',
                answer(200, { version: '0.4.1', files: { '/js/a.js': 'a'.repeat(64) } }),
            ),
        ).rejects.toThrow('malformed');
    });
});

describe('the lists published beside the entry page', () => {
    const dir = join(REPO, 'bootstrap', 'v1', 'interfaces');
    const names = readdirSync(dir).filter((f) => f.endsWith('.json'));

    it('cover every release reached through the introduction server', () => {
        expect(names).toEqual(expect.arrayContaining(['0.3.0.json', '0.3.1.json', '0.4.0.json']));
    });

    it('each name a release, its main page and nothing but digests', () => {
        for (const name of names) {
            const list = JSON.parse(readFileSync(join(dir, name), 'utf8'));
            expect(`${list.version}.json`).toBe(name);
            expect(isRelease(list.version)).toBe(true);
            expect(list.files['/index.html']).toMatch(/^[0-9a-f]{64}$/);
            expect(list.files[WEB_MANIFEST]).toBeUndefined();
            for (const [path, digest] of Object.entries(list.files)) {
                expect(path).toMatch(/^\/[^?#]+$/);
                expect(path).not.toMatch(/(^|\/)(test|node_modules|\.[^/]*)\//);
                expect(digest).toMatch(/^[0-9a-f]{64}$/);
            }
        }
    });
});

/** A Cache, enough of one: entries by absolute URL. */
function memoryCache(entries) {
    const map = new Map(
        Object.entries(entries).map(([p, body]) => [new URL(p, ORIGIN).href, body]),
    );
    const urlOf = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
    return {
        map,
        keys: async () => [...map.keys()].map((u) => new Request(u)),
        match: async (r) => (map.has(urlOf(r)) ? new Response(map.get(urlOf(r))) : undefined),
        delete: async (r) => map.delete(urlOf(r)),
    };
}

describe('a cached interface held against its list', () => {
    const app = 'console.log(1);\n';
    const index = servedIndex('0.4.1');
    const list = new Map([
        ['/index.html', sha(canonicalBytes('/index.html', bytesOf(index)))],
        ['/js/app.js', sha(bytesOf(app))],
    ]);

    it('passes when every file is official, a Windows copy and the manifest included', async () => {
        const cache = memoryCache({
            '/index.html': crlf(index),
            '/': personalise(index, 'MoonlightWeb [PC]', new Uint8Array([7])),
            '/js/app.js': app,
            [WEB_MANIFEST]: '{"name":"anything"}',
        });
        expect(await cacheMatchesList(cache, list, ORIGIN)).toEqual({ ok: true, differs: [] });
        expect(cache.map.size).toBe(4);
    });

    it('fails on a file that differs, and names it', async () => {
        const cache = memoryCache({ '/index.html': index, '/js/app.js': 'evil();\n' });
        expect(await cacheMatchesList(cache, list, ORIGIN)).toEqual({
            ok: false,
            differs: ['/js/app.js'],
        });
    });

    it('fails without the main page', async () => {
        const cache = memoryCache({ '/js/app.js': app });
        expect((await cacheMatchesList(cache, list, ORIGIN)).ok).toBe(false);
    });

    it('deletes what the list does not name, so it is never served', async () => {
        const cache = memoryCache({
            '/index.html': index,
            '/js/app.js': app,
            '/js/planted.js': 'evil();',
            '/js/app.js?v=1': 'evil();',
            'https://elsewhere.example/js/app.js': 'evil();',
        });
        expect((await cacheMatchesList(cache, list, ORIGIN)).ok).toBe(true);
        expect([...cache.map.keys()]).toEqual([`${ORIGIN}/index.html`, `${ORIGIN}/js/app.js`]);
    });

    it('deletes nothing where the verdict is only reported', async () => {
        const cache = memoryCache({
            '/index.html': index,
            '/js/app.js': app,
            '/js/stale.js': 'old();',
        });
        expect((await cacheMatchesList(cache, list, ORIGIN, { prune: false })).ok).toBe(true);
        expect(cache.map.size).toBe(3);
    });
});

describe("a cached interface held against its machine's own hashes", () => {
    const files = ['/index.html', '/js/app.js', WEB_MANIFEST];
    const hashes = [sha(bytesOf('<html>')), sha(bytesOf('app')), ''];

    it('passes when the cache holds exactly what the machine serves', async () => {
        const cache = memoryCache({
            '/index.html': '<html>',
            '/': '<html>',
            '/js/app.js': 'app',
            [WEB_MANIFEST]: '{}',
        });
        expect(await cacheMatchesManifest(cache, files, hashes)).toBe(true);
    });

    it('fails on a file the machine does not serve so, the copy under / included', async () => {
        const changed = memoryCache({
            '/index.html': '<html>',
            '/': '<html>',
            '/js/app.js': 'evil',
        });
        expect(await cacheMatchesManifest(changed, files, hashes)).toBe(false);
        const root = memoryCache({ '/index.html': '<html>', '/': '<evil>', '/js/app.js': 'app' });
        expect(await cacheMatchesManifest(root, files, hashes)).toBe(false);
    });

    it('deletes what the machine does not name', async () => {
        const cache = memoryCache({
            '/index.html': '<html>',
            '/': '<html>',
            '/js/app.js': 'app',
            '/x.js': 'evil',
        });
        await cacheMatchesManifest(cache, files, hashes);
        expect(cache.map.has(`${ORIGIN}/x.js`)).toBe(false);
    });

    it('takes the cache on trust from a machine that sends no hashes (before v0.4.1)', async () => {
        const cache = memoryCache({ '/js/app.js': 'anything' });
        expect(await cacheMatchesManifest(cache, files, undefined)).toBe(true);
    });
});
