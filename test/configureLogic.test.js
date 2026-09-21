import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { normalizeRunConfigs } from '../src/resolve.js';
import {
    DEFAULT_MODE,
    applyAnswersToPreset,
    buildInitialSelection,
    customChoiceValue,
    diffPreset,
    pendingModeQuestions,
    validateCustomName,
} from '../src/ui/configureLogic.js';

const require = createRequire(import.meta.url);
/** The demo-app payload — the same 13 rows `wsc -c` shows. */
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

describe('buildInitialSelection', () => {
    test('offers every configuration the IDE reported, in the IDE’s order', () => {
        const { choices } = buildInitialSelection(CONFIGS);
        assert.equal(choices.length, 13);
        assert.deepEqual(choices.map((c) => c.value), CONFIGS.map((c) => c.name));
    });

    test('nothing is checked when there is no preset yet', () => {
        const { choices } = buildInitialSelection(CONFIGS);
        assert.deepEqual(choices.filter((c) => c.checked), []);
    });

    test('the saved preset comes back checked — the re-run acceptance check', () => {
        const preset = [{ name: 'web', mode: 'debug' }, { name: 'api', mode: 'run' }];
        const { choices } = buildInitialSelection(CONFIGS, preset);

        assert.deepEqual(choices.filter((c) => c.checked).map((c) => c.value), ['web', 'api']);
    });

    test('a checked choice carries the mode it was saved with', () => {
        const { choices } = buildInitialSelection(CONFIGS, [{ name: 'web', mode: 'debug' }]);
        const web = choices.find((c) => c.value === 'web');
        assert.equal(web.mode, 'debug');
        assert.equal(choices.find((c) => c.value === 'api').mode, null);
    });

    test('the label shows the configuration type, the value stays the exact name', () => {
        const { choices } = buildInitialSelection(CONFIGS);
        const web = choices.find((c) => c.value === 'web');
        assert.equal(web.name, 'web  (npm)');
        assert.equal(web.value, 'web', 'the value is what gets saved and resolved');
    });

    test('a configuration with no description is labelled by name alone', () => {
        const { choices } = buildInitialSelection([{ name: 'bare' }]);
        assert.equal(choices[0].name, 'bare');
    });

    test('names containing colons survive as values untouched', () => {
        const { choices } = buildInitialSelection(CONFIGS);
        assert.ok(choices.some((c) => c.value === 'api > repro:stale-job:debug'));
    });

    test('a preset entry the IDE no longer reports is flagged as stale', () => {
        const preset = [{ name: 'web', mode: 'run' }, { name: 'deleted-in-the-ide', mode: 'debug' }];
        const { choices, stale } = buildInitialSelection(CONFIGS, preset);

        assert.deepEqual(stale.map((e) => e.name), ['deleted-in-the-ide']);
        assert.equal(choices.filter((c) => c.checked).length, 1, 'a stale entry cannot be shown as checked');
    });

    test('an empty IDE list yields no choices rather than throwing', () => {
        assert.deepEqual(buildInitialSelection([], []), { choices: [], stale: [] });
    });
});

describe('pendingModeQuestions', () => {
    test('asks about every configuration when the preset is new', () => {
        assert.deepEqual(pendingModeQuestions(['web', 'api']), ['web', 'api']);
    });

    test('does not re-ask about configurations already in the preset', () => {
        const preset = [{ name: 'web', mode: 'debug' }];
        assert.deepEqual(pendingModeQuestions(['web', 'api'], preset), ['api']);
    });

    test('asks nothing when the selection is unchanged', () => {
        const preset = [{ name: 'web', mode: 'debug' }, { name: 'api', mode: 'run' }];
        assert.deepEqual(pendingModeQuestions(['web', 'api'], preset), []);
    });

    test('a preset entry that was unchecked is not asked about', () => {
        const preset = [{ name: 'web', mode: 'debug' }];
        assert.deepEqual(pendingModeQuestions([], preset), []);
    });

    test('follows the order of the selection', () => {
        assert.deepEqual(pendingModeQuestions(['api', 'web']), ['api', 'web']);
    });
});

describe('applyAnswersToPreset', () => {
    test('builds entries from a fresh selection and its answers', () => {
        const preset = applyAnswersToPreset(['web', 'api'], { web: 'debug', api: 'run' });
        assert.deepEqual(preset, [
            { name: 'web', mode: 'debug' },
            { name: 'api', mode: 'run' },
        ]);
    });

    test('an unanswered selection defaults to run', () => {
        assert.deepEqual(applyAnswersToPreset(['web']), [{ name: 'web', mode: DEFAULT_MODE }]);
        assert.equal(DEFAULT_MODE, 'run');
    });

    test('an unchecked configuration is dropped', () => {
        const before = [{ name: 'web', mode: 'debug' }, { name: 'api', mode: 'run' }];
        assert.deepEqual(applyAnswersToPreset(['api'], {}, before), [{ name: 'api', mode: 'run' }]);
    });

    test('an existing entry keeps its mode when it was not re-asked', () => {
        const before = [{ name: 'web', mode: 'debug' }];
        assert.deepEqual(applyAnswersToPreset(['web'], {}, before), [{ name: 'web', mode: 'debug' }]);
    });

    test('an answer overrides the stored mode', () => {
        const before = [{ name: 'web', mode: 'debug' }];
        assert.deepEqual(applyAnswersToPreset(['web'], { web: 'run' }, before), [
            { name: 'web', mode: 'run' },
        ]);
    });

    test('existing entries keep their order; new ones are appended', () => {
        // A deliberately ordered preset must not be reshuffled by an unrelated edit.
        const before = [{ name: 'api', mode: 'run' }, { name: 'web', mode: 'debug' }];
        const after = applyAnswersToPreset(['web', 'docs', 'api'], { docs: 'run' }, before);

        assert.deepEqual(after.map((e) => e.name), ['api', 'web', 'docs']);
    });

    test('unknown keys on an existing entry are preserved', () => {
        // The store round-trips unknown fields; the configure screen must not undo that.
        const before = [{ name: 'web', mode: 'run', note: 'keep me' }];
        assert.deepEqual(applyAnswersToPreset(['web'], { web: 'debug' }, before), [
            { name: 'web', mode: 'debug', note: 'keep me' },
        ]);
    });

    test('an empty selection clears the preset', () => {
        assert.deepEqual(applyAnswersToPreset([], {}, [{ name: 'web', mode: 'run' }]), []);
    });

    test('does not mutate the preset it was given', () => {
        const before = [{ name: 'web', mode: 'run' }];
        applyAnswersToPreset(['web'], { web: 'debug' }, before);
        assert.equal(before[0].mode, 'run');
    });

    test('the result round-trips through the whole flow', () => {
        // checkbox → mode questions → saved preset → shown checked again.
        const first = applyAnswersToPreset(['web', 'api'], { web: 'debug', api: 'run' });
        const { choices } = buildInitialSelection(CONFIGS, first);

        assert.deepEqual(choices.filter((c) => c.checked).map((c) => [c.value, c.mode]), [
            ['web', 'debug'],
            ['api', 'run'],
        ]);
        assert.deepEqual(pendingModeQuestions(['web', 'api'], first), []);
    });
});

describe('configurations named after Object.prototype members', () => {
    const INHERITED = ['constructor', 'toString', 'valueOf', '__proto__'];

    for (const name of INHERITED) {
        test(`"${name}" with no answer defaults to run, not an inherited value`, () => {
            assert.deepEqual(applyAnswersToPreset([name]), [{ name, mode: 'run' }]);
        });

        test(`"${name}" keeps its stored mode when unanswered`, () => {
            const before = [{ name, mode: 'debug' }];
            assert.deepEqual(applyAnswersToPreset([name], {}, before), [{ name, mode: 'debug' }]);
        });
    }

    test('an explicit answer for such a name is still honoured', () => {
        const modes = Object.create(null);
        modes.constructor = 'debug';
        assert.deepEqual(applyAnswersToPreset(['constructor'], modes), [
            { name: 'constructor', mode: 'debug' },
        ]);
    });

    test('an answer stored on a plain object is honoured too', () => {
        assert.deepEqual(applyAnswersToPreset(['toString'], { toString: 'debug' }), [
            { name: 'toString', mode: 'debug' },
        ]);
    });

    test('such a name can be checked and unchecked like any other', () => {
        const { choices } = buildInitialSelection([{ name: 'constructor' }], [{ name: 'constructor', mode: 'debug' }]);
        assert.equal(choices[0].checked, true);
        assert.equal(choices[0].mode, 'debug');
        assert.deepEqual(pendingModeQuestions(['constructor'], [{ name: 'constructor', mode: 'debug' }]), []);
    });
});

describe('diffPreset', () => {
    test('reports an unchanged preset', () => {
        const preset = [{ name: 'web', mode: 'run' }];
        assert.equal(diffPreset(preset, [...preset]).unchanged, true);
    });

    test('reports additions', () => {
        const diff = diffPreset([], [{ name: 'web', mode: 'run' }]);
        assert.deepEqual(diff.added, ['web']);
        assert.equal(diff.unchanged, false);
    });

    test('reports removals', () => {
        const diff = diffPreset([{ name: 'web', mode: 'run' }], []);
        assert.deepEqual(diff.removed, ['web']);
    });

    test('reports a mode change, not an add plus a remove', () => {
        const diff = diffPreset([{ name: 'web', mode: 'run' }], [{ name: 'web', mode: 'debug' }]);
        assert.deepEqual(diff.changed, ['web → debug']);
        assert.deepEqual(diff.added, []);
        assert.deepEqual(diff.removed, []);
    });

    test('a change to terminal is reported like any other mode change', () => {
        const diff = diffPreset([{ name: 'web', mode: 'run' }], [{ name: 'web', mode: 'terminal' }]);
        assert.deepEqual(diff.changed, ['web → terminal']);
    });

    test('reports all three kinds at once', () => {
        const before = [{ name: 'web', mode: 'run' }, { name: 'api', mode: 'run' }];
        const after = [{ name: 'web', mode: 'debug' }, { name: 'docs', mode: 'run' }];
        const diff = diffPreset(before, after);

        assert.deepEqual(diff.changed, ['web → debug']);
        assert.deepEqual(diff.added, ['docs']);
        assert.deepEqual(diff.removed, ['api']);
    });
});

describe('custom command entries — the checkbox and what it saves', () => {
    const custom = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a saved custom entry is offered checked, after the IDE list, labelled with its commands', () => {
        const { choices } = buildInitialSelection(CONFIGS, [custom]);

        assert.equal(choices.length, 14);
        assert.deepEqual(choices[13], {
            name: '⌘ seed db — npm i && npm run seed',
            value: customChoiceValue('seed db'),
            checked: true,
            mode: 'terminal',
        });
    });

    test('it is not reported as stale: it refers to nothing in the IDE', () => {
        assert.deepEqual(buildInitialSelection(CONFIGS, [custom]).stale, []);
    });

    test('a custom entry called like an IDE configuration does not check that configuration', () => {
        const { choices } = buildInitialSelection(CONFIGS, [{ ...custom, name: 'web' }]);
        assert.equal(choices.find((c) => c.value === 'web').checked, false);
    });

    test('pendingModeQuestions never asks about a custom choice, nor mistakes its name for a known configuration', () => {
        const preset = [{ ...custom, name: 'web' }];
        assert.deepEqual(pendingModeQuestions([customChoiceValue('web'), 'web'], preset), ['web']);
    });

    test('a checked custom entry keeps its place and its commands', () => {
        const preset = [{ name: 'web', mode: 'run' }, custom, { name: 'api', mode: 'run' }];
        const after = applyAnswersToPreset(['web', customChoiceValue('seed db'), 'api'], {}, preset);
        assert.deepEqual(after, preset);
    });

    test('unchecking it removes it', () => {
        const preset = [{ name: 'web', mode: 'run' }, custom];
        assert.deepEqual(applyAnswersToPreset(['web'], {}, preset), [{ name: 'web', mode: 'run' }]);
    });

    test('new custom entries are appended after the configurations, in the order given', () => {
        const added = [
            { name: 'a', mode: 'terminal', commands: ['echo a'] },
            { name: 'b', mode: 'terminal', commands: ['echo b'] },
        ];
        const after = applyAnswersToPreset(['web'], { web: 'run' }, [], added);
        assert.deepEqual(after.map((entry) => entry.name), ['web', 'a', 'b']);
    });

    test('diffPreset names a custom entry, and tells it from a configuration of the same name', () => {
        const before = [{ name: 'web', mode: 'run' }];
        const after = [{ name: 'web', mode: 'run' }, { name: 'web', mode: 'terminal', commands: ['x'] }];
        const diff = diffPreset(before, after);

        assert.deepEqual(diff.added, ['web']);
        assert.deepEqual(diff.removed, []);
        assert.equal(diff.unchanged, false);
    });

    test('diffPreset of an untouched custom entry is unchanged', () => {
        assert.equal(diffPreset([custom], [{ ...custom }]).unchanged, true);
    });
});

describe('validateCustomName', () => {
    const opts = { taken: ['seed db'], ideNames: ['web', 'api'] };

    test('accepts a fresh name', () => {
        assert.equal(validateCustomName('lint all', opts), null);
    });

    test('refuses an empty or blank name', () => {
        assert.equal(validateCustomName('', opts), 'a name is required');
        assert.equal(validateCustomName('   ', opts), 'a name is required');
    });

    test('refuses a name a custom entry of the preset already has', () => {
        assert.equal(validateCustomName('seed db', opts), '"seed db" is already a custom command in this preset');
    });

    test('refuses the name of a run configuration', () => {
        assert.equal(
            validateCustomName('web', opts),
            '"web" is the name of a run configuration; pick a different name',
        );
    });

    test('refuses a name with a control character', () => {
        for (const name of ['a\nb', 'a\u001b[2Jb', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
            assert.equal(validateCustomName(name, opts), 'a name cannot contain control characters', JSON.stringify(name));
        }
    });

    test('a tab is not a control character here', () => {
        assert.equal(validateCustomName('seed\tdb', opts), null);
    });

    test('trims what it is given, so a trailing space is the same name', () => {
        assert.equal(validateCustomName('seed db ', opts), '"seed db" is already a custom command in this preset');
        assert.equal(validateCustomName(' web', opts), '"web" is the name of a run configuration; pick a different name');
        assert.equal(validateCustomName('  lint all  ', opts), null);
    });

    test('a prototype member is an ordinary name', () => {
        assert.equal(validateCustomName('constructor', opts), null);
        assert.equal(validateCustomName('__proto__', opts), null);
    });
});
