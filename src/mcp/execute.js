/**
 * The two IDE tools that actually start something, plus the runner that walks an
 * execution plan through them.
 *
 * Split from src/exec/planBuilder.js on purpose: *which* tool an entry needs is a
 * policy decision (target, mode) and belongs to the exec layer, while the tool names
 * and the argument shapes they expect are protocol details and belong next to
 * src/mcp/client.js. Nothing here decides anything — it only builds calls and issues
 * them.
 */
import { McpToolError } from './client.js';

/** Opens (or reuses) a native Run/Debug tab named after the configuration. */
export const RUN_CONFIGURATION_TOOL = 'execute_run_configuration';

/**
 * Starts a configuration with the Debug executor — a real Debug tab, exactly as the Debug
 * button does. Not part of the IDE: it comes from the optional wsc IDE plugin (ide-plugin/),
 * so it is only used when the session's tool list actually has it.
 */
export const DEBUG_CONFIGURATION_TOOL = 'debug_run_configuration';

/**
 * With reuseExistingTerminalWindow:false, one fresh Terminal tab per call — but not a real
 * terminal. Measured on WebStorm 2026.2.3: the command's stdin, stdout and stderr are pipes
 * (`[ -t 1 ]` is false, `TERM` is empty), so a program that draws its own screen (ngrok, top,
 * a progress bar) shows nothing, and Ctrl-C in the tab never reaches it. See TERMINAL_TAB_TOOL.
 */
export const TERMINAL_TOOL = 'execute_terminal_command';

/**
 * Opens a titled Terminal tab running the user's shell on a real terminal and types the
 * command into it — the tab the "+" button gives. From the optional wsc IDE plugin
 * (ide-plugin/), like DEBUG_CONFIGURATION_TOOL, so it is only used when the session lists it.
 */
export const TERMINAL_TAB_TOOL = 'open_terminal_tab';

/**
 * How long a terminal launch is given before the CLI moves on.
 *
 * Measured against WebStorm 2026.2.1: execute_terminal_command's own `timeout` argument
 * is **not** an upper bound — `sleep 8` with `timeout: 1500` came back after 8017ms, and
 * `sleep 1` after 1014ms. The call simply waits for the command to exit. So the bound
 * has to be applied client-side, and it is safe to do so: a command still running when
 * the call is abandoned keeps running (verified — a file touched six seconds after a
 * two-second client timeout still appeared). The argument is sent anyway, for IDE builds
 * that do honour it.
 *
 * The plan is issued sequentially (see runExecutionPlan), so a run pays this once per
 * terminal tab. Short enough to stay out of the way, long enough that an immediate crash
 * (missing script, wrong directory) still lands in the output while it can be reported.
 */
export const TERMINAL_TIMEOUT_MS = 1_500;

/** Output snapshot size. Only ever used to explain a failure, never printed wholesale. */
export const TERMINAL_MAX_LINES = 40;

/** JSON-RPC code the SDK uses for a request that outlived its timeout. */
const REQUEST_TIMEOUT_CODE = -32001;

/**
 * @typedef {import('./client.js').McpClient} McpClient
 * @typedef {{ tool: string, arguments: Record<string, unknown>, timeoutMs?: number }} ToolCall
 */

/**
 * Launch a configuration in the IDE's Run tool window.
 *
 * `waitForExit: false` is not a tuning knob — it is the feature. The point of `wsc` is
 * several tabs running *at once*; waiting for exit would serialise them and leave the
 * CLI hanging on the first long-lived dev server. With it false the IDE returns as soon
 * as the process has started and `timeout` is ignored entirely, so it is not sent.
 *
 * projectPath is deliberately absent: createMcpClient() injects it into every call.
 *
 * @param {string} configurationName - exactly as get_run_configurations reported it
 * @returns {ToolCall}
 */
export function runConfigurationCall(configurationName) {
    return {
        tool: RUN_CONFIGURATION_TOOL,
        arguments: { configurationName, waitForExit: false },
    };
}

/**
 * Debug a configuration in the IDE's own Debug tool window (needs the wsc IDE plugin).
 *
 * Nothing about ports or commands: the IDE starts the process itself and attaches its own
 * debugger, including to the child processes an npm script spawns — which is what the
 * `--inspect-brk` reroute through the Terminal cannot do. Like runConfigurationCall(), it
 * returns as soon as the tab is up rather than waiting for the process to exit.
 *
 * @param {string} configurationName - exactly as get_run_configurations reported it
 * @returns {ToolCall}
 */
export function debugConfigurationCall(configurationName) {
    return {
        tool: DEBUG_CONFIGURATION_TOOL,
        arguments: { configurationName },
    };
}

/**
 * Run a shell command in a real Terminal tab, through the wsc IDE plugin.
 *
 * The title is an argument here, so no session has to be opened under the tab's name (the
 * trick TERMINAL_TOOL needs), and there are no bounds to send: the plugin answers as soon as
 * the command has been typed in, never waiting for it to finish.
 *
 * @param {string} tabName
 * @param {string} command
 * @returns {ToolCall}
 */
export function terminalTabCall(tabName, command) {
    return {
        tool: TERMINAL_TAB_TOOL,
        arguments: { tabName, command },
    };
}

/**
 * Run a shell command in a new tab of the IDE's Terminal tool window.
 *
 * `executeInShell: true` because the commands this CLI builds are shell syntax
 * (`cd … && NODE_OPTIONS=… npm run …`), not a bare argv.
 * `reuseExistingTerminalWindow: false` is what gives one tab per configuration
 * instead of queueing everything into a single terminal.
 *
 * @param {string} command
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxLines]
 * @returns {ToolCall}
 */
export function terminalCommandCall(command, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? TERMINAL_TIMEOUT_MS;

    return {
        tool: TERMINAL_TOOL,
        // Enforced by the caller, because the IDE ignores the argument below.
        timeoutMs,
        arguments: {
            command,
            executeInShell: true,
            reuseExistingTerminalWindow: false,
            timeout: timeoutMs,
            maxLinesCount: opts.maxLines ?? TERMINAL_MAX_LINES,
            // Keep the head of the output: a launch that dies does it at the start.
            truncateMode: 'END',
        },
    };
}

/**
 * @typedef {import('../exec/planBuilder.js').McpCall} McpCall
 * @typedef {{ call: McpCall, reason: string }} LaunchFailure
 * @typedef {{ started: McpCall[], failed: LaunchFailure[] }} ExecutionReport
 */

/**
 * Whether a rejection is "the call outlived its timeout" rather than a real failure.
 *
 * For a terminal launch that is the *expected* outcome of anything long-lived, since
 * execute_terminal_command only answers once the command exits — see TERMINAL_TIMEOUT_MS.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isRequestTimeout(err) {
    return /** @type {any} */ (err)?.code === REQUEST_TIMEOUT_CODE;
}

/**
 * The exit code the IDE reports for a terminal command that already finished.
 *
 * execute_terminal_command answers `{command_exit_code, command_output}` — and a command
 * that failed is still a *successful* tool call, so without this a `npm run` that died
 * with "command not found" would be reported as a launched tab.
 *
 * @param {unknown} result
 * @returns {string | null} a reason when the launch failed, null when it did not
 */
export function launchFailureReason(result) {
    const payload = /** @type {{ command_exit_code?: unknown, command_output?: unknown }} */ (result);
    if (payload === null || typeof payload !== 'object') return null;

    // Object.hasOwn, per the house rule for reads off a payload the CLI did not build.
    // Defensive rather than a live bug — the payload comes from JSON.parse, and
    // Object.prototype carries neither of these keys — but it costs nothing to be exact.
    if (!Object.hasOwn(payload, 'command_exit_code')) return null;

    const code = payload.command_exit_code;
    if (typeof code !== 'number' || code === 0) return null;

    const output = Object.hasOwn(payload, 'command_output') && typeof payload.command_output === 'string'
        ? payload.command_output.trim()
        : '';
    return output === '' ? `exited with code ${code}` : `exited with code ${code}: ${output}`;
}

/**
 * How a started launch is described in the log.
 *
 * A debug launch names its inspector port, because that number is the whole point of the
 * reroute: the process is stopped on the first line waiting for WebStorm's "Attach to
 * Node.js" to connect, and every entry of a run gets its own port (see DEBUG_PORT_BASE),
 * so "the usual 9229" is not an answer the user can rely on.
 *
 * @param {McpCall} call
 * @returns {string}
 */
function describeMode(call) {
    const port = call.debugPort === undefined ? '' : `, attach to port ${call.debugPort}`;
    return ` (${call.mode}${port})`;
}

/**
 * Issue every call of an execution plan.
 *
 * **Sequential, not concurrent.** Tabs then appear in the order the CLI just printed,
 * which is the whole reason the plan is shown first; concurrent calls would order them
 * by whatever the IDE's UI thread got to first. It also costs almost nothing on the
 * main path — `waitForExit: false` returns as soon as the process starts — and only the
 * terminal path pays TERMINAL_TIMEOUT_MS per tab.
 *
 * **Not atomic, unlike plan building.** By the time the first call goes out the user has
 * already been told what will start, so aborting the rest on the first failure would
 * leave a half-launched project with no explanation. Instead every configuration is
 * attempted, each failure is reported as it happens, and the caller gets both lists to
 * summarise. Anything that is *not* a per-tool failure (a dead transport, a protocol
 * error) is rethrown: the remaining calls would fail identically, each only after the
 * full call timeout — but not before saying what did start, so that is not lost.
 *
 * @param {McpCall[]} calls - from buildExecutionPlan()
 * @param {object} opts
 * @param {McpClient} opts.client
 * @param {(name: string) => Promise<McpClient>} [opts.connectAs] - opens a session that
 *   calls itself `name`. A call with a `tabName` is made over one of these, because the IDE
 *   titles a Terminal tab after the MCP client that opened it and offers no other way to
 *   name it. Without it every call shares `client`, and the tabs are all titled "wsc".
 * @param {{ info: (...a: any[]) => void, error: (...a: any[]) => void, warn: (...a: any[]) => void, debug: (...a: any[]) => void }} [opts.log]
 * @returns {Promise<ExecutionReport>}
 */
export async function runExecutionPlan(calls, opts) {
    const { client } = opts;
    const log = opts.log ?? { info() {}, error() {}, warn() {}, debug() {} };

    /** @type {McpCall[]} */
    const started = [];
    /** @type {LaunchFailure[]} */
    const failed = [];
    /** Shared by every sessionFor() of this run, so a refusal is learned once. */
    const naming = { unavailable: false };

    for (const call of calls) {
        // Opened per tab and closed straight after: the command keeps running once the
        // session is gone (measured — a file touched eight seconds after the session was
        // closed still appeared), and only the name matters.
        const session = await sessionFor(call, opts, log, naming);
        try {
            const result = await session.callTool(call.tool, call.arguments, { timeoutMs: call.timeoutMs });
            log.debug(`${call.tool} → ${typeof result === 'string' ? result : JSON.stringify(result)}`);

            const reason = launchFailureReason(result);
            if (reason !== null) {
                failed.push({ call, reason });
                log.error(`${call.name}: ${reason}`);
                continue;
            }

            started.push(call);
            log.info(`started ${call.name}${describeMode(call)}`);
        } catch (err) {
            // A bounded call that ran out of time means the command is still going, which
            // for a dev server is success — the tab is open and the process is alive.
            if (isRequestTimeout(err) && call.timeoutMs !== undefined) {
                started.push(call);
                log.info(`started ${call.name}${describeMode(call)} — still running`);
                continue;
            }
            // Matched by name, not by instanceof, for the same reason KNOWN_ERRORS in
            // src/cli.js does: it is the exact class that means "the IDE rejected *this*
            // configuration". Its subclass AmbiguousProjectError deliberately falls
            // through to the abort below — a project the IDE cannot identify is not a
            // property of one entry, and every remaining call would repeat it verbatim.
            const toolError = /** @type {McpToolError} */ (err);
            if (!(err instanceof Error) || err.name !== 'McpToolError') {
                if (started.length > 0) {
                    log.warn(`already started: ${started.map((c) => c.name).join(', ')}`);
                }
                throw err;
            }
            failed.push({ call, reason: toolError.detail });
            log.error(`${call.name}: ${toolError.detail}`);
        } finally {
            // `await` on the call above is inside this try, so this never runs while it is
            // still in flight — the trap withMcpSession() in src/cli.js documents.
            if (session !== client) await session.close().catch(() => {});
        }
    }

    return { started, failed };
}

/**
 * The session one call is made over: its own, named after the tab, or the shared one.
 *
 * A failure to open a named session is not a failure to launch. The name is a nicety and
 * the command is the point, so the call falls back to the shared session — and says the
 * tab will carry the wrong title, rather than doing it silently.
 *
 * The first failure is remembered in `naming`: an IDE that would not open one session will
 * not open the next either, and asking again costs a connect timeout per tab (up to ten
 * seconds each) plus one identical warning per tab. Later tabs go straight to the shared
 * session and the run says so once.
 *
 * @param {McpCall} call
 * @param {{ client: McpClient, connectAs?: (name: string) => Promise<McpClient> }} opts
 * @param {{ warn: (...a: any[]) => void }} log
 * @param {{ unavailable: boolean }} naming - per-run state, owned by runExecutionPlan()
 * @returns {Promise<McpClient>}
 */
async function sessionFor(call, opts, log, naming) {
    if (call.tabName === undefined || opts.connectAs === undefined || naming.unavailable) return opts.client;
    try {
        return await opts.connectAs(call.tabName);
    } catch (err) {
        naming.unavailable = true;
        const why = err instanceof Error ? err.message : String(err);
        log.warn(`could not open a session named "${call.tabName}" (${why}); its tab will be titled "wsc", and so will every later one`);
        return opts.client;
    }
}
