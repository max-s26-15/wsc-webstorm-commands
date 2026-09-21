/**
 * The `--configure` screen: pick what launches by default, and in which mode.
 *
 * Deliberately thin. Everything worth testing lives in configureLogic.js; this file
 * only drives @inquirer/prompts and talks to the store, and is verified by hand
 * against the plan's phase-5 checklist.
 */
import { checkbox, confirm, input, select } from '@inquirer/prompts';

import { DEFAULT_MODE, MODES } from '../modes.js';
import { hasPreset, isCustomEntry, setPreset, writePresets } from '../presets/store.js';
import {
    applyAnswersToPreset,
    buildInitialSelection,
    diffPreset,
    pendingModeQuestions,
    validateCustomName,
} from './configureLogic.js';
import { CANCELLED_EXIT_CODE, isCancelled } from './promptCancel.js';

/**
 * Rows shown at once. Large enough that a typical project's whole list is visible
 * without scrolling; @inquirer/prompts clamps it to the terminal height anyway.
 */
const PAGE_SIZE = 20;

/**
 * @typedef {import('../resolve.js').RunConfigInfo} RunConfigInfo
 * @typedef {import('../presets/store.js').PresetConfig} PresetConfig
 *
 * The prompts this screen uses. Typed as a bundle so tests can pass fakes, and
 * so JSDoc keeps a concrete shape instead of a bare `object`.
 * @typedef {{
 *   checkbox: (config: any) => Promise<string[]>,
 *   select: (config: any) => Promise<import('../modes.js').LaunchMode>,
 *   confirm: (config: any) => Promise<boolean>,
 *   input: (config: any) => Promise<string>,
 * }} Prompts
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
 * @param {Prompts} [opts.prompts] - injected in tests; defaults to the real prompt module
 * @param {NodeJS.ReadStream} [opts.stdin]
 * @param {NodeJS.WriteStream} [opts.stdout]
 * @returns {Promise<number>} exit code
 */
export async function runConfigure(opts) {
    const { configs, config, presetName, projectRoot, log } = opts;
    const stdin = opts.stdin ?? process.stdin;
    const stdout = opts.stdout ?? process.stdout;
    const prompts = opts.prompts ?? { checkbox, select, confirm, input };

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
        log.warn('the IDE reported no run configurations — custom commands can still be added');
    }

    /** @type {string[]} */
    let selection = [];
    // Null prototype: a configuration named "__proto__" would otherwise hit the
    // prototype setter here and lose its answer silently.
    /** @type {Record<string, import('../modes.js').LaunchMode>} */
    const modes = Object.create(null);
    /** @type {import('../presets/store.js').PresetEntry[]} */
    let added = [];

    try {
        if (choices.length > 0) {
            selection = await prompts.checkbox({
                message: `Configurations to launch by default (preset "${presetName}")`,
                choices,
                pageSize: PAGE_SIZE,
                loop: false,
            });
        }

        for (const name of pendingModeQuestions(selection, before)) {
            modes[name] = await prompts.select({
                message: `Mode for "${name}"`,
                // Built from MODES so a mode added there cannot be missing from this screen.
                choices: MODES.map((mode) => ({ name: mode, value: mode })),
                default: DEFAULT_MODE,
            });
        }

        added = await askCustomCommands({
            prompts,
            // Every custom name the preset had, unchecked or not: see validateCustomName().
            taken: before.filter(isCustomEntry).map((entry) => entry.name),
            ideNames: configs.map((config) => config.name),
        });
    } catch (err) {
        // Ctrl-C inside a prompt is an ordinary way to back out, not a crash.
        if (isCancelled(err)) {
            log.info('cancelled; nothing was saved');
            return CANCELLED_EXIT_CODE;
        }
        throw err;
    }

    const after = applyAnswersToPreset(selection, modes, before, added);
    const diff = diffPreset(before, after);

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
 * The "add a custom command" loop: a name, then commands one line at a time.
 *
 * The prompts' own `validate` does the refusing, so a bad name is explained and asked
 * again in place instead of aborting the screen.
 *
 * @param {object} opts
 * @param {Prompts} opts.prompts
 * @param {string[]} opts.taken - custom names the preset already has
 * @param {string[]} opts.ideNames - names of the IDE's run configurations
 * @returns {Promise<import('../presets/store.js').PresetEntry[]>}
 */
async function askCustomCommands({ prompts, taken, ideNames }) {
    /** @type {import('../presets/store.js').PresetEntry[]} */
    const added = [];
    let message = 'Add a custom command?';

    while (await prompts.confirm({ message, default: false })) {
        const name = (
            await prompts.input({
                message: 'Name (it titles the terminal tab)',
                validate: (/** @type {string} */ value) =>
                    validateCustomName(value.trim(), { taken: [...taken, ...added.map((entry) => entry.name)], ideNames }) ?? true,
            })
        ).trim();

        /** @type {string[]} */
        const commands = [];
        for (;;) {
            const line = (
                await prompts.input({
                    message: commands.length === 0 ? 'Command' : `Command ${commands.length + 1} (empty to finish)`,
                    validate: (/** @type {string} */ value) =>
                        commands.length === 0 && value.trim() === '' ? 'the first command is required' : true,
                })
            ).trim();
            if (line === '') break;
            commands.push(line);
        }

        added.push({ name, mode: 'terminal', commands });
        message = 'Add another custom command?';
    }

    return added;
}
