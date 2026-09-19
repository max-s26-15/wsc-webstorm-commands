/**
 * A stand-in for child_process.spawn().
 *
 * The phase-8 plan is explicit that the terminal adapters are unit-tested "without a real
 * spawn", and the reason goes beyond speed: the tests assert the exact argv handed to an
 * emulator, on every platform, on a machine that has at most one of them installed. A fake
 * lets a Linux CI check the `wt` command line, and stops a passing test suite from leaving
 * a dozen terminal windows open on the developer's desktop.
 *
 * Lives in test-utils/ rather than test/, like every other shared fake: `node --test`
 * treats each .js file under test/ as a test file.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** A child process that never was. */
export class FakeChild extends EventEmitter {
    /** @param {{ pipes?: boolean }} [opts] */
    constructor(opts = {}) {
        super();
        this.stdout = opts.pipes ? new PassThrough() : null;
        this.stderr = opts.pipes ? new PassThrough() : null;
        /** Every signal kill() was asked for, in order. */
        this.killed = /** @type {string[]} */ ([]);
        this.unrefs = 0;
    }

    /** @param {string} [signal] */
    kill(signal = 'SIGTERM') {
        this.killed.push(signal);
        return true;
    }

    unref() {
        this.unrefs++;
    }

    /**
     * @param {'stdout' | 'stderr'} stream
     * @param {string} text
     */
    say(stream, text) {
        this[stream]?.write(text);
    }

    /**
     * Finish the process. 'close' rather than 'exit', after a turn of the loop, so buffered
     * output is delivered first — which is the ordering the real thing guarantees and the
     * pool depends on.
     *
     * @param {number | null} code
     * @param {string | null} [signal]
     */
    finish(code, signal = null) {
        this.stdout?.end();
        this.stderr?.end();
        setImmediate(() => this.emit('close', code, signal));
    }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.pipes] - give the children stdout/stderr streams
 * @param {Error} [opts.failWith] - emit 'error' instead of 'spawn'
 * @param {boolean} [opts.manual] - do not emit anything; the test drives the child
 * @returns {{ spawn: any, calls: { command: string, args: string[], options: any, child: FakeChild }[], children: FakeChild[] }}
 */
export function fakeSpawn(opts = {}) {
    const calls = [];
    const children = [];

    const spawn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
        const child = new FakeChild({ pipes: opts.pipes });
        calls.push({ command, args, options, child });
        children.push(child);

        if (!opts.manual) {
            // Asynchronously, exactly like the real events: code that attaches a listener
            // right after spawn() must still see them.
            setImmediate(() => (opts.failWith ? child.emit('error', opts.failWith) : child.emit('spawn')));
        }
        return child;
    };

    return { spawn, calls, children };
}

/**
 * A stand-in for `process`: where a SIGINT handler is installed, and how a process group
 * is signalled.
 *
 * @param {{ killThrows?: Error }} [opts] - make kill() fail, as it does for a process that
 *   has already exited (ESRCH)
 * @returns {{
 *   on: Function, off: Function, kill: Function,
 *   emit: (signal?: string) => void, handlers: Function[], signalled: [number, string][],
 * }}
 */
export function fakeSignals(opts = {}) {
    const handlers = /** @type {Function[]} */ ([]);
    /** Every (pid, signal) pair kill() was called with; a negative pid is a group. */
    const signalled = /** @type {[number, string][]} */ ([]);

    return {
        handlers,
        signalled,
        on: (/** @type {string} */ _signal, /** @type {Function} */ handler) => handlers.push(handler),
        off: (/** @type {string} */ _signal, /** @type {Function} */ handler) => {
            const at = handlers.indexOf(handler);
            if (at >= 0) handlers.splice(at, 1);
        },
        kill: (/** @type {number} */ pid, /** @type {string} */ signal) => {
            if (opts.killThrows) throw opts.killThrows;
            signalled.push([pid, signal]);
        },
        emit: () => {
            for (const handler of [...handlers]) handler();
        },
    };
}
