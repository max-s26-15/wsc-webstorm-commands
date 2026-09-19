/**
 * MCP port discovery.
 *
 * The IDE never writes its MCP port to disk (verified: mcpServer.xml stores only
 * enableMcpServer / enableBraveMode), so an explicit port is the primary path:
 * phase 0 pins it with -Didea.mcp.server.force.port and the user passes it via
 * WSC_MCP_PORT or --mcp-port. Range scanning stays a best-effort last resort —
 * the real port on this machine is 64542, well outside the "usual" 64342+ range,
 * so a scan is a lottery, not a strategy.
 */

/**
 * A port that was given explicitly but is not a port at all.
 *
 * Typed rather than a bare Error so callers can tell "you typed it wrong" (a usage
 * error the user fixes on the command line) from "the IDE is unreachable".
 */
export class InvalidPortError extends Error {
    /**
     * @param {string} source - "--mcp-port" or "WSC_MCP_PORT"
     * @param {unknown} value
     */
    constructor(source, value) {
        super(`${source}: ${JSON.stringify(String(value))} is not a valid port (expected 1-65535)`);
        this.name = 'InvalidPortError';
        this.source = source;
        this.value = value;
    }
}

/** Best-effort scan window. Deliberately narrow: a wide scan is slow and still unreliable. */
export const DEFAULT_FALLBACK_RANGE = /** @type {[number, number]} */ ([64342, 64562]);

/** How long a single port probe may take before it is treated as dead. */
export const DEFAULT_PROBE_TIMEOUT_MS = 700;

/** Ports probed at the same time during a fallback scan. */
const SCAN_CONCURRENCY = 32;

/**
 * @param {unknown} value
 * @returns {number | null} a valid TCP port, or null if the value is not one
 */
export function parsePort(value) {
    if (value === undefined || value === null || value === '') return null;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
}

/**
 * Check whether an MCP Server is listening on a port.
 *
 * The probe hits /sse and only inspects the response headers: a live MCP Server
 * answers 200 with `text/event-stream`. This rules out unrelated local servers
 * (the WebStorm built-in web server on 63342 answers text/html, for example).
 * The body is cancelled immediately — /sse is a stream that would never end.
 *
 * @param {number} port
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch] - injectable for tests
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function probePort(port, opts = {}) {
    const doFetch = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await doFetch(`http://127.0.0.1:${port}/sse`, {
            method: 'GET',
            headers: { accept: 'text/event-stream' },
            signal: controller.signal,
        });

        // We only needed the headers; releasing the body closes the connection.
        res.body?.cancel().catch(() => {});

        return res.ok && (res.headers.get('content-type') ?? '').includes('text/event-stream');
    } catch {
        // Connection refused, timeout, DNS — all mean "nothing usable here".
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve the port the MCP Server is reachable on.
 *
 * Order: explicitPort → WSC_MCP_PORT → best-effort scan (only when nothing explicit
 * was given). An explicit port that does not answer returns null rather than falling
 * through to a scan: silently connecting to some other IDE window would be worse than
 * telling the user their pinned port is down.
 *
 * @param {object} [opts]
 * @param {number | string} [opts.explicitPort] - from --mcp-port
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {[number, number] | null} [opts.fallbackRange] - null disables the scan
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs]
 * @param {{ debug: (...args: any[]) => void }} [opts.log]
 * @returns {Promise<number | null>} the live port, or null if none was found
 */
export async function discoverPort(opts = {}) {
    const env = opts.env ?? process.env;
    const log = opts.log ?? { debug: () => {} };
    const probeOpts = { fetch: opts.fetch, timeoutMs: opts.timeoutMs };

    const explicit = opts.explicitPort ?? env.WSC_MCP_PORT;
    if (explicit !== undefined && explicit !== null && explicit !== '') {
        const source = opts.explicitPort !== undefined ? '--mcp-port' : 'WSC_MCP_PORT';
        const port = parsePort(explicit);
        if (port === null) {
            throw new InvalidPortError(source, explicit);
        }

        log.debug(`probing MCP port ${port} from ${source}`);
        const alive = await probePort(port, probeOpts);
        log.debug(alive ? `MCP Server answered on ${port}` : `no MCP Server on ${port}`);
        return alive ? port : null;
    }

    const range = opts.fallbackRange === undefined ? DEFAULT_FALLBACK_RANGE : opts.fallbackRange;
    if (!range) return null;

    log.debug(`no explicit port; scanning ${range[0]}-${range[1]} (best effort)`);
    return scanRange(range, probeOpts, log);
}

/**
 * Probe a port range in batches and return the first responder.
 *
 * @param {[number, number]} range
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} probeOpts
 * @param {{ debug: (...args: any[]) => void }} log
 * @returns {Promise<number | null>}
 */
async function scanRange([start, end], probeOpts, log) {
    for (let base = start; base <= end; base += SCAN_CONCURRENCY) {
        const batch = [];
        for (let port = base; port <= Math.min(base + SCAN_CONCURRENCY - 1, end); port++) {
            batch.push(probePort(port, probeOpts).then((alive) => (alive ? port : null)));
        }

        const found = (await Promise.all(batch)).find((port) => port !== null);
        if (found !== undefined) {
            log.debug(`scan found MCP Server on ${found}`);
            return found;
        }
    }

    log.debug('scan found no MCP Server');
    return null;
}
