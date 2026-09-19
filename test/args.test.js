import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { DEFAULT_MODE, OPTIONS, UsageError, parseCliArgs, parseRequests, splitNameMode } from '../src/args.js';

const require = createRequire(import.meta.url);
/** The demo-app names — the colon cases below are not hypothetical. */
const NAMES = require('./fixtures/run-configurations.json').configurations.map((c) => c.name);
const known = new Set(NAMES);
const isKnownName = (/** @type {string} */ name) => known.has(name);

describe('splitNameMode — plain names', () => {
    test('a bare name defaults to run mode', () => {
        assert.deepEqual(splitNameMode('web'), { name: 'web', mode: 'run' });
    });

    test('splits an explicit :debug suffix', () => {
        assert.deepEqual(splitNameMode('web:debug'), { name: 'web', mode: 'debug' });
    });

    test('splits an explicit :run suffix', () => {
        assert.deepEqual(splitNameMode('web:run'), { name: 'web', mode: 'run' });
    });

    test('the default mode is run', () => {
        assert.equal(DEFAULT_MODE, 'run');
    });
});

describe('splitNameMode — names that contain colons', () => {
    test('leaves a suffix that is not a mode alone', () => {
        assert.deepEqual(splitNameMode('client > bundle:build'), {
            name: 'client > bundle:build',
            mode: 'run',
        });
    });

    test('leaves "mailer > debug:log" intact', () => {
        // "debug" appears mid-name; only the final segment could ever be a mode.
        assert.deepEqual(splitNameMode('mailer > debug:log'), {
            name: 'mailer > debug:log',
            mode: 'run',
        });
    });

    test('leaves a name starting with a colon-bearing prefix alone', () => {
        assert.deepEqual(splitNameMode('Repro: Stale Job Cleanup'), {
            name: 'Repro: Stale Job Cleanup',
            mode: 'run',
        });
    });

    test('a known name ending in :debug is NOT split', () => {
        // The syntactic rule alone would cut this one in half; only the IDE's own list
        // can tell "the configuration called ...:debug" from "...  in debug mode".
        assert.deepEqual(splitNameMode('api > repro:stale-job:debug', { isKnownName }), {
            name: 'api > repro:stale-job:debug',
            mode: 'run',
        });
    });

    test('without the IDE list the same token is split — documented degradation', () => {
        assert.deepEqual(splitNameMode('api > repro:stale-job:debug'), {
            name: 'api > repro:stale-job',
            mode: 'debug',
        });
    });

    test('doubling the suffix debugs a configuration whose name ends in :debug', () => {
        assert.deepEqual(splitNameMode('api > repro:stale-job:debug:debug', { isKnownName }), {
            name: 'api > repro:stale-job:debug',
            mode: 'debug',
        });
    });

    test('every fixture name round-trips unchanged', () => {
        for (const name of NAMES) {
            assert.deepEqual(splitNameMode(name, { isKnownName }), { name, mode: 'run' }, name);
        }
    });

    test('every fixture name can be requested in debug mode', () => {
        for (const name of NAMES) {
            assert.deepEqual(splitNameMode(`${name}:debug`, { isKnownName }), { name, mode: 'debug' }, name);
        }
    });
});

describe('splitNameMode — edge cases', () => {
    test('a leading colon is not a mode separator', () => {
        assert.deepEqual(splitNameMode(':debug'), { name: ':debug', mode: 'run' });
    });

    test('a trailing colon is not a mode', () => {
        assert.deepEqual(splitNameMode('web:'), { name: 'web:', mode: 'run' });
    });

    test('mode matching is case-sensitive', () => {
        assert.deepEqual(splitNameMode('web:DEBUG'), { name: 'web:DEBUG', mode: 'run' });
    });

    test('an unknown mode-looking suffix stays part of the name', () => {
        assert.deepEqual(splitNameMode('web:profile'), { name: 'web:profile', mode: 'run' });
    });

    test('only the last colon is considered', () => {
        assert.deepEqual(splitNameMode('a:b:debug'), { name: 'a:b', mode: 'debug' });
    });
});

describe('parseRequests', () => {
    test('parses several tokens in order', () => {
        assert.deepEqual(parseRequests(['web:debug', 'api']), [
            { name: 'web', mode: 'debug' },
            { name: 'api', mode: 'run' },
        ]);
    });

    test('returns an empty list for no tokens', () => {
        assert.deepEqual(parseRequests([]), []);
    });

    test('a repeated name is an override, keeping its first position', () => {
        assert.deepEqual(parseRequests(['web', 'api', 'web:debug']), [
            { name: 'web', mode: 'debug' },
            { name: 'api', mode: 'run' },
        ]);
    });

    test('rejects an empty token', () => {
        assert.throws(() => parseRequests(['']), UsageError);
    });

    test('a leading-colon token is a name, not a mode', () => {
        assert.deepEqual(parseRequests(['api', ':run']), [
            { name: 'api', mode: 'run' },
            { name: ':run', mode: 'run' },
        ]);
    });

    test('passes isKnownName through', () => {
        assert.deepEqual(parseRequests(['api > repro:stale-job:debug'], { isKnownName }), [
            { name: 'api > repro:stale-job:debug', mode: 'run' },
        ]);
    });
});

describe('parseCliArgs', () => {
    test('parses flags and positionals together', () => {
        const { values, positionals } = parseCliArgs(['--preset', 'backend', 'web:debug']);
        assert.equal(values.preset, 'backend');
        assert.deepEqual(positionals, ['web:debug']);
    });

    test('supports the short aliases', () => {
        assert.equal(parseCliArgs(['-h']).values.help, true);
        assert.equal(parseCliArgs(['-v']).values.version, true);
    });

    test('parses every declared option', () => {
        const { values } = parseCliArgs([
            '--preset', 'p', '--project', '/tmp/x', '--mcp-port', '64542', '--dry-run',
        ]);
        assert.deepEqual({ ...values }, {
            preset: 'p', project: '/tmp/x', 'mcp-port': '64542', 'dry-run': true,
        });
    });

    test('throws UsageError on an unknown flag', () => {
        assert.throws(() => parseCliArgs(['--nope']), (err) => {
            assert.ok(err instanceof UsageError);
            assert.match(err.message, /--nope/);
            return true;
        });
    });

    test('throws UsageError when a string flag has no value', () => {
        assert.throws(() => parseCliArgs(['--preset']), UsageError);
    });

    test('a name that looks like a flag can be passed after --', () => {
        assert.deepEqual(parseCliArgs(['--', '--weird-name']).positionals, ['--weird-name']);
    });

    test('OPTIONS declares no `multiple` flags — values are never arrays', () => {
        for (const [name, option] of Object.entries(OPTIONS)) {
            assert.notEqual(option.multiple, true, `${name} would break CliValues typing`);
        }
    });
});
