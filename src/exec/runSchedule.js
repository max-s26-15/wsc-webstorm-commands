/**
 * Walk a launch plan's barriers: launch up to the next one, look at how its preset did, wait.
 *
 * The one walk shared by every way of launching (IDE calls, OS terminal tabs, the single-tab
 * pool), which each bring only their `launchBatch`. It is a timer, not a health check: all it
 * knows of a launch is what `launchBatch` reports, and a process that dies during the pause
 * goes unnoticed.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { quotePresetName } from './schedule.js';

/**
 * @typedef {import('./schedule.js').PresetBarrier} PresetBarrier
 * @typedef {{ index: number, reason: string }} IndexFailure
 * @typedef {{ started: number[], failed: IndexFailure[] }} BatchReport
 * @typedef {BatchReport & { skipped: number[], blockedBy?: string, cancelled: boolean }} ScheduleReport
 * @typedef {(ms: number, opts: { signal?: AbortSignal }) => Promise<void>} Wait
 */

/** @type {Wait} */
export const waitForDelay = (ms, { signal }) => delay(ms, undefined, { signal });

/**
 * @param {number} total - how many entries the plan holds
 * @param {PresetBarrier[]} barriers - in plan order
 * @param {object} opts
 * @param {(start: number, end: number) => Promise<BatchReport>} opts.launchBatch - `end` is
 *   exclusive and every index is absolute. It attempts its whole range unless the signal
 *   aborts. A failure that is not about one entry is a rejection, and rejects this too.
 * @param {Wait} [opts.wait]
 * @param {AbortSignal} [opts.signal]
 * @param {{ info: (line: string) => void }} opts.log
 * @returns {Promise<ScheduleReport>}
 */
export async function runSchedule(total, barriers, opts) {
    const { launchBatch, signal, log } = opts;
    const wait = opts.wait ?? waitForDelay;

    /** @type {number[]} */
    const started = [];
    /** @type {IndexFailure[]} */
    const failed = [];
    /** @type {string | undefined} */
    let blockedBy;
    let next = 0;

    /** @param {number} end */
    const launchUpTo = async (end) => {
        if (end <= next) return;
        const report = await launchBatch(next, end);
        started.push(...report.started);
        failed.push(...report.failed);
        next = end;
    };

    /**
     * The signal is read after every await, since an abort can land while one settles: a
     * wait that finished in the same tick as Ctrl-C must not open the next tab.
     */
    const walk = async () => {
        for (const barrier of barriers) {
            if (signal?.aborted) return;
            await launchUpTo(barrier.after);
            if (signal?.aborted) return;

            const failedIndexes = new Set(failed.map((failure) => failure.index));
            if (barrier.members.some((member) => failedIndexes.has(member))) {
                blockedBy = barrier.presetName;
                return;
            }

            log.info(`waiting ${barrier.waitAfterSeconds}s after preset ${quotePresetName(barrier.presetName)}`);
            try {
                await wait(barrier.waitAfterSeconds * 1000, { signal });
            } catch (err) {
                if (signal?.aborted) return;
                throw err;
            }
        }
        if (signal?.aborted) return;
        await launchUpTo(total);
    };

    await walk();

    const attempted = new Set([...started, ...failed.map((failure) => failure.index)]);
    const skipped = Array.from({ length: total }, (_, index) => index).filter((index) => !attempted.has(index));

    return {
        started,
        failed,
        skipped,
        ...(blockedBy === undefined ? {} : { blockedBy }),
        cancelled: signal?.aborted ?? false,
    };
}
