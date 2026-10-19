/**
 * Pure logic behind the `--configure` screen.
 *
 * Kept apart from the prompts themselves so the interesting decisions — what starts
 * out checked, which entries need a mode question, what the saved preset ends up
 * looking like — are unit-tested without driving a terminal UI.
 */

import { customCommandLine } from '../exec/customCommands.js';
import { DEFAULT_MODE } from '../modes.js';
import { CONTROL_CHARACTERS, isCustomEntry } from '../presets/store.js';

// Mode assigned to a configuration the user checked but was never asked about.
export { DEFAULT_MODE };

const CUSTOM_PREFIX = '\u0000custom\u0000';

/**
 * A saved custom entry's value in the checkbox: its position in the preset being edited.
 *
 * Distinct from any configuration name — those are the raw names the IDE reported — so a
 * custom entry and a run configuration of the same name (a hand-edited file can have both)
 * are two different choices and cannot answer for one another. A position and not a name,
 * because the store accepts two custom entries of one name: keyed by name they were one
 * row, and editing or unchecking either changed both.
 *
 * @param {number} index - in the preset as it was when the screen opened
 * @returns {string}
 */
export function customChoiceValue(index) {
    return `${CUSTOM_PREFIX}${index}`;
}

/** @param {string} value */
const isCustomChoiceValue = (value) => value.startsWith(CUSTOM_PREFIX);

/**
 * The position customChoiceValue() was given, or -1 for any other value.
 *
 * @param {string} value
 * @returns {number}
 */
const customChoiceIndex = (value) => (isCustomChoiceValue(value) ? Number(value.slice(CUSTOM_PREFIX.length)) : -1);

const NEW_PREFIX = '\u0000new\u0000';

/**
 * The list value of a custom entry added on this screen, by its place among the added ones.
 *
 * Not its name, which an edit can change while the entry stays the same row. Distinct from a
 * configuration name and from customChoiceValue() alike, so the save can take these out of
 * the selection before anything reads it as names.
 *
 * @param {number} index
 * @returns {string}
 */
export function newChoiceValue(index) {
    return `${NEW_PREFIX}${index}`;
}

/** @param {string} value */
export const isNewChoiceValue = (value) => value.startsWith(NEW_PREFIX);

/**
 * The index newChoiceValue() was given, or -1 for any other value.
 *
 * @param {string} value
 * @returns {number}
 */
export function newChoiceIndex(value) {
    return isNewChoiceValue(value) ? Number(value.slice(NEW_PREFIX.length)) : -1;
}

/**
 * Identity of an entry across two versions of a preset. Kind first, so a custom entry and a
 * configuration of one name are not the same entry.
 *
 * @param {PresetEntry} entry
 * @param {string} [name] - the name to file it under, when it was renamed since
 */
const entryKey = (entry, name = entry.name) => JSON.stringify([isCustomEntry(entry) ? 'custom' : 'config', name]);

/**
 * How a custom entry is shown in a list: its name and the one line it runs.
 *
 * @param {{ name: string, commands: string[] }} entry
 */
const customLabel = (entry) => `⌘ ${entry.name} — ${customCommandLine(entry.commands)}`;

/**
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../presets/store.js').PresetEntry} PresetEntry
 * @typedef {{ name: string, value: string, checked: boolean, mode: import('../modes.js').LaunchMode | null }} Choice
 *
 * What the edit screen did to one saved custom entry, keyed elsewhere by its list value
 * (customChoiceValue(), its position) — a rename changes its name, not which entry it is.
 * @typedef {{ name: string, commands: string[] }} CustomEdit
 * @typedef {Map<string, CustomEdit>} CustomEdits
 *
 * Everything the `--configure` list has been through since the screen opened. Each
 * transition below returns a new one; none mutates the one it is given.
 * @typedef {{
 *   checked: Set<string>,
 *   edits: CustomEdits,
 *   added: PresetEntry[],
 *   deleted: Set<string>,
 * }} Screen
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
    const customChoices = preset.flatMap((entry, index) => (isCustomEntry(entry)
        ? [{ name: customLabel(entry), value: customChoiceValue(index), checked: true, mode: entry.mode }]
        : []));

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
 * @param {CustomEdits} [edits] - custom entries changed on this screen; each keeps its place
 * @returns {PresetEntry[]}
 */
export function applyAnswersToPreset(selection, modes = {}, preset = [], added = [], edits = new Map()) {
    const selectedNames = new Set(selection.filter((value) => !isCustomChoiceValue(value)));
    const keptCustom = new Set(selection.filter(isCustomChoiceValue));

    const kept = preset.flatMap((entry, index) => {
        if (!isCustomEntry(entry)) {
            return selectedNames.has(entry.name) ? [{ ...entry, mode: answered(modes, entry.name) ?? entry.mode }] : [];
        }
        const value = customChoiceValue(index);
        if (!keptCustom.has(value)) return [];
        const edit = edits.get(value);
        return [edit ? { ...entry, name: edit.name, commands: edit.commands } : entry];
    });

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
 * @param {CustomEdits} [edits] - so a renamed custom entry is matched with what it was
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: boolean }}
 */
export function diffPreset(before, after, edits = new Map()) {
    /**
     * @param {PresetEntry} entry - from `before`; the key it is found under in `after`
     * @param {number} index - its position in `before`
     */
    const keyAfter = (entry, index) =>
        entryKey(entry, (isCustomEntry(entry) && edits.get(customChoiceValue(index))?.name) || entry.name);

    const previous = new Map(before.map((entry, index) => [keyAfter(entry, index), entry]));
    const afterKeys = new Set(after.map((entry) => entryKey(entry)));

    const added = after.filter((entry) => !previous.has(entryKey(entry))).map((entry) => entry.name);
    const removed = before.filter((entry, index) => !afterKeys.has(keyAfter(entry, index))).map((entry) => entry.name);

    /** @type {string[]} */
    const changed = [];
    for (const entry of after) {
        const old = previous.get(entryKey(entry));
        if (!old) continue;
        if (old.name !== entry.name) changed.push(`${old.name}: renamed to ${entry.name}`);
        if (old.mode !== entry.mode) changed.push(`${entry.name} → ${entry.mode}`);
        // Compared as lists, not as joined lines: ['a', 'b'] and ['a && b'] print alike but
        // are not the same entry on disk.
        if (isCustomEntry(old) && isCustomEntry(entry)
            && JSON.stringify(old.commands) !== JSON.stringify(entry.commands)) {
            changed.push(`${entry.name}: ${customCommandLine(old.commands)} → ${customCommandLine(entry.commands)}`);
        }
    }

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
 * or renamed since (customNamesInUse()) — including one just unchecked: re-adding it in the
 * same run would be an edit in disguise, which the edit step does in place instead.
 *
 * `keep` are names the entry being renamed may always have — its own: a hand-edited file can
 * hold a custom entry called like a run configuration, and refusing that name would leave
 * "Name" with no answer that is accepted.
 *
 * @param {string} rawName - trimmed here; the caller may pass the line as typed
 * @param {{ taken?: string[], ideNames?: string[], keep?: string[] }} [opts]
 * @returns {string | null}
 */
export function validateCustomName(rawName, { taken = [], ideNames = [], keep = [] } = {}) {
    const name = rawName.trim();
    if (name === '') return 'a name is required';
    if (CONTROL_CHARACTERS.test(name)) return 'a name cannot contain control characters';
    if (keep.includes(name)) return null;
    if (taken.includes(name)) return `"${name}" is already a custom command in this preset`;
    if (ideNames.includes(name)) return `"${name}" is the name of a run configuration; pick a different name`;
    return null;
}

/**
 * Why a line cannot be one of a custom entry's commands, or `null` when it can.
 *
 * The same rule the store applies on read: a line it would refuse must not be written in the
 * first place, or the next `wsc` stops on a file this screen produced.
 *
 * @param {string} rawLine - trimmed here, like the line saved
 * @returns {string | null}
 */
export function validateCustomCommand(rawLine) {
    const line = rawLine.trim();
    if (line === '') return 'a command is required';
    if (CONTROL_CHARACTERS.test(line)) return 'a command cannot contain control characters';
    return null;
}

/**
 * @typedef {{ type: 'replace', index: number, line: string }
 *   | { type: 'up' | 'down' | 'remove', index: number }
 *   | { type: 'append', line: string }} CommandEdit
 */

/**
 * One change to a custom entry's command list, as a new list.
 *
 * A move past either end, or removing the only line, leaves the list as it was: the menu
 * does not offer them, and an entry with no commands is one the store refuses to read.
 *
 * @param {string[]} commands
 * @param {CommandEdit} edit
 * @returns {string[]}
 */
export function editCommands(commands, edit) {
    const next = [...commands];
    switch (edit.type) {
        case 'replace':
            next[edit.index] = edit.line;
            break;
        case 'up':
        case 'down': {
            const other = edit.type === 'up' ? edit.index - 1 : edit.index + 1;
            if (other < 0 || other >= next.length) break;
            [next[edit.index], next[other]] = [next[other], next[edit.index]];
            break;
        }
        case 'remove':
            if (next.length > 1) next.splice(edit.index, 1);
            break;
        case 'append':
            next.push(edit.line);
            break;
    }
    return next;
}

/**
 * Every custom name already spoken for, for the rename and add questions.
 *
 * The preset's own names count even when unchecked (see validateCustomName()), and an entry
 * renamed on this screen holds both its old and its new name. `except` is the entry being
 * renamed, which may keep its own name or take back the one it started with.
 *
 * @param {PresetEntry[]} preset - as it was when the screen opened
 * @param {CustomEdits} [edits]
 * @param {string} [except] - the list value of the entry being renamed
 * @returns {string[]}
 */
export function customNamesInUse(preset, edits = new Map(), except) {
    const names = new Set();
    preset.forEach((entry, index) => {
        const value = customChoiceValue(index);
        if (!isCustomEntry(entry) || value === except) return;
        names.add(entry.name);
        const edit = edits.get(value);
        if (edit) names.add(edit.name);
    });
    return [...names];
}

/**
 * The menu for one custom entry. "Done" is last, so the way out is always in the same place.
 *
 * @param {CustomEdit} draft
 * @returns {Array<{ name: string, value: 'name' | 'append' | 'delete' | 'done' | number }>}
 */
export function entryEditChoices(draft) {
    return [
        { name: `Name: ${draft.name}`, value: 'name' },
        ...draft.commands.map((command, index) => ({ name: `${index + 1}. ${command}`, value: index })),
        { name: '+ Add a command', value: 'append' },
        { name: `Delete "${draft.name}" from the preset`, value: 'delete' },
        { name: 'Done', value: 'done' },
    ];
}

/**
 * The menu for one command line. What cannot be done to it is shown disabled, with the
 * reason, rather than left out: the list keeps its shape from one line to the next.
 *
 * @param {string[]} commands
 * @param {number} index
 * @returns {Array<{ name: string, value: 'replace' | 'up' | 'down' | 'remove' | 'back', disabled?: string | false }>}
 */
export function commandEditChoices(commands, index) {
    return [
        { name: 'Change', value: 'replace' },
        { name: 'Move up', value: 'up', disabled: index === 0 && '(already the first)' },
        { name: 'Move down', value: 'down', disabled: index === commands.length - 1 && '(already the last)' },
        { name: 'Delete', value: 'remove', disabled: commands.length === 1 && '(the only command — delete the whole entry instead)' },
        { name: 'Back', value: 'back' },
    ];
}

/**
 * The `--configure` list as it stands: the IDE's configurations and the preset's custom
 * entries (buildInitialSelection()'s choices), with this screen's edits, additions and
 * deletions applied. Only custom entries, saved or new, are editable.
 *
 * @param {Choice[]} base - from buildInitialSelection()
 * @param {Screen} screen - `edits` keyed by a saved entry's list value (its position);
 *   `added` in the order added, never spliced; `deleted` the values removed with "Delete"
 * @returns {import('./checkboxKeys.js').Item[]}
 */
export function screenChoices(base, { checked, edits, added, deleted }) {
    const saved = base.map((choice) => {
        if (!isCustomChoiceValue(choice.value)) {
            return { name: choice.name, value: choice.value, checked: checked.has(choice.value), editable: false };
        }
        const edit = edits.get(choice.value);
        return {
            name: edit ? customLabel(edit) : choice.name,
            value: choice.value,
            checked: checked.has(choice.value),
            editable: true,
        };
    });
    const fresh = added.map((entry, index) => ({
        name: customLabel(/** @type {CustomEdit} */ (entry)),
        value: newChoiceValue(index),
        checked: checked.has(newChoiceValue(index)),
        editable: true,
    }));
    return [...saved, ...fresh].filter((item) => !deleted.has(item.value));
}

/**
 * Split what the list submitted into the selection applyAnswersToPreset() reads and the new
 * entries it appends. A new entry is saved only if it is still in the list and checked.
 *
 * @param {import('./checkboxKeys.js').Item[]} items - in list order
 * @param {PresetEntry[]} added - indexed by newChoiceValue()
 * @returns {{ selection: string[], added: PresetEntry[] }}
 */
export function splitSelection(items, added) {
    const checked = items.filter((item) => item.checked).map((item) => item.value);
    return {
        selection: checked.filter((value) => !isNewChoiceValue(value)),
        added: checked.filter(isNewChoiceValue).map((value) => added[newChoiceIndex(value)]),
    };
}

/**
 * The preset entry behind a saved custom entry's list value.
 *
 * @param {PresetEntry[]} preset
 * @param {string} value
 */
function savedEntry(preset, value) {
    const entry = preset[customChoiceIndex(value)];
    return entry && isCustomEntry(entry) ? entry : undefined;
}

/**
 * `n`: add a custom entry to the list, checked.
 *
 * @param {Screen} screen
 * @param {PresetEntry} entry
 * @returns {{ screen: Screen, value: string }} `value` is its list value, for the cursor
 */
export function addCustomEntry(screen, entry) {
    const value = newChoiceValue(screen.added.length);
    return {
        screen: { ...screen, added: [...screen.added, entry], checked: new Set([...screen.checked, value]) },
        value,
    };
}

/**
 * `e`: what the entry's menu opens with, and the names it may keep whatever else has them.
 *
 * A saved entry starts from its edit on this screen if it has one, and may keep both the name
 * in the file and its current one; an entry added on this screen only has the current one.
 *
 * @param {PresetEntry[]} preset - as it was when the screen opened
 * @param {Screen} screen
 * @param {string} value - the entry's list value
 * @returns {{ draft: CustomEdit, keep: string[] }}
 */
export function customDraft(preset, screen, value) {
    const index = newChoiceIndex(value);
    if (index !== -1) {
        const entry = screen.added[index];
        return { draft: { name: entry.name, commands: entry.commands ?? [] }, keep: [entry.name] };
    }
    const saved = savedEntry(preset, value);
    const name = saved?.name ?? '';
    const draft = screen.edits.get(value) ?? { name, commands: saved?.commands ?? [] };
    return { draft, keep: [name, draft.name] };
}

/**
 * What the entry's menu ended with: an edit, or `null` for "Delete".
 *
 * Deleting takes the row off the list; `deleted` is the only record of it, since a row that
 * is not drawn cannot be submitted checked. An edit that changed something also checks the
 * row: an unchecked row is dropped on save, and nobody edits an entry to have it dropped.
 * Opening the menu and leaving it untouched changes nothing, the check included.
 *
 * @param {PresetEntry[]} preset
 * @param {Screen} screen
 * @param {string} value
 * @param {CustomEdit | null} result
 * @returns {Screen}
 */
export function applyEntryEdit(preset, screen, value, result) {
    if (result === null) return { ...screen, deleted: new Set([...screen.deleted, value]) };

    const { draft } = customDraft(preset, screen, value);
    const changed = draft.name !== result.name || JSON.stringify(draft.commands) !== JSON.stringify(result.commands);
    const checked = changed ? new Set([...screen.checked, value]) : screen.checked;

    const index = newChoiceIndex(value);
    if (index !== -1) {
        const added = [...screen.added];
        added[index] = { ...added[index], ...result };
        return { ...screen, added, checked };
    }
    return savedEntry(preset, value) ? { ...screen, edits: new Map([...screen.edits, [value, result]]), checked } : screen;
}

/**
 * Custom names the entry with list value `except` cannot take, or a new entry if omitted.
 *
 * The preset's own names stay taken even once unchecked or deleted (see validateCustomName());
 * an entry added on this screen and deleted again was never saved, so its name is free.
 *
 * @param {PresetEntry[]} preset
 * @param {Screen} screen
 * @param {string} [except]
 * @returns {string[]}
 */
export function takenNames(preset, screen, except) {
    const fresh = screen.added
        .filter((_, index) => newChoiceValue(index) !== except && !screen.deleted.has(newChoiceValue(index)))
        .map((entry) => entry.name);
    return [...customNamesInUse(preset, screen.edits, except), ...fresh];
}

/** Rows shown at once when the terminal has room: a typical project's whole list. */
const PAGE_SIZE = 20;

/**
 * Lines a list or menu needs besides its rows: the question, the blank line and the key line,
 * plus one for a key line that wraps on a narrow terminal.
 */
const PAGE_CHROME = 4;

/**
 * How many rows a list or menu on this screen may show, for a terminal `rows` lines tall.
 *
 * Nothing in `@inquirer/core` clamps `pageSize` to the terminal, and this screen depends on
 * erasing a list to draw the next menu in its place — which cannot reach lines that have
 * already scrolled off the top. So a list taller than the terminal would leave stale copies.
 *
 * @param {number | undefined} rows - `stdout.rows`; unknown means "assume room"
 * @returns {number}
 */
export function pageSizeFor(rows) {
    if (rows === undefined) return PAGE_SIZE;
    return Math.max(1, Math.min(PAGE_SIZE, rows - PAGE_CHROME));
}
