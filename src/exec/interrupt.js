/**
 * Ctrl-C as an AbortSignal, for a launch whose tabs outlive `wsc`.
 *
 * It only turns the signal into an abort: what is already open stays open. A path that owns its
 * children (the single-tab pool) has its own handler, and does not use this.
 */

/**
 * @param {{ on: Function, off: Function }} [proc]
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
export function createInterruptScope(proc = process) {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    proc.on('SIGINT', onInterrupt);
    return {
        signal: controller.signal,
        // off() of a handler no longer there is a no-op, so this can run twice.
        dispose: () => proc.off('SIGINT', onInterrupt),
    };
}
