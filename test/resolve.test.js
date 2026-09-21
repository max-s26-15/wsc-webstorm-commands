import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
    AmbiguousNameError,
    RunConfigPayloadError,
    UnknownConfigurationError,
    buildLaunchPlan,
    formatPlan,
    isCustomPlanEntry,
    levenshtein,
    normalizeRunConfigs,
    resolveName,
    suggestNames,
} from '../src/resolve.js';

const require = createRequire(import.meta.url);
/** The anonymised demo-app payload — 13 configurations. */
const FIXTURE = require('./fixtures/run-configurations.json');
const CONFIGS = normalizeRunConfigs(FIXTURE);
const NAMES = CONFIGS.map((c) => c.name);

describe('normalizeRunConfigs', () => {
    test('accepts the {configurations: [...]} envelope the IDE sends', () => {
        assert.equal(CONFIGS.length, 13);
    });

    test('accepts a bare array', () => {
        assert.deepEqual(normalizeRunConfigs([{ name: 'api' }]), [{ name: 'api' }]);
    });

    test('keeps the fields the IDE reports', () => {
        const web = CONFIGS.find((c) => c.name === 'web');
        assert.equal(web.description, 'npm');
        assert.equal(web.supportsDynamicLaunchOverrides, false);
    });

    test('rejects a payload that is not a list', () => {
        assert.throws(() => normalizeRunConfigs({ oops: true }), TypeError);
        assert.throws(() => normalizeRunConfigs(null), TypeError);
    });

    test('rejects an entry without a name rather than silently dropping it', () => {
        assert.throws(() => normalizeRunConfigs([{ name: 'ok' }, { description: 'npm' }]), /configuration 1 has no name/);
    });

    test('a payload it cannot read is a named error, not a bare TypeError', () => {
        // Phase 10 finding: a bare TypeError is indistinguishable from a bug inside wsc,
        // so runCli() rethrew it and the user got a V8 stack trace. The plan's own risk
        // table calls a change in the IDE's tool signatures the likeliest cause, so the
        // message points at the diagnostic script for it.
        for (const payload of [{ oops: true }, null, 'plain console output', [{ description: 'npm' }]]) {
            assert.throws(
                () => normalizeRunConfigs(payload),
                (err) => {
                    assert.ok(err instanceof RunConfigPayloadError);
                    // Still a TypeError, so nothing that used to catch one stops working.
                    assert.ok(err instanceof TypeError);
                    assert.equal(err.name, 'RunConfigPayloadError');
                    assert.match(err.message, /mcp:probe/);
                    return true;
                },
            );
        }
    });
});

describe('levenshtein', () => {
    test('identical strings have distance 0', () => {
        assert.equal(levenshtein('web', 'web'), 0);
    });

    test('counts a single deletion', () => {
        assert.equal(levenshtein('wb', 'web'), 1);
    });

    test('counts a substitution', () => {
        assert.equal(levenshtein('api', 'apt'), 1);
    });

    test('an empty string costs the other string’s length', () => {
        assert.equal(levenshtein('', 'api'), 3);
        assert.equal(levenshtein('api', ''), 3);
    });

    test('is symmetric', () => {
        assert.equal(levenshtein('docs', 'dcos'), levenshtein('dcos', 'docs'));
    });
});

describe('resolveName — matching order', () => {
    test('exact match wins', () => {
        assert.equal(resolveName('web', CONFIGS).name, 'web');
    });

    test('case-insensitive match', () => {
        assert.equal(resolveName('WEB', CONFIGS).name, 'web');
        assert.equal(resolveName('ApI', CONFIGS).name, 'api');
    });

    test('prefix match', () => {
        assert.equal(resolveName('doc', CONFIGS).name, 'docs');
        assert.equal(resolveName('gate', CONFIGS).name, 'gateway');
    });

    test('prefix match is case-insensitive too', () => {
        assert.equal(resolveName('DOC', CONFIGS).name, 'docs');
    });

    test('resolves every fixture name to itself', () => {
        for (const name of NAMES) assert.equal(resolveName(name, CONFIGS).name, name);
    });

    test('an exact match beats a longer prefix sibling', () => {
        // "addon-client" is also a prefix of "addon-client-watch".
        assert.equal(resolveName('addon-client', CONFIGS).name, 'addon-client');
    });

    test('an exact match beats an ambiguous prefix', () => {
        assert.equal(resolveName('mailer', CONFIGS).name, 'mailer');
    });

    test('duplicate names resolve to the first, like the IDE dropdown', () => {
        const dupes = [{ name: 'api', description: 'npm' }, { name: 'api', description: 'Node.js' }];
        assert.equal(resolveName('api', dupes).description, 'npm');
    });
});

describe('resolveName — ambiguity', () => {
    test('an ambiguous prefix lists every candidate', () => {
        assert.throws(() => resolveName('addon', CONFIGS), (err) => {
            assert.ok(err instanceof AmbiguousNameError);
            assert.deepEqual(err.candidates, ['addon-client', 'addon-server', 'addon-client-watch']);
            assert.match(err.message, /matches several run configurations/);
            return true;
        });
    });

    test('"mail" is ambiguous between the app and its debug:log script', () => {
        assert.throws(() => resolveName('mail', CONFIGS), (err) => {
            assert.deepEqual(err.candidates, ['mailer', 'mailer > debug:log']);
            return true;
        });
    });

    test('an ambiguous case-insensitive match is reported', () => {
        const dupes = [{ name: 'Api' }, { name: 'API' }];
        assert.throws(() => resolveName('api', dupes), AmbiguousNameError);
    });

    test('the error says when the name came from a preset', () => {
        assert.throws(() => resolveName('addon', CONFIGS, { source: 'preset' }), /from the preset/);
    });
});

describe('resolveName — unknown names', () => {
    test('a typo suggests the intended configuration', () => {
        assert.throws(() => resolveName('wbe', CONFIGS), (err) => {
            assert.ok(err instanceof UnknownConfigurationError);
            assert.equal(err.requested, 'wbe');
            assert.ok(err.suggestions.includes('web'));
            assert.match(err.message, /Did you mean: web/);
            return true;
        });
    });

    test('a transposition suggests the intended configuration', () => {
        assert.throws(() => resolveName('dcos', CONFIGS), /Did you mean: docs/);
    });

    test('a substring suggests the long name that contains it', () => {
        // Edit distance alone would never surface this one.
        assert.throws(() => resolveName('stale-job', CONFIGS), (err) => {
            assert.ok(err.suggestions.some((s) => s.includes('stale-job')), err.suggestions.join('|'));
            return true;
        });
    });

    test('a name with nothing close by offers no suggestions', () => {
        assert.throws(() => resolveName('zzzzzzzzzzzzzzzz', CONFIGS), (err) => {
            assert.deepEqual(err.suggestions, []);
            assert.doesNotMatch(err.message, /Did you mean/);
            return true;
        });
    });

    test('an empty configuration list fails cleanly', () => {
        assert.throws(() => resolveName('web', []), UnknownConfigurationError);
    });

    test('the error names the preset as the source when it came from one', () => {
        assert.throws(() => resolveName('gone', CONFIGS, { source: 'preset' }), (err) => {
            assert.equal(err.source, 'preset');
            assert.match(err.message, /from the preset/);
            return true;
        });
    });
});

describe('suggestNames', () => {
    test('returns the closest names first', () => {
        assert.equal(suggestNames('wbe', NAMES)[0], 'web');
    });

    test('caps the number of suggestions', () => {
        assert.ok(suggestNames('addon-client', NAMES, 2).length <= 2);
    });

    test('is stable for equally distant names', () => {
        assert.deepEqual(suggestNames('addon', NAMES), suggestNames('addon', NAMES));
    });
});

describe('buildLaunchPlan', () => {
    test('a preset alone becomes the plan, in its configured order', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'api', mode: 'debug' }, { name: 'web', mode: 'run' }],
        });
        assert.deepEqual(plan.map((e) => [e.name, e.mode, e.source]), [
            ['api', 'debug', 'preset'],
            ['web', 'run', 'preset'],
        ]);
    });

    test('command-line requests alone become the plan', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            requests: [{ name: 'web', mode: 'debug' }],
        });
        assert.deepEqual(plan.map((e) => [e.name, e.mode, e.source]), [['web', 'debug', 'cli']]);
    });

    test('the command line overrides a preset entry’s mode, keeping its position', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }, { name: 'api', mode: 'run' }],
            requests: [{ name: 'web', mode: 'debug' }],
        });
        assert.deepEqual(plan.map((e) => [e.name, e.mode, e.source]), [
            ['web', 'debug', 'cli'],
            ['api', 'run', 'preset'],
        ]);
    });

    test('a new command-line name is appended after the preset', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }],
            requests: [{ name: 'docs', mode: 'debug' }],
        });
        assert.deepEqual(plan.map((e) => e.name), ['web', 'docs']);
    });

    test('overriding works across spellings — both sides resolve first', () => {
        // The preset stores "web"; the user types "WE". Same configuration.
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }],
            requests: [{ name: 'WE', mode: 'debug' }],
        });
        assert.equal(plan.length, 1, 'must not launch the same configuration twice');
        assert.equal(plan[0].mode, 'debug');
    });

    test('the plan carries the resolved configuration, not the typed string', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, requests: [{ name: 'doc', mode: 'run' }] });
        assert.equal(plan[0].name, 'docs');
        assert.equal(plan[0].config.description, 'npm');
    });

    test('an empty preset and no requests yield an empty plan', () => {
        assert.deepEqual(buildLaunchPlan({ configs: CONFIGS }), []);
    });

    test('an unknown command-line name throws before anything is planned', () => {
        assert.throws(
            () => buildLaunchPlan({ configs: CONFIGS, requests: [{ name: 'web', mode: 'run' }, { name: 'nope', mode: 'run' }] }),
            UnknownConfigurationError,
        );
    });

    test('a stale preset entry throws and says it came from the preset', () => {
        assert.throws(
            () => buildLaunchPlan({ configs: CONFIGS, preset: [{ name: 'deleted-in-the-ide', mode: 'run' }] }),
            (err) => {
                assert.ok(err instanceof UnknownConfigurationError);
                assert.equal(err.source, 'preset');
                return true;
            },
        );
    });

    test('resolution happens before anything is returned — no partial plan escapes', () => {
        // The guarantee the whole phase rests on: a bad third argument must not leave
        // the first two already launched.
        let plan;
        try {
            plan = buildLaunchPlan({
                configs: CONFIGS,
                requests: [
                    { name: 'web', mode: 'run' },
                    { name: 'api', mode: 'run' },
                    { name: 'does-not-exist', mode: 'run' },
                ],
            });
        } catch {
            plan = undefined;
        }
        assert.equal(plan, undefined);
    });

    test('handles the whole fixture at once', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            requests: NAMES.map((name) => ({ name, mode: 'run' })),
        });
        assert.equal(plan.length, 13);
        assert.deepEqual(plan.map((e) => e.name), NAMES);
    });
});

describe('formatPlan', () => {
    test('reports an empty plan in words', () => {
        assert.equal(formatPlan([]), 'nothing to launch');
    });

    test('aligns names and shows mode and source', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'debug' }],
            requests: [{ name: 'client > bundle:build', mode: 'run' }],
        });
        const lines = formatPlan(plan).split('\n');
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^web {20}debug {2}\(preset\)$/);
        assert.match(lines[1], /^client > bundle:build {2}run {4}\(cli\)$/);
    });

    test('a terminal entry widens the mode column instead of running into the source', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'terminal' }],
            requests: [{ name: 'api', mode: 'run' }],
        });
        const lines = formatPlan(plan).split('\n');
        assert.equal(lines[0], 'web  terminal  (preset)');
        assert.equal(lines[1], 'api  run       (cli)');
    });
});

describe('buildLaunchPlan — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a custom entry resolves without any run configuration', () => {
        const plan = buildLaunchPlan({ configs: [], preset: [seed] });
        assert.deepEqual(plan, [{ name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'], source: 'preset' }]);
        assert.equal(isCustomPlanEntry(plan[0]), true);
    });

    test('it keeps its place between run configurations', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }, seed, { name: 'api', mode: 'run' }],
        });
        assert.deepEqual(plan.map((entry) => entry.name), ['web', 'seed db', 'api']);
        assert.deepEqual(plan.map(isCustomPlanEntry), [false, true, false]);
    });

    test('a custom entry and a run configuration of the same name are two entries', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }, { ...seed, name: 'web' }],
        });
        assert.equal(plan.length, 2);
        assert.deepEqual(plan.map(isCustomPlanEntry), [false, true]);
    });

    test('a run configuration called like a key of the custom kind does not swallow it', () => {
        const plan = buildLaunchPlan({
            configs: [{ name: '["custom","seed db"]' }],
            preset: [{ name: '["custom","seed db"]', mode: 'run' }, seed],
        });
        assert.equal(plan.length, 2);
    });

    test('two custom entries of one name merge: first position, last commands', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [seed, { name: 'web', mode: 'run' }, { ...seed, commands: ['echo later'] }],
        });
        assert.deepEqual(plan.map((entry) => entry.name), ['seed db', 'web']);
        assert.deepEqual(plan[0].commands, ['echo later']);
    });

    test('the command line cannot name a custom entry: it only resolves against the IDE', () => {
        assert.throws(
            () => buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests: [{ name: 'seed db', mode: 'run' }] }),
            UnknownConfigurationError,
        );
    });

    test('formatPlan shows it as an ordinary terminal entry of the preset', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed] });
        assert.equal(formatPlan(plan), 'seed db  terminal  (preset)');
    });
});
