/*
 * MoonlightWeb — frontend TNR. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The signalling line going away under a working tunnel.
 *
 * Restarting the introduction server — a deploy, a reboot — drops every line
 * to it at once, the host's and the browser's. The host does nothing to its
 * tunnels when its own line drops; it was the page that took the tunnel down
 * with the line, and with it every session on the server's way out, streams on
 * the same LAN as their machine included. These pin the replacement: the
 * tunnel stays as long as the machine still answers on it, and goes down as
 * before when it does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

// The pairing layer needs WebCrypto and IndexedDB, which is not what is under
// test: an identity that exists is all connect() needs to reach the socket.
vi.mock('../../bootstrap/v1/pairing.js', () => ({
    loadIdentity: async () => ({ keyId: 'k', publicKeyBase64: 'p' }),
    helloMessage: () => ({ type: 'hello' }),
    verifyOffer: async () => true,
    signAnswer: async () => ({}),
}));

const HOST = 'a'.repeat(26);
const FRAME_REQUEST = 0x01;
const FRAME_RESPONSE = 0x02;

class FakeWebSocket {
    static last = null;
    static OPEN = 1;
    constructor(url) {
        this.url = String(url);
        this.readyState = FakeWebSocket.OPEN;
        FakeWebSocket.last = this;
    }
    send() {}
    close() {}
    /** The handshake completing. */
    open() {
        this.onopen?.();
    }
    /** The server, or whatever sits in front of it, going away. */
    drop(code = 1001) {
        this.readyState = 3;
        this.onclose({ code, reason: '' });
    }
}

/** The data channel to the host: records what is sent, and can close. */
class FakeChannel {
    constructor() {
        this.readyState = 'open';
        this.sent = [];
    }
    send(bytes) {
        this.sent.push(bytes);
    }
    /** What the far end closing it looks like from here. */
    closeFromFarEnd() {
        this.readyState = 'closed';
        this.onclose();
    }
}

let tunnelModule;

beforeEach(async () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.resetModules();
    tunnelModule = await import('../../bootstrap/v1/tunnel.js');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** A tunnel through connect(), up to an open channel, with its line and channel. */
async function openTunnel() {
    const t = new tunnelModule.Tunnel(HOST, 'https://example.test');
    const closed = [];
    t.onclosed = (why) => closed.push(why);
    const connecting = t.connect();
    await vi.waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    const line = FakeWebSocket.last;
    const channel = new FakeChannel();
    t._adoptChannel(channel);
    await connecting;
    vi.useFakeTimers();
    return { t, line, channel, closed };
}

/** The path of the request a frame carries, or null for any other frame. */
function requestPath(bytes) {
    if (bytes[0] !== FRAME_REQUEST) return null;
    const headLen = new DataView(bytes.buffer, bytes.byteOffset + 5).getUint32(0, false);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + headLen))).p;
}

/** One frame from the host, as the channel delivers it. */
function frameFromHost(t, kind, id) {
    t._onChannelMessage(
        tunnelModule.encodeFrame(kind, id, tunnelModule.encodeHead({ s: 200, h: {} })),
    );
}

describe('the signalling line dropping under an open tunnel', () => {
    beforeEach(() => {
        FakeWebSocket.last = null;
    });

    it('keeps the tunnel while the machine still answers', async () => {
        const { t, line, channel, closed } = await openTunnel();

        line.drop();

        // The machine is asked something, on the channel.
        const asked = channel.sent.map(requestPath).filter(Boolean);
        expect(asked).toEqual(['/api/health']);

        frameFromHost(t, FRAME_RESPONSE, 1);
        await vi.advanceTimersByTimeAsync(10000);

        expect(closed).toEqual([]);
        expect(t.connected).toBe(true);
    });

    it('counts any frame from the machine, not only the answer to that question', async () => {
        const { t, line, closed } = await openTunnel();

        line.drop();
        // The body of a request made before the line went, still arriving.
        frameFromHost(t, 0x03, 7);
        await vi.advanceTimersByTimeAsync(10000);

        expect(closed).toEqual([]);
    });

    it('takes the tunnel down when the machine stays silent', async () => {
        const { line, closed } = await openTunnel();

        line.drop();
        await vi.advanceTimersByTimeAsync(4900);
        expect(closed).toEqual([]);

        await vi.advanceTimersByTimeAsync(200);
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatch(/silent/);
    });

    it('leaves it to the channel when the machine closes it meanwhile', async () => {
        const { line, channel, closed } = await openTunnel();

        line.drop();
        channel.closeFromFarEnd();
        await vi.advanceTimersByTimeAsync(10000);

        // Reported once, by the channel's close, not a second time by the check.
        expect(closed).toEqual(['the channel closed']);
    });
});

describe('the signalling line dropping before the channel opens', () => {
    beforeEach(() => {
        FakeWebSocket.last = null;
    });

    it('is still a failed connection', async () => {
        const t = new tunnelModule.Tunnel(HOST, 'https://example.test');
        const connecting = t.connect();
        await vi.waitFor(() => expect(FakeWebSocket.last).not.toBeNull());

        FakeWebSocket.last.drop();

        await expect(connecting).rejects.toThrow('The introduction server hung up.');
    });
});

/* A page that keeps calling a server that is down — lineKeeper behind a stream,
   the entry page's retries — reaches the console once per try. Only a line that
   was open has something to say about why it went. */
describe('what the console hears of a line closing', () => {
    let warn;

    beforeEach(() => {
        FakeWebSocket.last = null;
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    const closedLines = () =>
        warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Signalling line'));

    async function dial(act) {
        const t = new tunnelModule.Tunnel(HOST, 'https://example.test');
        const connecting = t.connect();
        await vi.waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
        act(FakeWebSocket.last);
        await connecting.catch(() => {});
    }

    it('says nothing of a line that never opened', async () => {
        await dial((ws) => {
            ws.onerror();
            ws.drop(1006);
        });
        expect(closedLines()).toEqual([]);
    });

    it('gives the code of a line that was open', async () => {
        await dial((ws) => {
            ws.open();
            ws.drop(1001);
        });
        expect(closedLines()).toEqual(['[MW] Signalling line closed: code=1001 reason=(none)']);
    });
});

/* What a restart of the introduction server looks like to a page that calls
   during it: the entry page keeps calling under these, and only these. */
describe('failures that pass by themselves', () => {
    beforeEach(() => {
        FakeWebSocket.last = null;
    });

    /** The error connect() ends with when the server does `act` to its line. */
    async function failureAfter(act) {
        const t = new tunnelModule.Tunnel(HOST, 'https://example.test');
        const connecting = t.connect();
        await vi.waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
        act(FakeWebSocket.last);
        return connecting.then(
            () => null,
            (e) => e,
        );
    }

    const relayError = (code) => (ws) =>
        ws.onmessage({ data: JSON.stringify({ t: 'error', code }) });

    it('marks a server that hangs up', async () => {
        const e = await failureAfter((ws) => ws.drop());
        expect(e.transient).toBe(true);
    });

    it('marks a server that cannot be reached', async () => {
        const e = await failureAfter((ws) => ws.onerror());
        expect(e.message).toBe('Could not reach the introduction server.');
        expect(e.transient).toBe(true);
    });

    it('marks a machine not online, or gone, which may be its line coming back', async () => {
        expect((await failureAfter(relayError('offline'))).transient).toBe(true);
        expect((await failureAfter(relayError('host-gone'))).transient).toBe(true);
    });

    it('leaves a full machine and an outdated page as plain answers', async () => {
        const busy = await failureAfter(relayError('busy'));
        expect(busy.message).toMatch(/as many connections/);
        expect(busy.transient).toBeUndefined();
        expect((await failureAfter(relayError('unsupported_version'))).transient).toBeUndefined();
    });
});
