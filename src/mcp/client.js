/**
 * MCP client: a thin, testable wrapper around @modelcontextprotocol/sdk.
 *
 * The SDK plumbing lives in connectMcp(); everything the CLI actually depends on
 * (projectPath injection, error detection, payload unwrapping) is pure logic that
 * works against any object exposing callTool/close, so it is unit-tested without
 * a running IDE.
 */

/** Verified against WebStorm 2026.2: the Streamable HTTP endpoint is /stream. */
export const MCP_PATH = '/stream';

/** Default per-call timeout. Launches use waitForExit:false, so calls return fast. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Timeout for the initialize handshake. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Identity reported to the IDE during the handshake. */
const CLIENT_INFO = { name: 'wsc', version: '1.0.0' };

/**
 * A tool call that the IDE itself rejected.
 *
 * The MCP protocol reports tool failures as a *successful* response carrying
 * `isError: true`, so without this the CLI would happily treat "Unable to
 * determine the target project" as a valid result.
 */
export class McpToolError extends Error {
    /**
     * @param {string} tool
     * @param {string} detail
     */
    constructor(tool, detail) {
        super(`MCP tool "${tool}" failed: ${detail}`);
        this.name = 'McpToolError';
        this.tool = tool;
        this.detail = detail;
    }
}

/** The IDE could not tell which of the open projects a call was meant for. */
export class AmbiguousProjectError extends McpToolError {
    /**
     * @param {string} tool
     * @param {string} detail
     * @param {string[]} projects
     */
    constructor(tool, detail, projects) {
        super(tool, detail);
        this.name = 'AmbiguousProjectError';
        this.projects = projects;
    }
}

/**
 * The MCP session could not be opened at all.
 *
 * Distinct from every error above, which are about one *tool call*: this is the transport
 * and the `initialize` handshake, and it is reachable in ordinary use even though
 * discoverPort() has just probed the port successfully. Two ways in, both seen:
 *   - the IDE quit between the probe and the connect (the probe is a separate request);
 *   - the port belongs to something else that answers /sse with `text/event-stream` but is
 *     not an MCP Server, which the best-effort range scan can hand back.
 *
 * Typed, rather than left as the SDK's own StreamableHTTPError (whose `name` is the bare
 * "Error"), because an error class the CLI can surface and that is not in KNOWN_ERRORS
 * reaches the user as a V8 stack trace through node_modules — verified by running a
 * launch against a plain HTTP server on a probe-passing port.
 */
export class McpConnectError extends Error {
    /**
     * @param {URL} url
     * @param {unknown} cause
     */
    constructor(url, cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(
            `could not open an MCP session on ${url.host} (${detail}).\n` +
                '  The port answered a probe, so something is listening there — but it did not\n' +
                '  complete the MCP handshake. Check that WebStorm is still running with its MCP\n' +
                '  Server enabled, and that --mcp-port / WSC_MCP_PORT names its port.',
        );
        this.name = 'McpConnectError';
        this.url = String(url);
        this.cause = cause;
    }
}

/**
 * Extract the open project paths the IDE lists when a call is ambiguous.
 *
 * The paths are embedded in the error text as a JSON blob, which is the only
 * place the IDE exposes them — there is no dedicated tool for it.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseOpenProjects(text) {
    const match = /\{"projects":\s*\[.*?]}/s.exec(text);
    if (!match) return [];

    try {
        const parsed = JSON.parse(match[0]);
        return parsed.projects.map((/** @type {{ path: string }} */ p) => p.path).filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Turn a raw MCP tool result into a plain value.
 *
 * Tools answer with text parts; most IDE tools put JSON in them, but some
 * (execute_terminal_command) return plain console output — so the string is
 * returned as-is when it does not parse.
 *
 * @param {string} tool - only used to build error messages
 * @param {any} result - raw CallToolResult
 * @returns {unknown}
 * @throws {McpToolError} when the IDE reported a failure
 */
export function unwrapToolResult(tool, result) {
    const text = (result?.content ?? [])
        .filter((/** @type {{ type: string }} */ part) => part.type === 'text')
        .map((/** @type {{ text: string }} */ part) => part.text)
        .join('\n');

    if (result?.isError) {
        const projects = parseOpenProjects(text);
        const detail = text || 'no details returned';
        throw projects.length > 0
            ? new AmbiguousProjectError(tool, detail, projects)
            : new McpToolError(tool, detail);
    }

    // Newer servers may answer with a structured payload; prefer it when present.
    if (result?.structuredContent !== undefined) return result.structuredContent;
    if (text === '') return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Wrap an MCP session (real SDK client or a test double) in the interface the CLI uses.
 *
 * Session methods are declared with shorthand syntax (`callTool(...)`, not
 * `callTool: (...) =>`) on purpose: it makes TypeScript check this shape
 * bivariantly, the same way it checks interface methods. The real SDK
 * `Client#callTool` overload set is far more specific (zod schemas, `_meta`,
 * task options) than anything this file needs, so a strict/contravariant
 * check here would fail against the real client for reasons unrelated to
 * this module's actual contract.
 *
 * @param {{
 *   callTool(req: { name: string, arguments?: Record<string, unknown> }, schema?: unknown, opts?: object): Promise<any>,
 *   close(): Promise<void>,
 *   listTools?(): Promise<any>,
 * }} session
 * @param {object} [opts]
 * @param {string} [opts.projectPath] - injected into every call; the IDE needs it whenever more than one project is open
 * @param {number} [opts.timeoutMs]
 * @param {{ debug: (...args: any[]) => void }} [opts.log]
 */
export function createMcpClient(session, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const log = opts.log ?? { debug: () => {} };

    return {
        projectPath: opts.projectPath,

        /**
         * @param {string} name
         * @param {Record<string, unknown>} [args]
         * @param {object} [callOpts]
         * @param {number} [callOpts.timeoutMs] - overrides the session default for this call
         * @returns {Promise<unknown>}
         */
        async callTool(name, args = {}, callOpts = {}) {
            // An explicit projectPath in args always wins over the session default.
            const withProject =
                opts.projectPath !== undefined && /** @type {any} */ (args).projectPath === undefined
                    ? { ...args, projectPath: opts.projectPath }
                    : args;

            log.debug(`mcp call ${name} ${JSON.stringify(withProject)}`);
            const result = await session.callTool(
                { name, arguments: withProject },
                undefined,
                { timeout: callOpts.timeoutMs ?? timeoutMs },
            );
            return unwrapToolResult(name, result);
        },

        /** Diagnostics only — used by scripts/mcp-probe.js. */
        async listTools() {
            if (!session.listTools) return [];
            const result = await session.listTools();
            return result.tools ?? [];
        },

        close: () => session.close(),
    };
}

/** @typedef {ReturnType<typeof createMcpClient>} McpClient */

/**
 * Connect to the IDE's MCP Server.
 *
 * @param {number} port - from discoverPort()
 * @param {object} [opts]
 * @param {string} [opts.projectPath]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.connectTimeoutMs]
 * @param {{ debug: (...args: any[]) => void }} [opts.log]
 * @returns {Promise<McpClient>}
 */
export async function connectMcp(port, opts = {}) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );

    const url = new URL(`http://127.0.0.1:${port}${MCP_PATH}`);
    const session = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(url);

    // connect() performs the initialize handshake; without a guard a half-open
    // socket would hang the CLI with no output at all.
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let timer;
    try {
        await Promise.race([
            session.connect(transport),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`MCP handshake timed out after ${connectTimeoutMs}ms on ${url}`)),
                    connectTimeoutMs,
                );
            }),
        ]);
    } catch (err) {
        await session.close().catch(() => {});
        throw new McpConnectError(url, err);
    } finally {
        clearTimeout(timer);
    }

    opts.log?.debug(`connected to MCP Server on ${url}`);
    return createMcpClient(session, opts);
}
