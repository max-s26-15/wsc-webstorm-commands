import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
    LAUNCH_ONLY_FLAGS,
    LIST_IGNORED_FLAGS,
    UsageError,
    parseCliArgs,
    parseRequests,
    passedFlags,
    splitPresetNames,
} from './args.js';
import {
    DEBUG_PORT_BASE,
    DEFAULT_TARGET,
    DEBUG_PLUGIN_HINT,
    EXEC_TARGETS,
    MAX_PORT,
    buildExecutionPlan,
    debugPortsOf,
    executionNotes,
    formatExecutionPlan,
    guessedCommands,
    needsTerminalCommands,
} from './exec/planBuilder.js';
import { guessedCommandNote, ideaCommandResolver } from './exec/ideaCommands.js';
import { warnBusyDebugPorts } from './exec/inspectorPorts.js';
import { readIdeaRunConfigs } from './fallback/ideaRunConfigs.js';
import { runTerminalFallback } from './fallback/terminalFallback.js';
import { LIST_WITHOUT_IDE_LABEL, listFromDisk, listFromIde } from './list.js';
import { createLogger } from './log.js';
import { connectMcp } from './mcp/client.js';
import { discoverPort, parsePort } from './mcp/discovery.js';
import { DEBUG_CONFIGURATION_TOOL, runExecutionPlan } from './mcp/execute.js';
import {
    CONFIG_DIR,
    PresetConfigError,
    configPath,
    findProjectRoot,
    getPreset,
    hasPreset,
    readPresets,
} from './presets/store.js';
import { buildLaunchPlan, formatPlan, normalizeRunConfigs } from './resolve.js';
import { runConfigure } from './ui/configure.js';
import {
    FALLBACK_MODES,
    MCP_SETUP_HELP,
    mcpUnavailableMessage,
    resolveFallbackChoice,
} from './ui/mcpUnavailablePrompt.js';
import { CANCELLED_EXIT_CODE } from './ui/promptCancel.js';

// `import ... with {type: 'json'}` needs Node >=18.20/20.10 (unflagged import
// attributes); engines.node in package.json only guarantees >=18.0, so the
// package version is read the CJS way instead, which has worked on every
// Node >=12 ESM build.
const require = createRequire(import.meta.url);
/** @type {{ version: string }} */
const pkg = require('../package.json');

const HELP = `wsc — run WebStorm run configurations in one command

Usage:
  wsc [options] [configuration[:run|:debug|:terminal] ...]

Options:
  -c, --configure       pick which configurations launch by default, and how
  -l, --list            print every run configuration the project has, and stop
      --preset <name>   preset to configure or launch (default: the config's defaultPreset);
                        to launch several, list them: --preset a b, or repeat the flag
      --project <path>  project root (default: nearest directory with .idea/)
      --mcp-port <n>    MCP Server port (default: WSC_MCP_PORT, then a scan)
      --target <where>  run-window (default) — native Run/Debug tabs — or terminal
      --debug-port <n>  first inspector port for :debug entries (default: ${DEBUG_PORT_BASE})
      --dry-run         print what would be launched, without launching it
      --fallback <how>  when the IDE cannot be reached: retry (poll for it) or terminal
                        (launch without it). Default: ask, if there is a terminal to ask in
  -h, --help            show this help
  -v, --version         show version

Examples:
  wsc                                 launch the default preset
  wsc web:debug api                   preset plus two more, web in debug mode
  wsc --list                          print every configuration the IDE knows about
  wsc --preset backend --dry-run      show what the "backend" preset would launch
  wsc web:terminal api                web in a Terminal tab, api in the Run window
  wsc --target=terminal web           launch everything in Terminal tabs instead
  wsc -c                              edit the default preset interactively
  wsc --fallback=retry web            wait for WebStorm to come up, then launch
  wsc --fallback=terminal web         launch in OS terminal tabs, without WebStorm

:debug opens a real Debug tab when the wsc IDE plugin is installed (see ide-plugin/README.md).
Without it the IDE's MCP API has no debug parameter, so the command runs in a Terminal tab
rebuilt with --inspect-brk, and each :debug entry gets its own inspector port, counting up
from ${DEBUG_PORT_BASE} — attach WebStorm to the port wsc prints for it. --target=terminal
always takes that Terminal route.

:terminal starts one configuration in a new IDE Terminal tab, without a debugger — the same
launch --target=terminal gives every entry, chosen per entry (and storable in a preset).
Only npm and Node.js configurations can be rebuilt as a command line for it.

Without the IDE (--fallback=terminal), wsc opens one OS terminal tab per configuration —
gnome-terminal, konsole, Terminal.app or Windows Terminal, whichever is installed — and
falls back to running everything in this window, tagged per configuration, when none is.
The names come from what WebStorm saved in .idea/, so a configuration it has not written
out yet is not known there, and only npm and Node.js configurations can be rebuilt as a
command line. --list falls back the same way, to the configurations WebStorm saved there.

Only wsc's actual output — a --list listing, a --dry-run plan — goes to stdout; every
message goes to stderr, so \`wsc --list | grep dev\` sees configuration names and nothing else.
`;

/**
 * @typedef {object} CliDeps
 * @property {NodeJS.WriteStream} [stdout]
 * @property {NodeJS.WriteStream} [stderr]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {typeof discoverPort} [discoverPort]
 * @property {typeof connectMcp} [connectMcp]
 * @property {typeof executePlan} [executePlan]
 * @property {typeof runTerminalFallback} [runTerminalFallback]
 * @property {typeof resolveFallbackChoice} [resolveFallbackChoice]
 * @property {typeof runConfigure} [runConfigure]
 * @property {typeof readIdeaRunConfigs} [readIdeaRunConfigs]
 * @property {NodeJS.ReadStream} [stdin]
 */

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @param {CliDeps} [deps] - injected in tests; defaults are the real thing
 * @returns {Promise<number>} exit code: 0 success, 1 runtime error, 2 usage error
 */
export async function runCli(argv, deps = {}) {
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const env = deps.env ?? process.env;
    const cwd = deps.cwd ?? process.cwd();
    const log = createLogger({ stdout, stderr, env });

    try {
        return await run(argv, { ...deps, stdout, stderr, env, cwd, log });
    } catch (err) {
        if (err instanceof UsageError) {
            log.error(err.message);
            stderr.write(`\n${HELP}`);
            return 2;
        }
        // Every error the CLI raises deliberately carries a message meant for a human;
        // anything else is a bug and keeps its stack.
        if (err instanceof Error && KNOWN_ERRORS.has(err.name)) {
            log.error(err.message);
            return 1;
        }
        throw err;
    }
}

/**
 * Decide which project the CLI is acting on.
 *
 * An explicit --project is validated here rather than left to fail later: without
 * this, a typo'd path just reads as "no config file" (readPresets treats ENOENT as an
 * empty config) and the run only breaks much later, with the IDE's generic complaint
 * about an unknown project. The auto-detected path cannot have that problem, because
 * findProjectRoot only returns directories that contain .idea/.
 *
 * @param {string | undefined} explicit - from --project
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function resolveProjectRoot(explicit, cwd) {
    if (explicit === undefined) {
        const found = await findProjectRoot(cwd);
        if (!found) {
            throw new WscError(`no WebStorm project found above ${cwd} (looked for a ${CONFIG_DIR}/ directory)`);
        }
        return found;
    }

    // The IDE is told this path verbatim, so make it absolute regardless of cwd.
    const root = path.resolve(cwd, explicit);

    const stats = await fs.stat(root).catch(() => null);
    if (!stats) throw new WscError(`--project: no such directory: ${root}`);
    if (!stats.isDirectory()) throw new WscError(`--project: not a directory: ${root}`);

    const idea = await fs.stat(path.join(root, CONFIG_DIR)).catch(() => null);
    if (!idea?.isDirectory()) {
        throw new WscError(`--project: not a WebStorm project (no ${CONFIG_DIR}/ in ${root})`);
    }

    return root;
}

/**
 * Resolve --target into an execution target.
 *
 * A typo here is something the user typed, so it is a usage error (exit 2) and is
 * caught before the IDE is contacted — not after two tabs already opened.
 *
 * @param {string | undefined} value
 * @returns {import('./exec/planBuilder.js').ExecTarget}
 */
function resolveTarget(value) {
    if (value === undefined) return DEFAULT_TARGET;
    if (!(/** @type {readonly string[]} */ (EXEC_TARGETS)).includes(value)) {
        throw new UsageError(`--target: expected one of ${EXEC_TARGETS.join(', ')}, got "${value}"`);
    }
    return /** @type {import('./exec/planBuilder.js').ExecTarget} */ (value);
}

/**
 * Resolve --fallback into what should happen when the IDE cannot be reached.
 *
 * Validated up front like --target, and for the same reason: a typo is something the
 * user typed, so it is a usage error (exit 2) rather than a surprise discovered only on
 * the unhappy path — which, for this flag in particular, is the one path the user cannot
 * conveniently reproduce on demand.
 *
 * @param {string | undefined} value
 * @returns {import('./ui/mcpUnavailablePrompt.js').FallbackMode | undefined}
 */
function resolveFallback(value) {
    if (value === undefined) return undefined;
    if (!(/** @type {readonly string[]} */ (FALLBACK_MODES)).includes(value)) {
        throw new UsageError(`--fallback: expected one of ${FALLBACK_MODES.join(', ')}, got "${value}"`);
    }
    return /** @type {import('./ui/mcpUnavailablePrompt.js').FallbackMode} */ (value);
}

/**
 * Resolve --debug-port into the first inspector port a :debug entry may use.
 *
 * A usage error (exit 2) for the same reason --target is: it is something the user
 * typed, and it is caught before the IDE is contacted rather than after two tabs are
 * already open. parsePort() is the port validator the MCP flags already use — a port is
 * a port, whoever is going to listen on it.
 *
 * @param {string | undefined} value
 * @returns {number}
 */
function resolveDebugPort(value) {
    if (value === undefined) return DEBUG_PORT_BASE;

    const port = parsePort(value);
    if (port === null) {
        throw new UsageError(`--debug-port: ${JSON.stringify(value)} is not a valid port (expected 1-${MAX_PORT})`);
    }
    return port;
}

/**
 * Whether the IDE offers `debug_run_configuration`, the wsc plugin's tool.
 *
 * A failure to list tools is "no", not an error: the plugin is optional, and the terminal
 * route it replaces still works, so a session that cannot answer must not stop a launch.
 *
 * @param {import('./mcp/client.js').McpClient} client
 * @param {ReturnType<typeof createLogger>} log
 * @returns {Promise<boolean>}
 */
async function hasDebugTool(client, log) {
    try {
        const tools = await client.listTools();
        return tools.some((tool) => tool.name === DEBUG_CONFIGURATION_TOOL);
    } catch (err) {
        log.debug(`could not list the IDE's tools (${/** @type {Error} */ (err).message}); assuming no debug tool`);
        return false;
    }
}

/**
 * Launch every entry of the plan.
 *
 * Still a named seam rather than inline code, even now that it is filled in: it is what
 * keeps the --dry-run guard in run() visible and lets tests assert that a dry run never
 * reaches a launch. The calls themselves were already built (and validated) in run(),
 * so nothing can fail here for a reason the user has not been shown yet.
 *
 * @param {import('./resolve.js').PlanEntry[]} plan
 * @param {{
 *   client: import('./mcp/client.js').McpClient,
 *   log: ReturnType<typeof createLogger>,
 *   calls: import('./exec/planBuilder.js').McpCall[],
 *   connectAs?: (name: string) => Promise<import('./mcp/client.js').McpClient>,
 * }} ctx
 * @returns {Promise<number>}
 */
async function executePlan(plan, ctx) {
    const { started, failed } = await runExecutionPlan(ctx.calls, ctx).catch((err) => {
        // KNOWN_ERRORS already keeps this from becoming a stack trace, but only here does
        // the CLI know enough to say what it means: the tabs that opened are unaffected,
        // and the run can simply be repeated for the rest.
        if (err instanceof Error && err.name === 'McpError') {
            throw new WscError(
                `the IDE stopped answering mid-launch (${err.message}).\n` +
                    '  Whatever already started is unaffected — check that WebStorm is still\n' +
                    '  running, then re-run wsc for the configurations that did not.',
            );
        }
        throw err;
    });

    if (failed.length === 0) {
        ctx.log.info(`started ${started.length} configuration(s)`);
        return 0;
    }

    // Each failure has already been reported with the IDE's own words by the runner;
    // this is the line that stops a partial launch from looking like a whole one.
    ctx.log.error(
        `started ${started.length} of ${plan.length} configuration(s) — ` +
            `failed: ${failed.map(({ call }) => call.name).join(', ')}`,
    );
    return 1;
}

/**
 * Errors that are reported as a plain message rather than a crash.
 *
 * FallbackError is the terminal fallback's own (src/fallback/errors.js). It is listed here
 * for the reason InvalidPortError, UnsupportedLaunchError and McpError each had to be added
 * after the fact: an error class that carries a message written for a human and is *not* in
 * this set reaches the user as a V8 stack trace through node_modules.
 */
const KNOWN_ERRORS = new Set([
    'PresetConfigError',
    'UnknownConfigurationError',
    'AmbiguousNameError',
    'McpToolError',
    'AmbiguousProjectError',
    'UnsupportedLaunchError',
    'FallbackError',
    // The handshake, as opposed to a tool call. Reachable whenever the IDE goes down
    // between discoverPort()'s probe and the connect, and whenever the best-effort range
    // scan hands back a port belonging to something else — and the SDK's own
    // StreamableHTTPError is named "Error", so without this it was a stack trace.
    'McpConnectError',
    // A get_run_configurations payload wsc cannot read — the plan's own top risk (the IDE's
    // tool signatures changing between WebStorm versions). It is a TypeError subclass, and
    // a bare TypeError reads as a bug in wsc, so it was rethrown as a stack trace.
    'RunConfigPayloadError',
    // The SDK's own class ("MCP error -32000: Connection closed", "-32001: Request timed
    // out"). Before phase 6 the only call was get_run_configurations and this was close to
    // unreachable; a launch makes it routine, and runExecutionPlan deliberately rethrows it.
    // Left out, every such failure dumped a V8 stack trace through node_modules at the user.
    'McpError',
    'WscError',
]);

/** A condition the CLI detects itself, reported without a stack trace. */
class WscError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'WscError';
    }
}

/**
 * @typedef {CliDeps & {
 *   stdout: NodeJS.WriteStream,
 *   stderr: NodeJS.WriteStream,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   log: ReturnType<typeof createLogger>,
 * }} RunDeps
 */

/**
 * Find the IDE's MCP Server, or decide what to do without it.
 *
 * Shared by every command that needs the IDE — a launch, --configure and --list — so that
 * `--fallback` means one thing everywhere and the retry loop, the TTY rule and the
 * give-up message cannot drift between them. What *happens* on the without-IDE branch is
 * left to the caller: for a launch it is OS terminal tabs, for --list the catalogue
 * WebStorm saved to .idea/, and only the caller can say which.
 *
 * @param {RunDeps} deps
 * @param {import('./args.js').CliValues} values
 * @param {import('./ui/mcpUnavailablePrompt.js').FallbackMode | undefined} fallback
 * @param {object} [opts]
 * @param {boolean} [opts.terminalAvailable] - false when there is no without-IDE path here
 * @param {string} [opts.withoutIdeLabel] - how the prompt names that path, when there is one
 * @returns {Promise<{ kind: 'port', port: number }
 *   | { kind: 'without-ide' }
 *   | { kind: 'exit', code: number }>}
 */
async function reachMcp(deps, values, fallback, opts = {}) {
    const { log, env, stdout } = deps;
    const discover = deps.discoverPort ?? discoverPort;
    const terminalAvailable = opts.terminalAvailable !== false;

    // The same lookup, wrapped so "try again" repeats it exactly. An InvalidPortError is a
    // malformed port the user typed, so it stays a usage error (exit 2) and never reaches
    // the retry prompt: no amount of retrying fixes --mcp-port=abc.
    const findPort = () => discover({ explicitPort: values['mcp-port'], env, log }).catch((err) => {
        if (err instanceof Error && err.name === 'InvalidPortError') throw new UsageError(err.message);
        throw err;
    });

    const port = await findPort();
    if (port !== null) return { kind: 'port', port };

    // A prompt is drawn only when both ends are a terminal. In a pipe or a CI job a
    // question waiting for an answer is indistinguishable from a hang — the same
    // reason --configure refuses without a TTY, but a different conclusion: here
    // there are documented flags to state the answer in advance, so the run ends
    // with a message naming them instead of just refusing.
    const interactive = Boolean((deps.stdin ?? process.stdin).isTTY && stdout.isTTY);

    // The plan's UX for this: a message with two options, never a silent fallback. A
    // select() has room for one line, so the explanation goes above it — and *only*
    // there, because every other way out of this branch already carries the same text
    // in its own message, and printing it twice teaches the user to skip past it.
    if (interactive && fallback === undefined) log.warn(MCP_SETUP_HELP);

    const outcome = await (deps.resolveFallbackChoice ?? resolveFallbackChoice)(
        { fallback, interactive, terminalAvailable },
        findPort,
        { log, withoutIdeLabel: opts.withoutIdeLabel },
    );

    if (outcome.kind === 'cancelled') return { kind: 'exit', code: CANCELLED_EXIT_CODE };
    if (outcome.kind === 'unavailable') {
        throw new WscError(mcpUnavailableMessage({ ...outcome, terminalAvailable }));
    }
    if (outcome.kind === 'terminal') return { kind: 'without-ide' };

    log.info(`MCP Server answered on ${outcome.port}`);
    return { kind: 'port', port: outcome.port };
}

/**
 * Open an MCP session, hand it to `body`, and close it afterwards — whatever happens.
 *
 * `return await body(...)`, never a bare `return body(...)`: in an async function a plain
 * `return p` inside try/finally runs the finally *before* p settles, so close() tears the
 * transport down while the work is still in flight and every call comes back "Connection
 * closed". That bug shipped twice — once mid-launch, once as the --configure screen drew
 * its first prompt — because each caller owned its own try/finally and had to remember.
 * One place owns it now, so a caller can return a promise the ordinary way.
 *
 * @template T
 * @param {RunDeps} deps
 * @param {number} port
 * @param {string} projectRoot
 * @param {(client: import('./mcp/client.js').McpClient) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withMcpSession(deps, port, projectRoot, body) {
    const { log } = deps;
    const client = await (deps.connectMcp ?? connectMcp)(port, { projectPath: projectRoot, log });

    try {
        return await body(client);
    } finally {
        // A failure to close must never replace the run's own outcome. The SDK rejects
        // every in-flight request when the transport goes down and then throws the same
        // error again from close(), so a launch that died mid-call would be reported as
        // a bare "Connection closed" from the finally block, with the real cause lost.
        await client.close().catch((err) => log.debug(`closing the MCP session failed: ${err.message}`));
    }
}

/**
 * `--list`: print the project's run configurations and stop.
 *
 * Neither the preset file nor any launch flag is consulted (run() rejects those up front),
 * so this reaches the IDE, prints, and returns. The unreachable-IDE decision is the same
 * one a launch makes — the difference is only what "continue without the IDE" means here,
 * which is why the prompt is told to say so.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {import('./args.js').CliValues} ctx.values
 * @param {import('./ui/mcpUnavailablePrompt.js').FallbackMode | undefined} ctx.fallback
 * @param {RunDeps} ctx.deps
 * @returns {Promise<number>} exit code
 */
async function runList({ projectRoot, values, fallback, deps }) {
    const { log } = deps;
    const reached = await reachMcp(deps, values, fallback, { withoutIdeLabel: LIST_WITHOUT_IDE_LABEL });

    if (reached.kind === 'exit') return reached.code;
    if (reached.kind === 'without-ide') {
        // Said before the listing, not after: a reader who sees 12 names has no way to
        // tell where they came from, and this listing is the one that can be out of date.
        log.warn('WebStorm is not answering — listing what it last saved to disk instead');
        return await listFromDisk(projectRoot, log);
    }

    return await withMcpSession(deps, reached.port, projectRoot, (client) => listFromIde(client, log));
}

/**
 * @param {string[]} argv
 * @param {RunDeps} deps
 * @returns {Promise<number>}
 */
async function run(argv, deps) {
    const { log, env, cwd, stdout } = deps;
    const { values, positionals: typed, presetUses } = parseCliArgs(argv);

    if (values.help) {
        stdout.write(HELP);
        return 0;
    }
    if (values.version) {
        log.out(pkg.version);
        return 0;
    }

    // Editing a preset and naming configurations to launch are different intents;
    // accepting both would silently ignore one of them. Checked before the IDE is
    // contacted so the mistake is reported instantly.
    if (values.configure && typed.length > 0) {
        // `wsc -c --preset a b` lands here too, and "no configuration names" would send
        // the user looking for the wrong mistake: `b` is meant as a second preset.
        const twoPresets = presetUses.some((use) => use.following.length > 0);
        throw new UsageError(
            '--configure takes no configuration names' +
                (twoPresets ? ' (and edits one preset at a time, so --preset cannot name two)' : ''),
        );
    }
    if (values.configure && (values.preset?.length ?? 0) > 1) {
        throw new UsageError('--configure edits one preset at a time, but --preset was given more than once');
    }

    // Same reasoning one level further: --configure launches nothing, so every flag that
    // only steers a launch would be quietly discarded. Only a flag the user actually
    // passed counts — parseArgs leaves an absent one out of `values` entirely, which is
    // why this is an own-key check and not `values.target !== undefined` twice over.
    if (values.configure) {
        const ignored = passedFlags(values, LAUNCH_ONLY_FLAGS);
        if (ignored.length > 0) {
            throw new UsageError(
                `--configure launches nothing, so ${ignored.map((flag) => `--${flag}`).join(' and ')} ` +
                    'would be ignored',
            );
        }
    }

    // --list is a third intent next to launching and configuring, so it gets the same
    // treatment both of those already give a command line that means two things at once:
    // say so, exit 2, and contact nothing. Naming configurations is the one that would
    // look most like it worked — `wsc --list web` prints all 13 either way — which is
    // exactly why it is refused rather than quietly ignored.
    if (values.list) {
        if (values.configure) {
            throw new UsageError('--list prints run configurations and --configure edits a preset; pick one');
        }
        if (typed.length > 0) {
            throw new UsageError('--list takes no configuration names: it prints every one of them');
        }

        const ignored = passedFlags(values, LIST_IGNORED_FLAGS);
        if (ignored.length > 0) {
            throw new UsageError(
                `--list prints the IDE's own catalogue, so ${ignored.map((flag) => `--${flag}`).join(' and ')} ` +
                    'would be ignored',
            );
        }
    }

    // Not part of LAUNCH_ONLY_FLAGS (see args.js): --configure needs the IDE too, so
    // --fallback=retry is meaningful there. Only the terminal half is not — there is no
    // launch to move into a terminal — and saying so beats silently ignoring it.
    const fallback = resolveFallback(values.fallback);
    if (values.configure && fallback === 'terminal') {
        throw new UsageError('--configure has nothing to launch in a terminal; --fallback=retry waits for the IDE');
    }

    // ── Project and preset (no IDE needed yet) ───────────────────────────────
    const target = resolveTarget(values.target);
    const debugPortBase = resolveDebugPort(values['debug-port']);
    const projectRoot = await resolveProjectRoot(values.project, cwd);

    // Ahead of readPresets, deliberately: a listing is the IDE's own catalogue, so a
    // preset file that is missing, empty or hand-edited into something unparseable has no
    // bearing on it — and refusing to list because of one would break --list in exactly
    // the project where it is most wanted, the one that is not configured yet.
    if (values.list) return await runList({ projectRoot, values, fallback, deps });

    const config = await readPresets(projectRoot);
    // `--preset a b` and `--preset a --preset b` name several presets, launched together as
    // if they were one: entries in the order given, and a configuration in more than one
    // keeps its first position with the last mode — the rule buildLaunchPlan() already has
    // for a command-line name that overrides the preset's. Split here, not in parseCliArgs,
    // because telling `b` the preset from `b` the configuration takes the file just read.
    const explicitPreset = values.preset !== undefined;
    const split = splitPresetNames(typed, presetUses, (name) => hasPreset(config, name));
    const positionals = split.positionals;
    const presetNames = explicitPreset ? split.presets : [config.defaultPreset];
    // Only a label from here on (messages, the fallback's hand-over): --configure, the one
    // caller that uses it as a key, has exactly one name.
    const presetName = presetNames.join(' + ');
    const knownPresets = Object.keys(config.presets);
    const missingPresets = presetNames.filter((name) => !hasPreset(config, name));

    if (missingPresets.length > 0) {
        const hint = knownPresets.length > 0
            ? `known presets: ${knownPresets.join(', ')}`
            : 'no presets configured yet';

        if (explicitPreset && !values.configure) {
            throw new WscError(`unknown preset "${missingPresets[0]}" (${hint})`);
        }

        // A default that names nothing is a broken config, not an empty one — but only
        // fatal when it was the sole source of work. A project with no presets at all
        // is just unconfigured, and the emptier message below explains that better.
        if (knownPresets.length > 0 && !values.configure) {
            const detail = `defaultPreset "${presetName}" does not exist in ${configPath(projectRoot)} (${hint})`;
            if (positionals.length === 0) throw new WscError(detail);
            log.warn(`${detail}; launching only what you named`);
        }
    }

    const presetEntries = presetNames.flatMap((name) => getPreset(config, name));
    log.debug(`project ${projectRoot}, preset "${presetName}" (${presetEntries.length} entries)`);

    // ── Talk to the IDE ──────────────────────────────────────────────────────
    // --configure edits a preset; there is nothing a terminal could do for it.
    const reached = await reachMcp(deps, values, fallback, { terminalAvailable: !values.configure });

    if (reached.kind === 'exit') return reached.code;
    if (reached.kind === 'without-ide') {
        // The one line the fallback path would otherwise not say: without it, terminal
        // windows opening instead of IDE tabs looks like wsc simply misbehaving.
        log.warn('WebStorm is not answering — launching without IDE tabs');

        // The positional tokens are handed over raw, unsplit. Deciding whether
        // `api > repro:stale-job:debug` is a name or a debug request needs the
        // list of real names, and here there is none — but the fallback reads its own
        // list off disk (.idea/workspace.xml), so it can do the split properly a
        // moment later. Splitting it here would throw that away.
        //
        // dryRun travels with it because this branch returns *before* the --dry-run
        // guard further down: the fallback owns the other half of that promise.
        return await (deps.runTerminalFallback ?? runTerminalFallback)({
            presetName,
            presetEntries,
            positionals,
            projectRoot,
            debugPortBase,
            dryRun: Boolean(values['dry-run']),
            env,
            log,
        });
    }

    return await withMcpSession(deps, reached.port, projectRoot, async (client) => {
        const configs = normalizeRunConfigs(await client.callTool('get_run_configurations'));
        log.debug(`${configs.length} run configurations reported by the IDE`);

        // Knowing the real names is what lets a name ending in ":debug" stay intact.
        const known = new Set(configs.map((entry) => entry.name));
        const requests = parseRequests(positionals, { isKnownName: (name) => known.has(name) });

        if (values.configure) {
            // Before buildLaunchPlan: an empty or broken preset is exactly what the
            // user is here to fix, so it must not be a precondition.
            //
            // The session outlives this call — withMcpSession() awaits whatever this
            // function returns before closing it. That used to be each caller's job, and
            // was got wrong twice: a bare `return p` inside try/finally runs the finally
            // *before* p settles, which closed the transport the instant the first prompt
            // was drawn, and mid-launch on the path below.
            return (deps.runConfigure ?? runConfigure)({
                configs,
                config,
                presetName,
                projectRoot,
                log,
                stdin: deps.stdin ?? process.stdin,
                stdout: deps.stdout ?? process.stdout,
            });
        }

        const plan = buildLaunchPlan({ configs, preset: presetEntries, requests });
        if (plan.length === 0) {
            throw new WscError(
                `nothing to launch: preset "${presetName}" is empty and no configuration was named.\n` +
                    '  Pass configuration names, or configure a preset with --configure.',
            );
        }

        // The IDE can debug a configuration itself only with the wsc plugin's tool, so ask
        // rather than assume. Only worth a round trip when the plan has a :debug entry.
        const debugTool = plan.some((entry) => entry.mode === 'debug') && (await hasDebugTool(client, log));

        // A command line — for --target=terminal, and for every :debug without the plugin's
        // tool, which then has nowhere else to go — is rebuilt from what WebStorm saved to
        // .idea/, not from the configuration's name: MCP reports no script, directory or
        // environment, and the name-shaped guess is wrong for 12 of demo-app's 13
        // configurations. See src/exec/ideaCommands.js. Read only when a command is
        // actually needed, so the default run-window path pays nothing for it.
        const commandFor = needsTerminalCommands(plan, target, { debugTool })
            ? ideaCommandResolver(
                await (deps.readIdeaRunConfigs ?? readIdeaRunConfigs)(projectRoot),
                projectRoot,
            )
            : undefined;

        // Built here rather than inside the seam so that it is validated on the --dry-run
        // path too, and so an unlaunchable entry is reported before the first tab opens.
        const calls = buildExecutionPlan({ plan, target, debugPortBase, debugTool, commandFor });

        // One port per debug entry counts upwards, so a high --debug-port can run out of
        // range. Reported as the usage error it is, before anything starts.
        const debugPorts = debugPortsOf(calls);
        const overflow = debugPorts.filter((port) => port > MAX_PORT);
        if (overflow.length > 0) {
            throw new UsageError(
                `--debug-port ${debugPortBase}: ${debugPorts.length} :debug entries need ports up to ` +
                    `${debugPorts[debugPorts.length - 1]}, past the highest port there is (${MAX_PORT})`,
            );
        }

        // Under run-window, a :terminal entry is the one place the header would otherwise be
        // untrue; --target=terminal already says the whole run is a terminal run.
        const via = target === 'run-window' && plan.some((entry) => entry.mode === 'terminal')
            ? `${target} + terminal`
            : target;
        log.info(`${values['dry-run'] ? 'would launch' : 'launching'} ${plan.length} configuration(s) via ${via}:`);
        log.out(formatPlan(plan));
        const notes = executionNotes(calls);
        for (const note of notes) log.warn(note);
        // A note here means :debug was rerouted to the terminal; the plugin is the way out.
        if (notes.length > 0) log.warn(DEBUG_PLUGIN_HINT);

        // Said before the launch, like every other note: a guessed command line is the one
        // thing on this path that can open a tab which dies immediately.
        const guessed = guessedCommands(calls);
        if (guessed.length > 0) log.warn(guessedCommandNote(guessed));

        // Ahead of the --dry-run guard: a dry run is a real check of the launch, and a
        // port that is already taken is exactly the kind of thing it should surface.
        await warnBusyDebugPorts(debugPorts, log);

        // --dry-run returns *before* the execution seam. The guard stays here, ahead of
        // every side effect, now that executePlan() really launches things: the two tests
        // named "--dry-run … execution seam" fail if it is ever moved or inlined.
        if (values['dry-run']) {
            log.out(formatExecutionPlan(calls));
            return 0;
        }

        // The MCP session is still open here, and stays open until this promise settles:
        // see withMcpSession().
        // A Terminal tab is titled after the MCP client that opened it, so each one gets a
        // session called by its configuration's name — see runExecutionPlan().
        const connectAs = (/** @type {string} */ name) =>
            (deps.connectMcp ?? connectMcp)(reached.port, { projectPath: projectRoot, clientName: name, log });
        return (deps.executePlan ?? executePlan)(plan, { client, log, calls, connectAs });
    });
}
