/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * What no machine is sent over a tunnel, whichever application asks.
 *
 * The applications of 0.3.1 and 0.4.0 send the list of machines a browser knows
 * to /api/auth/home-screen/instances, for a home-screen shortcut's menu. That
 * list stays in the browser. Every connection of every version is a Tunnel of
 * the bootstrap's tunnel.js, so that is where the request is answered.
 */

/* global Response */

import { describe, it, expect, beforeEach, vi } from 'vitest';

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

let Tunnel;

beforeEach(async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
    ({ Tunnel } = await import('../../bootstrap/v1/tunnel.js'));
});

/** A tunnel whose channel is open, and what it put on it. */
function openTunnel(hostId = 'a'.repeat(26)) {
    const tunnel = new Tunnel(hostId, 'https://stream.example.top');
    const sent = [];
    tunnel._dc = { readyState: 'open', send: (frame) => sent.push(frame) };
    return { tunnel, sent };
}

const REGISTER = {
    instances: [
        { id: 'b'.repeat(26), name: 'Living room', url: 'https://stream.example.top/bbb' },
        { id: 'c'.repeat(26), name: 'Office', url: 'https://stream.example.top/ccc' },
    ],
};

describe("the list of this browser's machines", () => {
    it('is never sent, and answered as the host would', async () => {
        const { tunnel, sent } = openTunnel();
        const answer = await tunnel.fetch('/api/auth/home-screen/instances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(REGISTER),
        });
        expect(answer).toBeInstanceOf(Response);
        expect(answer.ok).toBe(true);
        expect(await answer.json()).toEqual({ status: 'ok' });
        expect(sent).toHaveLength(0);
    });

    it('is not sent over a line to another machine either', async () => {
        // What 0.4.0's askHomeScreenKeyAt did, over openSideTunnel.
        const { tunnel, sent } = openTunnel('d'.repeat(26));
        await tunnel.fetch('https://stream.example.top/api/auth/home-screen/instances', {
            method: 'POST',
            body: JSON.stringify(REGISTER),
        });
        expect(sent).toHaveLength(0);
    });

    it('is answered even with no channel open, so an older application goes on as before', async () => {
        const tunnel = new Tunnel('a'.repeat(26), 'https://stream.example.top');
        const answer = await tunnel.fetch('/api/auth/home-screen/instances', { method: 'POST' });
        expect(answer.status).toBe(200);
    });
});

describe('every other request', () => {
    it('still goes to the machine, the home-screen key included', async () => {
        const { tunnel, sent } = openTunnel();
        tunnel.fetch('/api/auth/home-screen/key', { method: 'POST', body: '{}' }).catch(() => {});
        tunnel.fetch('/api/auth/home-screen/instances/x', { method: 'POST' }).catch(() => {});
        expect(sent).toHaveLength(2);
        tunnel.close();
    });
});
