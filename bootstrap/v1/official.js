/*
 * MoonlightWeb — bootstrap. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The official interfaces, and how a machine's files are held against them.
 *
 * Every machine reached through the introduction server shares this one
 * origin, so the interface one of them serves runs beside the pairing keys and
 * the sessions of all the others (D26). Nothing here can tell a genuine machine
 * from a modified one — the machine is its owner's, its key and its disk
 * included — but the CODE can be told apart. Each release's interface is
 * published beside this file as the digest of every file it is made of
 * (v1/interfaces/<version>.json, built from the release tag by
 * scripts/interface-list.mjs and checked against that tag in CI), and the entry
 * page holds what a machine sends against it before storing any of it.
 *
 * Shared with the script that builds the lists, so the two cannot disagree on
 * what a file's digest is. No browser global is touched at import time.
 */

/** Where the lists are served from: one file per release, named by version. */
export const LIST_PATH = '/v1/interfaces/';

/**
 * The web manifest. A machine writes its name, its address and a sign-in key
 * into it on the way down (HomeScreenShell.cpp), and the signed-in page writes a
 * fresh copy over the stored one, so no list can know its bytes. It is data,
 * never code: stored as it comes, and served only as a manifest.
 */
export const WEB_MANIFEST = '/manifest.webmanifest';

/**
 * A release's version, as CI stamps it from a v* tag. A build of anything in
 * between reads 0.4.0.g412, 0.4.0.g412-dev or 0.4.0.g412-stg, and no list can
 * describe it.
 */
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Whether @p version names a release, and so a list. */
export function isRelease(version) {
    return typeof version === 'string' && RELEASE.test(version);
}

/**
 * The application version inside the manifest's `version`.
 *
 * The host writes `<version>-<12 hex, its files' fingerprint>`, then through the
 * tunnel `-<8 hex, its name and identifier>` (HttpServer.cpp, /api/app/manifest),
 * in that shape since v0.3.0. Read from the right, because a build's own version
 * may carry dashes ("0.4.1-dev").
 *
 * @returns {string|null}
 */
export function appVersionOf(manifestVersion) {
    if (typeof manifestVersion !== 'string') return null;
    const tail = /-[0-9a-f]{12}(?:-[0-9a-f]{8})?$/.exec(manifestVersion);
    return tail && tail.index > 0 ? manifestVersion.slice(0, tail.index) : null;
}

/**
 * Whether production refuses an interface that is not official. True from
 * v0.4.1: every official release that reaches this server has its list, held
 * against its packages. False puts production back to writing its verdict in
 * the console and nothing more — the way back if a list turned a genuine
 * machine away. sw.js's copy changes with it.
 */
export const PRODUCTION_ENFORCES = true;

/**
 * How strictly this page holds a machine to the list, by the name it was served
 * under.
 *
 *   stream.dev.   the staging server, which runs `main`. A release that differs
 *                 from its list is refused there first. A build of anything in
 *                 between — what developers and CI's dev and staging channels
 *                 run — is let through: no list can know it, and that server is
 *                 where those builds are tried.
 *   anything      production. Refused once PRODUCTION_ENFORCES is true, and
 *   else          until then reported.
 *
 * @returns {{enforce: boolean, unreleasedAllowed: boolean}}
 */
export function interfacePolicy(hostname) {
    const staging = /^stream\.dev\./.test(hostname || '');
    return { enforce: staging || PRODUCTION_ENFORCES, unreleasedAllowed: staging };
}

/**
 * Extensions of the files that are text. Git writes them with CRLF line endings
 * in a Windows checkout (core.autocrlf), and the release builds do: an installed
 * Windows machine serves index.html, the CSS and the locales so, while
 * .gitattributes keeps the JavaScript LF everywhere. A line ending means the
 * same either way to every parser that reads these files, so a digest is taken
 * over LF.
 */
const TEXT = new Set(['html', 'css', 'js', 'json', 'webmanifest', 'svg', 'txt', 'md', 'map']);

function extensionOf(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** @p bytes with every CR that starts a CRLF taken out. */
function withLfEndings(bytes) {
    let crlf = 0;
    for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) crlf++;
    if (crlf === 0) return bytes;
    const out = new Uint8Array(bytes.length - crlf);
    let o = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
        out[o++] = bytes[i];
    }
    return out;
}

/*
 * The two values a machine writes into its main page on the way down the tunnel
 * (mw::homescreen::shell): the name a home-screen shortcut takes, and its icon.
 * The same patterns, first match only, with \s spelled as the ASCII whitespace
 * PCRE2 reads it as.
 */
const WS = '[\\t\\n\\v\\f\\r ]';
const SHELL_TITLE = new RegExp(
    `<meta${WS}+name="apple-mobile-web-app-title"${WS}+content="([^"]*)"`,
);
const SHELL_ICON = new RegExp(`<link${WS}+rel="apple-touch-icon"[^>]*${WS}href="([^"]*)"`);
/* What a genuine machine writes there: the name HTML-escaped, so with no tag
   delimiter in it, and the icon as a data: URL — or the file's own value, when
   it rewrote nothing. */
const TITLE_VALUE = /^[^<>]*$/;
const ICON_VALUE =
    /^(?:data:image\/png;base64,[A-Za-z0-9+/]*={0,2}|\/[A-Za-z0-9_-][A-Za-z0-9_./-]*)$/;

/** @p text with the value captured by @p pattern's first match emptied. */
function blankFirst(text, pattern, allowed) {
    const m = pattern.exec(text);
    if (!m) return text;
    if (!allowed.test(m[1])) throw new Error('the main page carries a value no machine writes');
    // Both patterns end on the value's closing quote.
    const end = m.index + m[0].length - 1;
    return text.slice(0, end - m[1].length) + text.slice(end);
}

/**
 * The bytes of @p path that its digest is taken over: LF line endings for text,
 * and the main page with the two values its machine writes in emptied. Throws
 * for a main page that is not UTF-8 or carries a value no machine writes.
 *
 * @param {string} path
 * @param {Uint8Array} bytes  as served, the version already written in
 * @returns {Uint8Array}
 */
export function canonicalBytes(path, bytes) {
    // '/' is the copy of the main page the navigation is answered from.
    const name = path === '/' ? '/index.html' : path;
    const lf = TEXT.has(extensionOf(name)) ? withLfEndings(bytes) : bytes;
    if (name !== '/index.html') return lf;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(lf);
    const plain = blankFirst(blankFirst(text, SHELL_TITLE, TITLE_VALUE), SHELL_ICON, ICON_VALUE);
    return new TextEncoder().encode(plain);
}

/** SHA-256 of @p bytes, in hex. */
export async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    return hex;
}

/** The digest the list holds for @p path, if @p bytes are the official file. */
export async function officialDigest(path, bytes) {
    try {
        return await sha256Hex(canonicalBytes(path, bytes));
    } catch {
        return ''; // matches no digest
    }
}

/**
 * The list of one release, from the introduction server: path → digest.
 *
 * @returns {Promise<Map<string, string>|null>} null when no list exists for that
 *   version, which is the server's answer for a version that was never released
 * @throws when the list could not be read, which says nothing about the machine
 */
export async function fetchList(version, fetchImpl = globalThis.fetch) {
    if (!isRelease(version)) return null;
    const response = await fetchImpl(`${LIST_PATH}${version}.json`, { cache: 'no-cache' });
    if (response.status === 404) return null;
    if (!response.ok)
        throw new Error(`the list of official interfaces answered ${response.status}`);
    const body = await response.json();
    const files = body && body.version === version ? body.files : null;
    if (!files || typeof files !== 'object')
        throw new Error('the list of official interfaces is malformed');
    const list = new Map();
    for (const [path, digest] of Object.entries(files)) {
        if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) list.set(path, digest);
    }
    if (!list.has('/index.html')) throw new Error('the list of official interfaces is malformed');
    return list;
}

/**
 * What one file of a machine's is, held against @p list.
 *
 *   'official'   listed, and the same
 *   'differs'    listed, and not the same: the interface was modified
 *   'unlisted'   not part of the interface: never stored, so never served
 *   'data'       the web manifest
 *
 * @param {Map<string, string>} list
 * @param {string} path
 * @param {string} digest  officialDigest() of the file
 */
export function judgeFile(list, path, digest) {
    if (path === WEB_MANIFEST) return 'data';
    const want = list.get(path === '/' ? '/index.html' : path);
    if (!want) return 'unlisted';
    return digest === want ? 'official' : 'differs';
}

/**
 * Whether the cache holds an official interface and nothing else: every entry
 * the same as the list says, the main page among them. An entry the list does
 * not name — or one under a query, or another origin — is deleted, so nothing
 * planted beside the interface can be served in its place.
 *
 * Read on every start, because every page of this origin can write that cache
 * and the copy is only worth the check it passed last.
 *
 * @param {Cache} cache
 * @param {Map<string, string>} list
 * @param {string} origin  this page's
 * @param {{prune?: boolean}} [options]  prune false: judge, delete nothing —
 *   where the verdict is only reported, the cache stays exactly as it was
 * @returns {Promise<{ok: boolean, differs: string[]}>}
 */
export async function cacheMatchesList(cache, list, origin, { prune = true } = {}) {
    const differs = [];
    let index = false;
    for (const request of await cache.keys()) {
        const url = new URL(request.url);
        const path = url.pathname;
        const verdict =
            url.origin !== origin || url.search
                ? 'unlisted'
                : path === WEB_MANIFEST
                  ? 'data'
                  : judgeFile(list, path, await digestOf(cache, request, path));
        if (verdict === 'unlisted' && prune) await cache.delete(request);
        if (verdict === 'differs') differs.push(path);
        if (verdict === 'official' && (path === '/index.html' || path === '/')) index = true;
    }
    return { ok: index && differs.length === 0, differs };
}

async function digestOf(cache, request, path) {
    const hit = await cache.match(request);
    return hit ? officialDigest(path, new Uint8Array(await hit.arrayBuffer())) : '';
}

/**
 * Whether the cache holds exactly what this machine serves, by the hashes its
 * manifest carries — and nothing it does not serve.
 *
 * The check for a machine no list describes: a build of something between two
 * releases, on the staging server. The hashes come from THIS machine, over the
 * channel its key signed, so a page of another machine cannot have written them
 * (security review R1, 26/10/2026). A machine of before v0.4.1 sends none, and
 * its cache is taken on trust, as it always was.
 *
 * @param {Cache} cache
 * @param {string[]} files
 * @param {unknown} hashes  the manifest's `sha256`, beside `files`
 */
export async function cacheMatchesManifest(cache, files, hashes) {
    if (!Array.isArray(hashes) || hashes.length !== files.length) return true;
    const named = new Set(files);
    named.add('/');
    for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname;
        if (!named.has(path)) await cache.delete(request);
    }
    const results = await Promise.all(
        files.map(async (path, i) => {
            const want = hashes[i];
            // Empty where the copy legitimately differs (the web manifest).
            if (typeof want !== 'string' || !want) return true;
            // The navigation is answered from '/', a copy of the main page.
            for (const name of path === '/index.html' ? ['/index.html', '/'] : [path]) {
                const hit = await cache.match(name);
                if (!hit) return false;
                if ((await sha256Hex(new Uint8Array(await hit.arrayBuffer()))) !== want)
                    return false;
            }
            return true;
        }),
    );
    return results.every(Boolean);
}
