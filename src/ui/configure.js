/**
 * The `--configure` screen: pick what launches by default, and in which mode.
 *
 * Deliberately thin. Everything worth testing lives in configureLogic.js (and the list's
 * keys in checkboxKeys.js); this file only drives the prompts and talks to the store, and is
 * verified by hand against the plan's phase-5 checklist.
 */
import { input, select } from '@inquirer/prompts';

import { DEFAULT_MODE, MODES } from '../modes.js';
import { hasPreset, isCustomEntry, setPreset, writePresets } from '../presets/store.js';
import {
    applyAnswersToPreset,
    buildInitialSelection,
    commandEditChoices,
    customChoiceValue,
    customNamesInUse,
    diffPreset,
    editCommands,
    entryEditChoices,
    isNewChoiceValue,
    newChoiceValue,
    pendingModeQuestions,
    screenChoices,
    splitSelection,
    validateCustomCommand,
    validateCustomName,
} from './configureLogic.js';
import { editableCheckbox } from './editableCheckbox.js';
import { CANCELLED_EXIT_CODE, isCancelled } from './promptCancel.js';

/**
 * Rows shown at once. Large enough that a typical project's whole list is visible
 * without scrolling; @inquirer/prompts clamps it to the terminal height anyway.
 */
const PAGE_SIZE = 20;

/**
 * Passed to every prompt opened from the list with `e` or `n`: each one erases itself when
 * answered, so the list is drawn again where it was instead of below a trail of menus.
 */
const IN_PLACE = { clearPromptOnDone: true };

/**
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../presets/store.js').PresetConfig} PresetConfig
 * @typedef {import('../presets/store.js').PresetEntry} PresetEntry
 *
 * The prompts this screen uses. Typed as a bundle so tests can pass fakes, and
 * so JSDoc keeps a concrete shape instead of a bare `object`.
 * @typedef {{
 *   checkbox: (config: import('./editableCheckbox.js').ListConfig) => Promise<import('./editableCheckbox.js').ListResult>,
 *   select: (config: any, context?: object) => Promise<any>,
 *   input: (config: any, context?: object) => Promise<string>,
 * }} Prompts
 *
 * Everything the list has been through since the screen opened.
 * @typedef {{
 *   checked: Set<string>,
 *   edits: import('./configureLogic.js').CustomEdits,
 *   added: PresetEntry[],
 *   deleted: Set<string>,
 * }} Screen
 */

/**
 * Run the interactive preset editor.
 *
 * @param {object} opts
 * @param {RunConfigInfo[]} opts.configs - from get_run_configurations
 * @param {PresetConfig} opts.config - the preset file as read
 * @param {string} opts.presetName - preset being edited
 * @param {string} opts.projectRoot
 * @param {ReturnType<typeof import('../log.js').createLogger>} opts.log
 * @param {Prompts} [opts.prompts] - injected in tests; defaults to the real prompts
 * @param {NodeJS.ReadStream} [opts.stdin]
 * @param {NodeJS.WriteStream} [opts.stdout]
 * @returns {Promise<number>} exit code
 */
export async function runConfigure(opts) {
    const { configs, config, presetName, projectRoot, log } = opts;
    const stdin = opts.stdin ?? process.stdin;
    const stdout = opts.stdout ?? process.stdout;
    const prompts = opts.prompts ?? { checkbox: editableCheckbox, select, input };

    // Without a terminal the prompt has nothing to read and would wait forever, which
    // in a pipeline or CI job looks exactly like a hang.
    if (!stdin.isTTY || !stdout.isTTY) {
        log.error('--configure needs an interactive terminal (stdin and stdout must be a TTY)');
        return 1;
    }

    const before = hasPreset(config, presetName) ? config.presets[presetName] : [];
    const { choices, stale } = buildInitialSelection(configs, before);

    // Warn before any early exit: an IDE reporting nothing at all is precisely when a
    // silently stale preset is most confusing.
    for (const entry of stale) {
        log.warn(`"${entry.name}" is in the preset but no longer exists in the IDE; it will be dropped`);
    }

    // An IDE that reports nothing cannot vouch for the entries the preset already names, and
    // rewriting the preset from an empty list would drop them all. Refusing is the old
    // behaviour, kept for exactly that case — a preset with nothing to lose is different.
    if (configs.length === 0 && stale.length > 0) {
        log.error('the IDE reported no run configurations, so the preset\'s entries cannot be checked; nothing was changed');
        return 1;
    }
    if (configs.length === 0) {
        log.warn('the IDE reported no run configurations — press n in the list to add a custom command');
    }

    const ideNames = configs.map((config) => config.name);
    /** @type {Screen} */
    const screen = {
        checked: new Set(choices.filter((choice) => choice.checked).map((choice) => choice.value)),
        edits: new Map(),
        added: [],
        deleted: new Set(),
    };

    /** @type {string[]} */
    let selection = [];
    /** @type {PresetEntry[]} */
    let added = [];
    // Null prototype: a configuration named "__proto__" would otherwise hit the
    // prototype setter here and lose its answer silently.
    /** @type {Record<string, import('../modes.js').LaunchMode>} */
    const modes = Object.create(null);

    try {
        let active = 0;
        for (;;) {
            const result = await prompts.checkbox({
                message: `Configurations to launch by default (preset "${presetName}")`,
                choices: screenChoices(choices, screen),
                active,
                pageSize: PAGE_SIZE,
            });
            screen.checked = new Set(result.checked);
            active = result.active;
            if (result.action === 'submit') break;

            // Where the cursor goes when the list comes back: onto the entry just touched.
            const focus = result.action === 'new'
                ? await addFromList({ prompts, before, screen, ideNames })
                : await editFromList({ prompts, before, screen, ideNames, value: /** @type {string} */ (result.value) });
            const items = screenChoices(choices, screen);
            const at = items.findIndex((item) => item.value === focus);
            active = at === -1 ? Math.min(active, Math.max(items.length - 1, 0)) : at;
        }

        ({ selection, added } = splitSelection(screenChoices(choices, screen), screen.added));

        for (const name of pendingModeQuestions(selection, before)) {
            modes[name] = await prompts.select({
                message: `Mode for "${name}"`,
                // Built from MODES so a mode added there cannot be missing from this screen.
                choices: MODES.map((mode) => ({ name: mode, value: mode })),
                default: DEFAULT_MODE,
            });
        }
    } catch (err) {
        // Ctrl-C inside a prompt is an ordinary way to back out, not a crash.
        if (isCancelled(err)) {
            log.info('cancelled; nothing was saved');
            return CANCELLED_EXIT_CODE;
        }
        throw err;
    }

    const after = applyAnswersToPreset(selection, modes, before, added, screen.edits);
    const diff = diffPreset(before, after, screen.edits);

    if (diff.unchanged) {
        log.info(`preset "${presetName}" unchanged`);
        return 0;
    }

    const filePath = await writePresets(projectRoot, setPreset(config, presetName, after));

    log.info(`saved preset "${presetName}" to ${filePath}`);
    for (const name of diff.added) log.info(`  + ${name}`);
    for (const name of diff.removed) log.info(`  - ${name}`);
    for (const change of diff.changed) log.info(`  ~ ${change}`);
    return 0;
}

/**
 * Custom names the entry with list value `except` cannot take, or a new entry if omitted.
 *
 * The preset's own names stay taken even once unchecked or deleted (see validateCustomName());
 * an entry added on this screen and deleted again was never saved, so its name is free.
 *
 * @param {PresetEntry[]} before
 * @param {Screen} screen
 * @param {string} [except]
 * @returns {string[]}
 */
function takenNames(before, screen, except) {
    const original = except === undefined ? undefined : savedEntry(before, except)?.name;
    const fresh = screen.added
        .filter((_, index) => newChoiceValue(index) !== except && !screen.deleted.has(newChoiceValue(index)))
        .map((entry) => entry.name);
    return [...customNamesInUse(before, screen.edits, original), ...fresh];
}

/**
 * The preset entry behind a saved custom entry's list value.
 *
 * @param {PresetEntry[]} before
 * @param {string} value
 */
function savedEntry(before, value) {
    return before.filter(isCustomEntry).find((entry) => customChoiceValue(entry.name) === value);
}

/**
 * `n` in the list: ask for a name and commands, and add the entry checked.
 *
 * @param {{ prompts: Prompts, before: PresetEntry[], screen: Screen, ideNames: string[] }} opts
 * @returns {Promise<string | undefined>} the new entry's list value; nothing when backed out of
 */
async function addFromList({ prompts, before, screen, ideNames }) {
    const taken = takenNames(before, screen);
    const name = (
        await prompts.input(
            {
                message: 'Name (it titles the terminal tab; empty to go back)',
                // Empty is the way back to the list, so it is the one name not refused here.
                validate: (/** @type {string} */ value) =>
                    value.trim() === '' || (validateCustomName(value, { taken, ideNames }) ?? true),
            },
            IN_PLACE,
        )
    ).trim();
    if (name === '') return undefined;

    /** @type {string[]} */
    const commands = [];
    for (;;) {
        const line = (
            await prompts.input(
                {
                    message: commands.length === 0 ? 'Command' : `Command ${commands.length + 1} (empty to finish)`,
                    validate: (/** @type {string} */ value) => {
                        if (value.trim() !== '') return validateCustomCommand(value) ?? true;
                        return commands.length === 0 ? 'the first command is required' : true;
                    },
                },
                IN_PLACE,
            )
        ).trim();
        if (line === '') break;
        commands.push(line);
    }

    screen.added.push({ name, mode: 'terminal', commands });
    const value = newChoiceValue(screen.added.length - 1);
    screen.checked.add(value);
    return value;
}

/**
 * `e` in the list: open the custom entry's menu and record what it did.
 *
 * Nothing is written here — the edits are applied with everything else on save, so Ctrl-C
 * anywhere still leaves the file as it was.
 *
 * @param {{ prompts: Prompts, before: PresetEntry[], screen: Screen, ideNames: string[], value: string }} opts
 * @returns {Promise<string>} the list value, to put the cursor back on
 */
async function editFromList({ prompts, before, screen, ideNames, value }) {
    const index = isNewChoiceValue(value) ? screen.added.findIndex((_, i) => newChoiceValue(i) === value) : -1;
    const saved = savedEntry(before, value);
    const draft = index !== -1
        ? { name: screen.added[index].name, commands: screen.added[index].commands ?? [] }
        : screen.edits.get(saved?.name ?? '') ?? { name: saved?.name ?? '', commands: saved?.commands ?? [] };

    const result = await editCustomEntry({ prompts, draft, taken: takenNames(before, screen, value), ideNames });

    if (result === null) {
        // Deleting takes it off the list; unchecked, the save drops it.
        screen.deleted.add(value);
        screen.checked.delete(value);
    } else if (index !== -1) {
        screen.added[index] = { ...screen.added[index], ...result };
    } else if (saved) {
        screen.edits.set(saved.name, result);
    }
    return value;
}

/**
 * One custom entry's menu, redrawn after every change until "Done" or "Delete".
 *
 * @param {object} opts
 * @param {Prompts} opts.prompts
 * @param {import('./configureLogic.js').CustomEdit} opts.draft
 * @param {string[]} opts.taken - custom names this entry cannot be renamed to
 * @param {string[]} opts.ideNames
 * @returns {Promise<import('./configureLogic.js').CustomEdit | null>} `null` when deleted
 */
async function editCustomEntry({ prompts, draft, taken, ideNames }) {
    let { name, commands } = draft;

    for (;;) {
        const action = await prompts.select(
            {
                message: `Edit "${name}"`,
                choices: entryEditChoices({ name, commands }),
                pageSize: PAGE_SIZE,
                loop: false,
            },
            IN_PLACE,
        );

        if (action === 'done') return { name, commands };
        if (action === 'delete') return null;

        if (action === 'name') {
            name = (
                await prompts.input(
                    {
                        message: 'Name (it titles the terminal tab)',
                        default: name,
                        prefill: 'editable',
                        validate: (/** @type {string} */ value) => validateCustomName(value, { taken, ideNames }) ?? true,
                    },
                    IN_PLACE,
                )
            ).trim();
        } else if (action === 'append') {
            commands = editCommands(commands, { type: 'append', line: await askCommandLine(prompts, 'New command') });
        } else {
            const index = /** @type {number} */ (action);
            const op = await prompts.select(
                {
                    message: `Command ${index + 1}: ${commands[index]}`,
                    choices: commandEditChoices(commands, index),
                    loop: false,
                },
                IN_PLACE,
            );
            if (op === 'replace') {
                const line = await askCommandLine(prompts, `Command ${index + 1}`, commands[index]);
                commands = editCommands(commands, { type: 'replace', index, line });
            } else if (op !== 'back') {
                commands = editCommands(commands, { type: op, index });
            }
        }
    }
}

/**
 * Ask for one command line, refusing what the store would refuse on the next read.
 *
 * @param {Prompts} prompts
 * @param {string} message
 * @param {string} [current] - pre-filled, so a long line is edited rather than retyped
 * @returns {Promise<string>}
 */
async function askCommandLine(prompts, message, current) {
    const line = await prompts.input(
        {
            message,
            ...(current === undefined ? {} : { default: current, prefill: 'editable' }),
            validate: (/** @type {string} */ value) => validateCustomCommand(value) ?? true,
        },
        IN_PLACE,
    );
    return line.trim();
}
