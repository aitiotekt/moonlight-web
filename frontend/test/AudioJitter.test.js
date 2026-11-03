/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The audio jitter buffer's target. What matters is that it reaches the audio
 * receiver and only that one — the video receiver's target is driven from the
 * measured link and must not be overwritten — and that a browser without the
 * property, or a peer connection that refuses, costs nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    AUDIO_JITTER_TARGET_MS,
    audioJitterTargetMs,
    setAudioJitterBufferTarget,
    streamAudioReceivers,
} from '../js/util/AudioJitter.js';

const receiver = (kind, supported = true) => {
    const r = { track: { kind } };
    if (supported) r.jitterBufferTarget = null;
    return r;
};

describe('setAudioJitterBufferTarget', () => {
    it('sets no floor by default: NetEq sizes itself (L1, 11/10)', () => {
        expect(AUDIO_JITTER_TARGET_MS).toBe(null);
        const audio = receiver('audio');
        const pc = { getReceivers: () => [audio] };
        expect(setAudioJitterBufferTarget(pc, audioJitterTargetMs({ getItem: () => null }))).toBe(
            0,
        );
        expect(audio.jitterBufferTarget).toBe(null);
    });

    it('aims the audio receiver and leaves the video one alone', () => {
        const audio = receiver('audio');
        const video = receiver('video');
        video.jitterBufferTarget = 180;
        const pc = { getReceivers: () => [video, audio] };
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(setAudioJitterBufferTarget(pc, 60)).toBe(1);
        expect(audio.jitterBufferTarget).toBe(60);
        expect(video.jitterBufferTarget).toBe(180);
        info.mockRestore();
    });

    it('takes a target of its own, whole and never negative', () => {
        const audio = receiver('audio');
        const pc = { getReceivers: () => [audio] };
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        setAudioJitterBufferTarget(pc, 42.7);
        expect(audio.jitterBufferTarget).toBe(42);
        setAudioJitterBufferTarget(pc, -10);
        expect(audio.jitterBufferTarget).toBe(0);
        info.mockRestore();
    });

    it('is a no-op where the property does not exist — older browsers', () => {
        const audio = receiver('audio', false);
        const pc = { getReceivers: () => [audio] };
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(setAudioJitterBufferTarget(pc, 60)).toBe(0);
        expect(audio.jitterBufferTarget).toBeUndefined();
        info.mockRestore();
    });

    it('survives no connection, no receivers and a throwing one', () => {
        expect(setAudioJitterBufferTarget(null, 60)).toBe(0);
        expect(setAudioJitterBufferTarget({}, 60)).toBe(0);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(setAudioJitterBufferTarget({ getReceivers: () => [] }, 60)).toBe(0);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const pc = {
            getReceivers: () => {
                throw new Error('closed');
            },
        };
        expect(setAudioJitterBufferTarget(pc, 60)).toBe(0);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        info.mockRestore();
    });
});

describe('the stream sound only, never the audio road', () => {
    const transceiver = (mid, receiverObj) => ({ mid, receiver: receiverObj });

    it('leaves the vaudio and uaudio receivers alone (POC Ultra, audio road)', () => {
        const sound = receiver('audio');
        const vaudio = receiver('audio');
        const uaudio = receiver('audio');
        vaudio.jitterBufferTarget = 0;
        uaudio.jitterBufferTarget = 0;
        const pc = {
            getReceivers: () => [sound, vaudio, uaudio],
            getTransceivers: () => [
                transceiver('audio', sound),
                transceiver('vaudio', vaudio),
                transceiver('uaudio', uaudio),
            ],
        };
        expect(streamAudioReceivers(pc)).toEqual([sound]);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(setAudioJitterBufferTarget(pc, 60)).toBe(1);
        info.mockRestore();
        expect(sound.jitterBufferTarget).toBe(60);
        expect(vaudio.jitterBufferTarget).toBe(0);
        expect(uaudio.jitterBufferTarget).toBe(0);
    });

    it('touches nothing when the target is off (null)', () => {
        const sound = receiver('audio');
        expect(setAudioJitterBufferTarget({ getReceivers: () => [sound] }, null)).toBe(0);
        expect(sound.jitterBufferTarget).toBe(null);
    });
});

describe('audioJitterTargetMs, the bench key mw_audio_target', () => {
    const store = (v) => ({ getItem: () => v });

    it('is the default (none) without the key, or with a value it cannot read', () => {
        expect(audioJitterTargetMs(store(null))).toBe(AUDIO_JITTER_TARGET_MS);
        expect(audioJitterTargetMs(store(''))).toBe(AUDIO_JITTER_TARGET_MS);
        expect(audioJitterTargetMs(store('soon'))).toBe(AUDIO_JITTER_TARGET_MS);
        expect(audioJitterTargetMs(store('-5'))).toBe(AUDIO_JITTER_TARGET_MS);
        expect(audioJitterTargetMs(store('5000'))).toBe(AUDIO_JITTER_TARGET_MS);
    });

    it('reads a floor in whole ms, 0 included, and off as none at all', () => {
        expect(audioJitterTargetMs(store('20'))).toBe(20);
        expect(audioJitterTargetMs(store(' 33.9 '))).toBe(33);
        expect(audioJitterTargetMs(store('0'))).toBe(0);
        expect(audioJitterTargetMs(store('OFF'))).toBe(null);
    });

    it('survives a storage that throws', () => {
        const broken = {
            getItem: () => {
                throw new Error('denied');
            },
        };
        expect(audioJitterTargetMs(broken)).toBe(AUDIO_JITTER_TARGET_MS);
    });
});
