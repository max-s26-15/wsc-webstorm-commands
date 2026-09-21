/**
 * Name resolution and preset/CLI merging.
 *
 * Everything here is pure: it takes the run configurations the IDE reported, a preset
 * and the command line, and produces the exact list of things to launch — or throws.
 * Nothing is launched until the whole plan resolves, so a typo in the third argument
 * never leaves two processes already running.
 */

/**
 * @typedef {{ name: string, description?: string, supportsDynamicLaunchOverrides?: boolean }} RunConfigInfo
 * @typedef {{ name: string, mode: import('./modes.js').LaunchMode }} RunRequest
 * @typedef {'preset' | 'cli'} PlanSource
 * @typedef {{ name: string, mode: import('./modes.js').LaunchMode, config: RunConfigInfo, source: PlanSource }} ConfigPlanEntry
 * @typedef {{ name: string, mode: 'terminal', commands: string[], source: PlanSource }} CustomPlanEntry
 * @typedef {ConfigPlanEntry | CustomPlanEntry} PlanEntry
 */

/** How close a name must be to be offered as "did you mean". */
const MAX_SUGGESTION_DISTANCE = 5;

/** Suggestions beyond this many are noise rather than help. */
const MAX_SUGGESTIONS = 3;

/** A requested name that matches no configuration. Carries suggestions for the CLI to print. */
export class UnknownConfigurationError extends Error {
    /**
     * @param {string} requested
     * @param {string[]} suggestions
     * @param {PlanSource} [source]
     */
    constructor(requested, suggestions, source = 'cli') {
        const where = source === 'preset' ? ' (from the preset)' : '';
        const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?` : '';
        super(`unknown run configuration "${requested}"${where}${hint}`);
        this.name = 'UnknownConfigurationError';
        this.requested = requested;
        this.suggestions = suggestions;
        this.source = source;
    }
}

/** A requested name that matches several configurations. */
export class AmbiguousNameError extends Error {
    /**
     * @param {string} requested
     * @param {string[]} candidates
     * @param {PlanSource} [source]
     */
    constructor(requested, candidates, source = 'cli') {
        const where = source === 'preset' ? ' (from the preset)' : '';
        super(`"${requested}"${where} matches several run configurations: ${candidates.join(', ')}`);
        this.name = 'AmbiguousNameError';
        this.requested = requested;
        this.candidates = candidates;
        this.source = source;
    }
}

/**
 * `get_run_configurations` answered with something this CLI does not understand.
 *
 * A subclass of TypeError, because that is what this was — and staying one keeps every
 * caller that checks for a TypeError working. What it adds is a `name` the CLI can put in
 * KNOWN_ERRORS: a bare TypeError is indistinguishable from a bug in wsc itself, so it was
 * rethrown out of runCli() and reached the user as a V8 stack trace. The plan's own risk
 * table calls a change in the IDE's tool signatures the most likely thing to break here,
 * which is exactly the case this reports — so it names the diagnostic script too.
 */
export class RunConfigPayloadError extends TypeError {
    /** @param {string} detail */
    constructor(detail) {
        super(
            `the IDE answered get_run_configurations with something wsc does not understand: ${detail}.\n` +
                '  This usually means the MCP tool changed shape in a newer WebStorm. Run\n' +
                '  `npm run mcp:probe` against this IDE to see what it actually returns.',
        );
        this.name = 'RunConfigPayloadError';
        this.detail = detail;
    }
}

/**
 * Normalize whatever `get_run_configurations` returned into a flat list.
 *
 * The IDE currently answers `{ configurations: [...] }`, but the tool's own schema
 * leaves room for a bare array, so both are accepted.
 *
 * @param {unknown} payload
 * @returns {RunConfigInfo[]}
 * @throws {RunConfigPayloadError} for anything else
 */
export function normalizeRunConfigs(payload) {
    const list = Array.isArray(payload)
        ? payload
        : /** @type {any} */ (payload)?.configurations;

    if (!Array.isArray(list)) {
        throw new RunConfigPayloadError('it is not a list of configurations');
    }

    return list.map((entry, index) => {
        if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') {
            throw new RunConfigPayloadError(`run configuration ${index} has no name`);
        }
        return entry;
    });
}

/**
 * Levenshtein edit distance, used only to rank "did you mean" suggestions.
 *
 * Two rolling rows instead of a full matrix: the CLI may compare a typo against every
 * configuration name, and none of the intermediate values are needed afterwards.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    let current = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
        current[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
        }
        [previous, current] = [current, previous];
    }

    return previous[b.length];
}

/**
 * Rank candidate names by how close they are to what the user typed.
 *
 * Names that merely *contain* the query are offered too — with long names like
 * `api > repro:stale-job:debug` the edit distance from a short typo is large
 * even when the intent is obvious.
 *
 * @param {string} requested
 * @param {string[]} names
 * @param {number} [max]
 * @returns {string[]}
 */
export function suggestNames(requested, names, max = MAX_SUGGESTIONS) {
    const query = requested.toLowerCase();

    return names
        .map((name) => ({ name, distance: levenshtein(query, name.toLowerCase()) }))
        .filter(({ name, distance }) => distance <= MAX_SUGGESTION_DISTANCE || name.toLowerCase().includes(query))
        .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
        .slice(0, max)
        .map(({ name }) => name);
}

/**
 * Find the configuration a name refers to.
 *
 * Tried in order: exact, case-insensitive, then prefix. Each looser step must land on
 * exactly one configuration — `addon` prefix-matches three of them in demo-app, and
 * guessing which one the user meant would silently launch the wrong process.
 *
 * @param {string} requested
 * @param {RunConfigInfo[]} configs
 * @param {object} [opts]
 * @param {PlanSource} [opts.source] - where the name came from, for the error message
 * @returns {RunConfigInfo}
 */
export function resolveName(requested, configs, opts = {}) {
    const source = opts.source ?? 'cli';

    // Duplicate names are possible in the IDE and indistinguishable from here, so an
    // exact hit takes the first — the same thing the IDE's own dropdown does.
    const exact = configs.find((config) => config.name === requested);
    if (exact) return exact;

    const query = requested.toLowerCase();

    const insensitive = configs.filter((config) => config.name.toLowerCase() === query);
    if (insensitive.length === 1) return insensitive[0];
    if (insensitive.length > 1) throw new AmbiguousNameError(requested, names(insensitive), source);

    const prefixed = configs.filter((config) => config.name.toLowerCase().startsWith(query));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) throw new AmbiguousNameError(requested, names(prefixed), source);

    throw new UnknownConfigurationError(requested, suggestNames(requested, names(configs)), source);
}

/**
 * @param {RunConfigInfo[]} configs
 * @returns {string[]}
 */
function names(configs) {
    return configs.map((config) => config.name);
}

/**
 * A plan entry that runs the commands its preset wrote down, not a run configuration.
 *
 * @param {PlanEntry} entry
 * @returns {entry is CustomPlanEntry}
 */
export function isCustomPlanEntry(entry) {
    return 'commands' in entry;
}

/**
 * The key an entry has in the plan's Map.
 *
 * JSON rather than a prefix: a run configuration may be called anything, `custom:x` included,
 * and a plain concatenation would let it swallow a custom entry of that name.
 *
 * @param {'config' | 'custom'} kind
 * @param {string} name
 * @returns {string}
 */
function planKey(kind, name) {
    return JSON.stringify([kind, name]);
}

/**
 * Build the full list of things to launch.
 *
 * Preset entries come first, in the order they were configured; command-line requests
 * override the mode of anything already in the preset and are appended otherwise.
 * Both sides are resolved against the IDE's list *before* merging, so `wsc web`
 * overrides a preset entry written as `Web` — they are the same configuration.
 *
 * @param {object} args
 * @param {RunConfigInfo[]} args.configs - from get_run_configurations
 * @param {Array<RunRequest & { commands?: string[] }>} [args.preset] - entries of the active
 *   preset; one that carries `commands` is a custom entry and never touches `configs`
 * @param {RunRequest[]} [args.requests] - from the command line
 * @returns {PlanEntry[]}
 * @throws {UnknownConfigurationError|AmbiguousNameError} before anything is launched
 */
export function buildLaunchPlan({ configs, preset = [], requests = [] }) {
    /** @type {Map<string, PlanEntry>} */
    const plan = new Map();

    for (const entry of preset) {
        if (entry.commands !== undefined) {
            // Nothing to resolve: the commands are the definition. Two of one name (from two
            // presets launched together) follow the rule below — first position, last wins.
            plan.set(planKey('custom', entry.name), {
                name: entry.name,
                mode: 'terminal',
                commands: entry.commands,
                source: 'preset',
            });
            continue;
        }

        const config = resolveName(entry.name, configs, { source: 'preset' });
        plan.set(planKey('config', config.name), { name: config.name, mode: entry.mode, config, source: 'preset' });
    }

    for (const request of requests) {
        const config = resolveName(request.name, configs, { source: 'cli' });
        // Overriding keeps the preset's position; a genuinely new entry lands at the end.
        plan.set(planKey('config', config.name), { name: config.name, mode: request.mode, config, source: 'cli' });
    }

    return [...plan.values()];
}

/**
 * @param {PlanEntry[]} plan
 * @returns {string} one line per entry, for --dry-run and diagnostics
 */
export function formatPlan(plan) {
    if (plan.length === 0) return 'nothing to launch';

    const width = Math.max(...plan.map((entry) => entry.name.length));
    // 5 is `debug`, the longest mode before `terminal` existed: a plan without one keeps its
    // exact old alignment, and one with it widens the column rather than run into the source.
    const modeWidth = Math.max(5, ...plan.map((entry) => entry.mode.length));
    return plan
        .map((entry) => `${entry.name.padEnd(width)}  ${entry.mode.padEnd(modeWidth)}  (${entry.source})`)
        .join('\n');
}
