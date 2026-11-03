/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * EnhancerGovernor — observable behaviour: which algo the ladder asks for after
 * a sequence of observation windows. The first suite replays the five real
 * measurements this policy was calibrated on (4K client, FSR1, HEVC), so a
 * threshold change that would start degrading a healthy stream fails here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    EnhancerGovernor,
    ladderRung,
    rendererAlgo,
    rememberedRung,
    rememberRung,
} from '../js/stream/EnhancerGovernor.js';

/** Feed the same window repeatedly, 500ms apart (the real posting cadence). */
function feed(gov, obs, seconds, startMs = 0) {
    const steps = [];
    let now = startMs;
    for (let i = 0; i < seconds * 2; i++) {
        now += 500;
        const algo = gov.update({ serviceMs: obs.serviceMs, arrivalMs: obs.arrivalMs, now });
        if (algo) steps.push({ algo, now });
    }
    return steps;
}

/**
 * Same, but the service time follows the level actually running — which is the
 * whole point of the ladder: stepping down is supposed to make the draw
 * cheaper. Feeding a fixed cost would model a ladder that changes nothing.
 */
function run(gov, costByLevel, seconds, startMs = 0, arrivalMs = 16.7) {
    const steps = [];
    let now = startMs;
    for (let i = 0; i < seconds * 2; i++) {
        now += 500;
        const algo = gov.update({ serviceMs: costByLevel[gov.level], arrivalMs, now });
        if (algo) steps.push({ algo, now });
    }
    return { steps, now };
}

// Cost of one draw per level, in ms, down the ladder fsr1 → nis → sgsr → mwsr
// → off. Under a call the GPU is contended and FSR1 (3 passes) no longer fits
// a 16.7ms frame; NIS (one pass, heavier taps) does, and so do SGSR and mwsr
// (MoonlightWeb's own, about half of SGSR) below it.
const CONTENDED = { fsr1: 19.5, nis: 12, sgsr: 9, mwsr: 5, off: 3 };
// Recovery needs the running level under 0.4 × 16.7 = 6.7ms.
const IDLE = { fsr1: 10.3, nis: 6, sgsr: 5, mwsr: 3, off: 2 };

/** Same cadence as feed(), with a decode-queue depth on every window. */
function feedQueued(gov, obs, seconds, startMs = 0) {
    const steps = [];
    let now = startMs;
    for (let i = 0; i < seconds * 2; i++) {
        now += 500;
        const algo = gov.update({
            serviceMs: obs.serviceMs,
            arrivalMs: obs.arrivalMs,
            decodeQueue: obs.decodeQueue,
            now,
        });
        if (algo) steps.push({ algo, now });
    }
    return steps;
}

describe('EnhancerGovernor — measured scenarios', () => {
    // Each: [name, render service time, arrival avg] from the captured [perf] lines.
    const healthy = [
        ['video paused, 27fps', 10.1, 38.0],
        ['video playing, 60fps', 10.3, 16.8],
        ['mouse moving, 57fps', 10.9, 17.9],
        ['Teams call, static 22fps', 10.2, 47.0],
    ];

    for (const [name, serviceMs, arrivalMs] of healthy) {
        it(`holds FSR1 — ${name}`, () => {
            const gov = new EnhancerGovernor('fsr1');
            expect(feed(gov, { serviceMs, arrivalMs }, 60)).toEqual([]);
            expect(gov.level).toBe('fsr1');
            expect(gov.degraded).toBe(false);
        });
    }

    it('steps down under a Teams call at 60fps (19.5ms wait for a 16.7ms budget)', () => {
        const gov = new EnhancerGovernor('fsr1');
        const steps = feed(gov, { serviceMs: 19.5, arrivalMs: 16.7 }, 10);
        expect(steps[0].algo).toBe('nis');
        expect(gov.degraded).toBe(true);
    });
});

describe('EnhancerGovernor', () => {
    it('never climbs above the user setting', () => {
        const gov = new EnhancerGovernor('sgsr');
        expect(feed(gov, { serviceMs: 0.5, arrivalMs: 16.7 }, 120)).toEqual([]);
        expect(gov.level).toBe('sgsr');
    });

    it('walks the whole ladder down but stops at off', () => {
        const gov = new EnhancerGovernor('fsr1');
        const steps = feed(gov, { serviceMs: 40, arrivalMs: 16.7 }, 60);
        expect(steps.map((s) => s.algo)).toEqual(['nis', 'sgsr', 'mwsr', 'off']);
        expect(gov.level).toBe('off');
    });

    it('has mwsr one rung under SGSR, in both flavours, and reads an older memory as before', () => {
        // Cheaper than SGSR1 for FSR1's sharpness (upscaler-mwsr.md): a session
        // stepped down keeps a sharp picture one rung longer.
        const gov = new EnhancerGovernor('sgsr');
        const steps = feed(gov, { serviceMs: 40, arrivalMs: 16.7 }, 20);
        expect(steps.map((s) => s.algo)).toEqual(['mwsr', 'off']);
        expect(new EnhancerGovernor('mwsr').level).toBe('mwsr');
        expect(ladderRung('gl-mwsr')).toBe('mwsr');
        expect(rendererAlgo('mwsr', 'webgl')).toBe('gl-mwsr');
        expect(rendererAlgo('mwsr', 'webgpu')).toBe('mwsr');
        // A verdict kept before the rung existed names its rungs: still read.
        localStorage.setItem(
            'mw_enhancer_rung',
            JSON.stringify({ webgl: { ceiling: 'sgsr', rung: 'off', recoverAfterMs: 30000 } }),
        );
        expect(rememberedRung('webgl', 'sgsr')).toEqual({ rung: 'off', recoverAfterMs: 30000 });
        localStorage.removeItem('mw_enhancer_rung');
    });

    it('needs the verdict to hold — a single busy window changes nothing', () => {
        const gov = new EnhancerGovernor('fsr1');
        let now = 0;
        expect(gov.update({ serviceMs: 40, arrivalMs: 16.7, now: (now += 500) })).toBe(null);
        expect(gov.update({ serviceMs: 5, arrivalMs: 16.7, now: (now += 500) })).toBe(null);
        expect(gov.update({ serviceMs: 40, arrivalMs: 16.7, now: (now += 500) })).toBe(null);
        expect(gov.level).toBe('fsr1');
    });

    it('stops at the first level that fits, instead of falling to off', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = run(gov, CONTENDED, 120);
        expect(steps.map((s) => s.algo)).toEqual(['nis']);
        expect(gov.level).toBe('nis');
    });

    it('climbs back to the setting once the pressure is gone', () => {
        const gov = new EnhancerGovernor('fsr1');
        const call = run(gov, CONTENDED, 60);
        expect(gov.level).toBe('nis');

        const after = run(gov, IDLE, 60, call.now);
        expect(after.steps.map((s) => s.algo)).toEqual(['fsr1']);
        expect(gov.degraded).toBe(false);
    });

    it('backs off instead of flip-flopping when the level above never fits', () => {
        // Pathological: NIS looks cheap enough to justify a restore, FSR1 is
        // always too expensive — every restore is immediately undone.
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = run(gov, { fsr1: 19.5, nis: 6, sgsr: 6, off: 2 }, 300);
        const restores = steps.filter((s) => s.algo === 'fsr1');
        // A fixed 15s retry would have burnt ~19 restores over five minutes.
        expect(restores.length).toBeLessThanOrEqual(4);
        // …and each attempt waits longer than the previous one.
        const gaps = restores.slice(1).map((s, i) => s.now - restores[i].now);
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
        expect(gov.level).toBe('nis');
    });

    it('ignores the window right after a switch (it describes the old level)', () => {
        const gov = new EnhancerGovernor('fsr1');
        // One expensive burst, long enough to degrade once and no more: the
        // stale samples that follow must not walk the ladder down again.
        const steps = feed(gov, { serviceMs: 40, arrivalMs: 16.7 }, 3);
        expect(steps.map((s) => s.algo)).toEqual(['nis']);
    });

    it('decides nothing without a usable frame budget', () => {
        const gov = new EnhancerGovernor('fsr1');
        expect(feed(gov, { serviceMs: 40, arrivalMs: 0 }, 60)).toEqual([]);
        expect(feed(gov, { serviceMs: 40, arrivalMs: 5000 }, 60)).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('treats an unknown setting as the top of the ladder', () => {
        const gov = new EnhancerGovernor(undefined);
        expect(gov.level).toBe('fsr1');
    });
});

/**
 * The profile an invited player streams under. Their session is fixed at 60fps
 * and they chose none of it, so the promise is a flat cost cap rather than a
 * share of a frame budget that depends on their own link.
 */
describe('EnhancerGovernor — invited player profile', () => {
    const PLAYER = { fixedBudgetMs: 8, warmupMs: 10000, noRecovery: true };

    it('ignores the first 10 seconds, however expensive', () => {
        const gov = new EnhancerGovernor('sgsr', PLAYER);
        // 20ms a frame is way over the cap, but this is shader compilation and
        // a cold pipeline — not the steady cost.
        expect(feed(gov, { serviceMs: 20, arrivalMs: 16.7 }, 9)).toEqual([]);
        expect(gov.level).toBe('sgsr');
    });

    it('drops SGSR once it costs more than 8ms past the warm-up', () => {
        const gov = new EnhancerGovernor('sgsr', PLAYER);
        const steps = feed(gov, { serviceMs: 9, arrivalMs: 16.7 }, 20);
        expect(steps.map((s) => s.algo)).toEqual(['mwsr', 'off']);
        expect(gov.degraded).toBe(true);
    });

    it('holds SGSR at a cost the owner ladder would also accept', () => {
        const gov = new EnhancerGovernor('sgsr', PLAYER);
        // 6ms fits the 8ms cap; the adaptive rule (0.8 x 16.7 = 13.4ms) would
        // hold it too — this is the case where the two agree.
        expect(feed(gov, { serviceMs: 6, arrivalMs: 16.7 }, 60)).toEqual([]);
        expect(gov.level).toBe('sgsr');
    });

    it('applies the cap where the adaptive budget would not have', () => {
        const gov = new EnhancerGovernor('sgsr', PLAYER);
        // 11ms is under 0.8 x 16.7, so the owner's governor holds — but the
        // player was promised 8ms.
        const steps = feed(gov, { serviceMs: 11, arrivalMs: 16.7 }, 20);
        expect(steps.map((s) => s.algo)).toEqual(['mwsr', 'off']);

        const owner = new EnhancerGovernor('sgsr');
        expect(feed(owner, { serviceMs: 11, arrivalMs: 16.7 }, 20)).toEqual([]);
    });

    it('never comes back once dropped', () => {
        const gov = new EnhancerGovernor('sgsr', PLAYER);
        feed(gov, { serviceMs: 12, arrivalMs: 16.7 }, 20);
        expect(gov.level).toBe('off');
        // Idle GPU for five minutes: predictable beats optimal for a guest.
        expect(feed(gov, { serviceMs: 0.5, arrivalMs: 16.7 }, 300, 40000)).toEqual([]);
        expect(gov.level).toBe('off');
    });
});

/**
 * The failure the draw timing cannot report: a WebGL pass that only queues its
 * work costs nothing to submit while the decoder starves behind it. Numbers
 * from an Arc A380 streaming 1440p120 HEVC with FSR1 on — serviceMs 0.2ms for
 * a 9ms budget, decodeQueueSize 12-14, two thirds of the frames lost.
 */
describe('EnhancerGovernor — a starved decoder behind a cheap draw', () => {
    const STARVED = { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 13 };

    it('steps down although the draw says it fits', () => {
        const gov = new EnhancerGovernor('fsr1');
        // Same window without the queue: the old policy saw nothing at all.
        const blind = new EnhancerGovernor('fsr1');
        expect(feed(blind, { serviceMs: 0.2, arrivalMs: 9.0 }, 60)).toEqual([]);
        expect(blind.level).toBe('fsr1');

        const steps = feedQueued(gov, STARVED, 20);
        expect(steps[0].algo).toBe('nis');
        // The queue stays deep, so the ladder keeps walking down to off.
        expect(gov.level).toBe('off');
    });

    it('holds through a spike shorter than the sustain window', () => {
        const gov = new EnhancerGovernor('fsr1');
        expect(feedQueued(gov, STARVED, 1.5)).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('leaves a queue that is merely busy alone', () => {
        const gov = new EnhancerGovernor('fsr1');
        // decQ 2 with a cheap draw is a healthy 120fps stream, not starvation.
        expect(feedQueued(gov, { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 2 }, 60)).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('does not climb back while the queue is still deep', () => {
        const gov = new EnhancerGovernor('fsr1');
        feedQueued(gov, STARVED, 20);
        expect(gov.level).toBe('off');
        // Draw cost says recover — the decoder says the GPU is still behind.
        expect(
            feedQueued(gov, { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 6 }, 300, 20000),
        ).toEqual([]);
        expect(gov.level).toBe('off');
    });

    it('climbs back once the decoder is clear again', () => {
        const gov = new EnhancerGovernor('fsr1');
        feedQueued(gov, STARVED, 20);
        expect(gov.level).toBe('off');
        const steps = feedQueued(
            gov,
            { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 0 },
            300,
            20000,
        );
        expect(steps.map((s) => s.algo)).toContain('sgsr');
    });

    it('stays out of it with the enhancer already off', () => {
        const gov = new EnhancerGovernor('off');
        // A backlog with nothing enhancing is not the ladder's problem.
        expect(feedQueued(gov, STARVED, 60)).toEqual([]);
        expect(gov.level).toBe('off');
    });
});

/**
 * The other failure the draw timing cannot report: a GPU that keeps UP with the
 * frame rate but runs BEHIND it. 2-CU Radeon iGPU, 1440p60, FSR1 WebGL: 60 fps
 * in and out, decoder queue empty, submission 0.3ms — and every picture ~29ms
 * late (click-to-photon 59.6ms, 30.8 without the enhancer, 32.6 with SGSR).
 * The fences say it: FSR1's work is still running when the next frame comes.
 */
describe('EnhancerGovernor — a GPU that keeps up, frames late', () => {
    // Share of draws still on the GPU at the next one, per running level.
    const BEHIND = { fsr1: 1.0, nis: 0.9, sgsr: 0.0, mwsr: 0.0, off: 0.0 };

    function runGpu(gov, behindByLevel, seconds, startMs = 0) {
        const steps = [];
        let now = startMs;
        for (let i = 0; i < seconds * 2; i++) {
            now += 500;
            const algo = gov.update({
                serviceMs: 0.3,
                arrivalMs: 16.7,
                decodeQueue: 0,
                gpuBehind: behindByLevel[gov.level],
                now,
            });
            if (algo) steps.push({ algo, now });
        }
        return { steps, now };
    }

    it('steps down to the pass the GPU finishes in time', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = runGpu(gov, BEHIND, 10);
        expect(steps.map((s) => s.algo)).toEqual(['nis', 'sgsr']);
        expect(gov.level).toBe('sgsr');
    });

    it('undoes each bet on the heavier pass, and waits longer before the next', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = runGpu(gov, BEHIND, 300);
        const algos = steps.map((s) => s.algo);
        expect(algos.slice(0, 2)).toEqual(['nis', 'sgsr']);
        // Every climb back to NIS finds the fences late again and is undone.
        const bets = steps.filter((s, i) => i >= 2 && s.algo === 'nis').map((s) => s.now);
        expect(bets.length).toBeGreaterThan(1);
        for (let i = 2; i < algos.length; i += 2) expect(algos[i + 1] ?? 'sgsr').toBe('sgsr');
        // ...and the wait between bets grows.
        const gaps = bets.slice(1).map((t, i) => t - bets[i]);
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    });

    it('leaves a GPU that is only sometimes late alone', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = runGpu(gov, { fsr1: 0.3, nis: 0.3, sgsr: 0.3, off: 0 }, 60);
        expect(steps).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('treats a renderer that cannot tell (null) as never behind', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = runGpu(gov, { fsr1: null, nis: null, sgsr: null, off: null }, 60);
        expect(steps).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('does not bet on the heavier pass again while the GPU still lags', () => {
        const gov = new EnhancerGovernor('fsr1');
        runGpu(gov, BEHIND, 10);
        expect(gov.level).toBe('sgsr');
        // Draw and queue say recover; the fences of SGSR itself are not clear.
        const { steps } = runGpu(gov, { ...BEHIND, sgsr: 0.2 }, 300, 10000);
        expect(steps).toEqual([]);
        expect(gov.level).toBe('sgsr');
    });
});

describe('EnhancerGovernor — WebGL2 passes and the memory of a verdict', () => {
    const STARVED = { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 13 };
    const CLEAR = { serviceMs: 0.2, arrivalMs: 9.0, decodeQueue: 0 };

    beforeEach(() => localStorage.clear());

    it('names the same rung on both renderers', () => {
        expect(ladderRung('gl-sgsr')).toBe('sgsr');
        expect(ladderRung('sgsr')).toBe('sgsr');
        expect(ladderRung('off')).toBe('off');
        expect(rendererAlgo('sgsr', 'webgl')).toBe('gl-sgsr');
        expect(rendererAlgo('off', 'webgl')).toBe('off');
        expect(rendererAlgo('nis', 'webgpu')).toBe('nis');
    });

    it('starts where the last session left it, under the same ceiling', () => {
        const gov = new EnhancerGovernor('sgsr', { startRung: 'off' });
        expect(gov.level).toBe('off');
        expect(gov.degraded).toBe(true);
        expect(gov.ceiling).toBe('sgsr');
        // A start above the ceiling is not a start: the setting wins.
        expect(new EnhancerGovernor('sgsr', { startRung: 'fsr1' }).level).toBe('sgsr');
    });

    it('climbs back from a remembered start when the decoder is clear', () => {
        const gov = new EnhancerGovernor('sgsr', { startRung: 'off' });
        // One bet at a time, 15 s apart: mwsr first, the setting after it.
        expect(feedQueued(gov, CLEAR, 30).map((s) => s.algo)).toEqual(['mwsr']);
        expect(gov.degraded).toBe(true);
        expect(feedQueued(gov, CLEAR, 30, 30000).map((s) => s.algo)).toEqual(['sgsr']);
        expect(gov.degraded).toBe(false);
    });

    it("keeps the previous session's wait before its first bet", () => {
        const gov = new EnhancerGovernor('sgsr', { startRung: 'off', recoverAfterMs: 60000 });
        expect(gov.recoverAfterMs).toBe(60000);
        expect(feedQueued(gov, CLEAR, 50)).toEqual([]);
        expect(feedQueued(gov, CLEAR, 20, 50000).map((s) => s.algo)).toEqual(['mwsr']);
    });

    it('remembers a step down and forgets it back at the setting', () => {
        expect(rememberedRung('webgl', 'sgsr')).toBeNull();
        const gov = new EnhancerGovernor('sgsr');
        const down = feedQueued(gov, STARVED, 10);
        expect(down.map((s) => s.algo)).toEqual(['mwsr', 'off']);
        rememberRung('webgl', gov.ceiling, gov.level, gov.recoverAfterMs);
        expect(rememberedRung('webgl', 'sgsr')).toEqual({ rung: 'off', recoverAfterMs: 15000 });
        // Another renderer, another setting: nothing carried over.
        expect(rememberedRung('webgpu', 'sgsr')).toBeNull();
        expect(rememberedRung('webgl', 'fsr1')).toBeNull();
        rememberRung('webgl', 'sgsr', 'sgsr', 15000);
        expect(rememberedRung('webgl', 'sgsr')).toBeNull();
    });

    it('reads a damaged memory as nothing', () => {
        localStorage.setItem('mw_enhancer_rung', '{not json');
        expect(rememberedRung('webgl', 'sgsr')).toBeNull();
        localStorage.setItem(
            'mw_enhancer_rung',
            JSON.stringify({ webgl: { ceiling: 'sgsr', rung: 'x' } }),
        );
        expect(rememberedRung('webgl', 'sgsr')).toBeNull();
    });
});

describe('EnhancerGovernor — the frame copied at 1:1', () => {
    // At exactly the frame size the shader renderers skip the pass and copy
    // the frame (VideoRenderer.passthrough): the window then measures a copy,
    // whatever the rung says, so the ladder must neither step down on it nor
    // climb back on it, and its clock starts afresh when the pass resumes.
    function hold(gov, obs, seconds, startMs, passthrough) {
        const steps = [];
        let now = startMs;
        for (let i = 0; i < seconds * 2; i++) {
            now += 500;
            const algo = gov.update({
                serviceMs: obs.serviceMs,
                arrivalMs: obs.arrivalMs,
                passthrough,
                now,
            });
            if (algo) steps.push({ algo, now });
        }
        return { steps, now };
    }

    it('does not step down on a contended window while nothing runs', () => {
        const gov = new EnhancerGovernor('fsr1');
        const { steps } = hold(gov, { serviceMs: 19.5, arrivalMs: 16.7 }, 20, 0, true);
        expect(steps).toEqual([]);
        expect(gov.level).toBe('fsr1');
    });

    it('does not climb back while the frame is a copy, however long that lasts', () => {
        const gov = new EnhancerGovernor('fsr1', { startRung: 'sgsr' });
        const { steps, now } = hold(gov, { serviceMs: 2, arrivalMs: 16.7 }, 600, 0, true);
        expect(steps).toEqual([]);
        expect(gov.level).toBe('sgsr');
        // The pass back at scale, and cheap: the ordinary wait, then the climb.
        const back = hold(gov, { serviceMs: 5, arrivalMs: 16.7 }, 16, now, false);
        expect(back.steps.map((s) => s.algo)).toEqual(['nis']);
    });

    it('restarts its clock when the pass resumes', () => {
        const gov = new EnhancerGovernor('fsr1', { startRung: 'sgsr' });
        // 14 s in the clear: one more second would have been the first bet.
        let t = hold(gov, { serviceMs: 5, arrivalMs: 16.7 }, 14, 0, false);
        expect(t.steps).toEqual([]);
        // A passage through 1:1…
        t = hold(gov, { serviceMs: 2, arrivalMs: 16.7 }, 5, t.now, true);
        expect(t.steps).toEqual([]);
        // …then back at scale: not one window later, but 15 s later.
        t = hold(gov, { serviceMs: 5, arrivalMs: 16.7 }, 2, t.now, false);
        expect(t.steps).toEqual([]);
        expect(gov.level).toBe('sgsr');
        t = hold(gov, { serviceMs: 5, arrivalMs: 16.7 }, 14, t.now, false);
        expect(t.steps.map((s) => s.algo)).toEqual(['nis']);
    });
});

/**
 * Fences that find even the plain copy late. Chrome on a 120 Hz Radeon 780M,
 * 1080p120 (28/10/2026): MWSR cost 0.3 ms a frame, the fences read it late, the
 * ladder cut it — and the copy left in its place read late too, so the climb
 * back never came and the memory started every next session at 'off'.
 */
describe('EnhancerGovernor — fences that read the copy late', () => {
    // gpuBehind of the copy, window after window, as that evening's log has it (%).
    const COPY_120 = [
        88, 0, 2, 0, 0, 63, 25, 0, 14, 2, 0, 2, 0, 2, 0, 2, 0, 0, 11, 2, 0, 2, 2, 10, 30, 92, 100,
        40, 75, 0, 0, 0, 13, 18, 9, 7, 0, 0, 0, 57, 5, 36, 2, 0, 9, 0, 0, 23, 7, 16, 0, 25, 19, 36,
        19, 16, 96,
    ];

    /** 500 ms windows at 120 fps, the fences read by the level running. */
    function at120(gov, behindByLevel, seconds, startMs = 0) {
        const steps = [];
        let now = startMs;
        for (let i = 0; i < seconds * 2; i++) {
            now += 500;
            const algo = gov.update({
                serviceMs: 0.3,
                arrivalMs: 8.4,
                decodeQueue: 0,
                gpuBehind: behindByLevel[gov.level](i),
                now,
            });
            if (algo) steps.push({ algo, now });
        }
        return { steps, now };
    }
    // MWSR's own fences as late as before the cut, every draw: the strictest case.
    const measured = { mwsr: () => 1, off: (i) => COPY_120[i % COPY_120.length] / 100 };

    beforeEach(() => localStorage.clear());

    it('climbs back from a remembered off although the copy reads late, and forgets the verdict', () => {
        // Where that evening's sessions started: MWSR's ceiling, 'off' remembered.
        rememberRung('webgl', 'mwsr', 'off', 15000);
        const start = rememberedRung('webgl', 'mwsr');
        expect(start).toEqual({ rung: 'off', recoverAfterMs: 15000 });
        const gov = new EnhancerGovernor('mwsr', {
            startRung: start.rung,
            recoverAfterMs: start.recoverAfterMs,
        });
        const { steps, now } = at120(gov, measured, 30);
        expect(gov.fencesIgnored).toBe(true);
        expect(steps.map((s) => s.algo)).toEqual(['mwsr']);
        // Four late windows, then the ordinary 15 s in the clear.
        expect(steps[0].now).toBeLessThanOrEqual(25000);
        // StreamView keeps each step: back at the setting, nothing is kept.
        rememberRung('webgl', gov.ceiling, gov.level, gov.recoverAfterMs);
        expect(rememberedRung('webgl', 'mwsr')).toBeNull();
        // MWSR then holds, its own fences as late as ever.
        expect(at120(gov, measured, 120, now).steps).toEqual([]);
        expect(gov.level).toBe('mwsr');
    });

    it('cuts MWSR once and then gives it back for the session, starting without a memory', () => {
        const gov = new EnhancerGovernor('mwsr');
        const { steps } = at120(gov, measured, 60);
        expect(steps.map((s) => s.algo)).toEqual(['off', 'mwsr']);
        // The 2 s after the switch, four late windows, then 15 s in the clear.
        expect(steps[1].now - steps[0].now).toBeLessThanOrEqual(30000);
    });

    it('keeps the fences where the copy reads them clean: a pass the GPU finishes late is still undone', () => {
        const gov = new EnhancerGovernor('mwsr');
        const { steps } = at120(gov, { mwsr: () => 1, off: () => 0 }, 60);
        expect(gov.fencesIgnored).toBe(false);
        // Down, the bet 15 s later, undone again: the 25/09 behaviour, at the last rung.
        expect(steps.map((s) => s.algo).slice(0, 3)).toEqual(['off', 'mwsr', 'off']);
    });

    it('does not give up the fences for a copy late once or twice', () => {
        const gov = new EnhancerGovernor('mwsr', { startRung: 'off' });
        const late = [0.9, 0, 0, 0, 0.6, 0, 0.3];
        const { steps } = at120(gov, { mwsr: () => 1, off: (i) => late[i] ?? 0 }, 60);
        expect(gov.fencesIgnored).toBe(false);
        expect(steps.map((s) => s.algo).slice(0, 2)).toEqual(['mwsr', 'off']);
    });

    it("leaves the fences alone at the user's own off: there is nothing to climb back to", () => {
        const gov = new EnhancerGovernor('off');
        expect(at120(gov, measured, 30).steps).toEqual([]);
        expect(gov.fencesIgnored).toBe(false);
    });
});

/**
 * A copy that waits on presentation. Chrome WebGPU on a 120 Hz Radeon 780M,
 * 1080p120 (28/10/2026): the draw ends at onSubmittedWorkDone, which waits for
 * the swap chain too, so the plain copy alone took 5.0 to 6.0 ms of an 8.4 ms
 * frame — over the 3.4 ms a climb needs. The session left at 'off' stayed there,
 * and the memory started the next one at 'off' (17:02, 17:03).
 */
describe('EnhancerGovernor — a copy that waits on presentation', () => {
    // [serviceMs, arrivalMs, decodeQueue] of the copy, 17:02:16 to 17:02:48.
    const COPY_WEBGPU_120 = [
        [5.9, 8.3, 0], [5.4, 8.4, 0], [6.0, 8.5, 0.2], [5.5, 8.7, 0], [5.4, 8.4, 0], [5.9, 8.4, 0],
        [5.7, 8.2, 0], [5.1, 8.2, 0], [5.0, 8.3, 0], [5.1, 8.2, 0], [5.3, 8.2, 0], [5.8, 8.3, 0],
        [5.8, 8.2, 0], [5.4, 8.2, 0], [5.0, 8.6, 0], [5.2, 8.6, 0], [5.2, 8.2, 0], [5.4, 8.3, 0],
        [5.8, 8.4, 0], [5.3, 8.7, 0], [5.0, 9.1, 0], [5.2, 9.1, 0], [5.5, 9.2, 0], [5.6, 8.6, 0],
        [5.6, 8.3, 0], [5.7, 8.4, 0], [5.6, 8.5, 0],
    ];
    const copy = (i) => COPY_WEBGPU_120[i % COPY_WEBGPU_120.length];

    /** 500 ms windows, each level's [serviceMs, arrivalMs, decodeQueue]; no fences on WebGPU. */
    function play(gov, byLevel, seconds, startMs = 0) {
        const steps = [];
        let now = startMs;
        for (let i = 0; i < seconds * 2; i++) {
            now += 500;
            const [serviceMs, arrivalMs, decodeQueue] = byLevel[gov.level](i);
            const algo = gov.update({ serviceMs, arrivalMs, decodeQueue, gpuBehind: null, now });
            if (algo) steps.push({ algo, now });
        }
        return { steps, now };
    }

    beforeEach(() => localStorage.clear());

    it('climbs back from the 17:02 memory, forgets it, and keeps an MWSR that fits a frame', () => {
        rememberRung('webgpu', 'mwsr', 'off', 15000);
        const start = rememberedRung('webgpu', 'mwsr');
        const gov = new EnhancerGovernor('mwsr', {
            startRung: start.rung,
            recoverAfterMs: start.recoverAfterMs,
        });
        // MWSR a millisecond over the copy: past the 6.7 ms that cut it before.
        const levels = { off: copy, mwsr: () => [7.0, 8.4, 0] };
        const { steps, now } = play(gov, levels, 30);
        expect(gov.presentationBound).toBe(true);
        expect(steps.map((s) => s.algo)).toEqual(['mwsr']);
        // Four windows of the copy, then the ordinary 15 s.
        expect(steps[0].now).toBeLessThanOrEqual(25000);
        rememberRung('webgpu', gov.ceiling, gov.level, gov.recoverAfterMs);
        expect(rememberedRung('webgpu', 'mwsr')).toBeNull();
        expect(play(gov, levels, 120, now).steps).toEqual([]);
        expect(gov.level).toBe('mwsr');
    });

    it('still cuts an MWSR too slow for the GPU, and bets on it again less and less often', () => {
        const gov = new EnhancerGovernor('mwsr', { startRung: 'off' });
        // More than a whole frame: the GPU cannot keep up, whatever the swap chain does.
        const { steps } = play(gov, { off: copy, mwsr: () => [12, 8.4, 0] }, 300);
        expect(gov.presentationBound).toBe(true);
        const algos = steps.map((s) => s.algo);
        expect(algos.slice(0, 4)).toEqual(['mwsr', 'off', 'mwsr', 'off']);
        // Each bet undone within the 2 s after the switch plus the 2 s it takes to cut…
        for (let i = 1; i < steps.length; i += 2) {
            expect(steps[i].now - steps[i - 1].now).toBeLessThanOrEqual(4500);
        }
        // …and the wait before the next one grows.
        const bets = steps.filter((s) => s.algo === 'mwsr').map((s) => s.now);
        const gaps = bets.slice(1).map((t, i) => t - bets[i]);
        for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    });

    it('changes nothing where the copy leaves a climb its margin', () => {
        const gov = new EnhancerGovernor('mwsr', { startRung: 'off' });
        const { steps } = play(gov, { off: () => [2.0, 8.4, 0], mwsr: () => [7.0, 8.4, 0] }, 60);
        expect(gov.presentationBound).toBe(false);
        // The climb, then the cut at 7 ms > 0.8 × 8.4 as before.
        expect(steps.map((s) => s.algo).slice(0, 2)).toEqual(['mwsr', 'off']);
    });

    it('changes nothing for a copy that does not fit a frame: a machine overloaded', () => {
        const gov = new EnhancerGovernor('mwsr', { startRung: 'off' });
        const { steps } = play(gov, { off: () => [8.0, 8.4, 0], mwsr: () => [9.0, 8.4, 0] }, 60);
        expect(gov.presentationBound).toBe(false);
        expect(steps).toEqual([]);
    });

    it("leaves the user's own off alone", () => {
        const gov = new EnhancerGovernor('off');
        expect(play(gov, { off: copy }, 30).steps).toEqual([]);
        expect(gov.presentationBound).toBe(false);
    });
});
