/**
 * The pure half of `wsc --stop` and `wsc --restart`: which preset entries are running, and what
 * to do about each. Nothing here talks to the IDE — `list_running`'s answer comes in as data —
 * so every decision is testable without one; src/control/run.js carries the steps out.
 *
 * What runs is never remembered by wsc. The IDE is asked every time, and an entry counts as
 * running only while the IDE says so: a Run/Debug tab with a live process, or a Terminal tab
 * the plugin marked for it with a command still running inside.
 */
import { UsageError } from '../args.js';
import { MODES } from '../modes.js';
import { getPreset, isCustomEntry, listPresets } from '../presets/store.js';
import { resolveName } from '../resolve.js';

/**
 * @typedef {import('../modes.js').LaunchMode} LaunchMode
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../mcp/control.js').EntryKind} EntryKind
 * @typedef {import('../mcp/control.js').Running} Running
 * @typedef {import('../presets/store.js').PresetConfig} PresetConfig
 *
 * One place an entry runs: a Run or Debug tab, or a marked Terminal tab — with the mode the tab
 * was launched in and its inspector port, when it has one.
 * @typedef {{ where: 'run' | 'debug' } | { where: 'terminal', mode: LaunchMode, debugPort?: number }} Instance
 *
 * A preset entry and everywhere it runs. `modes` is its setup: every mode the presets in scope
 * give it — two presets may disagree, and running in either one is running as set up. `mode` is
 * the one a relaunch uses (the last, as buildLaunchPlan() would pick). `config` is set for a run
 * configuration (as resolveName() found it), `commands` for the user's own commands.
 * @typedef {{
 *   kind: EntryKind,
 *   name: string,
 *   mode: LaunchMode,
 *   modes: LaunchMode[],
 *   config?: RunConfigInfo,
 *   commands?: string[],
 *   presets: string[],
 *   instances: Instance[],
 * }} ControlTarget
 *
 * @typedef {{ action: 'stop', target: ControlTarget, instance: Instance, relaunch: boolean }
 *   | { action: 'restart', target: ControlTarget, instance: Instance }
 *   | { action: 'launch', target: ControlTarget }} ControlStep
 */

/** A command line `--stop`/`--restart` cannot act on, for a reason it can name. */
export class ControlError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ControlError';
    }
}

/** `web:debug` — a token that names a mode as well as an entry. */
const MODE_SUFFIX = new RegExp(`:(${MODES.join('|')})$`);

/**
 * Find the preset entries that are running, out of the presets in scope.
 *
 * @param {object} args
 * @param {PresetConfig} args.config
 * @param {string[] | null} args.presetNames - the presets in scope; null for all of them
 * @param {string[]} args.tokens - entry names from the command line; none means every entry
 * @param {RunConfigInfo[]} args.configs - from get_run_configurations
 * @param {Running} args.running - from list_running
 * @returns {{ targets: ControlTarget[], notRunning: ControlTarget[] }} `targets` in preset order;
 *   `notRunning` are entries named on the command line that run nowhere
 * @throws {UsageError} for a name with a mode suffix
 * @throws {ControlError} for a name that two different custom commands share
 */
export function selectTargets({ config, presetNames, tokens, configs, running }) {
    const { entries, conflicts } = collectEntries(config, presetNames ?? listPresets(config), configs);

    const chosen = tokens.length > 0 ? chooseNames(tokens, [...new Set([...entries.values()].map((t) => t.name))]) : null;

    /** @type {ControlTarget[]} */
    const targets = [];
    /** @type {ControlTarget[]} */
    const notRunning = [];

    for (const [key, target] of entries) {
        if (chosen !== null && !chosen.has(target.name)) continue;

        target.instances = instancesOf(target, running);
        // A clash between two custom commands matters only once one of them is acted on:
        // which of the two commands a restart should type is exactly what cannot be told.
        const clash = conflicts.get(key);
        if (clash !== undefined && (chosen !== null || target.instances.length > 0)) {
            throw new ControlError(
                `two different custom commands are called "${target.name}" (presets ${clash.join(', ')}) — ` +
                    'name one of those presets with --preset',
            );
        }

        if (target.instances.length > 0) targets.push(target);
        else if (chosen !== null) notRunning.push(target);
    }

    return { targets, notRunning };
}

/**
 * Every entry of the presets in scope, once each, keyed like buildLaunchPlan() keys its plan.
 *
 * @param {PresetConfig} config
 * @param {string[]} presetNames
 * @param {RunConfigInfo[]} configs
 * @returns {{ entries: Map<string, ControlTarget>, conflicts: Map<string, string[]> }}
 */
function collectEntries(config, presetNames, configs) {
    /** @type {Map<string, ControlTarget>} */
    const entries = new Map();
    /** @type {Map<string, string[]>} presets of a custom name whose commands differ */
    const conflicts = new Map();

    for (const preset of presetNames) {
        for (const entry of getPreset(config, preset)) {
            if (isCustomEntry(entry)) {
                const commands = /** @type {string[]} */ (entry.commands);
                const key = JSON.stringify(['custom', entry.name]);
                const known = entries.get(key);
                if (known === undefined) {
                    entries.set(key, { kind: 'custom', name: entry.name, mode: 'terminal', modes: ['terminal'], commands, presets: [preset], instances: [] });
                    continue;
                }
                addPreset(known, preset);
                if (JSON.stringify(known.commands) !== JSON.stringify(commands)) conflicts.set(key, known.presets);
                continue;
            }

            // A configuration the IDE no longer has cannot be running, and stopping the rest
            // must not depend on a stale preset entry: --configure is where that gets fixed.
            let resolved;
            try {
                resolved = resolveName(entry.name, configs, { source: 'preset' });
            } catch (err) {
                if (err instanceof Error && (err.name === 'UnknownConfigurationError' || err.name === 'AmbiguousNameError')) continue;
                throw err;
            }

            const key = JSON.stringify(['config', resolved.name]);
            const known = entries.get(key);
            if (known === undefined) {
                entries.set(key, { kind: 'config', name: resolved.name, mode: entry.mode, modes: [entry.mode], config: resolved, presets: [preset], instances: [] });
            } else {
                // First position, last mode — buildLaunchPlan()'s rule for two presets at once —
                // but every mode counts as its setup: `wsc --preset dev` then a bare `wsc --restart`
                // must not move an entry just because another preset debugs it.
                known.mode = entry.mode;
                if (!known.modes.includes(entry.mode)) known.modes.push(entry.mode);
                addPreset(known, preset);
            }
        }
    }

    return { entries, conflicts };
}

/**
 * @param {ControlTarget} target
 * @param {string} preset
 */
function addPreset(target, preset) {
    if (!target.presets.includes(preset)) target.presets.push(preset);
}

/**
 * Turn command-line tokens into entry names, the way a launch resolves configuration names.
 *
 * An exact name always wins, so `api > repro:stale-job:debug` stays a name. Anything else with a
 * mode suffix is refused rather than split: the mode of a restart comes from the preset.
 *
 * @param {string[]} tokens
 * @param {string[]} names - every entry name in scope
 * @returns {Set<string>}
 */
function chooseNames(tokens, names) {
    const candidates = names.map((name) => ({ name }));
    /** @type {Set<string>} */
    const chosen = new Set();

    for (const token of tokens) {
        if (names.includes(token)) {
            chosen.add(token);
            continue;
        }
        const suffix = MODE_SUFFIX.exec(token);
        if (suffix !== null) {
            throw new UsageError(`the mode comes from the preset; drop ":${suffix[1]}" from "${token}"`);
        }
        chosen.add(resolveName(token, candidates, { source: 'cli' }).name);
    }
    return chosen;
}

/**
 * @param {ControlTarget} target
 * @param {Running} running
 * @returns {Instance[]}
 */
function instancesOf(target, running) {
    /** @type {Instance[]} */
    const instances = [];

    if (target.kind === 'config') {
        for (const run of running.runs) {
            if (run.configurationName === target.name) instances.push({ where: run.mode });
        }
    }
    for (const tab of running.terminals) {
        if (tab.kind !== target.kind || tab.entryName !== target.name || !tab.commandRunning) continue;
        instances.push(tab.debugPort === undefined
            ? { where: 'terminal', mode: tab.mode }
            : { where: 'terminal', mode: tab.mode, debugPort: tab.debugPort });
    }
    return instances;
}

/**
 * The mode an instance actually runs in: its tool window for a Run/Debug tab, its mark for a
 * Terminal tab — which records the entry's mode, not `--target`, so a run entry sent to the
 * terminal by `--target=terminal` still reads as `run`.
 *
 * @param {Instance} instance
 * @returns {LaunchMode}
 */
function actualMode(instance) {
    return instance.where === 'terminal' ? instance.mode : instance.where;
}

/**
 * What to do, in order.
 *
 * A stop acts on every place the entry runs. A restart does so in place while it runs in a mode
 * one of the presets in scope gives it; once none does, it is stopped where it runs and launched
 * anew in `mode` — after every other step, by the ordinary launch.
 *
 * @param {'stop' | 'restart'} action
 * @param {ControlTarget[]} targets
 * @returns {ControlStep[]}
 */
export function planControl(action, targets) {
    if (action === 'stop') {
        return targets.flatMap((target) =>
            target.instances.map((instance) => ({ action: /** @type {const} */ ('stop'), target, instance, relaunch: false })),
        );
    }

    /** @type {ControlStep[]} */
    const steps = [];
    /** @type {ControlStep[]} */
    const launches = [];
    for (const target of targets) {
        const changed = target.instances.some((instance) => !target.modes.includes(actualMode(instance)));
        for (const instance of target.instances) {
            steps.push(changed ? { action: 'stop', target, instance, relaunch: true } : { action: 'restart', target, instance });
        }
        if (changed) launches.push({ action: 'launch', target });
    }
    return [...steps, ...launches];
}

/** @type {Record<Instance['where'], string>} */
const WHERE = { run: 'Run tab', debug: 'Debug tab', terminal: 'Terminal tab' };

/**
 * @param {ControlStep[]} steps
 * @returns {string} one line per step, for the screen and for --dry-run
 */
export function formatControlPlan(steps) {
    if (steps.length === 0) return 'nothing to do';

    const width = Math.max(...steps.map((step) => step.target.name.length));
    return steps
        .map((step) => {
            const head = `${step.action.padEnd(7)}  ${step.target.name.padEnd(width)}  `;
            if (step.action === 'launch') return `${head}as ${step.target.mode}`;
            const note = step.action === 'stop' && step.relaunch ? `  (preset now says ${step.target.mode})` : '';
            return `${head}${WHERE[step.instance.where]}${note}`;
        })
        .join('\n');
}
