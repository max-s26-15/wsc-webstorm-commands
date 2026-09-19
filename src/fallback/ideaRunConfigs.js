/**
 * The IDE's run configurations, read from disk instead of over MCP.
 *
 * Why this file exists at all
 *   Every phase from 3 onward resolves names against what `get_run_configurations`
 *   reports. With the MCP Server unreachable there is no such list — and without it the
 *   fallback would have to *guess* what `web` means, which is precisely what
 *   src/resolve.js exists to prevent.
 *
 *   WebStorm does write its run configurations to disk, though, in the project we already
 *   require to have a `.idea/`:
 *     .idea/workspace.xml            → <component name="RunManager">          (private)
 *     .idea/runConfigurations/*.xml  → <component name="ProjectRunConfigurationManager">
 *                                                                             (shared)
 *   Together they are the same 13 configurations `get_run_configurations` returns for the
 *   demo-app test project — same names, in the same two flavours (npm, Node.js).
 *
 * Why not package.json
 *   Because the names do not match, and silently launching the wrong script is worse than
 *   refusing. In demo-app the configuration called `web` runs the script `dev` in
 *   `web/package.json`; there is no `web` script anywhere. A catalogue built from
 *   package.json would therefore know a name the user has never seen (`dev`) and not know
 *   the one they have (`web`).
 *
 * What this buys over the MCP path
 *   MCP reports only `{name, description}`, so src/exec/planBuilder.js has to rebuild the
 *   command line from the *shape of the name* (`client > bundle:build` → `cd client && npm
 *   run bundle:build`). The XML carries the real thing — package.json path, npm command,
 *   script, arguments, environment, interpreter — so nothing has to be inferred here.
 *
 * Staleness is the trade-off, and it is the honest one: workspace.xml is the IDE's own
 * saved state, so a configuration created seconds ago may not be in it yet. That only ever
 * means "wsc does not know that name", never "wsc launched the wrong thing".
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEBUG_PORT_BASE, debugEnvPrefix, shellQuote } from '../exec/planBuilder.js';
import { CONFIG_DIR } from '../presets/store.js';
import { FallbackError } from './errors.js';
import { resolveProjectNode } from './projectNode.js';

/** Directory holding shared (checked-in) run configurations. */
export const SHARED_DIR = 'runConfigurations';

/** File holding the IDE's private per-user state, including its own run configurations. */
export const WORKSPACE_FILE = 'workspace.xml';

/**
 * Where these run configurations come from, spelled out for every message that has to
 * name it — the fallback launch, and `--list` without the IDE. One string, because both
 * are telling the user the same thing: this is the IDE's saved state, not the IDE.
 */
export const DISK_SOURCE = `${CONFIG_DIR}/${WORKSPACE_FILE} and ${CONFIG_DIR}/${SHARED_DIR}/`;

/** The two components that hold `<configuration>` elements. Anything else is ignored. */
export const COMPONENTS = ['ProjectRunConfigurationManager', 'RunManager'];

/** IntelliJ type ids this CLI can turn back into a command line. */
export const NPM_TYPE = 'js.build_tools.npm';
export const NODE_TYPE = 'NodeJSConfigurationType';

/**
 * `description` values the IDE reports over MCP for the two supported types.
 *
 * Copied verbatim from a live `get_run_configurations` payload (see
 * test/fixtures/run-configurations.json) so a configuration read off disk is
 * indistinguishable from one reported by the IDE — same field, same spelling — and error
 * messages read the same on both paths.
 */
const DESCRIPTIONS = { [NPM_TYPE]: 'npm', [NODE_TYPE]: 'Node.js' };

/** npm subcommand that takes a script name; every other one is run bare (`npm install`). */
const NPM_RUN = 'run';

/**
 * What to do about a configuration that cannot be rebuilt — on the path this file was
 * written for, where the MCP Server is down and starting it is the whole answer.
 *
 * A parameter (`opts.advice`) rather than a hard-coded line, because the same rebuilding is
 * now also used *with* the IDE running: src/exec/ideaCommands.js reads the real definition
 * off disk for `--target=terminal` and `:debug` instead of guessing it from the name, and
 * telling that user to "start the MCP Server" would name the one thing already true.
 */
export const START_MCP_ADVICE = '  Start the MCP Server and re-run, so the IDE launches it itself.';

/**
 * What a shell accepts on the left of a `NAME=value` command prefix.
 *
 * This one field cannot be made safe by quoting the way every other one is: `'A B'=x` is
 * not an assignment to a shell, it is a command called `A B=x`, so a quoted name would
 * change what the line *does* rather than what it contains. Since these files are read
 * from a repository — `.idea/runConfigurations/*.xml` is normally checked in — a name that
 * is not a plain identifier is refused instead of pasted in.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @typedef {object} IdeaRunConfig
 * @property {string} name - exactly as the IDE shows it, `&gt;` already decoded
 * @property {string} description - 'npm' / 'Node.js' / the raw type id when unsupported
 * @property {string} type - the IntelliJ type id
 * @property {string} [dir] - absolute working directory
 * @property {string} [command] - npm subcommand ('run', 'install', …)
 * @property {string[]} [scripts] - npm scripts, in the order the IDE runs them
 * @property {string} [file] - absolute entry file (Node.js configurations)
 * @property {string} [args] - the configuration's own argument string, verbatim
 * @property {string} [interpreter] - absolute path to the node the IDE would use: the one the
 *   configuration pins, else the project's (`.nvmrc`), which readIdeaRunConfigs() fills in
 * @property {string} [nodeArgs] - Node parameters (Node.js configurations): flags for `node`
 *   itself, as typed into the IDE
 * @property {Record<string, string>} [envs]
 */

/**
 * Decode the XML entities IntelliJ writes.
 *
 * `&gt;` is not decoration here: every generated name with a package prefix contains one
 * (`client &gt; bundle:build`), and a name that stays encoded matches nothing the user
 * could type.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeXml(value) {
    return value
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        // Last, so that an escaped ampersand cannot re-form another entity.
        .replaceAll('&amp;', '&');
}

/**
 * Expand the path macros IntelliJ stores instead of absolute paths.
 *
 * @param {string} value
 * @param {{ projectRoot: string, homeDir: string }} ctx
 * @returns {string}
 */
function expandMacros(value, ctx) {
    return value
        .replaceAll('$PROJECT_DIR$', ctx.projectRoot)
        // $MODULE_DIR$ is the module's own root; in a single-module JS project — which is
        // every project WebStorm opens this way — that is the project root.
        .replaceAll('$MODULE_DIR$', ctx.projectRoot)
        .replaceAll('$USER_HOME$', ctx.homeDir);
}

/**
 * Attributes of a single start tag.
 *
 * @param {string} tag - everything between `<configuration` and `>`
 * @returns {Record<string, string>}
 */
function attributes(tag) {
    /** @type {Record<string, string>} */
    const attrs = Object.create(null);
    for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        attrs[match[1]] = decodeXml(match[2]);
    }
    return attrs;
}

/**
 * The `value="…"` of a child element, e.g. `<command value="run" />`.
 *
 * @param {string} body
 * @param {string} tag
 * @returns {string | undefined}
 */
function childValue(body, tag) {
    const match = new RegExp(`<${tag}\\s+value="([^"]*)"`).exec(body);
    return match === null ? undefined : decodeXml(match[1]);
}

/**
 * The body of one `<component name="…">`.
 *
 * Non-greedy up to the first `</component>` is exact rather than approximate: IntelliJ
 * components never nest.
 *
 * @param {string} xml
 * @param {string} name
 * @returns {string | null}
 */
function componentBody(xml, name) {
    const match = new RegExp(`<component\\s+name="${name}"[^>]*>([\\s\\S]*?)</component>`).exec(xml);
    return match === null ? null : match[1];
}

/**
 * Read every `<configuration>` element of a `.idea` XML file.
 *
 * Parsed with regular expressions rather than an XML library, deliberately: the shape is
 * a handful of fixed elements written by one program, adding a dependency for it would be
 * out of proportion, and every value IntelliJ writes is attribute-encoded — so no raw `<`
 * or `>` can appear inside the attributes this scanner cuts on (`client &gt; bundle:build`
 * is stored encoded, which is exactly why decodeXml() runs afterwards).
 *
 * @param {string} xml - the whole file
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.homeDir]
 * @returns {IdeaRunConfig[]}
 */
export function parseRunConfigurations(xml, ctx) {
    const macros = { projectRoot: ctx.projectRoot, homeDir: ctx.homeDir ?? os.homedir() };
    // Comments could otherwise contribute a disabled configuration somebody kept "just in
    // case", which the IDE does not show either.
    const clean = xml.replace(/<!--[\s\S]*?-->/g, '');

    /** @type {IdeaRunConfig[]} */
    const found = [];

    for (const component of COMPONENTS) {
        const body = componentBody(clean, component);
        if (body === null) continue;

        for (const match of body.matchAll(/<configuration\b([^>]*?)(\/>|>([\s\S]*?)<\/configuration>)/g)) {
            const config = toRunConfig(attributes(match[1]), match[3] ?? '', macros);
            if (config !== null) found.push(config);
        }
    }

    // workspace.xml lists the same configuration several times (the RunManager body, then
    // again under <recent_temporary>), so first-wins deduplication by name is required
    // rather than tidy. It also matches resolveName(), which takes the first exact hit —
    // the same thing the IDE's own dropdown does with duplicate names.
    const seen = new Set();
    return found.filter(({ name }) => !seen.has(name) && seen.add(name));
}

/**
 * Turn one parsed `<configuration>` into an IdeaRunConfig.
 *
 * @param {Record<string, string>} attrs
 * @param {string} body
 * @param {{ projectRoot: string, homeDir: string }} macros
 * @returns {IdeaRunConfig | null} null for anything that is not a real configuration
 */
function toRunConfig(attrs, body, macros) {
    // `default="true"` entries are the templates behind the IDE's "Edit configuration
    // templates…" screen. They have no name and launch nothing.
    if (attrs.default === 'true' || !attrs.name || !attrs.type) return null;

    const expand = (/** @type {string | undefined} */ value) =>
        (value === undefined ? undefined : expandMacros(value, macros));

    /** @type {IdeaRunConfig} */
    const config = {
        name: attrs.name,
        // An unsupported type keeps its raw id, so the refusal can name what it is.
        description: DESCRIPTIONS[attrs.type] ?? attrs.type,
        type: attrs.type,
    };

    const envs = readEnvs(body, macros);
    if (envs !== undefined) config.envs = envs;

    if (attrs.type === NPM_TYPE) {
        // The package.json path is what makes this better than the MCP path: it is the
        // directory the script actually runs in, not one inferred from the name.
        const packageJson = expand(childValue(body, 'package-json'));
        if (packageJson !== undefined) config.dir = path.dirname(packageJson);
        config.command = childValue(body, 'command') ?? NPM_RUN;
        config.scripts = [...body.matchAll(/<script\s+value="([^"]*)"/g)].map((m) => decodeXml(m[1]));

        const args = childValue(body, 'arguments');
        if (args) config.args = args;

        // "project" means "whatever the project default is" — not a path to pin here;
        // readIdeaRunConfigs() resolves it afterwards, from .nvmrc.
        const interpreter = expand(childValue(body, 'node-interpreter'));
        if (interpreter !== undefined && path.isAbsolute(interpreter)) config.interpreter = interpreter;
        return config;
    }

    if (attrs.type === NODE_TYPE) {
        const file = expand(attrs['path-to-js-file']);
        if (file !== undefined) config.file = file;
        config.dir = expand(attrs['working-dir']) ?? (file === undefined ? undefined : path.dirname(file));

        const args = attrs['application-parameters'];
        if (args) config.args = args;

        const nodeArgs = attrs['node-parameters'];
        if (nodeArgs) config.nodeArgs = nodeArgs;

        const interpreter = expand(attrs['path-to-node']);
        if (interpreter !== undefined && path.isAbsolute(interpreter)) config.interpreter = interpreter;
        return config;
    }

    return config;
}

/**
 * @param {string} body
 * @param {{ projectRoot: string, homeDir: string }} macros
 * @returns {Record<string, string> | undefined}
 */
function readEnvs(body, macros) {
    const entries = [...body.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"/g)].map((match) => [
        decodeXml(match[1]),
        expandMacros(decodeXml(match[2]), macros),
    ]);

    // Object.fromEntries, per the house rule: an env var may legally be called
    // `__proto__`, and `obj[name] = value` would then mutate the prototype instead.
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Read every run configuration WebStorm has saved for a project.
 *
 * Shared configurations come first because that is the order the IDE reports them in over
 * MCP, and it is the order a `--dry-run` listing is easiest to compare against.
 *
 * A missing or unreadable file is not an error: a project may have no shared
 * configurations, or no workspace.xml yet. "Nothing was found" is reported by the caller,
 * which is the only place that knows whether anything was actually needed.
 *
 * @param {string} projectRoot
 * @param {object} [opts]
 * @param {string} [opts.homeDir] - injected in tests, so $USER_HOME$ is predictable
 * @param {NodeJS.ProcessEnv} [opts.env] - injected in tests, so the developer's `$NVM_DIR` cannot leak in
 * @returns {Promise<IdeaRunConfig[]>}
 */
export async function readIdeaRunConfigs(projectRoot, opts = {}) {
    const ideaDir = path.join(projectRoot, CONFIG_DIR);
    const ctx = { projectRoot, homeDir: opts.homeDir ?? os.homedir() };

    const sharedDir = path.join(ideaDir, SHARED_DIR);
    const sharedNames = await fs.readdir(sharedDir).catch(() => /** @type {string[]} */ ([]));
    const files = [
        ...sharedNames.filter((name) => name.endsWith('.xml')).sort().map((name) => path.join(sharedDir, name)),
        path.join(ideaDir, WORKSPACE_FILE),
    ];

    /** @type {IdeaRunConfig[]} */
    const configs = [];
    for (const file of files) {
        const xml = await fs.readFile(file, 'utf8').catch(() => null);
        if (xml !== null) configs.push(...parseRunConfigurations(xml, ctx));
    }

    // Same first-wins rule as within a file: a configuration can be both shared and
    // remembered in workspace.xml, and the shared copy is the authoritative one.
    const seen = new Set();
    const unique = configs.filter(({ name }) => !seen.has(name) && seen.add(name));

    // A configuration that pins no interpreter (`path-to-node` absent, or `project`) runs on
    // the IDE's "Project node" — .nvmrc, for an nvm project. Resolved once here, not per
    // configuration and not in the parser, which stays free of disk access. Left unset when
    // there is nothing to resolve, which keeps the tab on the shell's own PATH as before.
    const projectNode = await resolveProjectNode(projectRoot, { homeDir: ctx.homeDir, env: opts.env });
    if (projectNode === undefined) return unique;
    return unique.map((config) => (config.interpreter === undefined ? { ...config, interpreter: projectNode } : config));
}

/**
 * Rebuild the command line a run configuration stands for.
 *
 * The counterpart of buildTerminalCommand() in src/exec/planBuilder.js, and deliberately
 * not a call into it: that one reconstructs a command from the *name* because MCP gives it
 * nothing else, while here the package.json path, the script and the environment are all
 * known exactly. Reusing it would mean throwing away better data to reproduce a guess.
 * What *is* reused is everything that is genuinely shared — shellQuote() and
 * debugEnvPrefix(), so a fallback command quotes and debugs identically to an IDE one.
 *
 * @param {IdeaRunConfig} config
 * @param {'run' | 'debug'} mode
 * @param {object} opts
 * @param {string} opts.projectRoot - commands are emitted relative to it, since every tab
 *   is opened there
 * @param {number} [opts.debugPort]
 * @param {string} [opts.advice] - the indented line a refusal ends with; defaults to
 *   START_MCP_ADVICE, which is only true when the IDE is unreachable
 * @returns {string}
 * @throws {FallbackError} for a configuration type this CLI cannot express as a command
 */
export function buildFallbackCommand(config, mode, opts) {
    const advice = opts.advice ?? START_MCP_ADVICE;
    const parts = [];

    const dir = relativeDir(config.dir, opts.projectRoot);
    if (dir !== null) parts.push(`cd ${shellQuote(dir)} &&`);

    // The IDE pins an interpreter per configuration (an nvm path, typically); a terminal
    // has whatever the shell's PATH says. Putting the pinned bin directory first
    // reproduces the IDE's choice for both `node` and `npm`. A directory that no longer
    // exists — an nvm version since removed — is ignored by every shell, so this degrades
    // to "use PATH" instead of breaking the tab.
    if (config.interpreter) parts.push(`PATH=${shellQuote(path.dirname(config.interpreter))}:"$PATH"`);

    // Only the *value* can be quoted here; see ENV_NAME for why the name has to be
    // checked instead. config.args below is the single field that is deliberately left
    // raw, and it is raw because it is shell text the user typed — nothing else on this
    // line is exempt.
    for (const [name, value] of Object.entries(config.envs ?? {})) {
        if (!ENV_NAME.test(name)) {
            throw new FallbackError(
                `cannot rebuild a command for "${config.name}": its environment variable ` +
                    `${JSON.stringify(name)} is not a plain identifier, and wsc will not paste that into ` +
                    `a shell command line.\n${advice}`,
            );
        }
        parts.push(`${name}=${shellQuote(value)}`);
    }

    // Never quoted (see debugEnvPrefix): quoting is what would stop `$NODE_OPTIONS` from
    // expanding, and the whole point is to extend the shell's own value rather than
    // replace it. Nothing attaches to the resulting inspector here — the CLI says so.
    if (mode === 'debug') parts.push(debugEnvPrefix(opts.debugPort ?? DEBUG_PORT_BASE));

    parts.push(...programArgv(config, mode, advice));
    return parts.join(' ');
}

/**
 * The program half of the command line — everything after the env assignments.
 *
 * @param {IdeaRunConfig} config
 * @param {'run' | 'debug'} mode
 * @param {string} advice - the indented line a refusal ends with
 * @returns {string[]}
 */
function programArgv(config, mode, advice) {
    // The configuration's own arguments are shell text the user typed into the IDE, so
    // they are appended verbatim: quoting them would turn `--port 3000` into one word.
    // This is the only field on the line that is not quoted or validated — everything
    // else comes out of the XML as a single word and is treated as one.
    const args = config.args ? [config.args] : [];

    if (config.type === NPM_TYPE) {
        const command = config.command ?? NPM_RUN;
        const scripts = config.scripts ?? [];

        // Only `npm run` takes a script name; `npm install` / `npm test` are complete on
        // their own, and the IDE stores no script for them.
        // Quoted for the same reason the script name below is: it is one word chosen from
        // the IDE's own dropdown, and `npm 'install'` runs exactly like `npm install`, so
        // quoting costs nothing and stops a hand-edited `install; …` from being two
        // commands.
        if (command !== NPM_RUN) return ['npm', shellQuote(command), ...args];

        if (scripts.length !== 1) {
            throw new FallbackError(
                `cannot rebuild a command for "${config.name}": it runs ${scripts.length} npm scripts ` +
                    `(${scripts.join(', ') || 'none'}), and wsc only knows how to rebuild a single one.\n` +
                    advice,
            );
        }
        // `npm run x -- --flag` is npm's documented way of passing arguments through to
        // the script, and the only one that works on every npm since 6.
        return ['npm', 'run', shellQuote(scripts[0]), ...(args.length > 0 ? ['--', ...args] : [])];
    }

    if (config.type === NODE_TYPE) {
        if (config.file === undefined) {
            throw new FallbackError(
                `cannot rebuild a command for "${config.name}": it names no file to run.\n${advice}`,
            );
        }
        // Relative to the directory the command already cd-ed into, not just the file
        // name: demo-app's one Node.js configuration runs `api/scripts/…js` with a
        // working directory of `api`, so a basename would point at nothing.
        const file = config.dir === undefined ? config.file : path.relative(config.dir, config.file);
        // `node` rather than the pinned interpreter path: PATH already points at it (see
        // buildFallbackCommand), and a bare `node` is what the user would type.
        // Node parameters are flags for node itself, so they go before the file; like
        // `args` they are shell text the user typed, and are appended raw for the same reason.
        const nodeArgs = config.nodeArgs ? [config.nodeArgs] : [];
        return ['node', ...nodeArgs, shellQuote(toPosix(file)), ...args];
    }

    const what = mode === 'debug' ? `cannot debug "${config.name}"` : `cannot launch "${config.name}"`;
    throw new FallbackError(
        `${what}: wsc rebuilds a shell command line for OS terminal tabs, and only ` +
            `knows how to do that for npm and Node.js configurations (this one is "${config.description}").\n` +
            advice,
    );
}

/**
 * Where a configuration runs, relative to the project root.
 *
 * @param {string | undefined} dir - absolute
 * @param {string} projectRoot
 * @returns {string | null} null when it is the project root itself, so no `cd` is emitted
 */
function relativeDir(dir, projectRoot) {
    if (dir === undefined) return null;

    const relative = path.relative(projectRoot, dir);
    if (relative === '' || relative === '.') return null;

    return toPosix(relative);
}

/**
 * POSIX separators: the command is handed to bash even on Windows (see
 * src/fallback/terminalTabs.js), where path.relative produces backslashes — and a
 * backslash is an escape character to a shell, not a separator.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
    return value.split(path.sep).join('/');
}
