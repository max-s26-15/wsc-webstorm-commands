/**
 * A wait that only ends when a test says so, so nothing here depends on real time.
 *
 * Behaves as `node:timers/promises` does towards its signal: an abort rejects with an
 * AbortError, and no listener is left on the signal once the wait has settled. Releasing a wait
 * that was already aborted is harmless, which is what lets a test race the two.
 *
 * @typedef {{ ms: number, release: () => void }} PendingWait
 * @returns {{
 *   wait: import('../src/exec/runSchedule.js').Wait,
 *   calls: number[],
 *   next: () => Promise<PendingWait>,
 * }}
 */
export function createControlledWait() {
    /** @type {number[]} */
    const calls = [];
    /** @type {PendingWait[]} */
    const started = [];
    /** @type {Array<(pending: PendingWait) => void>} */
    const waiting = [];

    /** @param {PendingWait} pending */
    const announce = (pending) => {
        const taker = waiting.shift();
        if (taker) taker(pending);
        else started.push(pending);
    };

    return {
        calls,
        next: () => new Promise((resolve) => {
            const pending = started.shift();
            if (pending) resolve(pending);
            else waiting.push(resolve);
        }),
        wait: (ms, { signal } = {}) => new Promise((resolve, reject) => {
            calls.push(ms);
            const abort = () => {
                signal?.removeEventListener('abort', abort);
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort);
            announce({
                ms,
                release: () => {
                    signal?.removeEventListener('abort', abort);
                    resolve();
                },
            });
        }),
    };
}
