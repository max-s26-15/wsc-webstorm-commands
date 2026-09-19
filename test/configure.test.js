import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { createLogger } from '../src/log.js';
import { configPath, emptyConfig, readPresets } from '../src/presets/store.js';
import { normalizeRunConfigs } from '../src/resolve.js';
import { runConfigure } from '../src/ui/configure.js';
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
 * @param {Array<'run'|'debug'>} [opts.modes] - answers to the mode questions, in order
 * @param {object} [opts.config] - preset file contents as already read
 * @param {Error} [opts.throws] - make the first prompt throw (Ctrl-C, for instance)
 * @param {Error} [opts.throwsOnSelect] - make the *mode* prompt throw instead, so the
 *   second try/catch is exercised in its own right
 * @param {boolean} [opts.tty]
 */
async function configure(opts) {
    const stdout = fakeStream(opts.tty ?? true);
    const stderr = fakeStream(opts.tty ?? true);
    const stdin = { isTTY: opts.tty ?? true };
    const asked = [];
    const remaining = [...(opts.modes ?? [])];

    const prompts = {
        checkbox: async (config) => {
            asked.push({ type: 'checkbox', choices: config.choices, message: config.message });
            if (opts.throws) throw opts.throws;
            return opts.checked ?? [];
        },
        select: async (config) => {
            asked.push({ type: 'select', message: config.message });
            if (opts.throws) throw opts.throws;
            if (opts.throwsOnSelect) throw opts.throwsOnSelect;
            return remaining.shift() ?? 'run';
        },
    };

    const code = await runConfigure({
        configs: CONFIGS,
        config: opts.config ?? emptyConfig(),
        presetName: 'default',
        projectRoot: opts.dir,
        log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
        prompts,
        stdin: /** @type {any} */ (stdin),
        stdout: /** @type {any} */ (stdout),
    });

    return { code, asked, output: stdout.text() + stderr.text() };
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

    test('exits 1 when the IDE reports no configurations at all', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const stdout = fakeStream(true);
            const code = await runConfigure({
                configs: [],
                config: emptyConfig(),
                presetName: 'default',
                projectRoot: dir,
                log: createLogger({ stdout, stderr: stdout, env: { NO_COLOR: '1' } }),
                prompts: { checkbox: async () => assert.fail('must not prompt'), select: async () => 'run' },
                stdin: /** @type {any} */ ({ isTTY: true }),
                stdout: /** @type {any} */ (stdout),
            });

            assert.equal(code, 1);
            assert.match(stdout.text(), /no run configurations/);
        } finally {
            await cleanup();
        }
    });
});
