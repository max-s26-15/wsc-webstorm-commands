import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { UsageError } from '../src/args.js';
import { ControlError, formatControlPlan, planControl, selectTargets } from '../src/control/select.js';
import { parseConfig } from '../src/presets/store.js';
import { normalizeRunConfigs, UnknownConfigurationError } from '../src/resolve.js';

const require = createRequire(import.meta.url);
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

/** @param {Record<string, object[]>} presets - read the way the store reads the file (modes default to run) */
const config = (presets) => parseConfig(JSON.stringify({ version: 1, defaultPreset: 'default', presets }));

const nothing = { runs: [], terminals: [] };
const ngrok = { name: 'ngrok', mode: 'terminal', commands: ['ngrok http 8000'] };

/** @param {Partial<{ presetNames: string[] | null, tokens: string[] }>} [opts] */
function select(presets, running, opts = {}) {
    return selectTargets({
        config: config(presets),
        presetNames: opts.presetNames ?? null,
        tokens: opts.tokens ?? [],
        configs: CONFIGS,
        running: { ...nothing, ...running },
    });
}

const names = (targets) => targets.map((target) => target.name);

describe('selectTargets — which entries are running', () => {
    const presets = { dev: [{ name: 'web' }, { name: 'api' }, ngrok], docs: [{ name: 'docs' }] };

    test('without names it takes every running entry of every preset, in preset order', () => {
        const { targets, notRunning } = select(presets, {
            runs: [{ configurationName: 'docs', mode: 'run' }, { configurationName: 'web', mode: 'run' }],
            terminals: [{ entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: true }],
        });
        assert.deepEqual(names(targets), ['web', 'ngrok', 'docs']);
        assert.deepEqual(notRunning, []);
    });

    test('--preset narrows it to those presets', () => {
        const { targets } = select(presets, {
            runs: [{ configurationName: 'docs', mode: 'run' }, { configurationName: 'web', mode: 'run' }],
        }, { presetNames: ['docs'] });
        assert.deepEqual(names(targets), ['docs']);
    });

    test('a preset entry written differently from the IDE\'s name is still the same configuration', () => {
        const { targets } = select({ dev: [{ name: 'Web' }] }, { runs: [{ configurationName: 'web', mode: 'run' }] });
        assert.deepEqual(names(targets), ['web']);
    });

    test('an entry the IDE no longer has is skipped, not fatal to the rest', () => {
        const { targets } = select({ dev: [{ name: 'gone-for-good' }, { name: 'web' }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
        });
        assert.deepEqual(names(targets), ['web']);
    });

    test('a Terminal tab counts only while a command is running in it', () => {
        const { targets } = select(presets, {
            terminals: [{ entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: false }],
        });
        assert.deepEqual(targets, []);
    });

    test('a custom command and a configuration of one name are two entries', () => {
        const { targets } = select({ dev: [{ name: 'web' }, { name: 'web', mode: 'terminal', commands: ['make web'] }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
            terminals: [{ entryName: 'web', kind: 'custom', mode: 'terminal', commandRunning: true }],
        });
        assert.deepEqual(targets.map((target) => [target.kind, target.name]), [['config', 'web'], ['custom', 'web']]);
    });

    test('one configuration running in two places is one target with two instances', () => {
        const { targets } = select({ dev: [{ name: 'web' }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
            terminals: [{ entryName: 'web', kind: 'config', mode: 'run', commandRunning: true }],
        });
        assert.equal(targets.length, 1);
        assert.deepEqual(targets[0].instances, [{ where: 'run' }, { where: 'terminal', mode: 'run' }]);
    });

    test('a terminal instance carries the mode and inspector port its tab was marked with', () => {
        const { targets } = select({ dev: [{ name: 'api', mode: 'debug' }] }, {
            terminals: [{ entryName: 'api', kind: 'config', mode: 'debug', debugPort: 9301, commandRunning: true }],
        });
        assert.deepEqual(targets[0].instances, [{ where: 'terminal', mode: 'debug', debugPort: 9301 }]);
        assert.equal(targets[0].config?.name, 'api');
    });

    test('a configuration in two presets is one target, which knows both', () => {
        const { targets } = select({ a: [{ name: 'web' }], b: [{ name: 'web', mode: 'debug' }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
        });
        assert.equal(targets.length, 1);
        assert.deepEqual(targets[0].presets, ['a', 'b']);
        // Last mode wins, as in buildLaunchPlan().
        assert.equal(targets[0].mode, 'debug');
    });

    test('presets and entries named after Object.prototype members are ordinary names', () => {
        const { targets } = select({ constructor: [{ name: 'toString', mode: 'terminal', commands: ['echo hi'] }] }, {
            terminals: [{ entryName: 'toString', kind: 'custom', mode: 'terminal', commandRunning: true }],
        }, { presetNames: ['constructor'] });
        assert.deepEqual(names(targets), ['toString']);
    });
});

describe('selectTargets — names on the command line', () => {
    const presets = { dev: [{ name: 'web' }, { name: 'api' }, { name: 'api > repro:stale-job:debug' }, ngrok] };
    const allRunning = {
        runs: [
            { configurationName: 'web', mode: 'run' },
            { configurationName: 'api', mode: 'run' },
            { configurationName: 'api > repro:stale-job:debug', mode: 'run' },
        ],
        terminals: [{ entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: true }],
    };

    test('a name picks that entry only', () => {
        assert.deepEqual(names(select(presets, allRunning, { tokens: ['web'] }).targets), ['web']);
    });

    test('a custom command can be named, though a launch cannot name one', () => {
        assert.deepEqual(names(select(presets, allRunning, { tokens: ['ngrok'] }).targets), ['ngrok']);
    });

    test('a name is resolved like a launch: case and prefix', () => {
        assert.deepEqual(names(select(presets, allRunning, { tokens: ['WEB'] }).targets), ['web']);
        assert.deepEqual(names(select(presets, allRunning, { tokens: ['ngr'] }).targets), ['ngrok']);
    });

    test('a name with a colon in it is a name, not a mode', () => {
        const { targets } = select(presets, allRunning, { tokens: ['api > repro:stale-job:debug'] });
        assert.deepEqual(names(targets), ['api > repro:stale-job:debug']);
    });

    test('a mode suffix is refused: the mode comes from the preset', () => {
        assert.throws(() => select(presets, allRunning, { tokens: ['web:debug'] }), (err) => {
            assert.ok(err instanceof UsageError);
            assert.match(err.message, /drop ":debug" from "web:debug"/);
            return true;
        });
    });

    test('a name that is in no preset of the scope is unknown', () => {
        assert.throws(() => select(presets, allRunning, { tokens: ['docs'] }), UnknownConfigurationError);
    });

    test('a named entry that is not running is reported, not selected', () => {
        const { targets, notRunning } = select(presets, { runs: [{ configurationName: 'web', mode: 'run' }] }, {
            tokens: ['web', 'api'],
        });
        assert.deepEqual(names(targets), ['web']);
        assert.deepEqual(names(notRunning), ['api']);
    });

    test('two different custom commands of one name are refused once that name is chosen', () => {
        const presets2 = {
            a: [{ name: 'seed', mode: 'terminal', commands: ['npm run seed'] }, { name: 'web' }],
            b: [{ name: 'seed', mode: 'terminal', commands: ['make seed'] }],
        };
        const running = {
            runs: [{ configurationName: 'web', mode: 'run' }],
            terminals: [{ entryName: 'seed', kind: 'custom', mode: 'terminal', commandRunning: true }],
        };

        assert.deepEqual(names(select(presets2, running, { tokens: ['web'] }).targets), ['web']);
        assert.throws(() => select(presets2, running, { tokens: ['seed'] }), (err) => {
            assert.ok(err instanceof ControlError);
            assert.match(err.message, /two different custom commands are called "seed"/);
            assert.match(err.message, /--preset/);
            return true;
        });
    });
});

describe('planControl', () => {
    /** @param {object} entry @param {object} running */
    const targets = (entry, running) => select({ dev: [entry] }, running).targets;

    test('stop: one step per place the entry runs', () => {
        const steps = planControl('stop', targets({ name: 'web' }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
            terminals: [{ entryName: 'web', kind: 'config', mode: 'run', commandRunning: true }],
        }));
        assert.deepEqual(steps.map((step) => [step.action, step.instance?.where, step.relaunch]), [
            ['stop', 'run', false],
            ['stop', 'terminal', false],
        ]);
    });

    test('restart: the same setup restarts in place', () => {
        const steps = planControl('restart', targets({ name: 'web' }, { runs: [{ configurationName: 'web', mode: 'run' }] }));
        assert.deepEqual(steps.map((step) => step.action), ['restart']);
    });

    test('restart: --target=terminal is not part of the setup, so that tab restarts in place', () => {
        const steps = planControl('restart', targets({ name: 'web' }, {
            terminals: [{ entryName: 'web', kind: 'config', mode: 'run', commandRunning: true }],
        }));
        assert.deepEqual(steps.map((step) => step.action), ['restart']);
    });

    test('restart: an entry two presets give different modes stays where it runs, if it runs in either', () => {
        const { targets: both } = select({ dev: [{ name: 'web' }], debugging: [{ name: 'web', mode: 'debug' }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }],
        });
        assert.deepEqual(planControl('restart', both).map((step) => step.action), ['restart']);
    });

    test('restart: a custom command always restarts in place', () => {
        const steps = planControl('restart', targets(ngrok, {
            terminals: [{ entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: true }],
        }));
        assert.deepEqual(steps.map((step) => step.action), ['restart']);
    });

    test('restart: a changed mode stops it where it runs and launches it anew, after everything else', () => {
        const presets = { dev: [{ name: 'api', mode: 'debug' }, { name: 'web' }] };
        const { targets: both } = select(presets, {
            runs: [{ configurationName: 'api', mode: 'run' }, { configurationName: 'web', mode: 'run' }],
        });
        const steps = planControl('restart', both);
        assert.deepEqual(steps.map((step) => [step.action, step.target.name, step.relaunch]), [
            ['stop', 'api', true],
            ['restart', 'web', undefined],
            ['launch', 'api', undefined],
        ]);
    });
});

describe('formatControlPlan', () => {
    test('one line per step: action, name, and where', () => {
        const { targets } = select({ dev: [{ name: 'web' }, { name: 'api', mode: 'debug' }] }, {
            runs: [{ configurationName: 'web', mode: 'run' }, { configurationName: 'api', mode: 'run' }],
        });
        assert.equal(
            formatControlPlan(planControl('restart', targets)),
            [
                'restart  web  Run tab',
                'stop     api  Run tab  (preset now says debug)',
                'launch   api  as debug',
            ].join('\n'),
        );
    });

    test('says so when there is nothing to do', () => {
        assert.equal(formatControlPlan([]), 'nothing to do');
    });
});
