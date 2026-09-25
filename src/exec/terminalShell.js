/**
 * Whether this machine's IDE terminal can run the command lines wsc types into it.
 *
 * Every command wsc builds for a Terminal tab is POSIX shell: the NODE_OPTIONS expansion of
 * debugEnvPrefix(), `cd 'dir' && npm run …`, the .nvmrc PATH= prefix, shellQuote()'s single
 * quotes, the `&&` of custom commands. WebStorm's terminal on Windows is PowerShell unless
 * the user changed it, and the MCP API does not say which shell it runs — so on win32 a plan
 * that needs one is refused before its first call (same atomicity as buildExecutionPlan),
 * unless the user states, with WSC_POSIX_TERMINAL=1, that they set a POSIX shell.
 *
 * The run window and the plugin's debug_run_configuration are unaffected: there the IDE
 * builds the command line itself.
 */
import { TERMINAL_TAB_TOOL, TERMINAL_TOOL } from '../mcp/execute.js';

/** @typedef {import('./planBuilder.js').McpCall} McpCall */

export const POSIX_TERMINAL_ENV = 'WSC_POSIX_TERMINAL';

const TERMINAL_TOOLS = new Set([TERMINAL_TOOL, TERMINAL_TAB_TOOL]);

/**
 * @param {McpCall[]} calls
 * @returns {McpCall[]}
 */
export function callsNeedingPosixTerminal(calls) {
    return calls.filter((call) => TERMINAL_TOOLS.has(call.tool));
}

/** A plan that needs a POSIX shell in the IDE's terminal, on a platform where that is not a given. */
export class PosixTerminalRequiredError extends Error {
    /** @param {string[]} names */
    constructor(names) {
        const list = names.map((name) => `"${name}"`).join(', ');
        super(
            `cannot launch ${list} on Windows: wsc types a POSIX shell command into the IDE's Terminal ` +
                'for these, and WebStorm\'s terminal on Windows is PowerShell unless you changed it.\n' +
                '  For :debug, install wsc Companion (Settings → Plugins) and the IDE starts the Debug tab itself.\n' +
                '  Otherwise set Git Bash or WSL as the terminal shell (Settings → Tools → Terminal → Shell path)\n' +
                `  and run with ${POSIX_TERMINAL_ENV}=1, or launch these entries with :run.`,
        );
        this.name = 'PosixTerminalRequiredError';
        this.names = names;
    }
}

/**
 * @param {McpCall[]} calls
 * @param {{ platform: string, env: Record<string, string | undefined> }} opts
 * @throws {PosixTerminalRequiredError}
 */
export function assertPosixTerminal(calls, { platform, env }) {
    if (platform !== 'win32' || env[POSIX_TERMINAL_ENV] === '1') return;
    const needing = callsNeedingPosixTerminal(calls);
    if (needing.length > 0) throw new PosixTerminalRequiredError(needing.map((call) => call.name));
}
