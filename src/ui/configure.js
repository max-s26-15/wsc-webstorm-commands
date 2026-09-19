/**
 * The `--configure` screen: pick what launches by default, and in which mode.
 *
 * Deliberately thin. Everything worth testing lives in configureLogic.js; this file
 * only drives @inquirer/prompts and talks to the store, and is verified by hand
 * against the plan's phase-5 checklist.
 */
import { checkbox, select } from '@inquirer/prompts';

import { hasPreset, setPreset, writePresets } from '../presets/store.js';
import { applyAnswersToPreset, buildInitialSelection, diffPreset, pendingModeQuestions } from './configureLogic.js';
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
 * The two prompts this screen uses. Typed as a bundle so tests can pass fakes, and
 * so JSDoc keeps a concrete shape instead of a bare `object`.
 * @typedef {{
 *   checkbox: (config: any) => Promise<string[]>,
 *   select: (config: any) => Promise<'run' | 'debug'>,
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
    const prompts = opts.prompts ?? { checkbox, select };

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

    if (choices.length === 0) {
        log.error('the IDE reported no run configurations to choose from');
        return 1;
    }

    /** @type {string[]} */
    let selection;
    try {
        selection = await prompts.checkbox({
            message: `Configurations to launch by default (preset "${presetName}")`,
            choices,
            pageSize: PAGE_SIZE,
            loop: false,
        });
    } catch (err) {
        // Ctrl-C inside a prompt is an ordinary way to back out, not a crash.
        if (isCancelled(err)) {
            log.info('cancelled; nothing was saved');
            return CANCELLED_EXIT_CODE;
        }
        throw err;
    }

    // Null prototype: a configuration named "__proto__" would otherwise hit the
    // prototype setter here and lose its answer silently.
    /** @type {Record<string, 'run' | 'debug'>} */
    const modes = Object.create(null);
    try {
        for (const name of pendingModeQuestions(selection, before)) {
            modes[name] = await prompts.select({
                message: `Mode for "${name}"`,
                choices: [
                    { name: 'run', value: 'run' },
                    { name: 'debug', value: 'debug' },
                ],
                default: 'run',
            });
        }
    } catch (err) {
        if (isCancelled(err)) {
            log.info('cancelled; nothing was saved');
            return CANCELLED_EXIT_CODE;
        }
        throw err;
    }

    const after = applyAnswersToPreset(selection, modes, before);
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
