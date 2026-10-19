import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { runControl } from '../src/control/run.js';
import { RunningPayloadError } from '../src/mcp/control.js';
import { McpToolError } from '../src/mcp/client.js';
import { createLogger } from '../src/log.js';
import { parseConfig } from '../src/presets/store.js';
import { fakeStream } from '../test-utils/capture.js';
import { FIXTURE } from '../test-utils/fake-cli-deps.js';

const PLUGIN = ['debug_run_configuration', 'open_terminal_tab', 'list_running', 'stop_run_configuration',
    'restart_run_configuration', 'stop_terminal_tab', 'restart_terminal_tab'];

const PRESETS = {
    dev: [{ name: 'web' }, { name: 'api' }, { name: 'ngrok', mode: 'terminal', commands: ['ngrok http 8000'] }],
};

const WEB_AND_NGROK = {
    runs: [{ configurationName: 'web', mode: 'run' }],
    terminals: [{ entryName: 'ngrok', kind: 'custom', mode: 'terminal', commandRunning: true }],
};

/**
 * Run runControl() against a fake IDE.
 *
 * @param {object} opts
 * @param {'stop' | 'restart'} [opts.action]
 * @param {unknown} [opts.running] - what list_running answers
 * @param {string[]} [opts.tools]
 * @param {string[]} [opts.tokens]
 * @param {string[] | null} [opts.presetNames]
 * @param {boolean} [opts.dryRun]
 * @param {(name: string, args: any) => unknown} [opts.answer] - overrides a control tool's answer
 * @param {Record<string, object[]>} [opts.presets]
 */
async function control(opts = {}) {
    const stdout = fakeStream();
    const stderr = fakeStream();
    /** @type {Array<[string, any]>} */
    const calls = [];
    /** @type {any[]} */
    const launched = [];

    const client = {
        callTool: async (/** @type {string} */ name, /** @type {any} */ args) => {
            calls.push([name, args]);
            if (name === 'get_run_configurations') return FIXTURE;
            if (name === 'list_running') return opts.running ?? WEB_AND_NGROK;
            return opts.answer ? opts.answer(name, args) : `done ${name}`;
        },
    };

    const code = await runControl({
        action: opts.action ?? 'stop',
        client: /** @type {any} */ (client),
        tools: new Set(opts.tools ?? PLUGIN),
        config: parseConfig(JSON.stringify({ presets: opts.presets ?? PRESETS })),
        presetNames: opts.presetNames ?? null,
        tokens: opts.tokens ?? [],
        projectRoot: '/nowhere',
        dryRun: opts.dryRun ?? false,
        debugPortBase: 9229,
        platform: 'linux',
        env: {},
        log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
        readIdeaRunConfigs: async () => { throw new Error('.idea/ must not be read'); },
        launch: async (plan, launchCalls) => {
            launched.push({ plan, calls: launchCalls });
            return 0;
        },
    });

    return { code, calls, launched, stdout: stdout.text(), stderr: stderr.text() };
}

/** @param {Array<[string, any]>} calls - the control calls only, not the two reads */
const controlCalls = (calls) => calls.filter(([name]) => name !== 'get_run_configurations' && name !== 'list_running');

describe('runControl — without the plugin\'s tools', () => {
    test('no wsc Companion: says to install it, and asks the IDE nothing else', async () => {
        await assert.rejects(control({ tools: [] }), (err) => {
            assert.equal(/** @type {Error} */ (err).name, 'ControlError');
            assert.match(/** @type {Error} */ (err).message, /--stop needs the wsc Companion plugin/);
            assert.match(/** @type {Error} */ (err).message, /Install/);
            return true;
        });
    });

    test('an older wsc Companion: says to update it', async () => {
        await assert.rejects(control({ action: 'restart', tools: ['open_terminal_tab'] }), (err) => {
            assert.match(/** @type {Error} */ (err).message, /--restart needs wsc Companion 0\.6\.0 or later — update it/);
            return true;
        });
    });

    test('an answer from list_running wsc cannot read is a payload error, not a crash', async () => {
        await assert.rejects(control({ running: {} }), RunningPayloadError);
    });
});

describe('runControl — --stop', () => {
    test('stops each running entry where it runs, in preset order', async () => {
        const result = await control();

        assert.equal(result.code, 0);
        assert.deepEqual(controlCalls(result.calls), [
            ['stop_run_configuration', { configurationName: 'web' }],
            ['stop_terminal_tab', { kind: 'custom', entryName: 'ngrok' }],
        ]);
        assert.equal(result.stdout, 'stop     web    Run tab\nstop     ngrok  Terminal tab\n');
        assert.match(result.stderr, /^stopping 2 preset entries:$/m);
        assert.match(result.stderr, /^stopped 2 preset entries$/m);
    });

    test('a step the IDE refuses is reported, and the rest still runs', async () => {
        const result = await control({
            answer: (name, args) => {
                if (args.configurationName === 'web') throw new McpToolError(name, '"web" did not stop within 10s');
                return 'stopped';
            },
        });

        assert.equal(result.code, 1);
        assert.equal(controlCalls(result.calls).length, 2);
        assert.match(result.stderr, /web: "web" did not stop within 10s/);
        assert.match(result.stderr, /stopped 1 of 2 — failed: web/);
    });

    test('a broken connection stops the run: every other step would fail the same way', async () => {
        const broken = Object.assign(new Error('MCP error -32000: Connection closed'), { name: 'McpError' });
        await assert.rejects(control({ answer: () => { throw broken; } }), /Connection closed/);
    });

    test('--dry-run says what would be stopped, and stops nothing', async () => {
        const result = await control({ dryRun: true });

        assert.equal(result.code, 0);
        assert.deepEqual(controlCalls(result.calls), []);
        assert.match(result.stdout, /^stop {5}web {4}Run tab$/m);
        assert.match(result.stderr, /^would stop 2 preset entries:$/m);
    });

    test('nothing running is nothing to do', async () => {
        const result = await control({ running: { runs: [], terminals: [] } });

        assert.equal(result.code, 0);
        assert.match(result.stderr, /nothing to stop: no preset entry is running/);
        assert.equal(result.stdout, '');
    });

    test('a named entry that is not running is already stopped', async () => {
        const result = await control({ tokens: ['api'] });

        assert.equal(result.code, 0);
        assert.deepEqual(controlCalls(result.calls), []);
        assert.match(result.stderr, /"api" is not running/);
    });

    test('a configuration in both a Run tab and a Terminal tab is stopped in both', async () => {
        const result = await control({
            running: {
                runs: [{ configurationName: 'web', mode: 'run' }],
                terminals: [{ entryName: 'web', kind: 'config', mode: 'run', commandRunning: true }],
            },
        });

        assert.deepEqual(controlCalls(result.calls), [
            ['stop_run_configuration', { configurationName: 'web' }],
            ['stop_terminal_tab', { kind: 'config', entryName: 'web' }],
        ]);
        assert.match(result.stderr, /^stopping 1 preset entry:$/m);
    });
});
