/**
 * The side-effecting half of `wsc --stop` and `wsc --restart`: ask the IDE what runs, decide
 * with src/control/select.js, then carry the steps out one by one over the MCP session.
 *
 * Like a launch, this is not atomic: every step is attempted, each refusal is reported as it
 * happens, and only a failure that is not about one entry (the transport, the protocol) ends
 * the run early — the remaining steps would fail the same way.
 */
import { customCommandLine, announceCustomCommands } from '../exec/customCommands.js';
import { ideaCommandResolver } from '../exec/ideaCommands.js';
import { DEFAULT_TARGET, buildExecutionPlan, needsTerminalCommands } from '../exec/planBuilder.js';
import { assertPosixTerminal } from '../exec/terminalShell.js';
import { DEBUG_CONFIGURATION_TOOL, TERMINAL_TAB_TOOL } from '../mcp/execute.js';
import {
    LIST_RUNNING_TOOL,
    parseRunning,
    restartRunCall,
    restartTerminalCall,
    stopRunCall,
    stopTerminalCall,
} from '../mcp/control.js';
import { buildLaunchPlan, normalizeRunConfigs } from '../resolve.js';
import { ControlError, formatControlPlan, planControl, selectTargets } from './select.js';

/**
 * @typedef {import('./select.js').ControlStep} ControlStep
 * @typedef {import('./select.js').ControlTarget} ControlTarget
 * @typedef {import('../mcp/execute.js').ToolCall} ToolCall
 * @typedef {import('../exec/planBuilder.js').CommandFor} CommandFor
 * @typedef {import('../exec/planBuilder.js').McpCall} McpCall
 * @typedef {import('../resolve.js').PlanEntry} PlanEntry
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {ReturnType<typeof import('../log.js').createLogger>} Logger
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

    // Everything a restart will send is built here, ahead of the --dry-run return, so a dry run
    // checks it as a launch's dry run does — and so a refusal (Windows, an unbuildable command)
    // comes before the first entry is stopped.
    const commandFor = lazyCommandFor(ctx);
    const restartCalls = new Map(await Promise.all(
        steps.flatMap((step) => (step.action === 'restart' ? [restartCall(step, commandFor).then((call) => /** @type {const} */ ([step, call]))] : [])),
    ));
    const launchTargets = steps.flatMap((step) => (step.action === 'launch' ? [step.target] : []));
    const launch = launchTargets.length > 0 ? await buildLaunch(launchTargets, configs, ctx, commandFor) : null;

    assertPosixTerminal(
        [
            ...[...restartCalls].map(([step, call]) => ({ ...call, name: step.target.name, mode: step.target.mode })),
            ...(launch?.calls ?? []),
        ],
        { platform: ctx.platform, env: ctx.env },
    );
    announceCustomCommands(
        [...restartCalls.keys()]
            .filter((step) => step.target.kind === 'custom')
            .map((step) => ({ name: step.target.name, mode: 'terminal', commands: step.target.commands ?? [], source: 'preset' })),
        log,
    );

    if (ctx.dryRun) return code;

    /** @type {Set<ControlTarget>} */
    const failed = new Set();
    for (const step of steps) {
        if (step.action === 'launch') continue;
        const call = step.action === 'stop' ? stopCall(step) : /** @type {ToolCall} */ (restartCalls.get(step));
        if (!(await attempt(client, call, step.target, log))) {
            failed.add(step.target);
        } else if (step.action === 'restart' || !step.relaunch) {
            log.info(`${step.action === 'stop' ? 'stopped' : 'restarted'} ${step.target.name}`);
        }
    }

    // Launched only once stopped: a stop that failed leaves the old process where it was, and
    // a launch beside it would be the duplicate --restart exists to avoid.
    let launchCode = 0;
    const relaunch = launchTargets.filter((target) => !failed.has(target));
    if (relaunch.length > 0) {
        const ready = relaunch.length === launchTargets.length && launch !== null
            ? launch
            : await buildLaunch(relaunch, configs, ctx, commandFor);
        launchCode = await ctx.launch(ready.plan, ready.calls);
        // The launch reports its own failures, by name; here they are restarts that did not happen,
        // and the closing line must not count them as done.
        if (launchCode !== 0) for (const target of relaunch) failed.add(target);
    }

    const reported = report(action === 'stop' ? 'stopped' : 'restarted', targets, failed, log);
    return reported || launchCode || code;
}

/**
 * The `.idea/`-backed command builder, read at most once and only when a step needs it — a
 * restart of Run tabs and custom commands never touches the disk.
 *
 * @param {ControlContext} ctx
 * @returns {() => Promise<CommandFor>}
 */
function lazyCommandFor(ctx) {
    /** @type {Promise<CommandFor> | undefined} */
    let resolver;
    return () => {
        resolver ??= ctx.readIdeaRunConfigs(ctx.projectRoot).then((configs) => ideaCommandResolver(configs, ctx.projectRoot));
        return resolver;
    };
}

/**
 * The call that restarts one place an entry runs.
 *
 * A Terminal tab is given its command again, rebuilt from the preset as it reads now — the user's
 * own commands joined, or a configuration's command line out of `.idea/` — in the mode its tab
 * was marked with and on the inspector port it already had, so "Attach" keeps working.
 *
 * @param {ControlStep & { action: 'restart' }} step
 * @param {() => Promise<CommandFor>} commandFor
 * @returns {Promise<ToolCall>}
 */
async function restartCall(step, commandFor) {
    const { target, instance } = step;
    if (instance.where !== 'terminal') return restartRunCall(target.name);
    if (target.kind === 'custom') return restartTerminalCall('custom', target.name, customCommandLine(target.commands ?? []));

    const entry = { name: target.name, mode: instance.mode, config: /** @type {RunConfigInfo} */ (target.config), source: /** @type {const} */ ('preset') };
    const built = (await commandFor())(entry, instance.debugPort === undefined ? {} : { debugPort: instance.debugPort });
    return restartTerminalCall('config', target.name, built.command);
}

/**
 * The ordinary launch, for entries whose preset now gives them another mode: the same plan and
 * the same calls `wsc --preset …` would build for them, with the default target.
 *
 * @param {ControlTarget[]} targets
 * @param {RunConfigInfo[]} configs
 * @param {ControlContext} ctx
 * @param {() => Promise<CommandFor>} commandFor
 * @returns {Promise<{ plan: PlanEntry[], calls: McpCall[] }>}
 */
async function buildLaunch(targets, configs, ctx, commandFor) {
    const preset = targets.map((target) =>
        target.kind === 'custom'
            ? { name: target.name, mode: target.mode, commands: target.commands }
            : { name: target.name, mode: target.mode },
    );
    const plan = buildLaunchPlan({ configs, preset });
    const debugTool = ctx.tools.has(DEBUG_CONFIGURATION_TOOL);
    const calls = buildExecutionPlan({
        plan,
        debugPortBase: ctx.debugPortBase,
        debugTool,
        terminalTool: ctx.tools.has(TERMINAL_TAB_TOOL),
        commandFor: needsTerminalCommands(plan, DEFAULT_TARGET, { debugTool }) ? await commandFor() : undefined,
    });
    return { plan, calls };
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
