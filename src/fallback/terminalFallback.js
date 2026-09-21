/**
 * Launching without the IDE, end to end.
 *
 * The same pipeline the main path runs — catalogue → resolve → plan → launch — with the
 * two ends swapped: the list of run configurations comes from `.idea` on disk instead of
 * `get_run_configurations`, and the tabs come from an OS terminal emulator instead of
 * WebStorm. Everything between the two is literally the same code (parseRequests,
 * buildLaunchPlan, resolveName, the inspector-port assignment), which is the point: a name
 * that is ambiguous here is ambiguous there, and both fail before anything is launched.
 *
 * What this path cannot do, and says so
 *   - It only knows what the IDE has already *saved*. A configuration created a minute ago
 *     and not yet flushed to workspace.xml does not exist here.
 *   - `:debug` starts the process with --inspect-brk, exactly as the IDE path does, but
 *     nothing attaches to it: there is no IDE listening to be told about the port.
 *   - Only npm and Node.js configurations can be rebuilt as a command line.
 */
import { UsageError, parseRequests } from '../args.js';
import { announceCustomCommands, customCommandLine } from '../exec/customCommands.js';
import { findBusyPorts, warnBusyDebugPorts } from '../exec/inspectorPorts.js';
import { DEBUG_HOST, DEBUG_PORT_BASE, MAX_PORT, debugNote } from '../exec/planBuilder.js';
import { isCustomEntry } from '../presets/store.js';
import { buildLaunchPlan, formatPlan, isCustomPlanEntry } from '../resolve.js';
import { FallbackError } from './errors.js';
import { DISK_SOURCE, buildFallbackCommand, readIdeaRunConfigs } from './ideaRunConfigs.js';
import { runSingleTabPool } from './singleTabPool.js';
import { findTerminal, openTerminalTabs } from './terminalTabs.js';

/**
 * @typedef {import('./terminalTabs.js').TabSpec & {
 *   mode: import('../modes.js').LaunchMode,
 *   debugPort?: number,
 * }} FallbackTab
 */

/**
 * @typedef {object} FallbackContext
 * @property {string} presetName
 * @property {import('../presets/store.js').PresetEntry[]} presetEntries
 * @property {string[]} positionals - raw command-line tokens, still unsplit
 * @property {string} projectRoot
 * @property {number} debugPortBase
 * @property {boolean} [dryRun]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {ReturnType<typeof import('../log.js').createLogger>} log
 * @property {typeof readIdeaRunConfigs} [readConfigs] - injected in tests
 * @property {typeof findTerminal} [findTerminal]
 * @property {typeof openTerminalTabs} [openTabs]
 * @property {typeof runSingleTabPool} [runPool]
 * @property {typeof findBusyPorts} [findBusyPorts]
 */

/**
 * Launch a preset and a command line in OS terminal tabs.
 *
 * @param {FallbackContext} ctx
 * @returns {Promise<number>} exit code
 */
export async function runTerminalFallback(ctx) {
    const { log, projectRoot } = ctx;

    const configs = await (ctx.readConfigs ?? readIdeaRunConfigs)(projectRoot);
    log.debug(`${configs.length} run configurations read from ${DISK_SOURCE}`);
    // Only a launch that names run configurations needs the catalogue. A preset of nothing
    // but custom commands has no use for it, so a project WebStorm saved nothing for can
    // still run one — which is the whole point of a command that is not a run configuration.
    const needsCatalogue = ctx.positionals.length > 0 || ctx.presetEntries.some((entry) => !isCustomEntry(entry));
    if (configs.length === 0 && needsCatalogue) {
        throw new FallbackError(
            `WebStorm has saved no run configurations for this project (looked in ${DISK_SOURCE}).\n` +
                '  Without the MCP Server that file is the only list wsc has, so there is nothing\n' +
                '  it can launch. Start the MCP Server and re-run.',
        );
    }

    const plan = resolvePlan(ctx, configs);
    const tabs = buildTabs(plan, ctx);

    log.info(`${ctx.dryRun ? 'would launch' : 'launching'} ${tabs.length} configuration(s) without the IDE:`);
    log.out(formatPlan(plan));
    announceCustomCommands(plan, log);
    for (const note of debugNotes(tabs)) log.warn(note);

    // Ahead of the dry-run return, exactly as on the main path: a dry run is a real
    // rehearsal of the launch, and a port somebody else is holding is worth knowing about.
    const ports = tabs.map((tab) => tab.debugPort).filter((port) => port !== undefined);
    await warnBusyDebugPorts(ports, log, { findBusyPorts: ctx.findBusyPorts });

    // The second half of the --dry-run guard in src/cli.js. That one returns before
    // executePlan(); this path never reaches it, because the fallback is chosen while the
    // CLI is still deciding how to talk to the IDE — so without this line `wsc --dry-run
    // --fallback=terminal` would open real windows. Both halves mean the same thing:
    // nothing is started.
    if (ctx.dryRun) {
        log.out(formatCommands(tabs));
        return 0;
    }

    return await launch(tabs, ctx);
}

/**
 * Resolve the preset and the command line against what the IDE saved.
 *
 * @param {FallbackContext} ctx
 * @param {import('../resolve.js').RunConfigInfo[]} configs
 * @returns {import('../resolve.js').PlanEntry[]}
 */
function resolvePlan(ctx, configs) {
    // Now that there *is* a list of real names, a token is split the same way the main
    // path splits it: `api > repro:stale-job:debug` is a configuration, not a
    // request to debug `api > repro:stale-job`. src/cli.js could not do this itself
    // — it hands over the raw tokens precisely so the split can happen here, after the
    // catalogue is known.
    const known = new Set(configs.map((config) => config.name));
    const requests = parseRequests(ctx.positionals, { isKnownName: (name) => known.has(name) });

    let plan;
    try {
        plan = buildLaunchPlan({ configs, preset: ctx.presetEntries, requests });
    } catch (err) {
        // The name really is unknown *to this path*, which is a weaker statement than the
        // main path's: the IDE may well know it and simply not have written it out yet.
        // Saying where the list came from is the difference between "you made a typo" and
        // "wsc looked in the wrong place".
        if (err instanceof Error && err.name === 'UnknownConfigurationError') {
            throw new FallbackError(
                `${err.message}\n  Without the IDE, wsc can only see what WebStorm saved in ${DISK_SOURCE};\n` +
                    '  a configuration added since it last wrote them will not be there.',
            );
        }
        throw err;
    }

    if (plan.length === 0) {
        throw new FallbackError(
            `nothing to launch: preset "${ctx.presetName}" is empty and no configuration was named.\n` +
                '  Pass configuration names, or configure a preset with --configure.',
        );
    }
    return plan;
}

/**
 * Turn the plan into the commands the tabs will run.
 *
 * Atomic, like buildExecutionPlan(): every command is built before the first tab opens,
 * so a configuration this CLI cannot rebuild never leaves two others already running.
 *
 * @param {import('../resolve.js').PlanEntry[]} plan
 * @param {FallbackContext} ctx
 * @returns {FallbackTab[]}
 */
function buildTabs(plan, ctx) {
    const base = ctx.debugPortBase ?? DEBUG_PORT_BASE;
    let debugSeen = 0;

    const tabs = plan.map((entry) => {
        // The preset's own shell text: there is no run configuration to rebuild a command
        // from, and no inspector port to hand out.
        if (isCustomPlanEntry(entry)) {
            return { name: entry.name, mode: entry.mode, command: customCommandLine(entry.commands) };
        }

        // One inspector port per debug entry, counting up in plan order — the same rule
        // (and the same numbers) the IDE path uses, so `--debug-port` means one thing.
        const debugPort = entry.mode === 'debug' ? base + debugSeen++ : undefined;
        const config = /** @type {import('./ideaRunConfigs.js').IdeaRunConfig} */ (entry.config);

        /** @type {FallbackTab} */
        const tab = {
            name: entry.name,
            mode: entry.mode,
            command: buildFallbackCommand(config, entry.mode, { projectRoot: ctx.projectRoot, debugPort }),
        };
        if (debugPort !== undefined) tab.debugPort = debugPort;
        return tab;
    });

    // Reported as the usage error it is (exit 2), before anything is started, exactly as
    // on the IDE path: a --debug-port high enough to run out of range is something the
    // user typed.
    const ports = tabs.map((tab) => tab.debugPort).filter((port) => port !== undefined);
    const overflow = ports.filter((port) => port > MAX_PORT);
    if (overflow.length > 0) {
        throw new UsageError(
            `--debug-port ${base}: ${ports.length} :debug entries need ports up to ` +
                `${ports[ports.length - 1]}, past the highest port there is (${MAX_PORT})`,
        );
    }

    return tabs;
}

/**
 * What has to be said about the debug entries of this run, if any.
 *
 * debugNote() is reused rather than reworded, but not its reason: on the IDE path the
 * sentence explains a *reroute* (a Run/Debug tab became a Terminal one because
 * execute_run_configuration has no debug parameter). Here nothing is rerouted — every
 * entry is a terminal — and the thing the user has to know is the opposite one: the
 * process will sit on the first line until somebody attaches, and nobody will.
 *
 * @param {FallbackTab[]} tabs
 * @returns {string[]}
 */
function debugNotes(tabs) {
    const ports = tabs.map((tab) => tab.debugPort).filter((port) => port !== undefined);
    if (ports.length === 0) return [];

    return [
        `${debugNote(ports, { why: 'wsc is starting these itself, not the IDE, so ' })}.\n` +
            `  Nothing attaches automatically: each process stops on its first line until a debugger\n` +
            `  connects to ${DEBUG_HOST}:${ports[0]}${ports.length > 1 ? ' and up' : ''} ` +
            '(WebStorm: Run → Attach to Node.js/Chrome).',
    ];
}

/**
 * Open the tabs, or merge everything into this terminal when there are none to open.
 *
 * @param {FallbackTab[]} tabs
 * @param {FallbackContext} ctx
 * @returns {Promise<number>}
 */
async function launch(tabs, ctx) {
    const { log } = ctx;
    const env = ctx.env ?? process.env;
    const terminal = await (ctx.findTerminal ?? findTerminal)({ env });

    if (terminal === null) {
        // The plan's explicit requirement: never merge silently. Everything about this run
        // is about to be different — one scrollback, one Ctrl-C, and wsc stays in the
        // foreground — so it is said before the first line of output, not after.
        log.warn(
            'no terminal emulator found (looked for gnome-terminal, konsole, Terminal.app, wt) —\n' +
                '  running everything in this one window instead, with a coloured tag per configuration.\n' +
                '  Ctrl-C stops all of them at once.',
        );
        return await (ctx.runPool ?? runSingleTabPool)(tabs, { cwd: ctx.projectRoot, env, log });
    }

    const { adapter } = terminal;
    log.info(`opening ${tabs.length} ${adapter.opens}(s) in ${adapter.id}`);
    await (ctx.openTabs ?? openTerminalTabs)(tabs, { terminal, cwd: ctx.projectRoot, env, log });

    // Nothing is waited on: the tabs are detached and outlive this process, so the only
    // honest report is what was asked for, not what it went on to do.
    log.info(`started ${tabs.length} configuration(s) in ${adapter.id}`);
    return 0;
}

/**
 * @param {FallbackTab[]} tabs
 * @returns {string} one line per tab, for --dry-run: the exact command each would run
 */
export function formatCommands(tabs) {
    if (tabs.length === 0) return 'nothing to launch';

    const width = Math.max(...tabs.map((tab) => tab.name.length));
    return tabs.map((tab) => `→ ${tab.name.padEnd(width)}  ${tab.command}`).join('\n');
}
