import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import { runSchedule, waitForDelay } from '../src/exec/runSchedule.js';
import { createControlledWait } from '../test-utils/controlled-wait.js';

const barrier = (after, presetName, waitAfterSeconds, members) => ({ after, presetName, waitAfterSeconds, members });
const INFRA = [barrier(1, 'infra', 10, [0])];

/**
 * @param {object} [opts]
 * @param {Set<number>} [opts.failing] - indexes the adapter reports as failed
 */
function harness(opts = {}) {
    const clock = createControlledWait();
    const controller = new AbortController();
    const attempted = [];
    const batches = [];
    const infos = [];
    /** @type {(start: number, end: number) => Promise<any>} */
    const launchBatch = async (start, end) => {
        batches.push([start, end]);
        const report = { started: [], failed: [] };
        for (let index = start; index < end; index++) {
            attempted.push(index);
            if (opts.failing?.has(index)) report.failed.push({ index, reason: `boom ${index}` });
            else report.started.push(index);
        }
        return report;
    };
    return {
        clock,
        controller,
        attempted,
        batches,
        infos,
        launchBatch,
        run: (total, barriers) => runSchedule(total, barriers, {
            launchBatch,
            wait: clock.wait,
            signal: controller.signal,
            log: { info: (line) => infos.push(line) },
        }),
    };
}

describe('runSchedule', () => {
    test('nothing behind the pause starts until the pause is over', async () => {
        const h = harness();
        const running = h.run(3, INFRA);

        const pending = await h.clock.next();
        assert.equal(pending.ms, 10000);
        assert.deepEqual(h.attempted, [0]);

        pending.release();
        const report = await running;
        assert.deepEqual(report, { started: [0, 1, 2], failed: [], skipped: [], cancelled: false });
    });

    test('says once what it is waiting for, naming the preset', async () => {
        const h = harness();
        const running = h.run(2, [barrier(1, 'in"fra', 10, [0])]);
        (await h.clock.next()).release();
        await running;
        assert.deepEqual(h.infos, ['waiting 10s after preset "in\\"fra"']);
    });

    test('no barriers is exactly one batch and no wait', async () => {
        const h = harness();
        const report = await h.run(3, []);
        assert.deepEqual(h.batches, [[0, 3]]);
        assert.deepEqual(h.clock.calls, []);
        assert.deepEqual(report.started, [0, 1, 2]);
    });

    test('a failed member stops the run: no wait, the rest skipped, the preset named', async () => {
        const h = harness({ failing: new Set([0]) });
        const report = await h.run(3, INFRA);
        assert.deepEqual(report, {
            started: [],
            failed: [{ index: 0, reason: 'boom 0' }],
            skipped: [1, 2],
            blockedBy: 'infra',
            cancelled: false,
        });
        assert.deepEqual(h.clock.calls, []);
        assert.deepEqual(h.batches, [[0, 1]]);
    });

    test('every member of the blocking preset is still attempted', async () => {
        const h = harness({ failing: new Set([0]) });
        const report = await h.run(3, [barrier(2, 'infra', 1, [0, 1])]);
        assert.deepEqual(report.started, [1]);
        assert.deepEqual(report.skipped, [2]);
    });

    test('a failure in a preset without a pause does not stop a later pause that does not contain it', async () => {
        const h = harness({ failing: new Set([0]) });
        const running = h.run(3, [barrier(2, 'b', 5, [1])]);
        (await h.clock.next()).release();
        const report = await running;
        assert.deepEqual(report.started, [1, 2]);
        assert.deepEqual(report.failed, [{ index: 0, reason: 'boom 0' }]);
        assert.deepEqual(report.skipped, []);
        assert.equal(report.blockedBy, undefined);
    });

    test('a shared member that failed in an earlier preset blocks at the later barrier', async () => {
        const h = harness({ failing: new Set([0]) });
        const report = await h.run(3, [barrier(2, 'b', 5, [0, 1])]);
        assert.equal(report.blockedBy, 'b');
        assert.deepEqual(report.started, [1]);
        assert.deepEqual(report.skipped, [2]);
        assert.deepEqual(h.clock.calls, []);
    });

    test('two pauses at one position are two waits and no empty batch', async () => {
        const h = harness();
        const running = h.run(2, [barrier(1, 'a', 1, [0]), barrier(1, 'a', 2, [0])]);
        const first = await h.clock.next();
        assert.equal(first.ms, 1000);
        first.release();
        const second = await h.clock.next();
        assert.equal(second.ms, 2000);
        assert.deepEqual(h.attempted, [0]);
        second.release();
        await running;
        assert.deepEqual(h.batches, [[0, 1], [1, 2]]);
    });

    test('aborted before the start: everything skipped, nothing launched', async () => {
        const h = harness();
        h.controller.abort();
        const report = await h.run(3, INFRA);
        assert.deepEqual(report, { started: [], failed: [], skipped: [0, 1, 2], cancelled: true });
        assert.deepEqual(h.batches, []);
    });

    test('aborted before the start with no barriers launches nothing either', async () => {
        const h = harness();
        h.controller.abort();
        assert.deepEqual((await h.run(2, [])).skipped, [0, 1]);
        assert.deepEqual(h.batches, []);
    });

    test('aborted during the wait: the rest never launches, whatever a late release does', async () => {
        const h = harness();
        const running = h.run(3, INFRA);
        const pending = await h.clock.next();
        h.controller.abort();
        pending.release();
        const report = await running;
        assert.deepEqual(report, { started: [0], failed: [], skipped: [1, 2], cancelled: true });
        assert.deepEqual(h.attempted, [0]);
    });

    test('a wait that completes as Ctrl-C arrives counts as cancelled', async () => {
        const h = harness();
        const running = h.run(3, INFRA);
        const pending = await h.clock.next();
        pending.release();
        h.controller.abort();
        const report = await running;
        assert.equal(report.cancelled, true);
        assert.deepEqual(h.attempted, [0]);
    });

    test('aborted during a batch: what the batch did not attempt is skipped, and no wait begins', async () => {
        const h = harness();
        const report = await runSchedule(3, INFRA, {
            launchBatch: async () => {
                h.controller.abort();
                return { started: [], failed: [] };
            },
            wait: h.clock.wait,
            signal: h.controller.signal,
            log: { info() {} },
        });
        assert.deepEqual(report, { started: [], failed: [], skipped: [0, 1, 2], cancelled: true });
        assert.deepEqual(h.clock.calls, []);
    });

    test('a batch that rejects rejects the run unchanged', async () => {
        const boom = new Error('transport');
        await assert.rejects(
            runSchedule(2, [], { launchBatch: async () => { throw boom; }, log: { info() {} } }),
            (err) => err === boom,
        );
    });

    test('a wait that fails for any other reason rejects unchanged', async () => {
        const boom = new Error('clock broke');
        await assert.rejects(
            runSchedule(2, INFRA, {
                launchBatch: async () => ({ started: [0], failed: [] }),
                wait: async () => { throw boom; },
                signal: new AbortController().signal,
                log: { info() {} },
            }),
            (err) => err === boom,
        );
    });

    test('a batch that attempts less than it was given reports the rest as skipped', async () => {
        const report = await runSchedule(3, [], {
            launchBatch: async () => ({ started: [0], failed: [] }),
            log: { info() {} },
        });
        assert.deepEqual(report.skipped, [1, 2]);
    });
});

describe('waitForDelay', () => {
    test('an abort ends a day-long wait at once, and leaves no listener', async () => {
        const controller = new AbortController();
        const waiting = waitForDelay(86_400_000, { signal: controller.signal });
        assert.ok(getEventListeners(controller.signal, 'abort').length > 0);
        controller.abort();
        await assert.rejects(waiting, { name: 'AbortError' });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });

    test('a finished wait leaves no listener', async () => {
        const controller = new AbortController();
        await waitForDelay(1, { signal: controller.signal });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});
