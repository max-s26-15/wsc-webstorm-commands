import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { createLogger } from '../src/log.js';
import { configPath, emptyConfig, readPresets } from '../src/presets/store.js';
import { normalizeRunConfigs } from '../src/resolve.js';
import { runConfigure } from '../src/ui/configure.js';
import { customChoiceValue } from '../src/ui/configureLogic.js';
import { fakeStream } from '../test-utils/capture.js';
import { tmpProject } from '../test-utils/tmp-dir.js';

const require = createRequire(import.meta.url);
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

/**
 * Drive runConfigure with scripted answers instead of a terminal.
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string[]} [opts.checked] - what the checkbox returns
 * @param {Array<import('../src/modes.js').LaunchMode>} [opts.modes] - answers to the mode questions, in order
 * @param {boolean[]} [opts.confirms] - answers to "add a custom command?", in order; false once they run out
 * @param {string[]} [opts.inputs] - answers to the name and command lines, in order
 * @param {object[]} [opts.configs] - what the IDE reports; the 13-configuration fixture by default
 * @param {object} [opts.config] - preset file contents as already read
 * @param {Error} [opts.throws] - make the first prompt throw (Ctrl-C, for instance)
 * @param {Error} [opts.throwsOnSelect] - make the *mode* prompt throw instead, so the
 *   second try/catch is exercised in its own right
 * @param {Error} [opts.throwsOnConfirm] - make the custom-command question throw
 * @param {boolean} [opts.tty]
 */
async function configure(opts) {
    const stdout = fakeStream(opts.tty ?? true);
    const stderr = fakeStream(opts.tty ?? true);
    const stdin = { isTTY: opts.tty ?? true };
    const asked = [];
    // The custom-command prompts are recorded apart from `asked`, so the many tests that
    // read `asked` as "the checkbox, then one select per new entry" keep meaning that.
    const customAsked = [];
    const rejected = [];
    const remaining = [...(opts.modes ?? [])];
    const confirms = [...(opts.confirms ?? [])];
    const inputs = [...(opts.inputs ?? [])];

    const prompts = {
        checkbox: async (config) => {
            asked.push({ type: 'checkbox', choices: config.choices, message: config.message });
            if (opts.throws) throw opts.throws;
            return opts.checked ?? [];
        },
        select: async (config) => {
            asked.push({ type: 'select', message: config.message, choices: config.choices, default: config.default });
            if (opts.throws) throw opts.throws;
            if (opts.throwsOnSelect) throw opts.throwsOnSelect;
            return remaining.shift() ?? 'run';
        },
        confirm: async (config) => {
            customAsked.push(config.message);
            if (opts.throwsOnConfirm) throw opts.throwsOnConfirm;
            return confirms.shift() ?? false;
        },
        // Like the real prompt: a validate() that answers with a string rejects the line and
        // asks again, so a scripted refusal is followed by the next scripted answer.
        input: async (config) => {
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

    return { code, asked, customAsked, rejected, output: stdout.text() + stderr.text() };
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

            assert.deepEqual(checked.map((c) => [c.value, c.mode]), [['web', 'debug']]);
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
                    checkbox: async () => ['__proto__', 'constructor'],
                    select: async () => 'debug',
                    confirm: async () => false,
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
                    checkbox: async (c) => { seen.push(c.choices); return []; },
                    select: async () => 'run',
                    confirm: async () => false,
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
                    checkbox: async () => ['web'],
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

    test('asks whether to add one, and declining changes nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, customAsked, output } = await configure({ dir });
            assert.equal(code, 0);
            assert.deepEqual(customAsked, ['Add a custom command?']);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('saves a named command list after the configurations', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, customAsked, output } = await configure({
                dir,
                checked: ['web'],
                modes: ['run'],
                confirms: [true],
                inputs: ['seed db', 'npm i', 'npm run seed', ''],
            });

            assert.equal(code, 0);
            assert.deepEqual(customAsked, [
                'Add a custom command?',
                'Name (it titles the terminal tab)',
                'Command',
                'Command 2 (empty to finish)',
                'Command 3 (empty to finish)',
                'Add another custom command?',
            ]);
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
                confirms: [true, true],
                inputs: ['a', 'echo a', '', 'b', 'echo b', ''],
            });
            const saved = (await readPresets(dir)).presets.default;
            assert.deepEqual(saved.map((entry) => entry.name), ['a', 'b']);
        } finally {
            await cleanup();
        }
    });

    test('an empty name and the name of a run configuration are refused and asked again', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                confirms: [true],
                inputs: ['', 'web', 'seed db', 'npm i', ''],
            });

            assert.deepEqual(rejected, [
                'a name is required',
                '"web" is the name of a run configuration; pick a different name',
            ]);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });

    test('the first command is required; later ones end the list when left empty', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({ dir, confirms: [true], inputs: ['seed', '', 'npm i', ''] });
            assert.deepEqual(rejected, ['the first command is required']);
            assert.deepEqual((await readPresets(dir)).presets.default[0].commands, ['npm i']);
        } finally {
            await cleanup();
        }
    });

    test('surrounding spaces are trimmed from the name and from each command', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, confirms: [true], inputs: ['  seed db ', '  npm i  ', ''] });
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'seed db', mode: 'terminal', commands: ['npm i'] },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('a saved custom entry comes back checked in the same list', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await configure({
                dir,
                config: withSeed(),
                checked: [customChoiceValue('seed db')],
            });

            const custom = asked[0].choices.filter((c) => c.checked);
            assert.deepEqual(custom.map((c) => c.name), ['⌘ seed db — npm i && npm run seed']);
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
                checked: [],
                confirms: [true],
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

            const { code, output } = await configure({ dir, checked: ['web'], modes: ['run'], throwsOnConfirm: err });

            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            assert.deepEqual((await readPresets(dir)).presets, {});
        } finally {
            await cleanup();
        }
    });

    test('an IDE with no run configurations skips the checkbox and still offers custom commands', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, output } = await configure({
                dir,
                configs: [],
                confirms: [true],
                inputs: ['seed db', 'npm i', ''],
            });

            assert.equal(code, 0);
            assert.equal(asked.filter((a) => a.type === 'checkbox').length, 0);
            assert.match(output, /no run configurations/);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });
});
