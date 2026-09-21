import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { announceCustomCommands, customCommandLine, customCommandLines } from '../src/exec/customCommands.js';
import { createLogger } from '../src/log.js';
import { buildLaunchPlan } from '../src/resolve.js';
import { fakeStream } from '../test-utils/capture.js';

const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
const plan = buildLaunchPlan({ configs: [{ name: 'web' }], preset: [{ name: 'web', mode: 'run' }, seed] });

describe('customCommandLine', () => {
    test('joins the commands with && and quotes nothing', () => {
        assert.equal(customCommandLine(['npm i', 'echo "a b" | tr a-z A-Z']), 'npm i && echo "a b" | tr a-z A-Z');
    });

    test('a failing command stops the chain — run through a real /bin/sh', () => {
        const chained = spawnSync('/bin/sh', ['-c', customCommandLine(['false', 'echo second'])], { encoding: 'utf8' });
        assert.equal(chained.status, 1, 'the chain ends with the failure of its first command');
        assert.equal(chained.stdout, '', 'the second command must not run');

        // The control: the same two commands joined with ';' do run the second one, so the
        // assertion above is the && and not an accident of the shell.
        const loose = spawnSync('/bin/sh', ['-c', ['false', 'echo second'].join('; ')], { encoding: 'utf8' });
        assert.equal(loose.stdout, 'second\n');
    });

    test('a succeeding chain runs every command, in order', () => {
        const chained = spawnSync('/bin/sh', ['-c', customCommandLine(['echo one', 'echo two'])], { encoding: 'utf8' });
        assert.equal(chained.status, 0);
        assert.equal(chained.stdout, 'one\ntwo\n');
    });
});

describe('customCommandLines', () => {
    test('names only the custom entries, as "name: command line"', () => {
        assert.deepEqual(customCommandLines(plan), ['seed db: npm i && npm run seed']);
    });
});

describe('announceCustomCommands', () => {
    const logTo = (stderr) => createLogger({ stdout: fakeStream(), stderr, env: { NO_COLOR: '1' } });

    test('prints a header and one indented line per custom entry, on stderr', () => {
        const stderr = fakeStream();
        announceCustomCommands(plan, logTo(stderr));
        assert.match(stderr.text(), /custom commands from the preset:\n {2}seed db: npm i && npm run seed\n/);
    });

    test('says nothing for a plan without custom entries', () => {
        const stderr = fakeStream();
        announceCustomCommands(buildLaunchPlan({ configs: [{ name: 'web' }], preset: [{ name: 'web', mode: 'run' }] }), logTo(stderr));
        assert.equal(stderr.text(), '');
    });
});
