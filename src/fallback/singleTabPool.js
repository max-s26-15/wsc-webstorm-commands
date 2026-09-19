/**
 * The last resort: no emulator, so everything runs here, in one output stream.
 *
 * This is the shape the very first version of the plan had for the whole product — a
 * process pool with a coloured prefix per configuration — and it survives as the floor
 * under the fallback: a headless machine, an SSH session, a container. It is strictly
 * worse than tabs (one scrollback for everything, one Ctrl-C for everything), so the CLI
 * says out loud that the tabs were merged before it starts.
 *
 * Unlike the tab path, these processes are *ours*: `wsc` stays in the foreground for as
 * long as they run, and exits when the last one does.
 */
import { spawn as nodeSpawn } from 'node:child_process';

import { CANCELLED_EXIT_CODE } from '../ui/promptCancel.js';
import { SHELL } from './terminalTabs.js';

/**
 * How long a second Ctrl-C waits before SIGKILL.
 *
 * A pool that leaves orphans behind is a real hazard — every child holds a port — so the
 * escalation is not optional. The first Ctrl-C is polite (SIGINT, the same signal the
 * terminal would have sent), the second one is not.
 */
export const KILL_GRACE_MS = 2000;

/**
 * @typedef {import('./terminalTabs.js').TabSpec} TabSpec
 * @typedef {{ tagged: (name: string, line: string) => void, info: Function, warn: Function, error: Function, debug: Function }} PoolLogger
 */

/**
 * Split a stream into whole lines.
 *
 * Buffered rather than written straight through, because a child's stdout arrives in
 * chunks that have nothing to do with line boundaries: without this, two dev servers
 * writing at the same time produce half-lines with a prefix stapled into the middle of
 * them. The remainder is flushed when the stream ends, so a process that dies mid-line
 * still shows its last words.
 *
 * @param {(line: string) => void} onLine
 * @returns {{ push: (chunk: string) => void, flush: () => void }}
 */
export function lineBuffer(onLine) {
    let pending = '';

    return {
        push(chunk) {
            pending += chunk;
            const lines = pending.split('\n');
            // The tail is whatever came after the last newline: an incomplete line.
            pending = lines.pop() ?? '';
            for (const line of lines) onLine(line.replace(/\r$/, ''));
        },
        flush() {
            if (pending !== '') onLine(pending);
            pending = '';
        },
    };
}

/**
 * Run every command as a child process, tagging its output.
 *
 * @param {TabSpec[]} tabs
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {PoolLogger} opts.log
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof nodeSpawn} [opts.spawn] - injected in tests
 * @param {{ on: Function, off: Function, kill?: Function }} [opts.process] - where SIGINT is
 *   listened for, and how a process group is signalled
 * @param {string} [opts.platform]
 * @param {number} [opts.killGraceMs]
 * @returns {Promise<number>} 0 when every child exited 0, 130 on Ctrl-C, 1 otherwise
 */
export async function runSingleTabPool(tabs, opts) {
    const { cwd, log } = opts;
    const spawn = opts.spawn ?? nodeSpawn;
    const proc = opts.process ?? process;
    const platform = opts.platform ?? process.platform;

    /** @type {import('node:child_process').ChildProcess[]} */
    const children = [];
    let interrupted = false;
    let failures = 0;

    /** @param {NodeJS.Signals} signal */
    const stopAll = (signal) => {
        for (const child of children) stopTree(child, signal, proc, platform);
    };

    const onInterrupt = () => {
        if (interrupted) {
            // Second Ctrl-C: stop asking.
            stopAll('SIGKILL');
            return;
        }
        interrupted = true;
        log.warn(`stopping ${children.length} process(es) — press Ctrl-C again to kill them`);

        stopAll('SIGINT');
        setTimeout(() => stopAll('SIGKILL'), opts.killGraceMs ?? KILL_GRACE_MS).unref();
    };

    proc.on('SIGINT', onInterrupt);

    try {
        const runs = tabs.map((tab) => new Promise((resolve) => {
            const child = spawn(SHELL, ['-c', tab.command], {
                cwd,
                env: opts.env ?? process.env,
                // stdin is closed rather than inherited: several children sharing one
                // terminal's input would each read a fraction of whatever is typed.
                stdio: ['ignore', 'pipe', 'pipe'],
                // Each child leads its own process group, so Ctrl-C can take down the whole
                // tree behind it (see stopTree). It also means the terminal no longer
                // delivers Ctrl-C to them itself — the handler below is now the only route,
                // which is the point: signal delivery is identical with or without a tty.
                detached: true,
            });
            children.push(child);

            const buffers = [child.stdout, child.stderr].map((stream) => {
                const buffer = lineBuffer((line) => log.tagged(tab.name, line));
                stream?.setEncoding('utf8');
                stream?.on('data', (chunk) => buffer.push(chunk));
                return buffer;
            });

            child.on('error', (err) => {
                log.error(`${tab.name}: ${err.message}`);
                failures++;
                resolve(undefined);
            });

            // 'close' rather than 'exit': it fires once the pipes are drained, so the last
            // lines of a crashing process are printed before its status line.
            child.on('close', (code, signal) => {
                for (const buffer of buffers) buffer.flush();

                if (signal !== null) log.tagged(tab.name, `stopped by ${signal}`);
                else if (code !== 0) {
                    log.tagged(tab.name, `exited with code ${code}`);
                    failures++;
                } else log.tagged(tab.name, 'exited');

                resolve(undefined);
            });
        }));

        log.info(`running ${tabs.length} configuration(s) in this terminal — Ctrl-C stops all of them`);
        await Promise.all(runs);

        if (interrupted) return CANCELLED_EXIT_CODE;
        return failures === 0 ? 0 : 1;
    } finally {
        proc.off('SIGINT', onInterrupt);
    }
}

/**
 * Signal a child *and everything it started*.
 *
 * Killing only the direct child is not enough, and the failure mode is worse than an
 * orphan: `bash -c "npm run dev"` becomes bash → npm → sh → the actual server, and the
 * grandchildren inherit the pipes. Kill the child alone and the server keeps the pipe
 * open, so 'close' never fires and the pool hangs forever with the very processes it was
 * asked to stop still running. Found exactly that way — a live Ctrl-C that never returned.
 *
 * A negative pid is the POSIX way to address the whole process group, which is what
 * `detached: true` gave each child. Windows has no such thing, and neither does an already
 * dead child (ESRCH), so both fall back to signalling the child on its own.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @param {{ kill?: Function }} proc
 * @param {string} platform
 * @returns {void}
 */
function stopTree(child, signal, proc, platform) {
    if (child.pid !== undefined && platform !== 'win32' && proc.kill) {
        try {
            proc.kill(-child.pid, signal);
            return;
        } catch {
            // Already gone, or not ours to signal — fall through to the child itself.
        }
    }
    child.kill(signal);
}
