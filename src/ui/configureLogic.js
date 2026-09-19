/**
 * Pure logic behind the `--configure` screen.
 *
 * Kept apart from the prompts themselves so the interesting decisions — what starts
 * out checked, which entries need a mode question, what the saved preset ends up
 * looking like — are unit-tested without driving a terminal UI.
 */

/** Mode assigned to a configuration the user checked but was never asked about. */
export const DEFAULT_MODE = 'run';

/**
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../presets/store.js').PresetEntry} PresetEntry
 * @typedef {{ name: string, value: string, checked: boolean, mode: 'run' | 'debug' | null }} Choice
 */

/**
 * Turn the IDE's configuration list plus the saved preset into checkbox choices.
 *
 * Order follows the IDE, so the list matches the run-configuration dropdown the user
 * is looking at. The current preset only decides what is *checked*.
 *
 * @param {RunConfigInfo[]} runConfigs - from get_run_configurations
 * @param {PresetEntry[]} [preset] - the preset being edited
 * @returns {{ choices: Choice[], stale: PresetEntry[] }} `stale` are preset entries the
 *   IDE no longer reports — they cannot be shown as checked, so the caller must warn
 *   rather than let them vanish silently on save.
 */
export function buildInitialSelection(runConfigs, preset = []) {
    const modes = new Map(preset.map((entry) => [entry.name, entry.mode]));

    const choices = runConfigs.map((config) => ({
        name: config.description ? `${config.name}  (${config.description})` : config.name,
        value: config.name,
        checked: modes.has(config.name),
        mode: modes.get(config.name) ?? null,
    }));

    const known = new Set(runConfigs.map((config) => config.name));
    const stale = preset.filter((entry) => !known.has(entry.name));

    return { choices, stale };
}

/**
 * Which of the checked configurations still need a run/debug answer.
 *
 * Only newly checked ones are asked about: re-confirming the mode of every entry on
 * every `--configure` would turn a two-second edit into a thirteen-question interview.
 *
 * @param {string[]} selection - values returned by the checkbox
 * @param {PresetEntry[]} [preset]
 * @returns {string[]} in the order they appear in `selection`
 */
export function pendingModeQuestions(selection, preset = []) {
    const known = new Set(preset.map((entry) => entry.name));
    return selection.filter((name) => !known.has(name));
}

/**
 * Build the preset to save.
 *
 * Entries that were already in the preset keep their position, so a deliberately
 * ordered preset is not reshuffled by an unrelated edit; newly checked ones are
 * appended in the order the list showed them. Unknown keys on an existing entry are
 * preserved, matching what the store guarantees for hand-edited configs.
 *
 * @param {string[]} selection - values returned by the checkbox
 * @param {Record<string, 'run' | 'debug'>} [modes] - answers, plus any carried-over modes
 * @param {PresetEntry[]} [preset] - the preset before editing
 * @returns {PresetEntry[]}
 */
export function applyAnswersToPreset(selection, modes = {}, preset = []) {
    const selected = new Set(selection);

    const kept = preset
        .filter((entry) => selected.has(entry.name))
        .map((entry) => ({ ...entry, mode: answered(modes, entry.name) ?? entry.mode }));

    const keptNames = new Set(kept.map((entry) => entry.name));
    const added = selection
        .filter((name) => !keptNames.has(name))
        .map((name) => ({ name, mode: answered(modes, name) ?? DEFAULT_MODE }));

    return [...kept, ...added];
}

/**
 * Read a mode answer without picking up Object.prototype members.
 *
 * `modes` is keyed by configuration name, and a configuration may legitimately be
 * called "constructor" or "toString" — a plain lookup would return a function.
 *
 * @param {Record<string, 'run' | 'debug'>} modes
 * @param {string} name
 * @returns {'run' | 'debug' | undefined}
 */
function answered(modes, name) {
    return Object.hasOwn(modes, name) ? modes[name] : undefined;
}

/**
 * Describe what changed, for the summary printed after saving.
 *
 * @param {PresetEntry[]} before
 * @param {PresetEntry[]} after
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: boolean }}
 */
export function diffPreset(before, after) {
    const beforeModes = new Map(before.map((entry) => [entry.name, entry.mode]));
    const afterModes = new Map(after.map((entry) => [entry.name, entry.mode]));

    const added = after.filter((entry) => !beforeModes.has(entry.name)).map((entry) => entry.name);
    const removed = before.filter((entry) => !afterModes.has(entry.name)).map((entry) => entry.name);
    const changed = after
        .filter((entry) => beforeModes.has(entry.name) && beforeModes.get(entry.name) !== entry.mode)
        .map((entry) => `${entry.name} → ${entry.mode}`);

    return {
        added,
        removed,
        changed,
        unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
    };
}
