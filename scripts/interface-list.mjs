#!/usr/bin/env node
/* Builds and checks the lists of official interfaces (bootstrap/v1/interfaces/).

   Every machine reached through the introduction server shares one origin, so
   the entry page holds the files a machine sends against the interface of the
   release it says it runs, and refuses one that differs (bootstrap/v1/
   official.js). This script writes that list for a release: the digest of every
   file an installed machine of that release serves, taken from the release tag.
   No checkout is needed, so the lists of past releases are built the same way.

   Which files: the frontend directory as the CMake install() rule ships it
   (backend/CMakeLists.txt), less what the host never lists
   (StaticFileHandler::listFiles: dot files, source maps, assets/dev/) and the
   web manifest, which the machine writes its own name and key into. Each file as
   served: an .html with __MW_VERSION__ replaced by the version, as
   StaticFileHandler does, then official.js's canonicalBytes().

   Usage (from anywhere, no dependencies):
     node scripts/interface-list.mjs build 0.4.1              from tag v0.4.1
     node scripts/interface-list.mjs build 0.4.1 --ref HEAD   from a commit, before
                                                              the tag exists
     node scripts/interface-list.mjs check                    every list against
                                                              its tag (HEAD for
                                                              one not tagged
                                                              yet); exit 1 if
                                                              one differs
     node scripts/interface-list.mjs check --release 0.4.1    the same, and the
                                                              list of 0.4.1 must
                                                              exist and match
                                                              HEAD (a tag's CI)
     node scripts/interface-list.mjs live 0.4.1 <origin>      the list of 0.4.1
                                                              as <origin> serves
                                                              it must be the
                                                              committed one

   A release commit carries its own list: build it with --ref HEAD on the commit
   that will be tagged, and commit it there. Until the tag exists, `check` holds
   it against HEAD: CI's other runs pass on that commit, and fail on a later one
   that changes the interface without building the list again. Production must
   serve it before a machine installs the release, or the entry page turns that
   machine away wherever the check is enforced: `live` waits for it, and the
   packages are only built once it is there. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
    canonicalBytes,
    isRelease,
    LIST_PATH,
    PRODUCTION_ENFORCES,
    WEB_MANIFEST,
} from '../bootstrap/v1/official.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = path.join(ROOT, 'bootstrap', 'v1', 'interfaces');

// install(DIRECTORY frontend …) in backend/CMakeLists.txt: the directories at the
// top of frontend/ and the files, by name at any depth, that it leaves out.
const NOT_INSTALLED_DIRS = new Set([
    '.claude',
    'node_modules',
    'test',
    'scripts',
    'build',
    'coverage',
]);
const NOT_INSTALLED_FILES = new Set([
    '.prettierignore',
    '.prettierrc.json',
    '.tolgeerc.json',
    'eslint.config.js',
    'package.json',
    'package-lock.json',
    'prompt-frontend.md',
    'tsconfig.json',
    'vitest.config.js',
]);

/** Whether an installed machine lists @p rel (relative to frontend/). */
function served(rel) {
    const segments = rel.split('/');
    if (NOT_INSTALLED_DIRS.has(segments[0]) && segments.length > 1) return false;
    if (NOT_INSTALLED_FILES.has(segments[segments.length - 1])) return false;
    if (segments.some((s) => s.startsWith('.'))) return false;
    if (segments[0] === 'assets' && segments[1] === 'dev') return false;
    if (rel.endsWith('.map')) return false;
    return `/${rel}` !== WEB_MANIFEST;
}

function git(args, input) {
    return execFileSync('git', args, { cwd: ROOT, input, maxBuffer: 1 << 30 });
}

/** Whether @p ref names a commit here. */
function isCommit(ref) {
    try {
        git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

/** The blobs under frontend/ at @p ref: [{ rel, oid }]. */
function frontendBlobs(ref) {
    const out = git(['ls-tree', '-r', '-z', ref, '--', 'frontend/']).toString('utf8');
    const blobs = [];
    for (const entry of out.split('\0')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        const [mode, type, oid] = entry.slice(0, tab).split(' ');
        const rel = entry.slice(tab + 1).replace(/^frontend\//, '');
        // A link or a submodule is no file a machine serves.
        if (type === 'blob' && mode !== '120000') blobs.push({ rel, oid });
    }
    return blobs;
}

/** The contents of @p oids, read in one `git cat-file --batch`. */
function readBlobs(oids) {
    const out = git(['cat-file', '--batch'], oids.join('\n') + '\n');
    const contents = new Map();
    let at = 0;
    for (const oid of oids) {
        const eol = out.indexOf(10, at);
        const [got, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
        if (got !== oid || type !== 'blob')
            throw new Error(`git cat-file: unexpected ${got} ${type}`);
        const start = eol + 1;
        contents.set(oid, new Uint8Array(out.subarray(start, start + Number(size))));
        at = start + Number(size) + 1;
    }
    return contents;
}

/** @p bytes with every `__MW_VERSION__` replaced, as QByteArray::replace does. */
function withVersion(bytes, version) {
    const text = Buffer.from(bytes).toString('latin1');
    return new Uint8Array(Buffer.from(text.split('__MW_VERSION__').join(version), 'latin1'));
}

/** The list of release @p version, from @p ref, as the JSON the server serves. */
export function buildList(version, ref) {
    if (!isRelease(version)) throw new Error(`${version} is not a release version (x.y.z)`);
    const blobs = frontendBlobs(ref).filter((b) => served(b.rel));
    if (!blobs.some((b) => b.rel === 'index.html'))
        throw new Error(`${ref} has no frontend/index.html`);
    const contents = readBlobs(blobs.map((b) => b.oid));
    const files = {};
    for (const { rel, oid } of blobs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
        const p = `/${rel}`;
        let bytes = contents.get(oid);
        if (rel.endsWith('.html')) bytes = withVersion(bytes, version);
        files[p] = createHash('sha256').update(canonicalBytes(p, bytes)).digest('hex');
    }
    return JSON.stringify({ version, files }, null, 2) + '\n';
}

function listPath(version) {
    return path.join(LISTS, `${version}.json`);
}

/** The list as committed, with LF endings whatever the checkout wrote. */
function committedList(version) {
    return fs.readFileSync(listPath(version), 'utf8').replace(/\r\n/g, '\n');
}

function main(argv) {
    const [command, ...rest] = argv;
    const option = (name) => {
        const i = rest.indexOf(name);
        return i < 0 ? null : rest[i + 1];
    };

    if (command === 'build') {
        const version = rest[0];
        const ref = option('--ref') || `v${version}`;
        fs.mkdirSync(LISTS, { recursive: true });
        fs.writeFileSync(listPath(version), buildList(version, ref));
        console.log(`wrote bootstrap/v1/interfaces/${version}.json from ${ref}`);
        return 0;
    }

    if (command === 'check') {
        const release = option('--release');
        const versions = fs.existsSync(LISTS)
            ? fs
                  .readdirSync(LISTS)
                  .filter((f) => f.endsWith('.json'))
                  .map((f) => f.slice(0, -'.json'.length))
            : [];
        if (release && !versions.includes(release)) {
            console.error(
                `::error::bootstrap/v1/interfaces/${release}.json is missing: build it on the release ` +
                    `commit (node scripts/interface-list.mjs build ${release} --ref HEAD) and commit it ` +
                    'there, or every machine that installs this release is refused by the entry page.',
            );
            return 1;
        }
        let bad = 0;
        for (const version of versions.sort()) {
            // A list whose tag is not there yet is the release being prepared:
            // it was built on the commit that will be tagged, so until then it
            // describes HEAD.
            const ref = version === release || !isCommit(`v${version}`) ? 'HEAD' : `v${version}`;
            let fresh;
            try {
                fresh = buildList(version, ref);
            } catch (e) {
                console.error(`::error::${version}: ${e.message}`);
                bad++;
                continue;
            }
            if (fresh === committedList(version)) {
                console.log(`ok    ${version} (${ref})`);
            } else {
                const fix =
                    ref === 'HEAD'
                        ? `: build it again (node scripts/interface-list.mjs build ${version} ` +
                          '--ref HEAD) and commit it'
                        : '';
                console.error(
                    `::error::bootstrap/v1/interfaces/${version}.json does not match ${ref}${fix}`,
                );
                bad++;
            }
        }
        return bad ? 1 : 0;
    }

    if (command === 'live') return live(rest[0], rest[1], Number(option('--wait') || 2700));

    console.error(
        'usage: interface-list.mjs build <x.y.z> [--ref <ref>] | check [--release <x.y.z>] ' +
            '| live <x.y.z> <origin> [--wait <seconds>]',
    );
    return 2;
}

/**
 * Whether @p origin serves the committed list of @p version, waiting up to
 * @p waitSeconds for it: production is moved to a release tag by hand, after the
 * tag is pushed (deploy/powerdns/deploy-prod.sh). While production does not
 * enforce the check yet, a missing list is only a warning — a machine there is
 * not turned away for it — and nothing waits.
 */
async function live(version, origin, waitSeconds) {
    if (!isRelease(version) || !origin) {
        console.error('usage: interface-list.mjs live <x.y.z> <origin> [--wait <seconds>]');
        return 2;
    }
    const want = committedList(version);
    const url = `${origin.replace(/\/$/, '')}${LIST_PATH}${version}.json`;
    const giveUpAt = Date.now() + (PRODUCTION_ENFORCES ? waitSeconds * 1000 : 0);
    for (;;) {
        let got = null;
        try {
            const response = await fetch(url, { cache: 'no-store' });
            got = response.ok ? await response.text() : `HTTP ${response.status}`;
        } catch (e) {
            got = e.message;
        }
        if (got === want) {
            console.log(`ok    ${url} is the committed list`);
            return 0;
        }
        if (Date.now() >= giveUpAt) break;
        console.log(`wait  ${url}: not served yet (${got.length > 40 ? 'another list' : got})`);
        await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    const what =
        `${url} does not serve the list of ${version}. Move production to the release tag ` +
        `(deploy/powerdns/deploy-prod.sh v${version} --apply)`;
    if (!PRODUCTION_ENFORCES) {
        console.log(`::warning::${what}: production only reports for now, so nothing waits on it.`);
        return 0;
    }
    console.error(
        `::error::${what}, then run this job again: every machine that installs ${version} ` +
            'before then is refused by the entry page.',
    );
    return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
