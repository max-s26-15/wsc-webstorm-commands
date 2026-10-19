import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    RESTART_RUN_TOOL,
    RESTART_TERMINAL_TOOL,
    RunningPayloadError,
    STOP_RUN_TOOL,
    STOP_TERMINAL_TOOL,
    parseRunning,
    restartRunCall,
    restartTerminalCall,
    stopRunCall,
    stopTerminalCall,
} from '../src/mcp/control.js';

const FULL = {
    runs: [
        { configurationName: 'web', mode: 'run' },
        { configurationName: 'api', mode: 'debug' },
    ],
    terminals: [
        { entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: true },
        { entryName: 'test', kind: 'config', mode: 'debug', debugPort: 9229, commandRunning: false },
    ],
};

describe('parseRunning', () => {
    test('accepts what list_running answers, and returns it', () => {
        assert.deepEqual(parseRunning(FULL), FULL);
    });

    test('leaves debugPort out when the tab has none', () => {
        const [ngrok] = parseRunning(FULL).terminals;
        assert.equal(Object.hasOwn(ngrok, 'debugPort'), false);
    });

    test('empty lists are an answer: nothing is running', () => {
        assert.deepEqual(parseRunning({ runs: [], terminals: [] }), { runs: [], terminals: [] });
    });

    const broken = {
        'null': null,
        'a string': 'nothing is running',
        'no runs': { terminals: [] },
        'runs that is not a list': { runs: {}, terminals: [] },
        'a run without a name': { runs: [{ mode: 'run' }], terminals: [] },
        'a run in terminal mode': { runs: [{ configurationName: 'web', mode: 'terminal' }], terminals: [] },
        'an unknown kind': { runs: [], terminals: [{ entryName: 'x', kind: 'other', mode: 'run', commandRunning: true }] },
        'an unknown terminal mode': { runs: [], terminals: [{ entryName: 'x', kind: 'config', mode: 'fast', commandRunning: true }] },
        'commandRunning that is not a boolean': {
            runs: [],
            terminals: [{ entryName: 'x', kind: 'custom', mode: 'terminal', commandRunning: 'yes' }],
        },
        'a debugPort that is a string': {
            runs: [],
            terminals: [{ entryName: 'x', kind: 'config', mode: 'debug', debugPort: '9229', commandRunning: true }],
        },
    };

    for (const [what, payload] of Object.entries(broken)) {
        test(`refuses ${what}`, () => {
            assert.throws(() => parseRunning(payload), RunningPayloadError);
        });
    }

    test('says what to do about it, like the other payload error', () => {
        const err = new RunningPayloadError('it has no runs');
        assert.equal(err.name, 'RunningPayloadError');
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /list_running/);
        assert.match(err.message, /wsc Companion/);
        assert.match(err.message, /wsc-mcp-probe/);
    });
});

describe('control calls', () => {
    test('a run configuration is named the way the IDE names it', () => {
        assert.deepEqual(stopRunCall('web'), { tool: STOP_RUN_TOOL, arguments: { configurationName: 'web' } });
        assert.deepEqual(restartRunCall('web'), { tool: RESTART_RUN_TOOL, arguments: { configurationName: 'web' } });
    });

    test('a Terminal tab is named by the mark it carries', () => {
        assert.deepEqual(stopTerminalCall('custom', 'ngrok'), {
            tool: STOP_TERMINAL_TOOL,
            arguments: { kind: 'custom', entryName: 'ngrok' },
        });
        assert.deepEqual(restartTerminalCall('custom', 'ngrok', 'ngrok http 8000'), {
            tool: RESTART_TERMINAL_TOOL,
            arguments: { kind: 'custom', entryName: 'ngrok', command: 'ngrok http 8000' },
        });
    });
});
