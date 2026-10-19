import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { createLogger } from '../src/log.js';
import { configPath, emptyConfig, readPresets } from '../src/presets/store.js';
import { normalizeRunConfigs } from '../src/resolve.js';
import { runConfigure } from '../src/ui/configure.js';
import { customChoiceValue, newChoiceValue } from '../src/ui/configureLogic.js';
import { fakeStream } from '../test-utils/capture.js';
import { tmpProject } from '../test-utils/tmp-dir.js';

const require = createRequire(import.meta.url);
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

/**
 * Drive runConfigure with scripted answers instead of a terminal.
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string[]} [opts.checked] - what the list is submitted with; by default, whatever is
 *   checked when Enter is pressed
 * @param {Array<{ action: 'edit' | 'new', value?: string, checked?: string[] }>} [opts.steps] -
 *   `e` and `n` pressed in the list, in order, before the final Enter; `checked` is what the
 *   list held at that moment (by default, what it was drawn with)
 * @param {Array<import('../src/modes.js').LaunchMode>} [opts.modes] - answers to the mode questions, in order
 * @param {string[]} [opts.inputs] - answers to the name and command lines, in order
 * @param {object[]} [opts.configs] - what the IDE reports; the 13-configuration fixture by default
 * @param {object} [opts.config] - preset file contents as already read
 * @param {Error} [opts.throws] - make the first prompt throw (Ctrl-C, for instance)
 * @param {Error} [opts.throwsOnSelect] - make the *mode* prompt throw instead, so the
 *   second try/catch is exercised in its own right
 * @param {Error} [opts.throwsOnInput] - make the first text question throw
 * @param {string[]} [opts.menus] - labels to pick in the edit menus, in order; once they run
 *   out every menu answers with its last choice, which is always the way out
 * @param {Error} [opts.throwsOnEdit] - make the first edit menu throw
 * @param {boolean} [opts.tty]
 * @param {number} [opts.rows] - the terminal's height, as stdout reports it
 */
async function configure(opts) {
    const stdout = fakeStream(opts.tty ?? true);
    if (opts.rows !== undefined) stdout.rows = opts.rows;
    const stderr = fakeStream(opts.tty ?? true);
    const stdin = { isTTY: opts.tty ?? true };
    const asked = [];
    // The custom-command prompts are recorded apart from `asked`, so the many tests that
    // read `asked` as "the checkbox, then one select per new entry" keep meaning that.
    const customAsked = [];
    // The edit menus, apart from `asked` for the same reason; and every input's config, so a
    // test can see what an edit question was pre-filled with.
    const editAsked = [];
    const pageSizes = [];
    const inputConfigs = [];
    const rejected = [];
    const menus = [...(opts.menus ?? [])];
    const remaining = [...(opts.modes ?? [])];
    const steps = [...(opts.steps ?? [])];
    const inputs = [...(opts.inputs ?? [])];

    const prompts = {
        // Answers like the real list: what it was left holding, how it was left, and where.
        checkbox: async (config) => {
            asked.push({ type: 'checkbox', choices: config.choices, message: config.message, active: config.active, pageSize: config.pageSize });
            if (opts.throws) throw opts.throws;
            const current = config.choices.filter((c) => c.checked).map((c) => c.value);
            const step = steps.shift();
            if (!step) return { action: 'submit', checked: opts.checked ?? current, active: config.active };

            const index = config.choices.findIndex((c) => c.value === step.value);
            if (step.action === 'edit') assert.ok(config.choices[index]?.editable, `"${step.value}" is not editable`);
            return { ...step, checked: step.checked ?? current, active: index === -1 ? config.active : index };
        },
        select: async (config) => {
            if (!config.message.startsWith('Mode for')) {
                editAsked.push(config.message);
                pageSizes.push(config.pageSize);
                if (opts.throwsOnEdit) throw opts.throwsOnEdit;
                const label = menus.shift();
                const choice = label === undefined
                    ? config.choices.at(-1)
                    : config.choices.find((c) => c.name === label);
                assert.ok(choice, `no choice "${label}" in "${config.message}"`);
                assert.ok(!choice.disabled, `"${choice.name}" is disabled in "${config.message}"`);
                return choice.value;
            }
            asked.push({ type: 'select', message: config.message, choices: config.choices, default: config.default });
            if (opts.throws) throw opts.throws;
            if (opts.throwsOnSelect) throw opts.throwsOnSelect;
            return remaining.shift() ?? 'run';
        },
        confirm: async () => assert.fail('the screen asks no yes/no question'),
        // Like the real prompt: a validate() that answers with a string rejects the line and
        // asks again, so a scripted refusal is followed by the next scripted answer.
        input: async (config) => {
            inputConfigs.push(config);
            if (opts.throwsOnInput) throw opts.throwsOnInput;
            for (;;) {
                const answer = inputs.shift();
                assert.notEqual(answer, undefined, `no scripted answer left for "${config.message}"`);
                customAsked.push(config.message);
                const verdict = config.validate ? config.validate(answer) : true;
                if (verdict === true) return answer;
                rejected.push(verdict);
            }
        },
    };

    const code = await runConfigure({
        configs: opts.configs ?? CONFIGS,
        config: opts.config ?? emptyConfig(),
        presetName: 'default',
        projectRoot: opts.dir,
        log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
        prompts,
        stdin: /** @type {any} */ (stdin),
        stdout: /** @type {any} */ (stdout),
    });

    return { code, asked, customAsked, editAsked, inputConfigs, pageSizes, rejected, output: stdout.text() + stderr.text() };
}

describe('runConfigure — the interactive screen', () => {
    test('offers all 13 configurations from the IDE', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked } = await configure({ dir });
            assert.equal(asked[0].type, 'checkbox');
            assert.equal(asked[0].choices.length, 13);
            assert.match(asked[0].message, /preset "default"/);
        } finally {
            await cleanup();
        }
    });

    test('saves the selection and asks a mode for each newly checked entry', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, output } = await configure({
                dir,
                checked: ['web', 'api'],
                modes: ['debug', 'run'],
            });

            assert.equal(code, 0);
            assert.deepEqual(asked.slice(1).map((a) => a.message), ['Mode for "web"', 'Mode for "api"']);

            const saved = await readPresets(dir);
            assert.deepEqual(saved.presets.default, [
                { name: 'web', mode: 'debug' },
                { name: 'api', mode: 'run' },
            ]);
            assert.match(output, /saved preset "default"/);
            assert.match(output, /\+ web/);
        } finally {
            await cleanup();
        }
    });

    test('the mode question offers run, debug and terminal, defaulting to run', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked } = await configure({ dir, checked: ['web'], modes: ['run'] });
            const [question] = asked.filter((a) => a.type === 'select');
            assert.deepEqual(question.choices.map((c) => c.value), ['run', 'debug', 'terminal']);
            assert.equal(question.default, 'run');
        } finally {
            await cleanup();
        }
    });

    test('a terminal answer is saved as the entry\'s mode', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, checked: ['web', 'api'], modes: ['terminal', 'run'] });
            const saved = await readPresets(dir);
            assert.deepEqual(saved.presets.default, [
                { name: 'web', mode: 'terminal' },
                { name: 'api', mode: 'run' },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('a re-run shows the saved choice already checked', async () => {
        // The plan's second acceptance check, without a terminal.
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, checked: ['web'], modes: ['debug'] });

            const config = await readPresets(dir);
            const { asked } = await configure({ dir, config, checked: ['web'] });
            const checked = asked[0].choices.filter((c) => c.checked);

            assert.deepEqual(checked.map((c) => c.value), ['web']);
        } finally {
            await cleanup();
        }
    });

    test('an unchanged selection is not re-asked and not rewritten', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, checked: ['web'], modes: ['debug'] });
            const before = await fs.readFile(configPath(dir), 'utf8');

            const config = await readPresets(dir);
            const { code, asked, output } = await configure({ dir, config, checked: ['web'] });

            assert.equal(code, 0);
            assert.equal(asked.filter((a) => a.type === 'select').length, 0, 'no mode question for an existing entry');
            assert.match(output, /unchanged/);
            assert.equal(await fs.readFile(configPath(dir), 'utf8'), before);
        } finally {
            await cleanup();
        }
    });

    test('unchecking everything clears the preset', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, checked: ['web'], modes: ['run'] });
            const config = await readPresets(dir);
            const { code, output } = await configure({ dir, config, checked: [] });

            assert.equal(code, 0);
            assert.deepEqual((await readPresets(dir)).presets.default, []);
            assert.match(output, /- web/);
        } finally {
            await cleanup();
        }
    });

    test('warns about a preset entry the IDE no longer reports', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const config = { ...emptyConfig(), presets: { default: [{ name: 'gone', mode: 'run' }] } };
            const { output } = await configure({ dir, config, checked: [] });
            assert.match(output, /"gone" is in the preset but no longer exists in the IDE/);
        } finally {
            await cleanup();
        }
    });

    test('other presets in the file are left alone', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const config = {
                ...emptyConfig(),
                presets: { backend: [{ name: 'api', mode: 'run' }] },
                futureFlag: 7,
            };
            await configure({ dir, config, checked: ['web'], modes: ['run'] });

            const saved = await readPresets(dir);
            assert.deepEqual(saved.presets.backend, [{ name: 'api', mode: 'run' }]);
            assert.equal(saved.futureFlag, 7, 'unknown top-level fields survive');
        } finally {
            await cleanup();
        }
    });
});

describe('runConfigure — configurations named after prototype members', () => {
    test('the mode answered for "__proto__" is actually saved', async () => {
        // A plain `modes[name] = …` would hit the prototype setter and lose the answer.
        const { dir, cleanup } = await tmpProject();
        try {
            const stdout = fakeStream(true);
            const code = await runConfigure({
                configs: [{ name: '__proto__' }, { name: 'constructor' }],
                config: emptyConfig(),
                presetName: 'default',
                projectRoot: dir,
                log: createLogger({ stdout, stderr: stdout, env: { NO_COLOR: '1' } }),
                prompts: {
                    checkbox: async () => ({ action: 'submit', checked: ['__proto__', 'constructor'], active: 0 }),
                    select: async () => 'debug',
                    input: async () => assert.fail('no custom command was asked for'),
                },
                stdin: /** @type {any} */ ({ isTTY: true }),
                stdout: /** @type {any} */ (stdout),
            });

            assert.equal(code, 0);
            const saved = await readPresets(dir);
            assert.deepEqual(saved.presets.default, [
                { name: '__proto__', mode: 'debug' },
                { name: 'constructor', mode: 'debug' },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('a preset named "constructor" is read as its own entry, not a function', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const stdout = fakeStream(true);
            const seen = [];
            await runConfigure({
                configs: CONFIGS,
                config: emptyConfig(),
                presetName: 'constructor',
                projectRoot: dir,
                log: createLogger({ stdout, stderr: stdout, env: { NO_COLOR: '1' } }),
                prompts: {
                    checkbox: async (c) => { seen.push(c.choices); return { action: 'submit', checked: [], active: 0 }; },
                    select: async () => 'run',
                    input: async () => assert.fail('no custom command was asked for'),
                },
                stdin: /** @type {any} */ ({ isTTY: true }),
                stdout: /** @type {any} */ (stdout),
            });

            assert.equal(seen[0].filter((c) => c.checked).length, 0, 'an inherited member is not a preset');
        } finally {
            await cleanup();
        }
    });
});

describe('runConfigure — refusals and cancellation', () => {
    test('refuses to run without a TTY instead of hanging', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, output } = await configure({ dir, tty: false });
            assert.equal(code, 1);
            assert.deepEqual(asked, [], 'no prompt may be opened without a terminal');
            assert.match(output, /needs an interactive terminal/);
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C at a prompt saves nothing and exits 130', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const err = new Error('User force closed the prompt');
            err.name = 'ExitPromptError';
            const { code, output } = await configure({ dir, throws: err });

            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            await assert.rejects(() => fs.readFile(configPath(dir)), { code: 'ENOENT' });
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C during the mode question also saves nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const stdout = fakeStream(true);
            const err = new Error('User force closed the prompt');
            err.name = 'ExitPromptError';

            const code = await runConfigure({
                configs: CONFIGS,
                config: emptyConfig(),
                presetName: 'default',
                projectRoot: dir,
                log: createLogger({ stdout, stderr: stdout, env: { NO_COLOR: '1' } }),
                prompts: {
                    checkbox: async () => ({ action: 'submit', checked: ['web'], active: 0 }),
                    select: async () => { throw err; },
                },
                stdin: /** @type {any} */ ({ isTTY: true }),
                stdout: /** @type {any} */ (stdout),
            });

            assert.equal(code, 130);
            assert.match(stdout.text(), /cancelled; nothing was saved/);
            await assert.rejects(() => fs.readFile(configPath(dir)), { code: 'ENOENT' });
        } finally {
            await cleanup();
        }
    });

    test('an unexpected prompt failure is not swallowed as a cancellation', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await assert.rejects(() => configure({ dir, throws: new Error('tty exploded') }), /tty exploded/);
        } finally {
            await cleanup();
        }
    });

    test('the same holds for the mode questions, which have their own catch', async () => {
        // The two loops each own a try/catch, so the second one can drift from the first.
        // Swallowing a real failure there would write a preset with half the answers in it.
        const { dir, cleanup } = await tmpProject();
        try {
            await assert.rejects(
                () => configure({ dir, checked: ['web'], throwsOnSelect: new Error('tty exploded') }),
                /tty exploded/,
            );
            assert.deepEqual(await readPresets(dir), emptyConfig(), 'nothing may be written');
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C during a mode question is still an ordinary cancellation', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const err = new Error('prompt closed');
            err.name = 'ExitPromptError';
            const { code, output } = await configure({ dir, checked: ['web'], throwsOnSelect: err });
            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            assert.deepEqual(await readPresets(dir), emptyConfig());
        } finally {
            await cleanup();
        }
    });

    test('an empty IDE list still reports stale preset entries', async () => {
        // The one case where a stale entry would otherwise vanish without a word.
        const { dir, cleanup } = await tmpProject();
        try {
            const stdout = fakeStream(true);
            const code = await runConfigure({
                configs: [],
                config: { ...emptyConfig(), presets: { default: [{ name: 'gone', mode: 'run' }] } },
                presetName: 'default',
                projectRoot: dir,
                log: createLogger({ stdout, stderr: stdout, env: { NO_COLOR: '1' } }),
                prompts: { checkbox: async () => assert.fail('must not prompt'), select: async () => 'run' },
                stdin: /** @type {any} */ ({ isTTY: true }),
                stdout: /** @type {any} */ (stdout),
            });

            assert.equal(code, 1);
            assert.match(stdout.text(), /"gone" is in the preset but no longer exists/);
            assert.match(stdout.text(), /no run configurations/);
        } finally {
            await cleanup();
        }
    });
});

describe('runConfigure — custom commands', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const withSeed = () => ({ ...emptyConfig(), presets: { default: [seed] } });
    const NAME = 'Name (it titles the terminal tab; empty to go back)';
    const FIRST = 'Command (empty to go back)';

    test('only the list is shown until n is pressed', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, customAsked, output } = await configure({ dir });
            assert.equal(code, 0);
            assert.deepEqual(customAsked, []);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('n asks a name and the commands, and the entry comes back checked under the cursor', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, customAsked, output } = await configure({
                dir,
                steps: [{ action: 'new', checked: ['web'] }],
                modes: ['run'],
                inputs: ['seed db', 'npm i', 'npm run seed', ''],
            });

            assert.equal(code, 0);
            assert.deepEqual(customAsked, [NAME, FIRST, 'Command 2 (empty to finish)', 'Command 3 (empty to finish)']);
            const [, list] = asked;
            assert.deepEqual(list.choices.at(-1), {
                name: '⌘ seed db — npm i && npm run seed', value: newChoiceValue(0), checked: true, editable: true,
            });
            assert.equal(list.active, list.choices.length - 1);
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'web', mode: 'run' },
                { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] },
            ]);
            assert.match(output, /\+ seed db/);
        } finally {
            await cleanup();
        }
    });

    test('can add several in one run', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({
                dir,
                steps: [{ action: 'new' }, { action: 'new' }],
                inputs: ['a', 'echo a', '', 'b', 'echo b', ''],
            });
            const saved = (await readPresets(dir)).presets.default;
            assert.deepEqual(saved.map((entry) => entry.name), ['a', 'b']);
        } finally {
            await cleanup();
        }
    });

    test('an empty name goes back to the list and adds nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, customAsked, output } = await configure({ dir, steps: [{ action: 'new' }], inputs: [''] });
            assert.deepEqual(customAsked, [NAME]);
            assert.equal(asked.filter((a) => a.type === 'checkbox').length, 2);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('a new entry unchecked before Enter is not saved', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { output } = await configure({ dir, steps: [{ action: 'new' }], inputs: ['a', 'echo a', ''], checked: [] });
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('the name of a run configuration is refused and asked again', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                steps: [{ action: 'new' }],
                inputs: ['web', 'seed db', 'npm i', ''],
            });

            assert.deepEqual(rejected, ['"web" is the name of a run configuration; pick a different name']);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });

    test('an empty first command also goes back, adding nothing — not even the name', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, customAsked, rejected, output } = await configure({
                dir,
                steps: [{ action: 'new' }, { action: 'new' }],
                inputs: ['seed', '', 'seed', 'npm i', ''],
            });
            assert.deepEqual(rejected, [], 'the name is free again: nothing was added');
            assert.deepEqual(customAsked.slice(0, 2), [NAME, FIRST]);
            assert.equal(asked.filter((a) => a.type === 'checkbox').length, 3);
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'seed', mode: 'terminal', commands: ['npm i'] },
            ]);
            assert.match(output, /\+ seed/);
        } finally {
            await cleanup();
        }
    });

    test('a command with a control character is refused, since the store would not read it back', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                steps: [{ action: 'new' }],
                inputs: ['seed', 'npm i\u001b[2J', 'npm i', 'a\u0085b', ''],
            });
            assert.deepEqual(rejected, [
                'a command cannot contain control characters',
                'a command cannot contain control characters',
            ]);
            assert.deepEqual((await readPresets(dir)).presets.default[0].commands, ['npm i']);
        } finally {
            await cleanup();
        }
    });

    test('surrounding spaces are trimmed from the name and from each command', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, steps: [{ action: 'new' }], inputs: ['  seed db ', '  npm i  ', ''] });
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'seed db', mode: 'terminal', commands: ['npm i'] },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('a saved custom entry comes back checked in the same list, and editable', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await configure({ dir, config: withSeed() });

            const custom = asked[0].choices.filter((c) => c.checked);
            assert.deepEqual(custom, [
                { name: '⌘ seed db — npm i && npm run seed', value: customChoiceValue(0), checked: true, editable: true },
            ]);
            assert.ok(asked[0].choices.filter((c) => c !== custom[0]).every((c) => !c.editable));
            assert.match(output, /unchanged/, 'an untouched custom entry is not rewritten');
        } finally {
            await cleanup();
        }
    });

    test('unchecking it removes it, and is reported', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { output } = await configure({ dir, config: withSeed(), checked: [] });

            assert.deepEqual((await readPresets(dir)).presets.default, []);
            assert.match(output, /- seed db/);
        } finally {
            await cleanup();
        }
    });

    test('a name the preset already has is refused, even when it was just unchecked', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                config: withSeed(),
                steps: [{ action: 'new', checked: [] }],
                inputs: ['seed db', 'other', 'echo hi', ''],
            });

            assert.deepEqual(rejected, ['"seed db" is already a custom command in this preset']);
            assert.deepEqual((await readPresets(dir)).presets.default.map((entry) => entry.name), ['other']);
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C while answering cancels and saves nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const err = new Error('User force closed the prompt');
            err.name = 'ExitPromptError';

            const { code, output } = await configure({
                dir,
                steps: [{ action: 'new', checked: ['web'] }],
                throwsOnInput: err,
            });

            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            assert.deepEqual((await readPresets(dir)).presets, {});
        } finally {
            await cleanup();
        }
    });

    test('an IDE with no run configurations still shows the list, where n adds a custom command', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, output } = await configure({
                dir,
                configs: [],
                steps: [{ action: 'new' }],
                inputs: ['seed db', 'npm i', ''],
            });

            assert.equal(code, 0);
            assert.deepEqual(asked[0].choices, []);
            assert.match(output, /no run configurations/);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });
});

describe('runConfigure — editing custom commands from the list', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const withSeed = () => ({ ...emptyConfig(), presets: { default: [{ name: 'web', mode: 'run' }, seed] } });
    const SEED = customChoiceValue(1);
    const editSeed = [{ action: 'edit', value: SEED }];

    /** @param {object} opts */
    const edit = (opts) => configure({ config: withSeed(), steps: editSeed, ...opts });
    const saved = async (dir) => (await readPresets(dir)).presets.default;

    test('e opens the entry, and leaving it untouched changes nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, editAsked, asked, output } = await edit({ dir });
            assert.equal(code, 0);
            assert.deepEqual(editAsked, ['Edit "seed db"']);
            assert.equal(asked.filter((a) => a.type === 'checkbox').length, 2, 'the list comes back');
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('renames an entry in place, pre-filling the old name; the list shows the new one under the cursor', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { editAsked, asked, inputConfigs, output } = await edit({ dir, menus: ['Name: seed db'], inputs: [' seed '] });

            assert.deepEqual(editAsked, ['Edit "seed db"', 'Edit "seed"']);
            assert.equal(inputConfigs[0].default, 'seed db');
            assert.equal(inputConfigs[0].prefill, 'editable');
            const list = asked[1];
            assert.equal(list.choices[list.active].name, '⌘ seed — npm i && npm run seed');
            assert.deepEqual(await saved(dir), [
                { name: 'web', mode: 'run' },
                { name: 'seed', mode: 'terminal', commands: ['npm i', 'npm run seed'] },
            ]);
            assert.match(output, /~ seed db: renamed to seed/);
            assert.doesNotMatch(output, /[-+] seed/);
        } finally {
            await cleanup();
        }
    });

    test('an unchecked entry that is changed comes back checked: an edit is meant to be kept', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked } = await edit({
                dir,
                steps: [{ action: 'edit', value: SEED, checked: ['web'] }],
                menus: ['Name: seed db'],
                inputs: ['seed'],
            });

            assert.equal(asked[1].choices.find((c) => c.value === SEED).checked, true);
            assert.deepEqual((await saved(dir)).map((entry) => entry.name), ['web', 'seed']);
        } finally {
            await cleanup();
        }
    });

    test('an unchecked entry opened and left untouched stays unchecked', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await edit({ dir, steps: [{ action: 'edit', value: SEED, checked: ['web'] }] });

            assert.equal(asked[1].choices.find((c) => c.value === SEED).checked, false);
            assert.deepEqual(await saved(dir), [{ name: 'web', mode: 'run' }]);
            assert.match(output, /- seed db/);
        } finally {
            await cleanup();
        }
    });

    test('in a short terminal the list and every menu fit on the screen', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, pageSizes } = await edit({ dir, rows: 12, menus: ['1. npm i'] });
            assert.ok(asked.every((a) => a.type !== 'checkbox' || a.pageSize === 8));
            assert.deepEqual(pageSizes, [8, 8, 8]);
        } finally {
            await cleanup();
        }
    });

    test('of two custom entries with one name, e edits the one under the cursor and leaves the other', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const twins = [
                { name: 'x', mode: 'terminal', commands: ['echo first'] },
                { name: 'x', mode: 'terminal', commands: ['echo second'] },
            ];
            const { inputConfigs } = await configure({
                dir,
                config: { ...emptyConfig(), presets: { default: twins } },
                steps: [{ action: 'edit', value: customChoiceValue(1) }],
                menus: ['1. echo second', 'Change'],
                inputs: ['echo edited'],
            });

            assert.equal(inputConfigs[0].default, 'echo second');
            assert.deepEqual((await saved(dir)).map((entry) => entry.commands), [['echo first'], ['echo edited']]);
        } finally {
            await cleanup();
        }
    });

    test('a rename to a run configuration or to another custom name is refused; its own name is fine', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const config = { ...emptyConfig(), presets: { default: [seed, { ...seed, name: 'other' }] } };
            const { rejected, output } = await configure({
                dir,
                config,
                steps: [{ action: 'edit', value: customChoiceValue(0) }],
                menus: ['Name: seed db'],
                inputs: ['web', 'other', 'seed db'],
            });

            assert.deepEqual(rejected, [
                '"web" is the name of a run configuration; pick a different name',
                '"other" is already a custom command in this preset',
            ]);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('changes one command, pre-filling the old line', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { inputConfigs, output } = await edit({ dir, menus: ['1. npm i', 'Change'], inputs: ['npm ci'] });

            assert.equal(inputConfigs[0].default, 'npm i');
            assert.deepEqual((await saved(dir))[1].commands, ['npm ci', 'npm run seed']);
            assert.match(output, /~ seed db: npm i && npm run seed → npm ci && npm run seed/);
        } finally {
            await cleanup();
        }
    });

    test('moves a command, and the menu follows it to its new number', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { output } = await edit({ dir, menus: ['1. npm i', 'Move down', '2. npm i', 'Move up'] });
            assert.match(output, /unchanged/, 'moved there and back');

            await edit({ dir, menus: ['1. npm i', 'Move down'] });
            assert.deepEqual((await saved(dir))[1].commands, ['npm run seed', 'npm i']);
        } finally {
            await cleanup();
        }
    });

    test('deletes one command and adds another at the end', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await edit({ dir, menus: ['1. npm i', 'Delete', '+ Add a command'], inputs: ['echo done'] });
            assert.deepEqual((await saved(dir))[1].commands, ['npm run seed', 'echo done']);
        } finally {
            await cleanup();
        }
    });

    test('a line with a control character is refused, when changed and when added', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await edit({
                dir,
                menus: ['1. npm i', 'Change', '+ Add a command'],
                inputs: ['npm i\u001b[2J', 'npm ci', 'echo\nrm', 'echo ok'],
            });

            assert.deepEqual(rejected, [
                'a command cannot contain control characters',
                'a command cannot contain control characters',
            ]);
            assert.deepEqual((await saved(dir))[1].commands, ['npm ci', 'npm run seed', 'echo ok']);
        } finally {
            await cleanup();
        }
    });

    test('every question in the menu has a way back: an empty answer changes nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { editAsked, inputConfigs, rejected, output } = await edit({
                dir,
                menus: ['Name: seed db', '+ Add a command', '1. npm i', 'Change'],
                inputs: ['', '', ''],
            });

            assert.deepEqual(rejected, []);
            assert.deepEqual(inputConfigs.map((c) => c.message), [
                'Name (it titles the terminal tab; empty to keep it)',
                'New command (empty to go back)',
                'Command 1 (empty to keep it)',
            ]);
            assert.deepEqual(editAsked.filter((m) => m.startsWith('Edit')), Array(4).fill('Edit "seed db"'));
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('an entry called like a run configuration can keep its name', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const config = { ...emptyConfig(), presets: { default: [{ ...seed, name: 'web' }] } };
            const { rejected, output } = await configure({
                dir,
                config,
                steps: [{ action: 'edit', value: customChoiceValue(0) }],
                menus: ['Name: web', 'Name: web', 'Name: www'],
                inputs: ['web', 'www', 'web'],
            });

            assert.deepEqual(rejected, [], 'its own name, even after a rename on this screen');
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('deletes the whole entry, which then leaves the list', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await edit({ dir, menus: ['Delete "seed db" from the preset'] });

            assert.equal(asked[1].choices.some((c) => c.value === SEED), false);
            assert.deepEqual(await saved(dir), [{ name: 'web', mode: 'run' }]);
            assert.match(output, /- seed db/);
        } finally {
            await cleanup();
        }
    });

    test('a name given to an entry on this screen cannot be reused by a new one', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await edit({
                dir,
                steps: [...editSeed, { action: 'new' }],
                menus: ['Name: seed db'],
                inputs: ['seed', 'seed', 'seed db', 'lint', 'npm run lint', ''],
            });

            assert.deepEqual(rejected, [
                '"seed" is already a custom command in this preset',
                '"seed db" is already a custom command in this preset',
            ]);
            assert.deepEqual((await saved(dir)).map((entry) => entry.name), ['web', 'seed', 'lint']);
        } finally {
            await cleanup();
        }
    });

    test('an entry added with n can be edited before it is saved', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({
                dir,
                steps: [{ action: 'new' }, { action: 'edit', value: newChoiceValue(0) }],
                menus: ['Name: lint', '1. npm run lint', 'Change'],
                inputs: ['lint', 'npm run lint', '', 'lint:fix', 'npm run lint -- --fix'],
            });
            assert.deepEqual((await saved(dir)), [
                { name: 'lint:fix', mode: 'terminal', commands: ['npm run lint -- --fix'] },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('an entry added with n and then deleted is not saved', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await configure({
                dir,
                steps: [{ action: 'new' }, { action: 'edit', value: newChoiceValue(0) }],
                menus: ['Delete "lint" from the preset'],
                inputs: ['lint', 'npm run lint', ''],
            });
            assert.equal(asked.at(-1).choices.some((c) => c.value === newChoiceValue(0)), false);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C in an edit menu cancels and saves nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const err = new Error('User force closed the prompt');
            err.name = 'ExitPromptError';

            const { code, output } = await edit({ dir, throwsOnEdit: err });
            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            assert.deepEqual((await readPresets(dir)).presets, {});
        } finally {
            await cleanup();
        }
    });
});
