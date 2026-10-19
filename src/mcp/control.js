/**
 * The protocol half of `wsc --stop` and `wsc --restart`: the wsc Companion tools that see and
 * stop what is running, and the shape of their answers. Which entry needs which call is policy,
 * and lives in src/control/ — the same split src/mcp/execute.js keeps for a launch.
 */

/** What is running: Run/Debug tabs with a live process, and the Terminal tabs wsc marked. */
export const LIST_RUNNING_TOOL = 'list_running';

/** The Stop button for every live process of a run configuration. */
export const STOP_RUN_TOOL = 'stop_run_configuration';

/** The Rerun button: the same Run or Debug tab, the same executor. */
export const RESTART_RUN_TOOL = 'restart_run_configuration';

/** Ctrl-C in the Terminal tab marked for a preset entry. */
export const STOP_TERMINAL_TOOL = 'stop_terminal_tab';

/** Ctrl-C, then the entry's command typed into the same tab again. */
export const RESTART_TERMINAL_TOOL = 'restart_terminal_tab';

/**
 * @typedef {import('./execute.js').ToolCall} ToolCall
 * @typedef {import('../modes.js').LaunchMode} LaunchMode
 * @typedef {'config' | 'custom'} EntryKind
 * @typedef {{ configurationName: string, mode: 'run' | 'debug' }} RunningRun
 * @typedef {{
 *   entryName: string,
 *   kind: EntryKind,
 *   mode: LaunchMode,
 *   debugPort?: number,
 *   commandRunning: boolean,
 * }} RunningTerminal
 * @typedef {{ runs: RunningRun[], terminals: RunningTerminal[] }} Running
 */

const RUN_MODES = new Set(['run', 'debug']);
const TERMINAL_MODES = new Set(['run', 'debug', 'terminal']);
const KINDS = new Set(['config', 'custom']);

/**
 * `list_running` answered with something this CLI does not understand.
 *
 * A TypeError subclass with a name for KNOWN_ERRORS, for the reason RunConfigPayloadError is
 * one: a bare TypeError reads as a bug in wsc and reaches the user as a stack trace. The likely
 * cause here is a plugin and a CLI from different releases, so it names both ways to look.
 */
export class RunningPayloadError extends TypeError {
    /** @param {string} detail */
    constructor(detail) {
        super(
            `the IDE answered ${LIST_RUNNING_TOOL} with something wsc does not understand: ${detail}.\n` +
                '  wsc Companion and wsc are probably from different releases — update both, or run\n' +
                '  `wsc-mcp-probe` against this IDE to see what it actually returns.',
        );
        this.name = 'RunningPayloadError';
        this.detail = detail;
    }
}

/**
 * Check a `list_running` answer and return it typed.
 *
 * @param {unknown} payload
 * @returns {Running}
 * @throws {RunningPayloadError}
 */
export function parseRunning(payload) {
    const answer = /** @type {any} */ (payload);
    if (answer === null || typeof answer !== 'object') throw new RunningPayloadError('it is not an object');
    if (!Array.isArray(answer.runs)) throw new RunningPayloadError('it has no list of runs');
    if (!Array.isArray(answer.terminals)) throw new RunningPayloadError('it has no list of terminals');

    const runs = answer.runs.map((/** @type {any} */ run, /** @type {number} */ index) => {
        if (typeof run?.configurationName !== 'string' || !RUN_MODES.has(run.mode)) {
            throw new RunningPayloadError(`run ${index} has no configuration name or an unknown mode`);
        }
        return /** @type {RunningRun} */ ({ configurationName: run.configurationName, mode: run.mode });
    });

    const terminals = answer.terminals.map((/** @type {any} */ tab, /** @type {number} */ index) => {
        const valid =
            typeof tab?.entryName === 'string' &&
            KINDS.has(tab.kind) &&
            TERMINAL_MODES.has(tab.mode) &&
            typeof tab.commandRunning === 'boolean' &&
            (tab.debugPort === undefined || Number.isInteger(tab.debugPort));
        if (!valid) throw new RunningPayloadError(`terminal ${index} is not a marked wsc tab`);

        /** @type {RunningTerminal} */
        const terminal = { entryName: tab.entryName, kind: tab.kind, mode: tab.mode, commandRunning: tab.commandRunning };
        if (tab.debugPort !== undefined) terminal.debugPort = tab.debugPort;
        return terminal;
    });

    return { runs, terminals };
}

/**
 * @param {string} configurationName - exactly as get_run_configurations reported it
 * @returns {ToolCall}
 */
export function stopRunCall(configurationName) {
    return { tool: STOP_RUN_TOOL, arguments: { configurationName } };
}

/**
 * @param {string} configurationName - exactly as get_run_configurations reported it
 * @returns {ToolCall}
 */
export function restartRunCall(configurationName) {
    return { tool: RESTART_RUN_TOOL, arguments: { configurationName } };
}

/**
 * @param {EntryKind} kind
 * @param {string} entryName - the name the tab was marked with
 * @returns {ToolCall}
 */
export function stopTerminalCall(kind, entryName) {
    return { tool: STOP_TERMINAL_TOOL, arguments: { kind, entryName } };
}

/**
 * @param {EntryKind} kind
 * @param {string} entryName - the name the tab was marked with
 * @param {string} command - typed into the tab once the old command has stopped
 * @returns {ToolCall}
 */
export function restartTerminalCall(kind, entryName, command) {
    return { tool: RESTART_TERMINAL_TOOL, arguments: { kind, entryName, command } };
}
