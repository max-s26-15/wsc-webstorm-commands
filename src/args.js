/**
 * Argument parsing — flags and positional `name[:run|:debug]` tokens.
 *
 * Pure and side-effect free: nothing here touches the filesystem, the IDE or the
 * process, so the tricky part (names that themselves contain colons) is fully
 * unit-testable.
 */
import { parseArgs } from 'node:util';

import { DEFAULT_MODE, MODES } from './modes.js';

// Re-exported so existing importers keep working; the list itself lives in modes.js.
export { DEFAULT_MODE, MODES };

/**
 * The flags `wsc` accepts — the final set, fixed in phase 9.
 *
 * `@satisfies` rather than `@type`: an annotation would widen every `type: 'boolean'`
 * to `string`, and parseArgs would then infer each value as possibly an array.
 *
 * @satisfies {import('node:util').ParseArgsOptionsConfig}
 */
export const OPTIONS = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    configure: { type: 'boolean', short: 'c' },
    list: { type: 'boolean', short: 'l' },
    preset: { type: 'string', multiple: true },
    project: { type: 'string' },
    'mcp-port': { type: 'string' },
    target: { type: 'string' },
    'debug-port': { type: 'string' },
    'dry-run': { type: 'boolean' },
    fallback: { type: 'string' },
    completion: { type: 'string' },
    'delete-preset': { type: 'string' },
};

/**
 * Flags that only mean something for a launch.
 *
 * Named here rather than in src/cli.js so the list sits next to OPTIONS, where a new
 * launch-only flag is added: --configure launches nothing, so accepting any of these
 * alongside it would silently ignore what the user asked for.
 *
 * --fallback is deliberately absent: --configure needs the IDE just as much as a launch
 * does, so `--fallback=retry` — "wait for WebStorm instead of asking me" — means exactly
 * the same thing there. Only `--fallback=terminal` is meaningless with --configure, since
 * there is no launch to move into a terminal, and src/cli.js rejects that one pairing.
 */
export const LAUNCH_ONLY_FLAGS = /** @type {const} */ (['target', 'debug-port', 'dry-run']);

/**
 * Flags that mean nothing to `--list`.
 *
 * The launch-only ones for the same reason --configure refuses them, plus --preset: a
 * listing is the IDE's own catalogue of run configurations, and a preset is wsc's
 * selection *out of* that catalogue — naming one changes nothing about what gets printed.
 * Refusing beats printing the same 13 lines and leaving the user to work out that half
 * their command line did nothing.
 */
export const LIST_IGNORED_FLAGS = /** @type {const} */ ([...LAUNCH_ONLY_FLAGS, 'preset']);

/**
 * Flags that mean nothing to `--delete-preset`.
 *
 * Every flag but --project: deleting a preset edits a file and contacts nothing, so there
 * is no launch to steer, no IDE to wait for or fall back from, and no second preset to
 * name. Derived from OPTIONS rather than spelled out, so a flag added later is refused
 * here by default instead of silently ignored. --help and --version win before any intent
 * is looked at, and --completion refuses every other flag itself, so none of the three is
 * listed.
 */
export const DELETE_PRESET_IGNORED_FLAGS = Object.freeze(
    Object.keys(OPTIONS).filter(
        (flag) => !['delete-preset', 'project', 'help', 'version', 'completion'].includes(flag),
    ),
);

/**
 * Which of `flags` the user actually passed.
 *
 * Object.hasOwn rather than `values[flag] !== undefined`: parseArgs leaves an absent flag
 * out of `values` entirely, so an own-key check is right by construction instead of right
 * by accident — and a flag whose value is legitimately falsy (`--preset ""`) still counts
 * as passed.
 *
 * @param {CliValues} values
 * @param {readonly string[]} flags
 * @returns {string[]} the passed ones, in the order given
 */
export function passedFlags(values, flags) {
    return flags.filter((flag) => Object.hasOwn(values, flag));
}

/** A malformed command line. The CLI turns this into exit code 2. */
export class UsageError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}

/**
 * @typedef {{ name: string, mode: import('./modes.js').LaunchMode }} RunRequest
 */

/**
 * Split a positional token into a configuration name and a launch mode.
 *
 * The naive rule — "cut at the last colon when the suffix is run or debug" — is not
 * enough, because real configuration names end that way: demo-app has
 * `api > repro:stale-job:debug`. So the token is first checked against the
 * names the IDE actually reports; only a token that is *not* itself a configuration
 * is eligible for splitting.
 *
 * Without `isKnownName` the split is purely syntactic, which is all the CLI can do
 * before it has talked to the IDE.
 *
 * @param {string} token
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.isKnownName]
 * @returns {RunRequest}
 */
export function splitNameMode(token, opts = {}) {
    // A token that names a configuration outright is never split, whatever it ends with.
    if (opts.isKnownName?.(token)) return { name: token, mode: DEFAULT_MODE };

    const colon = token.lastIndexOf(':');
    if (colon <= 0) return { name: token, mode: DEFAULT_MODE };

    const suffix = token.slice(colon + 1);
    if (!MODES.includes(/** @type {any} */ (suffix))) return { name: token, mode: DEFAULT_MODE };

    return { name: token.slice(0, colon), mode: /** @type {import('./modes.js').LaunchMode} */ (suffix) };
}

/**
 * Turn positional tokens into launch requests.
 *
 * Repeating a configuration is an override rather than an error — `wsc api api:debug`
 * means "api, in debug" — so the last mention of a name wins while keeping the
 * position of the first, which is the order the user typed things in.
 *
 * @param {string[]} tokens
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.isKnownName]
 * @returns {RunRequest[]}
 */
export function parseRequests(tokens, opts = {}) {
    /** @type {Map<string, RunRequest>} */
    const byName = new Map();

    for (const token of tokens) {
        if (token === '') throw new UsageError('empty configuration name');

        // splitNameMode never yields an empty name: a colon at index 0 is part of the
        // name, so the remaining slice always has at least one character.
        const request = splitNameMode(token, opts);
        byName.set(request.name, request);
    }

    return [...byName.values()];
}

/**
 * @typedef {{
 *   help?: boolean,
 *   version?: boolean,
 *   configure?: boolean,
 *   list?: boolean,
 *   preset?: string[],
 *   project?: string,
 *   'mcp-port'?: string,
 *   target?: string,
 *   'debug-port'?: string,
 *   'dry-run'?: boolean,
 *   fallback?: string,
 *   completion?: string,
 *   'delete-preset'?: string,
 * }} CliValues
 */

/**
 * @typedef {{ name: string, following: number[] }} PresetUse
 *   one `--preset <name>`, and the positionals (as indexes) that came right after it
 */

/**
 * Parse a raw argv into flags and positionals.
 *
 * `presetUses` is what makes `--preset a b` readable: a positional token that comes
 * *directly* after a `--preset` (and its value) might be another preset's name rather
 * than a configuration. Only the caller knows which names are presets, so each use of
 * the flag is returned with the indexes into `positionals` that followed it, in argv
 * order, and the decision is left to `splitPresetNames()`.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ values: CliValues, positionals: string[], presetUses: PresetUse[] }}
 * @throws {UsageError} on an unknown or malformed flag
 */
export function parseCliArgs(argv) {
    try {
        const { values, positionals, tokens } = parseArgs({
            args: argv,
            options: OPTIONS,
            strict: true,
            allowPositionals: true,
            tokens: true,
        });

        /** @type {PresetUse[]} */
        const presetUses = [];
        let ordinal = 0;
        /** @type {PresetUse | null} */
        let current = null;
        for (const token of tokens) {
            if (token.kind === 'positional') {
                current?.following.push(ordinal);
                ordinal += 1;
            } else if (token.kind === 'option' && token.name === 'preset') {
                current = { name: String(token.value), following: [] };
                presetUses.push(current);
            } else {
                // `--preset a --dry-run b`: the flag in between ends the run, so `b` is a
                // configuration however it is spelled.
                current = null;
            }
        }

        return { values, positionals, presetUses };
    } catch (err) {
        // Every ERR_PARSE_ARGS_* code means "the user typed something wrong"; matching the
        // prefix rather than a fixed list keeps new Node codes from crashing with a stack.
        const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
        if (code.startsWith('ERR_PARSE_ARGS_')) {
            throw new UsageError(/** @type {Error} */ (err).message);
        }
        throw err;
    }
}

/**
 * Every preset a command line names, for `--preset a b c` and `--preset a --preset b`.
 *
 * Positionals are configuration names, and `wsc --preset watch test:coverage` has always
 * meant "the watch preset, plus test:coverage" — so a token after `--preset` is a preset
 * name only if it *is* one, and the first that is not ends the run (`--preset a b typo`
 * is preset a, preset b, and a configuration called "typo", which then fails as an
 * unknown configuration instead of as a confusing unknown preset). A name that is both a
 * preset and a configuration is read as the preset; naming the configuration before the
 * flag (`wsc x --preset a`) or after another flag keeps it a configuration.
 *
 * The value of `--preset` itself is returned unchecked, so that a typo in it is reported
 * as an unknown preset.
 *
 * @param {string[]} positionals
 * @param {PresetUse[]} presetUses - from parseCliArgs()
 * @param {(name: string) => boolean} isPreset
 * @returns {{ presets: string[], positionals: string[] }} presets in the order typed,
 *   and the positionals that were configurations after all
 */
export function splitPresetNames(positionals, presetUses, isPreset) {
    /** @type {Set<number>} */
    const taken = new Set();
    /** @type {string[]} */
    const presets = [];

    for (const use of presetUses) {
        presets.push(use.name);
        for (const index of use.following) {
            if (!isPreset(positionals[index])) break;
            taken.add(index);
            presets.push(positionals[index]);
        }
    }

    return { presets, positionals: positionals.filter((_, index) => !taken.has(index)) };
}
