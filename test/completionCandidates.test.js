import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { complete, findProjectFlag } from '../src/completion/candidates.js';

const catalogue = {
    presets: ['default', 'backend'],
    configs: ['web', 'api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server', 'toString'],
};

/**
 * `typed` is the words and then the partial word, separated by single spaces — so a
 * trailing space is an empty partial. Names that contain spaces go through complete()
 * directly.
 *
 * @param {string} typed
 */
const at = (typed) => {
    const parts = typed.split(' ');
    return complete({ words: parts.slice(0, -1), partial: parts[parts.length - 1] }, catalogue);
};

describe('complete — configuration names', () => {
    test('a bare Tab offers every configuration and no preset', () => {
        assert.deepEqual(at(''), { directive: 'values', values: catalogue.configs });
    });

    test('filters by prefix', () => {
        assert.deepEqual(at('a').values, ['api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server']);
    });

    test('offers the modes only once the name is followed by a colon', () => {
        assert.deepEqual(at('api:').values, ['api:run', 'api:debug', 'api:terminal']);
        assert.deepEqual(at('api:de').values, ['api:debug']);
        assert.deepEqual(at('api').values.includes('api:run'), false);
    });

    test('a name that itself contains colons completes as a name, and takes modes after it', () => {
        assert.deepEqual(complete({ words: [], partial: 'api > repro:stale-job:' }, catalogue).values, [
            'api > repro:stale-job:debug',
        ]);
        assert.deepEqual(complete({ words: [], partial: 'api > repro:stale-job:debug:' }, catalogue).values, [
            'api > repro:stale-job:debug:run',
            'api > repro:stale-job:debug:debug',
            'api > repro:stale-job:debug:terminal',
        ]);
    });

    test('names that collide with Object.prototype are ordinary names', () => {
        assert.deepEqual(at('to').values, ['toString']);
        assert.deepEqual(at('constr').values, []);
    });
});

describe('complete — flags', () => {
    test('two dashes offer the long flags, taken from OPTIONS', () => {
        const flags = at('--').values;
        for (const flag of ['--preset', '--target', '--dry-run', '--fallback', '--configure']) {
            assert.ok(flags.includes(flag), `${flag} missing`);
        }
        assert.equal(flags.includes('-c'), false);
    });

    test('one dash adds the short flags', () => {
        const flags = at('-').values;
        for (const flag of ['-c', '-l', '-h', '-v', '--list']) assert.ok(flags.includes(flag), `${flag} missing`);
    });

    test('filters by prefix', () => {
        assert.deepEqual(at('--ta').values, ['--target']);
    });
});

describe('complete — flag values', () => {
    // `--completion` joins OPTIONS only in Task 8, so its own value list is asserted there.
    test('--target and --fallback offer their fixed values', () => {
        assert.deepEqual(at('--target ').values, ['run-window', 'terminal']);
        assert.deepEqual(at('--target te').values, ['terminal']);
        assert.deepEqual(at('--fallback ').values, ['retry', 'terminal']);
    });

    test('the --flag=value form keeps the flag in every candidate', () => {
        assert.deepEqual(at('--target=t').values, ['--target=terminal']);
        assert.deepEqual(at('--preset=b').values, ['--preset=backend']);
    });

    test('--preset offers preset names', () => {
        assert.deepEqual(at('--preset ').values, ['default', 'backend']);
    });

    test('--project hands the decision to the shell, and the = form offers nothing', () => {
        assert.deepEqual(at('--project '), { directive: 'dirs', values: [] });
        assert.deepEqual(at('--project=').directive, 'none');
    });

    test('numeric flags offer nothing, and not file names either', () => {
        assert.deepEqual(at('--mcp-port '), { directive: 'none', values: [] });
        assert.deepEqual(at('--debug-port '), { directive: 'none', values: [] });
    });

    test('a flag that is not one of ours is not looked up on Object.prototype', () => {
        assert.equal(at('--constructor=').directive, 'none');
        assert.equal(at('--toString ').directive, 'values');
    });
});

describe('complete — what may follow', () => {
    test('after --preset a, another preset or a configuration may follow', () => {
        assert.deepEqual(at('--preset backend ').values, ['default', 'backend', ...catalogue.configs]);
    });

    test('a token that is not a preset ends the run of presets', () => {
        assert.deepEqual(at('--preset backend web ').values, catalogue.configs);
    });

    test('a flag in between ends the run of presets', () => {
        assert.deepEqual(at('--preset backend --dry-run ').values, catalogue.configs);
    });

    test('--configure, --list and --completion take no names', () => {
        assert.deepEqual(at('-c '), { directive: 'none', values: [] });
        assert.deepEqual(at('--list '), { directive: 'none', values: [] });
        assert.deepEqual(at('--completion zsh '), { directive: 'none', values: [] });
        assert.deepEqual(at('--completion=zsh '), { directive: 'none', values: [] });
    });

    test('--configure still takes --preset, so its value is completed', () => {
        assert.deepEqual(at('-c --preset ').values, ['default', 'backend']);
    });

    test('after -- everything is a name, even something that looks like a flag', () => {
        assert.deepEqual(at('-- ').values, catalogue.configs);
        assert.deepEqual(at('-- -').values, []);
    });

    test('a -c before -- still refuses names that come after it', () => {
        assert.deepEqual(at('-c -- '), { directive: 'none', values: [] });
    });
});

describe('findProjectFlag', () => {
    test('reads both spellings, and the last one wins', () => {
        assert.equal(findProjectFlag(['--project', '/a']), '/a');
        assert.equal(findProjectFlag(['--project=/b']), '/b');
        assert.equal(findProjectFlag(['--project', '/a', '--project=/b']), '/b');
    });

    test('is undefined when absent, or when the flag has no value yet, or after --', () => {
        assert.equal(findProjectFlag(['web']), undefined);
        assert.equal(findProjectFlag(['--project']), undefined);
        assert.equal(findProjectFlag(['--', '--project', '/a']), undefined);
    });
});
