/**
 * Turn a resolved launch plan into the MCP calls that realise it.
 *
 * Pure and side-effect free, like src/resolve.js: it decides *which* tool each entry
 * needs and, for the terminal path, rebuilds the command line — but issues nothing.
 * That keeps the whole tool-choice / debug-command question unit-testable against the
 * phase-2 fixture, with no IDE anywhere near it.
 *
 * Building is atomic, for the same reason buildLaunchPlan() is: every entry is turned
 * into a call before a single one is issued, so a configuration this CLI cannot express
 * as a terminal command never leaves the first two already running.
 *
 * Deviation from the plan's literal contract
 *   buildExecutionPlan(resolved, runConfigs, target)
 * The plan assumed the resolved list is `{name, mode}[]` and that the matching
 * RunConfigInfo still has to be looked up. It does not: src/resolve.js already emits
 * PlanEntry (`{name, mode, config, source}`) carrying the resolved configuration, so
 * passing runConfigs again would mean a second, weaker lookup by name. The parameters
 * are an options object instead, matching buildLaunchPlan() next door.
 */
import {
    TERMINAL_TOOL,
    debugConfigurationCall,
    runConfigurationCall,
    terminalCommandCall,
    terminalTabCall,
} from '../mcp/execute.js';
import { isCustomPlanEntry } from '../resolve.js';
import { customCommandLine } from './customCommands.js';

/**
 * @typedef {import('../resolve.js').PlanEntry} PlanEntry
 * @typedef {import('../resolve.js').ConfigPlanEntry} ConfigPlanEntry
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {'run-window' | 'terminal'} ExecTarget
 * @typedef {{
 *   name: string,
 *   mode: import('../modes.js').LaunchMode,
 *   tool: string,
 *   arguments: Record<string, unknown>,
 *   timeoutMs?: number,
 *   note?: string,
 *   debugPort?: number,
 *   commandSource?: CommandSource,
 *   tabName?: string,
 * }} McpCall
 *
 * `tabName` is set on a Terminal call only: what the IDE should title that tab. The tool
 * has no parameter for it, so the runner puts the call on a session of that name instead
 * (see runExecutionPlan).
 *
 * Where the shell command line behind a terminal call came from.
 *   'idea' — read out of what WebStorm saved to .idea/, so it is the real definition.
 *   'name' — rebuilt from the configuration's name, because .idea/ had no entry for it.
 *   'custom' — a preset entry's own commands, joined; nothing was looked up.
 * Absent means nothing was consulted: buildExecutionPlan() was called without a
 * commandFor resolver, so there is no lookup to report the outcome of.
 * @typedef {'idea' | 'name' | 'custom'} CommandSource
 *
 * How a terminal command line is obtained for one plan entry. Injected rather than
 * imported so this module stays pure and free of any dependency on the filesystem —
 * see src/exec/ideaCommands.js for the resolver the CLI actually passes.
 * @typedef {(entry: ConfigPlanEntry, opts: { debugPort?: number }) => {
 *   command: string,
 *   source?: CommandSource,
 * }} CommandFor
 */

/** Where a launch shows up. */
export const EXEC_TARGETS = /** @type {const} */ (['run-window', 'terminal']);

/** Native Run/Debug tabs are the point of the product; the terminal is opt-in. */
export const DEFAULT_TARGET = 'run-window';

/** `description` the IDE reports for npm run configurations. */
const NPM_DESCRIPTION = 'npm';

/** Separator WebStorm puts between a package.json directory and a script name. */
const NAME_SEPARATOR = ' > ';

/**
 * Interface the inspector is bound to.
 *
 * Spelled out rather than left to Node's default (which is also 127.0.0.1) so the port
 * half is never read as `--inspect-brk=9229`-style shorthand, and so a future default
 * change upstream cannot silently expose a debugged process to the network.
 */
export const DEBUG_HOST = '127.0.0.1';

/**
 * Port of the *first* debug entry in a run; the next one gets base + 1, and so on.
 *
 * A shared port is not an option: `--inspect-brk` with no port means 9229 for everyone,
 * so `wsc a:debug b:debug` starts one debugger and then prints "Starting inspector on
 * 127.0.0.1:9229 failed: address already in use" into the second tab (reproduced in the
 * IDE's own terminal). Ports are therefore handed out per debug entry, in plan order —
 * deterministic, so the number this CLI prints is the number WebStorm has to attach to.
 *
 * 9229 upwards is the right window to take: it is Node's own inspector default, what the
 * IDE's "Attach to Node.js" configuration offers first, and what Node itself walks up
 * from when a cluster forks workers. It is *not* probed and reassigned — a port already
 * taken by an unrelated debugger is reported (see --debug-port) instead of silently
 * swapped, because a printed port that keeps moving between runs is worse than one the
 * user is told to move.
 */
export const DEBUG_PORT_BASE = 9229;

/** Highest port the assignment may reach; beyond it there is nothing to bind. */
export const MAX_PORT = 65535;

/** The inspector flag itself. Break *before* the first line, so nothing is missed. */
export const DEBUG_FLAG = '--inspect-brk';

/**
 * How a debug launch is expressed.
 *
 * There is no debug parameter anywhere in the IDE's MCP API — verified against the live
 * tool schemas of WebStorm 2026.2: execute_run_configuration takes only
 * configurationName / waitForExit / timeout / programArguments / workingDirectory /
 * envs. So the debugger has to be asked for inside the command itself.
 *
 * The `envs` override is not a way around it either: the IDE gates overrides behind
 * `supportsDynamicLaunchOverrides`, which is `false` on every npm and Node.js
 * configuration observed so far — including all 13 in the test fixture.
 *
 * `${NODE_OPTIONS:+$NODE_OPTIONS }` extends whatever the shell already exports instead
 * of replacing it: a plain `NODE_OPTIONS=--inspect-brk` prefix drops the user's own
 * `--max-old-space-size`, `--enable-source-maps`, `--experimental-vm-modules` and so on,
 * and a project that needs them then fails only once the script is already running. The
 * `:+` form contributes nothing at all when the variable is unset, so the command stays
 * clean in the common case. It has to be shell syntax rather than a JS env object — the
 * IDE runs this line in the terminal's own shell, and there is no env parameter to pass.
 * Never route it through shellQuote(): quoting is exactly what would stop the expansion.
 *
 * @param {number} port
 * @returns {string} an assignment prefix, ready to be put in front of a command
 */
export function debugEnvPrefix(port) {
    // The value is double-quoted so an inherited NODE_OPTIONS containing spaces (the
    // normal case — it is a flag list) stays a single word.
    return `NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }${DEBUG_FLAG}=${DEBUG_HOST}:${port}"`;
}

/**
 * The reroute warning for a plan, naming the ports that plan actually assigned.
 *
 * A function of the assignment rather than a constant built from DEBUG_PORT_BASE: frozen
 * at module load it kept saying "from 9229 up" under `--debug-port 9400`, contradicting
 * the very commands it was explaining — on the one flag it exists to document.
 *
 * Said once per run, not once per entry (see executionNotes()); every debug entry of a
 * plan therefore has to get the *same* string, which is why this takes the whole port
 * list rather than one entry's port.
 *
 * Deliberately not a repeat of the runner's per-entry "attach to port 9230" line: it
 * names the window the run occupies as a whole — what has to be free, and what
 * --debug-port moves. With a single entry there is no window to speak of, so it names the
 * one port instead of a range of one.
 *
 * The reason is a parameter because the *fact* is shared and the *cause* is not: the
 * terminal fallback assigns the very same ports from the same --debug-port and has to say
 * the same thing about them, but nothing was rerouted there — every entry is a terminal
 * already. One sentence with two openings beats two sentences that drift apart.
 *
 * @param {number[]} ports - the assigned inspector ports, in plan order; at least one
 * @param {object} [opts]
 * @param {string} [opts.why] - the opening clause, ending in a space; it is followed by
 *   "the command is rebuilt with ..."
 * @returns {string}
 */
export function debugNote(ports, opts = {}) {
    const why = opts.why ??
        ('debug mode goes through the IDE\'s Terminal window: execute_run_configuration has no ' +
        'debug parameter, so ');

    if (ports.length === 1) {
        return `${why}the command is rebuilt with ${DEBUG_FLAG}=${DEBUG_HOST}:${ports[0]} ` +
            '(--debug-port moves it)';
    }

    // Contiguous by construction (base + index), so first..last describes the set exactly.
    return `${why}each command is rebuilt with ${DEBUG_FLAG}=${DEBUG_HOST}:<port> — ports ` +
        `${ports[0]}-${ports[ports.length - 1]}, one per entry in plan order ` +
        '(--debug-port moves the range)';
}

/**
 * What to say after the reroute note when the IDE has no debug tool.
 *
 * Separate from debugNote() on purpose: that one is shared with the terminal fallback,
 * where no IDE is involved and a plugin is not an answer to anything.
 */
export const DEBUG_PLUGIN_HINT =
    'for a real Debug tab instead, install the wsc IDE plugin (see ide-plugin/README.md in the wsc repository)';

/**
 * What to say when a run opens Terminal tabs through the IDE's own tool.
 *
 * Measured, not assumed: that tool runs the command on pipes (see TERMINAL_TOOL), so the
 * tab shows what the command prints and nothing else. Said once per run, before anything
 * starts, because a tab that opens and then shows nothing reads as a broken command.
 */
export const PIPED_TERMINAL_NOTE =
    'the IDE\'s own terminal tool runs a command on pipes, not a real terminal: a program that draws ' +
    'its own screen (ngrok, top, a progress bar) shows nothing in its tab, and Ctrl-C there cannot stop it.\n' +
    '  For a real Terminal tab, install the wsc IDE plugin (see ide-plugin/README.md in the wsc repository)';

/** Characters that need no quoting in any POSIX shell. */
const SHELL_SAFE = /^[A-Za-z0-9._:@/+-]+$/;

/**
 * The way out of the terminal, when a configuration cannot be expressed as a command line.
 *
 * The two cases need opposite advice, and the difference is not cosmetic: `--target=terminal`
 * is a choice the user can simply drop, while `:debug` has nowhere else to go — the IDE's
 * MCP API has no debug parameter at all (see debugEnvPrefix), so there is no Run/Debug tab
 * to fall back to.
 *
 * Shared with the .idea-backed command builder (src/fallback/ideaRunConfigs.js takes it as
 * `advice`) so that a refusal reads the same whichever half of the reconstruction produced
 * it. Its own default — "start the MCP Server" — is the right advice only on the no-IDE
 * path, and would be nonsense here, where the IDE is answering.
 *
 * @param {import('../modes.js').LaunchMode} mode
 * @returns {string} one indented line, ready to follow a message
 */
export function terminalEscapeHint(mode) {
    if (mode === 'debug') return '  Run it without :debug, or name a configuration that already starts a debugger.';
    // :terminal is the entry's own choice, so dropping the flag would not help: :run is what
    // asks for the Run window (and a --target=terminal on the command line would still win).
    if (mode === 'terminal') return '  Use :run, without --target=terminal, to launch it in the IDE\'s Run window.';
    return '  Drop --target=terminal to launch it in the IDE\'s Run window.';
}

/** A configuration this CLI cannot express as a shell command line. */
export class UnsupportedLaunchError extends Error {
    /**
     * @param {RunConfigInfo} config
     * @param {import('../modes.js').LaunchMode} mode
     */
    constructor(config, mode) {
        const kind = config.description ? `a "${config.description}" configuration` : 'of an unknown type';
        const why =
            'wsc rebuilds a shell command line for the IDE\'s Terminal window, and only knows how to do ' +
            `that for npm configurations (this one is ${kind})`;

        // Debug can only ever reach the terminal, so the two cases need different advice:
        // one is "you cannot debug this at all", the other is "you asked for the terminal".
        const what = mode === 'debug'
            ? `cannot debug "${config.name}"`
            : `cannot run "${config.name}" in a terminal`;

        super(`${what}: ${why}.\n${terminalEscapeHint(mode)}`);
        this.name = 'UnsupportedLaunchError';
        this.config = config;
        this.mode = mode;
    }
}

/**
 * Quote a value for a POSIX shell, but only when it actually needs it.
 *
 * Leaving safe words bare matters for --dry-run: the command printed there is meant to
 * be recognisable, and `npm run 'test'` reads worse than `npm run test`.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
    if (SHELL_SAFE.test(value)) return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Split an npm configuration name into the directory holding package.json and the script.
 *
 * WebStorm names npm run configurations after the script, prefixing the package.json
 * directory only when it is not the project root — `client > bundle:build` in demo-app,
 * plain `web` for a root script. Cut at the *last* separator: the script is the last
 * segment, and a nested path (`packages/client > build`) keeps its slashes on the left.
 *
 * @param {string} name
 * @returns {{ workspace: string | null, script: string }}
 */
export function splitNpmConfigName(name) {
    const at = name.lastIndexOf(NAME_SEPARATOR);
    if (at < 0) return { workspace: null, script: name };
    return { workspace: name.slice(0, at), script: name.slice(at + NAME_SEPARATOR.length) };
}

/**
 * Rebuild the command line that a run configuration stands for.
 *
 * get_run_configurations reports only `name` and `description` — no script, no cwd, no
 * env (checked on a live IDE, despite what the tool's own docs suggest) — so the command
 * has to be reconstructed from the IDE's naming convention. That works for npm
 * configurations and nothing else: a "Node.js" configuration's entry file is simply not
 * knowable from here, and guessing one would launch the wrong process.
 *
 * @param {RunConfigInfo} config
 * @param {import('../modes.js').LaunchMode} mode
 * @param {object} [opts]
 * @param {number} [opts.debugPort] - ignored unless mode is debug; defaults to the base,
 *   which is what a plan with a single debug entry gets anyway
 * @returns {string}
 * @throws {UnsupportedLaunchError} when the configuration is not an npm one
 */
export function buildTerminalCommand(config, mode, opts = {}) {
    if (config.description !== NPM_DESCRIPTION) throw new UnsupportedLaunchError(config, mode);

    const { workspace, script } = splitNpmConfigName(config.name);
    const debugPort = opts.debugPort ?? DEBUG_PORT_BASE;
    const run = `${mode === 'debug' ? `${debugEnvPrefix(debugPort)} ` : ''}npm run ${shellQuote(script)}`;

    // The IDE opens the terminal at the project root, so a workspace script needs a cd.
    return workspace === null ? run : `cd ${shellQuote(workspace)} && ${run}`;
}

/**
 * Whether one plan entry has to go through a shell command line rather than a Run tab.
 *
 * A `:terminal` entry always does: the entry asked for the Terminal window by name. So does
 * a `:debug` entry — unless the IDE has the wsc plugin's debug tool, which starts the
 * configuration with the Debug executor itself. An explicit `--target=terminal` stays a
 * terminal launch either way, for every entry: the user asked for the terminal by name.
 *
 * Exported because the CLI has to know the same thing one step earlier: a command line is
 * the only thing that needs the run configuration's *real* definition read off disk, and
 * a plan of plain run-window entries must not pay for a `.idea/` read it will not use.
 *
 * @param {PlanEntry} entry
 * @param {ExecTarget} target
 * @param {{ debugTool?: boolean }} [opts] - debugTool: the IDE offers debug_run_configuration
 * @returns {boolean}
 */
export function usesTerminal(entry, target, opts = {}) {
    return target === 'terminal' || entry.mode === 'terminal' || (entry.mode === 'debug' && !opts.debugTool);
}

/**
 * Whether any entry of a plan will need a rebuilt command line.
 *
 * @param {PlanEntry[]} plan
 * @param {ExecTarget} target
 * @param {{ debugTool?: boolean }} [opts]
 * @returns {boolean}
 */
export function needsTerminalCommands(plan, target, opts = {}) {
    // A custom entry carries its own command line: there is nothing in `.idea/` to read for it.
    return plan.some((entry) => !isCustomPlanEntry(entry) && usesTerminal(entry, target, opts));
}

/**
 * The default command source: the IDE's naming convention, and nothing else.
 *
 * `source` is deliberately left unset. It answers "what did the .idea/ lookup find?", and
 * without a resolver there was no lookup — claiming 'name' here would make every caller
 * that never opted into the disk catalogue (every unit test of this module) report a
 * fallback that never happened.
 *
 * @type {CommandFor}
 */
const NAME_ONLY = (entry, opts) => ({ command: buildTerminalCommand(entry.config, entry.mode, opts) });

/**
 * Decide the MCP call behind every entry of a launch plan.
 *
 * A debug entry goes through the IDE's Debug tool window when the wsc plugin's
 * debug_run_configuration is available (`debugTool`). Without it, it ends up in the
 * terminal, whatever the target: that is the only place a `--inspect-brk` can be attached
 * (see debugEnvPrefix). It is a documented reroute rather than a silent one — the entry
 * carries debugNote() so the CLI says so out loud before launching, instead of quietly
 * starting the process in plain run mode.
 *
 * Inspector ports are handed out here rather than inside buildTerminalCommand(), because
 * "one port per debug entry" is a property of the whole plan: the builder is the only
 * place that can see how many debug entries there are and in which order.
 *
 * @param {object} args
 * @param {PlanEntry[]} args.plan - from buildLaunchPlan()
 * @param {ExecTarget} [args.target]
 * @param {number} [args.debugPortBase] - port of the first debug entry (--debug-port)
 * @param {boolean} [args.debugTool] - the IDE has debug_run_configuration (the wsc plugin)
 * @param {boolean} [args.terminalTool] - the IDE has open_terminal_tab (the wsc plugin): every
 *   Terminal tab of the plan is then a real one instead of the IDE's piped runner
 * @param {CommandFor} [args.commandFor] - how a terminal command line is obtained;
 *   defaults to rebuilding it from the configuration's name, which is all
 *   get_run_configurations gives. src/exec/ideaCommands.js supplies the better one.
 * @returns {McpCall[]}
 * @throws {UnsupportedLaunchError} before any call is issued
 */
export function buildExecutionPlan({
    plan,
    target = DEFAULT_TARGET,
    debugPortBase = DEBUG_PORT_BASE,
    debugTool = false,
    terminalTool = false,
    commandFor = NAME_ONLY,
}) {
    let debugSeen = 0;

    /**
     * The call behind one Terminal tab, titled `name`. With the plugin's tool it is a real
     * shell tab that the plugin titles itself; without it, the IDE's own tool, which titles a
     * tab after the MCP client that opened it — hence `tabName`, which makes the runner open
     * a session under that name (see runExecutionPlan).
     *
     * @param {string} name
     * @param {string} command
     */
    const terminalCall = (name, command) =>
        terminalTool ? terminalTabCall(name, command) : { ...terminalCommandCall(command), tabName: name };

    const calls = plan.map((entry) => {
        if (isCustomPlanEntry(entry)) {
            // Always a Terminal tab, whatever the target: the entry asked for a command line.
            // No commandFor (nothing to look up), no inspector port (nothing is debugged), no
            // note (nothing was rerouted), and a tab named after the entry like every other.
            /** @type {McpCall} */
            const custom = {
                name: entry.name,
                mode: entry.mode,
                ...terminalCall(entry.name, customCommandLine(entry.commands)),
                commandSource: 'custom',
            };
            return custom;
        }

        const viaTerminal = usesTerminal(entry, target, { debugTool });
        const viaDebugTool = entry.mode === 'debug' && !viaTerminal;
        // Counted over the debug entries that use an inspector port — the terminal ones —
        // so a mixed plan still starts at the base and the numbers stay the ones the user
        // was told about. The IDE's own debugger picks its port itself.
        const debugPort = entry.mode === 'debug' && viaTerminal ? debugPortBase + debugSeen++ : undefined;
        const built = viaTerminal ? commandFor(entry, { debugPort }) : null;

        /** @type {McpCall} */
        const call = {
            name: entry.name,
            mode: entry.mode,
            ...(viaDebugTool
                ? debugConfigurationCall(entry.name)
                : built === null
                    ? runConfigurationCall(entry.name)
                    : terminalCall(entry.name, built.command)),
        };

        if (built?.source !== undefined) call.commandSource = built.source;
        // Carried on the call so the runner can print where to attach, and so the CLI can
        // check the port before anything is launched.
        if (debugPort !== undefined) call.debugPort = debugPort;
        return call;
    });

    // A second pass, because the note names the ports of the *whole* plan and the last of
    // them is only known once every entry has been assigned one. An explicit
    // --target=terminal needs no note: nothing was rerouted behind the user's back.
    const ports = debugPortsOf(calls);
    if (target !== 'terminal' && ports.length > 0) {
        const note = debugNote(ports);
        for (const call of calls) if (call.debugPort !== undefined) call.note = note;
    }

    return calls;
}

/**
 * Whether any tab of an execution plan goes through the IDE's own, piped terminal tool.
 *
 * @param {McpCall[]} calls
 * @returns {boolean}
 */
export function usesPipedTerminal(calls) {
    return calls.some((call) => call.tool === TERMINAL_TOOL);
}

/**
 * The inspector ports an execution plan will occupy, in plan order.
 *
 * @param {McpCall[]} calls
 * @returns {number[]}
 */
export function debugPortsOf(calls) {
    return /** @type {number[]} */ (calls.map((call) => call.debugPort).filter((port) => port !== undefined));
}

/**
 * The distinct explanations an execution plan carries, in first-seen order.
 *
 * Deduplicated because the note is a property of the *plan*, not of each entry: four
 * debug entries are one reroute, not four warnings.
 *
 * @param {McpCall[]} calls
 * @returns {string[]}
 */
export function executionNotes(calls) {
    return [...new Set(calls.map((call) => call.note).filter((note) => note !== undefined))];
}

/**
 * The entries whose command line is a guess, in plan order.
 *
 * A separate list rather than another entry in executionNotes(): the debug note explains a
 * decision wsc *made*, while this reports a lookup that came up empty, and the CLI has to
 * be able to name the configurations involved. Empty whenever buildExecutionPlan() ran
 * without a resolver — see CommandSource.
 *
 * @param {McpCall[]} calls
 * @returns {string[]} configuration names
 */
export function guessedCommands(calls) {
    return calls.filter((call) => call.commandSource === 'name').map((call) => call.name);
}

/**
 * @param {McpCall[]} calls
 * @returns {string} one line per call, for --dry-run: what would actually be sent
 */
export function formatExecutionPlan(calls) {
    if (calls.length === 0) return 'nothing to launch';

    const width = Math.max(...calls.map((call) => call.tool.length));
    return calls
        .map((call) => {
            const payload = call.arguments.command ?? call.arguments.configurationName;
            return `→ ${call.tool.padEnd(width)}  ${payload}`;
        })
        .join('\n');
}
