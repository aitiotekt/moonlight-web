/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The order in which the entry page fetches the application's files through the
 * tunnel: the largest first, so that over a long round trip they overlap the
 * small ones instead of trailing alone at the end. The host sends the sizes
 * beside the paths since v0.4.1; with an older host, which sends none, the page
 * keeps the host's order, as it always did.
 */

import { describe, it, expect } from 'vitest';
import { shellFetchOrder } from '../../bootstrap/v1/tunnel.js';

describe('shellFetchOrder', () => {
    const files = ['/index.html', '/js/app.js', '/js/ui/StreamView.js', '/css/base.css'];

    it('puts the largest files first', () => {
        expect(shellFetchOrder(files, [9000, 239000, 624000, 4000])).toEqual([
            '/js/ui/StreamView.js',
            '/js/app.js',
            '/index.html',
            '/css/base.css',
        ]);
    });

    it("keeps the host's order between files of the same size", () => {
        expect(shellFetchOrder(files, [10, 10, 20, 10])).toEqual([
            '/js/ui/StreamView.js',
            '/index.html',
            '/js/app.js',
            '/css/base.css',
        ]);
    });

    it("keeps the host's order when it sends no sizes, as a host before v0.4.1 does", () => {
        expect(shellFetchOrder(files, undefined)).toEqual(files);
        expect(shellFetchOrder(files, null)).toEqual(files);
    });

    it('ignores sizes that do not line up with the files', () => {
        expect(shellFetchOrder(files, [1, 2, 3])).toEqual(files);
    });

    it('takes an unreadable size as 0, the rest still in order', () => {
        expect(shellFetchOrder(files, [5, 'big', 7, -1])).toEqual([
            '/js/ui/StreamView.js',
            '/index.html',
            '/js/app.js',
            '/css/base.css',
        ]);
    });

    it('returns a new array, the manifest left as it was', () => {
        const ordered = shellFetchOrder(files, [1, 2, 3, 4]);
        expect(ordered).not.toBe(files);
        expect(files[0]).toBe('/index.html');
    });
});
