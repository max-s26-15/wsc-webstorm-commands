/**
 * Ctrl-C as an AbortSignal, for a launch whose tabs outlive `wsc`.
 *
 * It only turns the signal into an abort: what is already open stays open. A path that owns its
 * children (the single-tab pool) has its own handler, and does not use this.
 *
 * Installed only for a run with a pause in it. Without one, Ctrl-C keeps its usual meaning.
 * The handler goes after the first Ctrl-C: an abort cannot interrupt a launch call already in
 * flight, so a second one has to be able to end the process if the IDE is not answering.
 */

/**
 * @param {{ on: Function, off: Function }} [proc]
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
export function createInterruptScope(proc = process) {
    const controller = new AbortController();
    const onInterrupt = () => {
        proc.off('SIGINT', onInterrupt);
        controller.abort();
    };
    proc.on('SIGINT', onInterrupt);
    return {
        signal: controller.signal,
        // off() of a handler no longer there is a no-op, so this can run twice.
        dispose: () => proc.off('SIGINT', onInterrupt),
    };
}
