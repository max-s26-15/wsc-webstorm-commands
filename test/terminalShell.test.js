import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    POSIX_TERMINAL_ENV,
    PosixTerminalRequiredError,
    assertPosixTerminal,
    callsNeedingPosixTerminal,
} from '../src/exec/terminalShell.js';

const run = { name: 'web', mode: 'run', tool: 'execute_run_configuration', arguments: {} };
const pluginDebug = { name: 'api', mode: 'debug', tool: 'debug_run_configuration', arguments: {} };
const pipedTerminal = { name: 'test', mode: 'terminal', tool: 'execute_terminal_command', arguments: {} };
const realTerminal = { name: 'seed db', mode: 'terminal', tool: 'open_terminal_tab', arguments: {} };

describe('callsNeedingPosixTerminal', () => {
    test('is every call that types a command into a terminal, whichever tool opens it', () => {
        assert.deepEqual(callsNeedingPosixTerminal([run, pipedTerminal, pluginDebug, realTerminal]), [pipedTerminal, realTerminal]);
    });
});

describe('assertPosixTerminal', () => {
    const win = { platform: 'win32', env: {} };

    test('a run-window plan runs on Windows', () => {
        assert.doesNotThrow(() => assertPosixTerminal([run], win));
    });

    test('debug through the plugin is not refused', () => {
        assert.doesNotThrow(() => assertPosixTerminal([pluginDebug], win));
    });

    test('a mixed plan is refused as a whole, naming only the terminal entries', () => {
        assert.throws(() => assertPosixTerminal([run, pipedTerminal, realTerminal], win), (err) => {
            assert.ok(err instanceof PosixTerminalRequiredError);
            assert.equal(err.name, 'PosixTerminalRequiredError');
            assert.deepEqual(err.names, ['test', 'seed db']);
            assert.match(err.message, /"test", "seed db"/);
            assert.match(err.message, /PowerShell/);
            assert.match(err.message, /wsc Companion/);
            assert.match(err.message, /Git Bash/);
            assert.match(err.message, /WSC_POSIX_TERMINAL=1/);
            return true;
        });
    });

    test(`${POSIX_TERMINAL_ENV}=1 is the user's promise that the IDE terminal is POSIX`, () => {
        assert.doesNotThrow(() => assertPosixTerminal([pipedTerminal], { platform: 'win32', env: { [POSIX_TERMINAL_ENV]: '1' } }));
    });

    test('any other value is not that promise', () => {
        for (const value of ['0', 'true', 'yes', '']) {
            assert.throws(
                () => assertPosixTerminal([pipedTerminal], { platform: 'win32', env: { [POSIX_TERMINAL_ENV]: value } }),
                PosixTerminalRequiredError,
            );
        }
    });

    test('other platforms are never refused', () => {
        for (const platform of ['linux', 'darwin']) {
            assert.doesNotThrow(() => assertPosixTerminal([pipedTerminal, realTerminal], { platform, env: {} }));
        }
    });
});
