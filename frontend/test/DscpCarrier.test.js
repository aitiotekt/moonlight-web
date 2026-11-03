/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The bench's silent carrier. What matters is that without the key nothing
 * changes — the answer stays receive-only, no transceiver is touched — and that
 * with it only the stream's sound section is asked to send, at a high network
 * priority, with no microphone.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    armDscpCarrier,
    dscpCarrierMode,
    prepareDscpCarrier,
    recvonlyExceptCarrier,
} from '../js/util/DscpCarrier.js';

const store = (v) => ({ getItem: () => v });

const pcWith = (transceivers) => ({
    getTransceivers: () => transceivers,
    addEventListener: () => {},
    connectionState: 'connected',
});

const sender = () => {
    let params = { encodings: [{}] };
    const s = {
        track: null,
        getParameters: () => JSON.parse(JSON.stringify(params)),
        setParameters: vi.fn(async (p) => {
            params = p;
        }),
        replaceTrack: vi.fn(async (t) => {
            s.track = t;
        }),
    };
    return s;
};

const SDP =
    'v=0\r\n' +
    'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=sendrecv\r\n' +
    'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=sendrecv\r\n' +
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n';

describe('dscpCarrierMode', () => {
    it('is off without the key, or with anything but its two values', () => {
        expect(dscpCarrierMode(store(null))).toBe(null);
        expect(dscpCarrierMode(store(''))).toBe(null);
        expect(dscpCarrierMode(store('1'))).toBe(null);
        expect(dscpCarrierMode(store('on'))).toBe(null);
    });

    it('reads notrack and track', () => {
        expect(dscpCarrierMode(store('notrack'))).toBe('notrack');
        expect(dscpCarrierMode(store(' Track '))).toBe('track');
    });

    it('is off when storage throws', () => {
        expect(
            dscpCarrierMode({
                getItem: () => {
                    throw new Error('denied');
                },
            }),
        ).toBe(null);
    });
});

describe('prepareDscpCarrier', () => {
    it('touches nothing when off', () => {
        const t = { mid: 'audio', direction: 'recvonly' };
        expect(prepareDscpCarrier(pcWith([t]), null)).toBe(false);
        expect(t.direction).toBe('recvonly');
    });

    it('asks only the stream sound section to send', () => {
        const sound = { mid: 'audio', direction: 'recvonly' };
        const road = { mid: 'vaudio', direction: 'recvonly' };
        const video = { mid: 'video', direction: 'recvonly' };
        expect(prepareDscpCarrier(pcWith([road, video, sound]), 'notrack')).toBe(true);
        expect(sound.direction).toBe('sendrecv');
        expect(road.direction).toBe('recvonly');
        expect(video.direction).toBe('recvonly');
    });
});

describe('recvonlyExceptCarrier', () => {
    it('answers receive-only everywhere when off, as before', () => {
        const out = recvonlyExceptCarrier(SDP, null);
        expect(out).not.toContain('a=sendrecv');
        expect(out.match(/a=recvonly/g)).toHaveLength(2);
    });

    it('keeps the sound section sendrecv for the carrier, and only it', () => {
        const out = recvonlyExceptCarrier(SDP, 'track');
        const [, audio, video] = out.split(/(?=^m=)/m);
        expect(audio).toContain('a=sendrecv');
        expect(video).toContain('a=recvonly');
        expect(video).not.toContain('a=sendrecv');
    });
});

describe('armDscpCarrier', () => {
    it('does nothing when off', async () => {
        expect(await armDscpCarrier(pcWith([]), null)).toEqual({ armed: false });
    });

    it('stays unarmed when the host offered the sound sendonly', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const t = { mid: 'audio', currentDirection: 'recvonly', sender: sender() };
        const r = await armDscpCarrier(pcWith([t]), 'notrack');
        expect(r.armed).toBe(false);
        expect(t.sender.setParameters).not.toHaveBeenCalled();
        info.mockRestore();
    });

    it('notrack: high priority on the sender, no track, no AudioContext', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const t = { mid: 'audio', currentDirection: 'sendrecv', sender: sender() };
        const r = await armDscpCarrier(pcWith([t]), 'notrack');
        expect(r.armed).toBe(true);
        expect(t.sender.replaceTrack).not.toHaveBeenCalled();
        expect(t.sender.getParameters().encodings[0].networkPriority).toBe('high');
        info.mockRestore();
    });

    it('track: a track of zeros, a constant source at 0 feeding the destination only', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const track = { kind: 'audio' };
        const dest = { stream: { getAudioTracks: () => [track] } };
        const zero = { offset: { value: 1 }, connect: vi.fn(), start: vi.fn() };
        const created = [];
        globalThis.AudioContext = class {
            constructor() {
                this.state = 'running';
                this.destination = { speaker: true };
                created.push(this);
            }
            createMediaStreamDestination() {
                return dest;
            }
            createConstantSource() {
                return zero;
            }
            close() {
                return Promise.resolve();
            }
        };
        const t = { mid: 'audio', currentDirection: 'sendrecv', sender: sender() };
        const r = await armDscpCarrier(pcWith([t]), 'track');
        expect(r).toMatchObject({ armed: true, context: 'running' });
        expect(created).toHaveLength(1);
        // Without a source the destination renders nothing and Chrome sends no RTP (bench, 21/10).
        expect(zero.offset.value).toBe(0);
        expect(zero.connect).toHaveBeenCalledTimes(1);
        expect(zero.connect).toHaveBeenCalledWith(dest);
        expect(zero.start).toHaveBeenCalled();
        expect(t.sender.replaceTrack).toHaveBeenCalledWith(track);
        expect(t.sender.getParameters().encodings[0].networkPriority).toBe('high');
        delete globalThis.AudioContext;
        info.mockRestore();
    });
});
