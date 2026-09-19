/**
 * "Can a debugger still bind this port?" — the one impure half of the debug path.
 *
 * Kept out of src/exec/planBuilder.js, which is pure by contract: the port *assignment*
 * is a decision (deterministic, unit-testable), while asking the operating system what
 * is already listening is a side effect.
 *
 * The check is a real bind on the same host:port the launched process will use, not a
 * connect: a connect only notices a peer that accepts, while a bind reproduces exactly
 * the EADDRINUSE that Node's inspector would hit ("Starting inspector on 127.0.0.1:9229
 * failed: address already in use"), including a listener bound to 0.0.0.0.
 *
 * It is inherently best-effort — the port is released again the moment the check ends,
 * and the process only starts seconds later inside the IDE — so callers warn on the
 * result, never refuse to launch on it.
 */
import net from 'node:net';

import { DEBUG_HOST } from './planBuilder.js';

/** Long enough for a loopback bind, short enough never to be felt before a launch. */
export const DEFAULT_BIND_TIMEOUT_MS = 300;

/**
 * @param {number} port
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>} true when nothing is holding the port right now
 */
export function isPortFree(port, opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_BIND_TIMEOUT_MS;

    return new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        /** @param {boolean} free */
        const finish = (free) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.close(() => resolve(free));
        };

        // A bind that neither succeeds nor fails (an exotic filesystem-backed namespace,
        // a hung kernel path) must not hold a launch up; unknown counts as usable.
        const timer = setTimeout(() => finish(true), timeoutMs);

        server.once('error', () => finish(false));
        server.once('listening', () => finish(true));

        // `exclusive` so the answer is not softened by SO_REUSEPORT-style sharing between
        // Node processes: the inspector does not share either.
        server.listen({ host, port, exclusive: true });
    });
}

/**
 * @param {number[]} ports
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<number[]>} the subset that is already taken, in the order given
 */
export async function findBusyPorts(ports, opts = {}) {
    const checked = await Promise.all(ports.map(async (port) => ({ port, free: await isPortFree(port, opts) })));
    return checked.filter(({ free }) => !free).map(({ port }) => port);
}

/**
 * Warn about inspector ports something else is already holding.
 *
 * A warning rather than a refusal, and never a reassignment: the check is a snapshot (the
 * port is released again immediately, and the process only starts a moment later), and
 * silently shifting to another port would make the number printed here differ from run to
 * run — which is precisely what makes it useless for attaching. Node would report this
 * itself, but only inside the terminal tab and only after the plan has been printed, where
 * it reads like the launch worked.
 *
 * Lives here rather than in src/cli.js because both launch paths need it and neither may
 * own the wording: the IDE path (src/cli.js) and the terminal fallback
 * (src/fallback/terminalFallback.js) hand out the same ports from the same --debug-port,
 * so a user who sees the warning on one must see the identical one on the other.
 *
 * @param {number[]} ports
 * @param {{ warn: (...a: any[]) => void }} log
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {typeof findBusyPorts} [opts.findBusyPorts] - injected in tests, so none binds a socket
 * @returns {Promise<void>}
 */
export async function warnBusyDebugPorts(ports, log, opts = {}) {
    if (ports.length === 0) return;

    const host = opts.host ?? DEBUG_HOST;
    const busy = await (opts.findBusyPorts ?? findBusyPorts)(ports, { host });
    if (busy.length === 0) return;

    log.warn(
        `inspector port ${busy.join(', ')} already in use on ${host} — that debugger will not start\n` +
            '  ("address already in use"). Stop what is listening there, or move the range with --debug-port.',
    );
}
