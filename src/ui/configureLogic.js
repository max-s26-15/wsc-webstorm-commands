/**
 * Pure logic behind the `--configure` screen.
 *
 * Kept apart from the prompts themselves so the interesting decisions — what starts
 * out checked, which entries need a mode question, what the saved preset ends up
 * looking like — are unit-tested without driving a terminal UI.
 */

import { customCommandLine } from '../exec/customCommands.js';
import { DEFAULT_MODE } from '../modes.js';
import { isCustomEntry } from '../presets/store.js';

// Mode assigned to a configuration the user checked but was never asked about.
export { DEFAULT_MODE };

const CUSTOM_PREFIX = '\u0000custom\u0000';

/**
 * A custom entry's value in the checkbox.
 *
 * Distinct from any configuration name — those are the raw names the IDE reported — so a
 * custom entry and a run configuration of the same name (a hand-edited file can have both)
 * are two different choices and cannot answer for one another.
 *
 * @param {string} name
 * @returns {string}
 */
export function customChoiceValue(name) {
    return `${CUSTOM_PREFIX}${name}`;
}

/** @param {string} value */
const isCustomChoiceValue = (value) => value.startsWith(CUSTOM_PREFIX);

/**
 * Identity of an entry across two versions of a preset. Kind first, so a custom entry and a
 * configuration of one name are not the same entry.
 *
 * @param {PresetEntry} entry
 */
const entryKey = (entry) => JSON.stringify([isCustomEntry(entry) ? 'custom' : 'config', entry.name]);

/**
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../presets/store.js').PresetEntry} PresetEntry
 * @typedef {{ name: string, value: string, checked: boolean, mode: import('../modes.js').LaunchMode | null }} Choice
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
    // Custom entries refer to nothing in the IDE, so they take no part in the by-name
    // matching: a hand-edited custom "web" must not tick the run configuration "web".
    const references = preset.filter((entry) => !isCustomEntry(entry));
    const modes = new Map(references.map((entry) => [entry.name, entry.mode]));

    const ideChoices = runConfigs.map((config) => ({
        name: config.description ? `${config.name}  (${config.description})` : config.name,
        value: config.name,
        checked: modes.has(config.name),
        mode: modes.get(config.name) ?? null,
    }));

    const known = new Set(runConfigs.map((config) => config.name));
    const stale = references.filter((entry) => !known.has(entry.name));

    // After the IDE's list, in the order the preset has them; always checked, because
    // unchecking is how one is deleted.
    const customChoices = preset.filter(isCustomEntry).map((entry) => ({
        name: `⌘ ${entry.name} — ${customCommandLine(entry.commands)}`,
        value: customChoiceValue(entry.name),
        checked: true,
        mode: entry.mode,
    }));

    return { choices: [...ideChoices, ...customChoices], stale };
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
    const known = new Set(preset.filter((entry) => !isCustomEntry(entry)).map((entry) => entry.name));
    return selection.filter((value) => !isCustomChoiceValue(value) && !known.has(value));
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
 * @param {Record<string, import('../modes.js').LaunchMode>} [modes] - answers, plus any carried-over modes
 * @param {PresetEntry[]} [preset] - the preset before editing
 * @param {PresetEntry[]} [added] - custom entries created on this screen
 * @returns {PresetEntry[]}
 */
export function applyAnswersToPreset(selection, modes = {}, preset = [], added = []) {
    const selectedNames = new Set(selection.filter((value) => !isCustomChoiceValue(value)));
    const keptCustom = new Set(selection.filter(isCustomChoiceValue));

    const kept = preset
        .filter((entry) =>
            isCustomEntry(entry) ? keptCustom.has(customChoiceValue(entry.name)) : selectedNames.has(entry.name))
        .map((entry) =>
            isCustomEntry(entry) ? entry : { ...entry, mode: answered(modes, entry.name) ?? entry.mode });

    const keptNames = new Set(kept.filter((entry) => !isCustomEntry(entry)).map((entry) => entry.name));
    const appended = selection
        .filter((value) => !isCustomChoiceValue(value) && !keptNames.has(value))
        .map((name) => ({ name, mode: answered(modes, name) ?? DEFAULT_MODE }));

    return [...kept, ...appended, ...added];
}

/**
 * Read a mode answer without picking up Object.prototype members.
 *
 * `modes` is keyed by configuration name, and a configuration may legitimately be
 * called "constructor" or "toString" — a plain lookup would return a function.
 *
 * @param {Record<string, import('../modes.js').LaunchMode>} modes
 * @param {string} name
 * @returns {import('../modes.js').LaunchMode | undefined}
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
    const beforeModes = new Map(before.map((entry) => [entryKey(entry), entry.mode]));
    const afterModes = new Map(after.map((entry) => [entryKey(entry), entry.mode]));

    const added = after.filter((entry) => !beforeModes.has(entryKey(entry))).map((entry) => entry.name);
    const removed = before.filter((entry) => !afterModes.has(entryKey(entry))).map((entry) => entry.name);
    const changed = after
        .filter((entry) => beforeModes.has(entryKey(entry)) && beforeModes.get(entryKey(entry)) !== entry.mode)
        .map((entry) => `${entry.name} → ${entry.mode}`);

    return {
        added,
        removed,
        changed,
        unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
    };
}

/**
 * Why a name cannot be used for a new custom command, or `null` when it can.
 *
 * `taken` is every custom name the preset had when the screen opened, plus what was added
 * since — including one just unchecked: re-adding it in the same run would look, to the
 * diff, like nothing changed and the new commands would never be saved.
 *
 * @param {string} name - already trimmed
 * @param {{ taken?: string[], ideNames?: string[] }} [opts]
 * @returns {string | null}
 */
export function validateCustomName(name, { taken = [], ideNames = [] } = {}) {
    if (name.trim() === '') return 'a name is required';
    if (taken.includes(name)) return `"${name}" is already a custom command in this preset`;
    if (ideNames.includes(name)) return `"${name}" is the name of a run configuration; pick a different name`;
    return null;
}
