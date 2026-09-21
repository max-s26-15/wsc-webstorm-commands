/**
 * Preset storage — .idea/webstorm-commands.json.
 *
 * The file lives in .idea/ for convenience (it travels with the project and the IDE
 * ignores files it does not own), but it is ours: the IDE never reads or rewrites it.
 *
 * Writes are atomic. A preset write can coincide with the IDE indexing .idea/, with a
 * second `wsc` invocation, or with the user pressing Ctrl-C — none of which may leave a
 * half-written config behind, because a corrupt config means the CLI can no longer tell
 * the user what it was about to launch.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MODES } from '../modes.js';

/** Directory the config lives in, relative to the project root. */
export const CONFIG_DIR = '.idea';

/** Config file name. Deliberately not `.iml`/`workspace.xml`-adjacent — this is not IDE state. */
export const CONFIG_FILE = 'webstorm-commands.json';

/** Schema version written by this build. Bumped only on a breaking layout change. */
export const SCHEMA_VERSION = 1;

/** Name used when no preset is requested. */
export const DEFAULT_PRESET = 'default';

// The launch modes a preset entry may carry — the same list the command line accepts.
export { MODES };

/**
 * @typedef {{
 *   name: string,
 *   mode: import('../modes.js').LaunchMode,
 *   commands?: string[],
 *   [extra: string]: unknown,
 * }} PresetEntry
 * @typedef {{
 *   version: number,
 *   defaultPreset: string,
 *   presets: Record<string, PresetEntry[]>,
 *   [extra: string]: unknown,
 * }} PresetConfig
 */

/** A config file that exists but cannot be used. Always carries the path to fix. */
export class PresetConfigError extends Error {
    /**
     * @param {string} filePath
     * @param {string} detail
     */
    constructor(filePath, detail) {
        super(`${filePath}: ${detail}`);
        this.name = 'PresetConfigError';
        this.filePath = filePath;
        this.detail = detail;
    }
}

/**
 * Control characters: C0 except TAB, DEL, and C1. A custom entry's name and commands are
 * printed straight to the terminal (the plan, the announcement), so a newline could forge
 * lines of that output and an escape sequence could clear it; a tab is harmless and shell
 * text has a use for it. Newline and carriage return are in the set, which is what keeps
 * every command on one line.
 */
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/;

/**
 * An entry that runs shell commands of its own instead of naming a run configuration.
 *
 * The parser and the `--configure` screen (checkbox, save) ask this. Downstream of the
 * parser the entry has already been told apart by a cheaper test of the same fact: the
 * launch plan branches on `commands !== undefined` in `buildLaunchPlan()` and every later
 * stage on `isCustomPlanEntry()` (`'commands' in entry`) in `resolve.js`, because by then an
 * entry either carries a validated `commands` array or has no such key at all.
 *
 * @param {PresetEntry} entry
 * @returns {entry is PresetEntry & { commands: string[] }}
 */
export function isCustomEntry(entry) {
    return Array.isArray(entry.commands);
}

/** @returns {PresetConfig} a config with nothing configured yet */
export function emptyConfig() {
    return { version: SCHEMA_VERSION, defaultPreset: DEFAULT_PRESET, presets: {} };
}

/**
 * Walk up from a directory looking for the project root (the one containing .idea/).
 *
 * @param {string} startDir
 * @returns {Promise<string | null>}
 */
export async function findProjectRoot(startDir = process.cwd()) {
    let dir = path.resolve(startDir);

    for (;;) {
        try {
            const stats = await fs.stat(path.join(dir, CONFIG_DIR));
            if (stats.isDirectory()) return dir;
        } catch {
            // Not here; keep walking up.
        }

        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * @param {string} projectRoot
 * @returns {string} absolute path to the config file
 */
export function configPath(projectRoot) {
    return path.join(projectRoot, CONFIG_DIR, CONFIG_FILE);
}

/**
 * Upgrades from one schema version to the next.
 *
 * Keyed by the version being migrated *from*, so `MIGRATIONS[0]` turns a v0 config
 * into a v1 one. Migrations run on loosely-shaped data, before strict validation —
 * handling an old layout is exactly their job.
 *
 * @type {Record<number, (config: any) => any>}
 */
export const MIGRATIONS = {
    /**
     * v0 → v1: entries were bare configuration names.
     *
     * v0 is "written before versioning existed", which also covers a config a user
     * hand-wrote as `{"presets": {"default": ["web", "api"]}}` — the obvious
     * shorthand. Both become full entries defaulting to run mode.
     */
    0: (config) => ({
        ...config,
        presets: Object.fromEntries(
            Object.entries(config.presets).map(([name, entries]) => [
                name,
                Array.isArray(entries)
                    ? entries.map((entry) => (typeof entry === 'string' ? { name: entry, mode: 'run' } : entry))
                    : entries, // left alone so the validator can report it properly
            ]),
        ),
    }),
};

/**
 * Bring a config up to the current schema, one version at a time.
 *
 * Migration happens in memory on read; the upgraded file only reaches disk on the
 * next explicit write. Rewriting a project's config as a side effect of reading it
 * would be a surprising thing for a CLI to do.
 *
 * @param {any} config - must already have a numeric `version`
 * @param {string} filePath - for error messages
 * @returns {any}
 */
export function migrateConfig(config, filePath = configPath('.')) {
    let current = config;

    while (current.version < SCHEMA_VERSION) {
        const migrate = MIGRATIONS[current.version];
        if (!migrate) {
            throw new PresetConfigError(filePath, `no migration path from schema version ${current.version}`);
        }
        current = { ...migrate(current), version: current.version + 1 };
    }

    return current;
}

/**
 * Parse and validate raw config text.
 *
 * Invalid input throws instead of falling back to defaults: silently replacing a
 * config the user hand-edited would delete their work at the exact moment they
 * most want to know what went wrong.
 *
 * @param {string} text
 * @param {string} [filePath] - only used in error messages
 * @returns {PresetConfig}
 */
export function parseConfig(text, filePath = configPath('.')) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new PresetConfigError(filePath, `invalid JSON (${err.message})`);
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new PresetConfigError(filePath, 'expected a JSON object at the top level');
    }

    const { version, defaultPreset, presets, ...unknown } = raw;

    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version))) {
        throw new PresetConfigError(filePath, `"version" must be an integer, got ${JSON.stringify(version)}`);
    }
    if (typeof version === 'number' && version > SCHEMA_VERSION) {
        throw new PresetConfigError(
            filePath,
            `written by a newer version of wsc (schema ${version}, this build understands ${SCHEMA_VERSION})`,
        );
    }
    if (defaultPreset !== undefined && typeof defaultPreset !== 'string') {
        throw new PresetConfigError(filePath, '"defaultPreset" must be a string');
    }
    if (presets !== undefined && (presets === null || typeof presets !== 'object' || Array.isArray(presets))) {
        throw new PresetConfigError(filePath, '"presets" must be an object');
    }

    // A file with no version predates versioning, so it starts at 0 and gets migrated.
    const migrated = migrateConfig(
        {
            ...unknown,
            version: version ?? 0,
            defaultPreset: defaultPreset ?? DEFAULT_PRESET,
            presets: presets ?? {},
        },
        filePath,
    );

    // Strict validation runs last, on the already-migrated shape.
    //
    // Built through Object.fromEntries rather than `obj[name] = …`: a plain assignment
    // of a "__proto__" key invokes the prototype setter, which would silently drop that
    // preset and mutate the object's prototype. fromEntries defines own properties.
    /** @type {Record<string, PresetEntry[]>} */
    const parsedPresets = Object.fromEntries(
        Object.entries(migrated.presets).map(([name, entries]) => {
            if (!Array.isArray(entries)) {
                throw new PresetConfigError(filePath, `preset "${name}" must be an array`);
            }
            return [name, entries.map((entry, index) => parseEntry(entry, name, index, filePath))];
        }),
    );

    // Unknown top-level keys are carried through untouched: a newer wsc, or the user,
    // may have added something this build does not know about yet.
    return { ...migrated, presets: parsedPresets };
}

/**
 * @param {unknown} entry
 * @param {string} presetName
 * @param {number} index
 * @param {string} filePath
 * @returns {PresetEntry}
 */
function parseEntry(entry, presetName, index, filePath) {
    const where = `preset "${presetName}" entry ${index}`;

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new PresetConfigError(filePath, `${where} must be an object`);
    }

    const { name, mode, commands, ...extra } = /** @type {Record<string, unknown>} */ (entry);

    if (typeof name !== 'string' || name === '') {
        throw new PresetConfigError(filePath, `${where} is missing a non-empty "name"`);
    }
    if (commands !== undefined) return parseCustomEntry(name, mode, commands, extra, where, filePath);
    if (mode !== undefined && !MODES.includes(/** @type {any} */ (mode))) {
        throw new PresetConfigError(
            filePath,
            `${where} has mode ${JSON.stringify(mode)}, expected ${MODES.slice(0, -1).join(', ')} or ${MODES[MODES.length - 1]}`,
        );
    }

    return { ...extra, name, mode: /** @type {import('../modes.js').LaunchMode} */ (mode ?? 'run') };
}

/**
 * @param {string} name
 * @param {unknown} mode
 * @param {unknown} commands
 * @param {Record<string, unknown>} extra
 * @param {string} where
 * @param {string} filePath
 * @returns {PresetEntry}
 */
function parseCustomEntry(name, mode, commands, extra, where, filePath) {
    if (mode !== undefined && mode !== 'terminal') {
        throw new PresetConfigError(
            filePath,
            `${where} has "commands", so its mode must be "terminal", got ${JSON.stringify(mode)}`,
        );
    }

    // Unlike an ordinary entry's name, nothing checks this one against the IDE's catalogue,
    // and it is printed as it stands.
    if (CONTROL_CHARACTERS.test(name)) {
        throw new PresetConfigError(filePath, `${where} "name" must not contain control characters`);
    }

    // One line each: the list is joined with `&&` into a single command line, and a newline
    // inside an item would start a second command that `&&` no longer guards.
    const valid = Array.isArray(commands)
        && commands.length > 0
        && commands.every((command) => typeof command === 'string' && command.trim() !== '' && !CONTROL_CHARACTERS.test(command));
    if (!valid) {
        throw new PresetConfigError(
            filePath,
            `${where} "commands" must be a non-empty list of non-empty strings without control characters (a tab is fine)`,
        );
    }

    return { ...extra, name, mode: 'terminal', commands: [.../** @type {string[]} */ (commands)] };
}

/**
 * Render a config as the exact bytes to write.
 *
 * Key order is fixed (known keys first, unknown ones after, sorted) so that rewriting an
 * unchanged config produces an identical file — otherwise every `wsc --configure` would
 * show up as a noisy diff in the project's history.
 *
 * @param {PresetConfig} config
 * @returns {string}
 */
export function serializeConfig(config) {
    const { version, defaultPreset, presets, ...unknown } = config;

    /** @type {Record<string, unknown>} */
    const ordered = {
        version: version ?? SCHEMA_VERSION,
        defaultPreset: defaultPreset ?? DEFAULT_PRESET,
        presets: Object.fromEntries(
            Object.entries(presets ?? {}).map(([name, entries]) => [
                name,
                entries.map(({ name: entryName, mode, commands, ...extra }) => ({
                    name: entryName,
                    mode,
                    ...(commands === undefined ? {} : { commands }),
                    ...sortKeys(extra),
                })),
            ]),
        ),
    };

    for (const [key, value] of Object.entries(sortKeys(unknown))) ordered[key] = value;

    // Trailing newline: the file is meant to be committable and POSIX-friendly.
    return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>}
 */
function sortKeys(object) {
    return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Read the preset config for a project.
 *
 * A missing file is not an error — it just means nothing has been configured yet.
 *
 * @param {string} projectRoot
 * @returns {Promise<PresetConfig>}
 */
export async function readPresets(projectRoot) {
    const filePath = configPath(projectRoot);

    let text;
    try {
        text = await fs.readFile(filePath, 'utf8');
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return emptyConfig();
        throw err;
    }

    return parseConfig(text, filePath);
}

/**
 * Write the preset config for a project, atomically.
 *
 * @param {string} projectRoot
 * @param {PresetConfig} config
 * @param {object} [opts]
 * @param {() => void | Promise<void>} [opts.beforeRename] - test hook: simulate a crash mid-write
 * @returns {Promise<string>} the path written
 */
export async function writePresets(projectRoot, config, opts = {}) {
    const filePath = configPath(projectRoot);
    await writeFileAtomic(filePath, serializeConfig(config), opts);
    return filePath;
}

/**
 * Write a file so that readers only ever see the old content or the new content.
 *
 * The sequence is write-to-temp → fsync → rename → fsync directory:
 *   - the temp file is created in the *same* directory, because rename() is only
 *     atomic within a filesystem (a temp in /tmp would fail with EXDEV or, worse,
 *     silently degrade to a copy);
 *   - fsync before rename means a power loss cannot expose a renamed-but-empty file;
 *   - rename() itself is atomic, so a `kill -9` at any instant leaves either the
 *     complete old file or the complete new one;
 *   - fsync on the directory makes the rename itself durable.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {object} [opts]
 * @param {() => void | Promise<void>} [opts.beforeRename]
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(filePath, contents, opts = {}) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Unique per process and per call, so concurrent writers never share a temp file.
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);

    // A fresh file would get default permissions; keep whatever the existing file has
    // so a config deliberately made group-readable (or not) stays that way.
    const mode = await fileMode(filePath);

    let handle = null;
    try {
        handle = await fs.open(tmpPath, 'wx', mode);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;

        if (opts.beforeRename) await opts.beforeRename();

        await fs.rename(tmpPath, filePath);
        await syncDirectory(dir);
    } catch (err) {
        if (handle) await handle.close().catch(() => {});
        // Never leave debris behind — a stray .tmp in .idea/ would confuse the user.
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
    }
}

/**
 * @param {string} filePath
 * @returns {Promise<number | undefined>} existing permission bits, or undefined if new
 */
async function fileMode(filePath) {
    try {
        return (await fs.stat(filePath)).mode & 0o777;
    } catch {
        return undefined;
    }
}

/**
 * fsync a directory so a rename survives a power loss.
 *
 * Best effort by design: Windows cannot open a directory as a file handle, and some
 * filesystems reject the fsync. Failing the whole write over that would be worse than
 * the durability it buys.
 *
 * @param {string} dir
 */
async function syncDirectory(dir) {
    let handle = null;
    try {
        handle = await fs.open(dir, constants.O_RDONLY);
        await handle.sync();
    } catch {
        // Not supported here — the rename already happened, which is what matters.
    } finally {
        await handle?.close().catch(() => {});
    }
}

// ── Preset accessors (used by --configure in phase 5) ────────────────────────

/**
 * @param {PresetConfig} config
 * @param {string} [name] - defaults to the config's defaultPreset
 * @returns {PresetEntry[]} a copy; mutating it does not touch the config
 */
export function getPreset(config, name = config.defaultPreset) {
    // hasOwn, not `?? []`: a preset named "constructor" or "toString" would otherwise
    // resolve to an inherited Object.prototype member and blow up on the spread.
    return hasPreset(config, name) ? [...config.presets[name]] : [];
}

/**
 * Whether a preset exists — an *own* property check.
 *
 * @param {PresetConfig} config
 * @param {string} name
 * @returns {boolean}
 */
export function hasPreset(config, name) {
    return Object.hasOwn(config.presets, name);
}

/**
 * @param {PresetConfig} config
 * @param {string} name
 * @param {PresetEntry[]} entries
 * @returns {PresetConfig} a new config — the input is left untouched
 */
export function setPreset(config, name, entries) {
    return { ...config, presets: { ...config.presets, [name]: [...entries] } };
}

/**
 * @param {PresetConfig} config
 * @returns {string[]} preset names, in insertion order
 */
export function listPresets(config) {
    return Object.keys(config.presets);
}
