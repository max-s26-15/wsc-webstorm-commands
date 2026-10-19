/**
 * The side-effecting half of `wsc --stop` and `wsc --restart`: ask the IDE what runs, decide
 * with src/control/select.js, then carry the steps out one by one over the MCP session.
 *
 * Like a launch, this is not atomic: every step is attempted, each refusal is reported as it
 * happens, and only a failure that is not about one entry (the transport, the protocol) ends
 * the run early — the remaining steps would fail the same way.
 */
import { DEBUG_CONFIGURATION_TOOL, TERMINAL_TAB_TOOL } from '../mcp/execute.js';
import { LIST_RUNNING_TOOL, parseRunning, stopRunCall, stopTerminalCall } from '../mcp/control.js';
import { normalizeRunConfigs } from '../resolve.js';
import { ControlError, formatControlPlan, planControl, selectTargets } from './select.js';

/**
 * @typedef {import('./select.js').ControlStep} ControlStep
 * @typedef {import('./select.js').ControlTarget} ControlTarget
 * @typedef {import('../mcp/execute.js').ToolCall} ToolCall
 * @typedef {{
 *   info: (...a: any[]) => void,
 *   warn: (...a: any[]) => void,
 *   error: (...a: any[]) => void,
 *   debug: (...a: any[]) => void,
 *   out: (...a: any[]) => void,
 * }} Logger
 *
 * @typedef {object} ControlContext
 * @property {'stop' | 'restart'} action
 * @property {import('../mcp/client.js').McpClient} client
 * @property {Set<string>} tools - what the IDE lists
 * @property {import('../presets/store.js').PresetConfig} config
 * @property {string[] | null} presetNames - --preset, or null for every preset
 * @property {string[]} tokens - entry names from the command line
 * @property {string} projectRoot
 * @property {boolean} dryRun
 * @property {number} debugPortBase - --debug-port, for an entry launched anew in debug
 * @property {string} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {Logger} log
 * @property {typeof import('../fallback/ideaRunConfigs.js').readIdeaRunConfigs} readIdeaRunConfigs
 * @property {(plan: import('../resolve.js').PlanEntry[], calls: import('../exec/planBuilder.js').McpCall[]) => Promise<number>} launch
 *   - the ordinary launch, for entries whose preset now gives them another mode
 */

/**
 * The plugin's tools that came before list_running: their presence means "update", their
 * absence "install".
 */
const OLDER_PLUGIN_TOOLS = [DEBUG_CONFIGURATION_TOOL, TERMINAL_TAB_TOOL];

/**
 * @param {ControlContext} ctx
 * @returns {Promise<number>} exit code
 */
export async function runControl(ctx) {
    const { action, client, log } = ctx;
    requirePlugin(action, ctx.tools);

    const configs = normalizeRunConfigs(await client.callTool('get_run_configurations'));
    const running = parseRunning(await client.callTool(LIST_RUNNING_TOOL));
    const { targets, notRunning } = selectTargets({
        config: ctx.config,
        presetNames: ctx.presetNames,
        tokens: ctx.tokens,
        configs,
        running,
    });

    // A named entry that runs nowhere is already stopped, so --stop has nothing to say against
    // it. A restart was asked to restart it and cannot — it does not start what is stopped.
    let code = 0;
    for (const target of notRunning) {
        if (action === 'stop') {
            log.info(`"${target.name}" is not running`);
        } else {
            code = 1;
            log.error(`"${target.name}" is not running — ${startHint(target)}`);
        }
    }

    const steps = planControl(action, targets);
    if (steps.length === 0) {
        if (notRunning.length === 0) log.info(`nothing to ${action}: no preset entry is running`);
        return code;
    }

    const count = `${targets.length} preset ${targets.length === 1 ? 'entry' : 'entries'}`;
    const verb = action === 'stop' ? 'stopping' : 'restarting';
    log.info(`${ctx.dryRun ? `would ${action}` : verb} ${count}:`);
    log.out(formatControlPlan(steps));

    if (action === 'restart') throw new Error('restart: Task 8');

    if (ctx.dryRun) return code;

    /** @type {Set<ControlTarget>} */
    const failed = new Set();
    for (const step of steps) {
        if (step.action !== 'stop') continue;
        if (!(await attempt(client, stopCall(step), step.target, log))) failed.add(step.target);
        else log.info(`stopped ${step.target.name}`);
    }

    return report('stopped', targets, failed, log) || code;
}

/**
 * @param {'stop' | 'restart'} action
 * @param {Set<string>} tools
 * @throws {ControlError} when the IDE has no list_running
 */
function requirePlugin(action, tools) {
    if (tools.has(LIST_RUNNING_TOOL)) return;
    if (OLDER_PLUGIN_TOOLS.some((tool) => tools.has(tool))) {
        throw new ControlError(`--${action} needs wsc Companion 0.6.0 or later — update it in Settings → Plugins`);
    }
    throw new ControlError(
        `--${action} needs the wsc Companion plugin: WebStorm's own MCP tools cannot stop anything. ` +
            'Install it from Settings → Plugins → Marketplace',
    );
}

/**
 * How to start an entry that is not running: a configuration by name, a custom command only
 * through its preset — the command line has no way to name one for a launch.
 *
 * @param {ControlTarget} target
 * @returns {string}
 */
function startHint(target) {
    return target.kind === 'config'
        ? `start it with \`wsc ${target.name}\``
        : `it starts with its preset: wsc --preset ${target.presets[0]}`;
}

/**
 * @param {ControlStep & { action: 'stop' }} step
 * @returns {ToolCall}
 */
function stopCall(step) {
    return step.instance.where === 'terminal'
        ? stopTerminalCall(step.target.kind, step.target.name)
        : stopRunCall(step.target.name);
}

/**
 * Make one call. A refusal by the IDE is this entry's failure and is reported; anything else is
 * not about one entry, and ends the run.
 *
 * @param {import('../mcp/client.js').McpClient} client
 * @param {ToolCall} call
 * @param {ControlTarget} target
 * @param {Logger} log
 * @returns {Promise<boolean>} whether it worked
 */
async function attempt(client, call, target, log) {
    try {
        const result = await client.callTool(call.tool, call.arguments);
        log.debug(`${call.tool} → ${typeof result === 'string' ? result : JSON.stringify(result)}`);
        return true;
    } catch (err) {
        // By name, as runExecutionPlan() does: AmbiguousProjectError is a subclass that is
        // not about this entry, and must abort rather than be counted against it.
        if (!(err instanceof Error) || err.name !== 'McpToolError') throw err;
        log.error(`${target.name}: ${/** @type {import('../mcp/client.js').McpToolError} */ (err).detail}`);
        return false;
    }
}

/**
 * The closing line, which keeps a partial run from reading like a whole one.
 *
 * @param {'stopped' | 'restarted'} done
 * @param {ControlTarget[]} targets
 * @param {Set<ControlTarget>} failed
 * @param {Logger} log
 * @returns {number} exit code
 */
function report(done, targets, failed, log) {
    if (failed.size === 0) {
        log.info(`${done} ${targets.length} preset ${targets.length === 1 ? 'entry' : 'entries'}`);
        return 0;
    }
    log.error(
        `${done} ${targets.length - failed.size} of ${targets.length} — ` +
            `failed: ${[...failed].map((target) => target.name).join(', ')}`,
    );
    return 1;
}
