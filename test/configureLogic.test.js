import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { normalizeRunConfigs } from '../src/resolve.js';
import {
    DEFAULT_MODE,
    applyAnswersToPreset,
    buildInitialSelection,
    commandEditChoices,
    customChoiceValue,
    customNamesInUse,
    diffPreset,
    editCommands,
    addCustomEntry,
    applyEntryEdit,
    customDraft,
    entryEditChoices,
    newChoiceIndex,
    newChoiceValue,
    pendingModeQuestions,
    screenChoices,
    splitSelection,
    takenNames,
    validateCustomCommand,
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

    test('a name the entry may keep is accepted even if a run configuration has it too', () => {
        // A hand-edited file can hold a custom entry called like a configuration.
        assert.equal(validateCustomName('web', { ...opts, keep: ['web'] }), null);
        assert.equal(validateCustomName(' web ', { ...opts, keep: ['web'] }), null);
        assert.equal(validateCustomName('', { ...opts, keep: [''] }), 'a name is required');
    });
});

describe('validateCustomCommand', () => {
    test('accepts an ordinary line, pipes and tabs included', () => {
        assert.equal(validateCustomCommand('npm run a | tee log'), null);
        assert.equal(validateCustomCommand('printf "a\tb"'), null);
    });

    test('refuses a blank line', () => {
        assert.equal(validateCustomCommand(''), 'a command is required');
        assert.equal(validateCustomCommand('   '), 'a command is required');
    });

    test('refuses a control character, which the store would refuse on the next read', () => {
        for (const line of ['a\nb', 'a\u001b[2Jb', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
            assert.equal(validateCustomCommand(line), 'a command cannot contain control characters', JSON.stringify(line));
        }
    });
});

describe('editCommands', () => {
    const commands = ['npm i', 'npm run build', 'npm run seed'];

    test('replace changes one line in place', () => {
        assert.deepEqual(editCommands(commands, { type: 'replace', index: 1, line: 'npm ci' }), [
            'npm i', 'npm ci', 'npm run seed',
        ]);
    });

    test('up and down swap a line with its neighbour', () => {
        assert.deepEqual(editCommands(commands, { type: 'up', index: 1 }), ['npm run build', 'npm i', 'npm run seed']);
        assert.deepEqual(editCommands(commands, { type: 'down', index: 1 }), ['npm i', 'npm run seed', 'npm run build']);
    });

    test('a move past either end changes nothing', () => {
        assert.deepEqual(editCommands(commands, { type: 'up', index: 0 }), commands);
        assert.deepEqual(editCommands(commands, { type: 'down', index: 2 }), commands);
    });

    test('remove drops one line, append adds one at the end', () => {
        assert.deepEqual(editCommands(commands, { type: 'remove', index: 0 }), ['npm run build', 'npm run seed']);
        assert.deepEqual(editCommands(commands, { type: 'append', line: 'echo done' }), [...commands, 'echo done']);
    });

    test('the last line is never removed: an entry without commands would not load', () => {
        assert.deepEqual(editCommands(['npm i'], { type: 'remove', index: 0 }), ['npm i']);
    });

    test('does not mutate the list it was given', () => {
        const copy = [...commands];
        editCommands(copy, { type: 'up', index: 2 });
        editCommands(copy, { type: 'remove', index: 0 });
        assert.deepEqual(copy, commands);
    });
});

describe('editing custom entries — the menus', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('entryEditChoices: the name, each command, add, delete, done — done last', () => {
        assert.deepEqual(entryEditChoices(seed), [
            { name: 'Name: seed db', value: 'name' },
            { name: '1. npm i', value: 0 },
            { name: '2. npm run seed', value: 1 },
            { name: '+ Add a command', value: 'append' },
            { name: 'Delete "seed db" from the preset', value: 'delete' },
            { name: 'Done', value: 'done' },
        ]);
    });

    test('commandEditChoices disables what cannot be done to that line, back last', () => {
        assert.deepEqual(commandEditChoices(['a', 'b'], 0), [
            { name: 'Change', value: 'replace' },
            { name: 'Move up', value: 'up', disabled: '(already the first)' },
            { name: 'Move down', value: 'down', disabled: false },
            { name: 'Delete', value: 'remove', disabled: false },
            { name: 'Back', value: 'back' },
        ]);
        const last = commandEditChoices(['a', 'b'], 1);
        assert.equal(last[1].disabled, false);
        assert.equal(last[2].disabled, '(already the last)');
    });

    test('the only command cannot be deleted; the entry can', () => {
        const [, up, down, remove] = commandEditChoices(['a'], 0);
        assert.ok(up.disabled && down.disabled);
        assert.equal(remove.disabled, '(the only command — delete the whole entry instead)');
    });
});

describe('customNamesInUse', () => {
    const preset = [
        { name: 'web', mode: 'run' },
        { name: 'a', mode: 'terminal', commands: ['x'] },
        { name: 'b', mode: 'terminal', commands: ['x'] },
    ];

    test('every custom name the preset had, never a configuration', () => {
        assert.deepEqual(customNamesInUse(preset).sort(), ['a', 'b']);
    });

    test('an entry renamed on this screen holds both its names', () => {
        const edits = new Map([['a', { name: 'c', commands: ['x'] }]]);
        assert.deepEqual(customNamesInUse(preset, edits).sort(), ['a', 'b', 'c']);
    });

    test('the entry being renamed does not stand in its own way', () => {
        const edits = new Map([['a', { name: 'c', commands: ['x'] }]]);
        assert.deepEqual(customNamesInUse(preset, edits, 'a'), ['b']);
    });

    test('prototype members are ordinary names', () => {
        const odd = [{ name: '__proto__', mode: 'terminal', commands: ['x'] }];
        const edits = new Map([['__proto__', { name: 'constructor', commands: ['x'] }]]);
        assert.deepEqual(customNamesInUse(odd, edits).sort(), ['__proto__', 'constructor']);
    });
});

describe('editing custom entries — what is saved and reported', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'], note: 'keep me' };
    const preset = [{ name: 'web', mode: 'run' }, seed, { name: 'api', mode: 'run' }];
    const selection = ['web', customChoiceValue('seed db'), 'api'];
    const edits = new Map([['seed db', { name: 'seed', commands: ['npm ci', 'npm run seed'] }]]);

    test('an edited entry keeps its place and its unknown keys', () => {
        assert.deepEqual(applyAnswersToPreset(selection, {}, preset, [], edits), [
            { name: 'web', mode: 'run' },
            { name: 'seed', mode: 'terminal', commands: ['npm ci', 'npm run seed'], note: 'keep me' },
            { name: 'api', mode: 'run' },
        ]);
    });

    test('an edit of an entry that was unchecked is not resurrected', () => {
        assert.deepEqual(applyAnswersToPreset(['web', 'api'], {}, preset, [], edits).map((e) => e.name), ['web', 'api']);
    });

    test('an edit never applies to a run configuration of the same name', () => {
        const clash = new Map([['web', { name: 'www', commands: ['x'] }]]);
        assert.deepEqual(applyAnswersToPreset(selection, {}, preset, [], clash), preset);
    });

    test('diffPreset reports a rename and a command change, not a removal plus an addition', () => {
        const after = applyAnswersToPreset(selection, {}, preset, [], edits);
        assert.deepEqual(diffPreset(preset, after, edits), {
            added: [],
            removed: [],
            changed: ['seed db: renamed to seed', 'seed: npm i && npm run seed → npm ci && npm run seed'],
            unchanged: false,
        });
    });

    test('diffPreset sees reordered commands, even when the joined line would read the same', () => {
        const before = [{ name: 's', mode: 'terminal', commands: ['a', 'b'] }];
        const reordered = [{ name: 's', mode: 'terminal', commands: ['b', 'a'] }];
        const merged = [{ name: 's', mode: 'terminal', commands: ['a && b'] }];

        assert.deepEqual(diffPreset(before, reordered).changed, ['s: a && b → b && a']);
        assert.equal(diffPreset(before, merged).unchanged, false);
    });

    test('an edit that ends where it started is no change at all', () => {
        const same = new Map([['seed db', { name: 'seed db', commands: ['npm i', 'npm run seed'] }]]);
        const after = applyAnswersToPreset(selection, {}, preset, [], same);
        assert.equal(diffPreset(preset, after, same).unchanged, true);
    });

    test('an entry edited and then deleted is reported under its old name', () => {
        const after = applyAnswersToPreset(['web', 'api'], {}, preset, [], edits);
        assert.deepEqual(diffPreset(preset, after, edits).removed, ['seed db']);
    });
});

describe('screenChoices — the list as the screen draws it', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const configs = [{ name: 'web', description: 'npm' }, { name: 'api', description: '' }];
    const { choices: base } = buildInitialSelection(configs, [{ name: 'web', mode: 'run' }, seed]);
    const SEED = customChoiceValue('seed db');
    const screen = (over = {}) => ({ checked: new Set(['web', SEED]), edits: new Map(), added: [], deleted: new Set(), ...over });

    test('the IDE list, then the preset\'s custom entries; only those are editable', () => {
        assert.deepEqual(screenChoices(base, screen()), [
            { name: 'web  (npm)', value: 'web', checked: true, editable: false },
            { name: 'api', value: 'api', checked: false, editable: false },
            { name: '⌘ seed db — npm i && npm run seed', value: SEED, checked: true, editable: true },
        ]);
    });

    test('checked comes from the screen, not from the preset', () => {
        const items = screenChoices(base, screen({ checked: new Set(['api']) }));
        assert.deepEqual(items.map((item) => item.checked), [false, true, false]);
    });

    test('an edited entry shows its new name and commands, under its old value', () => {
        const edits = new Map([['seed db', { name: 'seed', commands: ['npm ci'] }]]);
        assert.deepEqual(screenChoices(base, screen({ edits }))[2], {
            name: '⌘ seed — npm ci', value: SEED, checked: true, editable: true,
        });
    });

    test('entries added on this screen follow, editable, under values of their own', () => {
        const added = [{ name: 'lint', mode: 'terminal', commands: ['npm run lint'] }];
        const items = screenChoices(base, screen({ added, checked: new Set([newChoiceValue(0)]) }));
        assert.deepEqual(items[3], { name: '⌘ lint — npm run lint', value: newChoiceValue(0), checked: true, editable: true });
    });

    test('a deleted entry leaves the list, whichever kind it is', () => {
        const added = [{ name: 'lint', mode: 'terminal', commands: ['x'] }];
        const items = screenChoices(base, screen({ added, deleted: new Set([SEED, newChoiceValue(0)]) }));
        assert.deepEqual(items.map((item) => item.value), ['web', 'api']);
    });

    test('a new entry\'s value is never a configuration\'s or a saved custom entry\'s', () => {
        assert.notEqual(newChoiceValue(0), customChoiceValue('0'));
        assert.notEqual(newChoiceValue(0), '0');
        assert.notEqual(newChoiceValue(0), newChoiceValue(1));
    });
});

describe('splitSelection — what the list hands to the save', () => {
    const added = [
        { name: 'a', mode: 'terminal', commands: ['x'] },
        { name: 'b', mode: 'terminal', commands: ['y'] },
    ];
    const item = (value, checked) => ({ value, name: value, checked, editable: false });

    test('the checked values in list order, with the new entries taken out and handed back as entries', () => {
        const items = [
            item('web', true),
            item('api', false),
            item(customChoiceValue('seed'), true),
            item(newChoiceValue(0), false),
            item(newChoiceValue(1), true),
        ];
        assert.deepEqual(splitSelection(items, added), {
            selection: ['web', customChoiceValue('seed')],
            added: [added[1]],
        });
    });

    test('a new entry that was deleted is not in the list, so it is not saved', () => {
        assert.deepEqual(splitSelection([item(newChoiceValue(1), true)], added).added, [added[1]]);
    });

    test('the selection never asks a mode question about a new entry', () => {
        const { selection } = splitSelection([item(newChoiceValue(0), true), item('web', true)], added);
        assert.deepEqual(pendingModeQuestions(selection, []), ['web']);
    });
});

describe('the list\'s screen state — pure transitions', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'], note: 'keep me' };
    const other = { name: 'other', mode: 'terminal', commands: ['x'] };
    const preset = [{ name: 'web', mode: 'run' }, seed, other];
    const SEED = customChoiceValue('seed db');
    const fresh = () => ({ checked: new Set(['web', SEED]), edits: new Map(), added: [], deleted: new Set() });

    test('newChoiceIndex reads back newChoiceValue, and is -1 for anything else', () => {
        assert.equal(newChoiceIndex(newChoiceValue(0)), 0);
        assert.equal(newChoiceIndex(newChoiceValue(12)), 12);
        assert.equal(newChoiceIndex(SEED), -1);
        assert.equal(newChoiceIndex('web'), -1);
    });

    test('addCustomEntry appends the entry checked and names its list value; the old screen is untouched', () => {
        const screen = fresh();
        const entry = { name: 'lint', mode: 'terminal', commands: ['npm run lint'] };
        const { screen: next, value } = addCustomEntry(screen, entry);

        assert.equal(value, newChoiceValue(0));
        assert.deepEqual(next.added, [entry]);
        assert.ok(next.checked.has(value));
        assert.deepEqual(screen.added, []);
        assert.ok(!screen.checked.has(value));
    });

    test('customDraft of a saved entry: its commands, and the names it may keep', () => {
        assert.deepEqual(customDraft(preset, fresh(), SEED), {
            draft: { name: 'seed db', commands: ['npm i', 'npm run seed'] },
            keep: ['seed db', 'seed db'],
        });
    });

    test('customDraft of an edited saved entry starts from the edit, and may still go back to its old name', () => {
        const screen = { ...fresh(), edits: new Map([['seed db', { name: 'seed', commands: ['npm ci'] }]]) };
        assert.deepEqual(customDraft(preset, screen, SEED), {
            draft: { name: 'seed', commands: ['npm ci'] },
            keep: ['seed db', 'seed'],
        });
    });

    test('customDraft of an entry added on this screen', () => {
        const { screen } = addCustomEntry(fresh(), { name: 'lint', mode: 'terminal', commands: ['a'] });
        assert.deepEqual(customDraft(preset, screen, newChoiceValue(0)), {
            draft: { name: 'lint', commands: ['a'] },
            keep: ['lint'],
        });
    });

    test('applyEntryEdit records a saved entry\'s edit under the name it opened with', () => {
        const next = applyEntryEdit(preset, fresh(), SEED, { name: 'seed', commands: ['npm ci'] });
        assert.deepEqual([...next.edits], [['seed db', { name: 'seed', commands: ['npm ci'] }]]);
    });

    test('applyEntryEdit replaces an added entry in place, keeping what the edit does not cover', () => {
        const { screen } = addCustomEntry(fresh(), { name: 'lint', mode: 'terminal', commands: ['a'] });
        const next = applyEntryEdit(preset, screen, newChoiceValue(0), { name: 'lint:fix', commands: ['b'] });
        assert.deepEqual(next.added, [{ name: 'lint:fix', mode: 'terminal', commands: ['b'] }]);
        assert.deepEqual(screen.added[0].name, 'lint');
    });

    test('applyEntryEdit with null deletes: the row is gone, and that is the only record of it', () => {
        const next = applyEntryEdit(preset, fresh(), SEED, null);
        assert.deepEqual([...next.deleted], [SEED]);
        assert.deepEqual(splitSelection(screenChoices(buildInitialSelection([{ name: 'web' }], preset).choices, next), next.added).selection, ['web']);
    });

    test('takenNames for a new entry: every saved custom name, every name given on this screen', () => {
        let screen = applyEntryEdit(preset, fresh(), SEED, { name: 'seed', commands: ['x'] });
        ({ screen } = addCustomEntry(screen, { name: 'lint', mode: 'terminal', commands: ['x'] }));
        assert.deepEqual(takenNames(preset, screen).sort(), ['lint', 'other', 'seed', 'seed db']);
    });

    test('takenNames leaves out the entry asked about, saved or new', () => {
        let screen = fresh();
        ({ screen } = addCustomEntry(screen, { name: 'lint', mode: 'terminal', commands: ['x'] }));
        assert.deepEqual(takenNames(preset, screen, SEED).sort(), ['lint', 'other']);
        assert.deepEqual(takenNames(preset, screen, newChoiceValue(0)).sort(), ['other', 'seed db']);
    });

    test('a new entry deleted again frees its name; a deleted saved entry does not', () => {
        let screen = fresh();
        ({ screen } = addCustomEntry(screen, { name: 'lint', mode: 'terminal', commands: ['x'] }));
        screen = applyEntryEdit(preset, screen, newChoiceValue(0), null);
        screen = applyEntryEdit(preset, screen, SEED, null);
        assert.deepEqual(takenNames(preset, screen).sort(), ['other', 'seed db']);
    });
});
