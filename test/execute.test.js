import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AmbiguousProjectError, McpToolError, createMcpClient } from '../src/mcp/client.js';
import {
    DEBUG_CONFIGURATION_TOOL,
    RUN_CONFIGURATION_TOOL,
    debugConfigurationCall,
    launchFailureReason,
    TERMINAL_MAX_LINES,
    TERMINAL_TIMEOUT_MS,
    TERMINAL_TOOL,
    runConfigurationCall,
    runExecutionPlan,
    terminalCommandCall,
} from '../src/mcp/execute.js';
import { fakeSession, textResult } from '../test-utils/fake-session.js';

/**
 * A mock client that records what it was asked to launch.
 *
 * @param {(name: string, args: object) => unknown} [handler] - throw to simulate a failure
 */
function mockClient(handler) {
    const calls = [];
    return {
        calls,
        client: /** @type {any} */ ({
            async callTool(name, args) {
                calls.push({ name, args });
                return handler ? handler(name, args) : 'ok';
            },
            async close() {},
        }),
    };
}

/** Logger double: keeps every line, tagged with its level. */
function mockLog() {
    const lines = [];
    const at = (level) => (...args) => lines.push(`${level}: ${args.join(' ')}`);
    return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

/** @param {string} name @param {'run'|'debug'} [mode] */
const runCall = (name, mode = 'run') => ({ name, mode, ...runConfigurationCall(name) });

/** @param {string} name @param {string} command */
const termCall = (name, command) => ({ name, mode: 'run', ...terminalCommandCall(command) });

describe('runConfigurationCall', () => {
    test('names the tool and the configuration', () => {
        const call = runConfigurationCall('web');
        assert.equal(call.tool, RUN_CONFIGURATION_TOOL);
        assert.equal(call.arguments.configurationName, 'web');
    });

    test('never waits for exit — that is what allows several tabs at once', () => {
        assert.equal(runConfigurationCall('web').arguments.waitForExit, false);
    });

    test('omits timeout entirely, since the IDE ignores it when waitForExit is false', () => {
        assert.equal('timeout' in runConfigurationCall('web').arguments, false);
    });

    test('sends no projectPath — createMcpClient injects it', () => {
        assert.equal('projectPath' in runConfigurationCall('web').arguments, false);
    });

    test('a name that collides with Object.prototype is just a name', () => {
        // Run configurations may legitimately be called "constructor" or "toString".
        for (const name of ['constructor', 'toString', '__proto__']) {
            assert.equal(runConfigurationCall(name).arguments.configurationName, name);
        }
    });
});

describe('debugConfigurationCall', () => {
    test('names the plugin\'s tool and the configuration, and nothing else', () => {
        // No waitForExit, no ports, no command: the IDE starts and attaches by itself, and
        // projectPath is the client's to add (createMcpClient injects it).
        assert.deepEqual(debugConfigurationCall('web'), {
            tool: DEBUG_CONFIGURATION_TOOL,
            arguments: { configurationName: 'web' },
        });
    });

    test('a name that collides with Object.prototype is just a name', () => {
        for (const name of ['constructor', 'toString', '__proto__']) {
            assert.equal(debugConfigurationCall(name).arguments.configurationName, name);
        }
    });
});

describe('terminalCommandCall', () => {
    test('asks for a brand new tab, in a real shell', () => {
        const call = terminalCommandCall('npm run dev');
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, 'npm run dev');
        assert.equal(call.arguments.reuseExistingTerminalWindow, false);
        assert.equal(call.arguments.executeInShell, true);
    });

    test('bounds output collection by default', () => {
        const { arguments: args } = terminalCommandCall('npm run dev');
        assert.equal(args.timeout, TERMINAL_TIMEOUT_MS);
        assert.equal(args.maxLinesCount, TERMINAL_MAX_LINES);
        assert.equal(args.truncateMode, 'END');
    });

    test('the bounds are overridable', () => {
        const { arguments: args } = terminalCommandCall('npm run dev', { timeoutMs: 10, maxLines: 2 });
        assert.equal(args.timeout, 10);
        assert.equal(args.maxLinesCount, 2);
    });

    test('sends no projectPath — createMcpClient injects it', () => {
        assert.equal('projectPath' in terminalCommandCall('npm run dev').arguments, false);
    });
});

describe('runExecutionPlan — the happy path', () => {
    test('issues every call and reports them all as started', async () => {
        const { client, calls } = mockClient();
        const log = mockLog();

        const report = await runExecutionPlan([runCall('web'), runCall('api')], { client, log });

        assert.deepEqual(calls.map((c) => c.name), [RUN_CONFIGURATION_TOOL, RUN_CONFIGURATION_TOOL]);
        assert.deepEqual(report.started.map((c) => c.name), ['web', 'api']);
        assert.deepEqual(report.failed, []);
    });

    test('calls go out sequentially, so tabs open in the order the plan was printed', async () => {
        const order = [];
        const client = /** @type {any} */ ({
            async callTool(_name, args) {
                order.push(`start ${args.configurationName}`);
                // A concurrent runner would interleave: every start before every finish.
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push(`done ${args.configurationName}`);
                return 'ok';
            },
        });

        await runExecutionPlan([runCall('a'), runCall('b')], { client });
        assert.deepEqual(order, ['start a', 'done a', 'start b', 'done b']);
    });

    test('names each started configuration and its mode', async () => {
        const { client } = mockClient();
        const log = mockLog();
        await runExecutionPlan([runCall('web', 'run'), termCall('api', 'npm run api')], { client, log });
        assert.ok(log.lines.includes('info: started web (run)'));
        assert.ok(log.lines.includes('info: started api (run)'));
    });

    test('works without a logger at all', async () => {
        const { client } = mockClient();
        const report = await runExecutionPlan([runCall('web')], { client });
        assert.equal(report.started.length, 1);
    });

    test('an empty plan is a no-op, not an error', async () => {
        const { client, calls } = mockClient();
        const report = await runExecutionPlan([], { client });
        assert.deepEqual(calls, []);
        assert.deepEqual(report, { started: [], failed: [] });
    });
});

describe('runExecutionPlan — partial failure', () => {
    /** Fails only on the named configuration, the way the IDE rejects one launch. */
    const failOn = (bad) =>
        mockClient((name, args) => {
            if (args.configurationName === bad) throw new McpToolError(name, `no configuration named ${bad}`);
            return 'ok';
        });

    test('a rejected launch does not stop the rest of the plan', async () => {
        const { client, calls } = failOn('api');
        const report = await runExecutionPlan(
            [runCall('web'), runCall('api'), runCall('shared')],
            { client },
        );

        assert.equal(calls.length, 3, 'every configuration must still be attempted');
        assert.deepEqual(report.started.map((c) => c.name), ['web', 'shared']);
        assert.deepEqual(report.failed.map(({ call }) => call.name), ['api']);
    });

    test('the failure is reported the moment it happens, in the IDE\'s own words', async () => {
        const { client } = failOn('api');
        const log = mockLog();
        await runExecutionPlan([runCall('api')], { client, log });
        assert.ok(log.lines.includes('error: api: no configuration named api'));
    });

    test('every entry can fail without the runner throwing', async () => {
        const { client } = mockClient((name) => {
            throw new McpToolError(name, 'Brave Mode is off');
        });
        const report = await runExecutionPlan([runCall('a'), runCall('b')], { client });
        assert.equal(report.started.length, 0);
        assert.equal(report.failed.length, 2);
    });
});

describe('runExecutionPlan — a failure that is not about one configuration', () => {
    test('a transport error aborts instead of repeating itself once per entry', async () => {
        // Every remaining call would fail identically, each only after the full timeout.
        const { client, calls } = mockClient((_name, args) => {
            if (args.configurationName === 'api') throw new Error('socket hang up');
            return 'ok';
        });

        await assert.rejects(
            () => runExecutionPlan([runCall('web'), runCall('api'), runCall('shared')], { client }),
            /socket hang up/,
        );
        assert.equal(calls.length, 2, 'the plan must stop, not grind through a dead connection');
    });

    test('but it says what already started before letting go', async () => {
        const { client } = mockClient((_name, args) => {
            if (args.configurationName === 'api') throw new Error('socket hang up');
            return 'ok';
        });
        const log = mockLog();

        await assert.rejects(() => runExecutionPlan([runCall('web'), runCall('api')], { client, log }));
        assert.ok(log.lines.includes('warn: already started: web'));
    });

    test('an ambiguous project aborts too — it is not a property of one entry', async () => {
        // AmbiguousProjectError is an McpToolError subclass, so an instanceof check would
        // record it as a per-configuration failure and repeat it for every entry.
        const { client, calls } = mockClient((name) => {
            throw new AmbiguousProjectError(name, 'Unable to determine the target project', ['/a', '/b']);
        });

        await assert.rejects(
            () => runExecutionPlan([runCall('web'), runCall('api')], { client }),
            /Unable to determine the target project/,
        );
        assert.equal(calls.length, 1);
    });

    test('a rejection that is not even an Error is passed on untouched', async () => {
        const { client } = mockClient(() => { throw 'plain string'; });
        await assert.rejects(() => runExecutionPlan([runCall('web')], { client }), (err) => {
            assert.equal(err, 'plain string');
            return true;
        });
    });

    test('nothing started yet means nothing to say', async () => {
        const { client } = mockClient(() => {
            throw new Error('socket hang up');
        });
        const log = mockLog();
        await assert.rejects(() => runExecutionPlan([runCall('web')], { client, log }));
        assert.deepEqual(log.lines.filter((line) => line.startsWith('warn:')), []);
    });
});

describe('runExecutionPlan — against a real McpClient', () => {
    test('the IDE reporting a failure as a successful isError response still counts as failed', async () => {
        // The trap from phase 2: MCP returns tool failures with isError: true, not as an
        // exception. Going through createMcpClient proves the runner sees them as failures.
        const session = fakeSession((req) =>
            req.arguments.configurationName === 'api'
                ? textResult('Run configuration not found', true)
                : textResult('started'),
        );
        const client = createMcpClient(session, { projectPath: '/p' });

        const report = await runExecutionPlan([runCall('web'), runCall('api')], { client });
        assert.deepEqual(report.started.map((c) => c.name), ['web']);
        assert.deepEqual(report.failed.map(({ call }) => call.name), ['api']);
        assert.match(report.failed[0].reason, /Run configuration not found/);
    });

    test('projectPath reaches the IDE on every launch, injected by the client', async () => {
        const session = fakeSession(() => textResult('started'));
        const client = createMcpClient(session, { projectPath: '/home/me/demo-app' });

        await runExecutionPlan([runCall('web'), termCall('api', 'npm run api')], { client });
        for (const call of session.calls) {
            assert.equal(call.arguments.projectPath, '/home/me/demo-app');
        }
    });
});

describe('launchFailureReason', () => {
    test('a terminal command that exited non-zero is a failed launch', () => {
        // Real payload from WebStorm 2026.2.1: the tool call *succeeded*, the command did not.
        assert.equal(
            launchFailureReason({ command_exit_code: 127, command_output: 'zsh:1: command not found: npm\n' }),
            'exited with code 127: zsh:1: command not found: npm',
        );
    });

    test('exit code 0 is a launch, not a failure', () => {
        assert.equal(launchFailureReason({ command_exit_code: 0, command_output: 'done\n' }), null);
    });

    test('a still-running command reports no exit code at all', () => {
        assert.equal(launchFailureReason({ command_output: 'listening on :3000' }), null);
    });

    test('a non-zero code with no output still says something', () => {
        assert.equal(launchFailureReason({ command_exit_code: 3, command_output: '' }), 'exited with code 3');
        assert.equal(launchFailureReason({ command_exit_code: 3 }), 'exited with code 3');
    });

    test('an inherited command_exit_code is not the IDE reporting one', () => {
        // House rule: a read off a payload the CLI did not build goes through Object.hasOwn.
        assert.equal(launchFailureReason(Object.create({ command_exit_code: 9 })), null);
        assert.equal(
            launchFailureReason(Object.assign(Object.create({ command_output: 'inherited' }), {
                command_exit_code: 2,
            })),
            'exited with code 2',
        );
    });

    test('shapes other than a terminal result are left alone', () => {
        for (const value of [null, undefined, 'plain text', 42, { output: '', fullOutputPath: '/tmp/x' }]) {
            assert.equal(launchFailureReason(value), null);
        }
    });
});

describe('runExecutionPlan — a terminal launch that outlives its bound', () => {
    /** The SDK's rejection for a call that ran out of time. */
    const timeoutError = () => Object.assign(new Error('MCP error -32001: Request timed out'), {
        name: 'McpError',
        code: -32001,
    });

    test('a bounded terminal call is passed its own, shorter timeout', async () => {
        const seen = [];
        const client = /** @type {any} */ ({
            async callTool(_name, _args, opts) {
                seen.push(opts);
                return { command_output: '' };
            },
        });

        await runExecutionPlan([termCall('api', 'npm run api'), runCall('web')], { client });
        assert.equal(seen[0].timeoutMs, TERMINAL_TIMEOUT_MS, 'the IDE ignores its own timeout argument');
        assert.equal(seen[1].timeoutMs, undefined, 'a run-window launch returns at once and needs no bound');
    });

    test('a timed-out terminal launch counts as started — the process keeps running', async () => {
        const client = /** @type {any} */ ({ async callTool() { throw timeoutError(); } });
        const log = mockLog();

        const report = await runExecutionPlan([termCall('api', 'npm run api')], { client, log });
        assert.deepEqual(report.started.map((c) => c.name), ['api']);
        assert.deepEqual(report.failed, []);
        assert.ok(log.lines.includes('info: started api (run) — still running'));
    });

    test('a timed-out launch does not stop the rest of the plan', async () => {
        const { client, calls } = mockClient((name) => {
            if (name === TERMINAL_TOOL) throw timeoutError();
            return 'ok';
        });
        const report = await runExecutionPlan(
            [termCall('api', 'npm run api'), runCall('web')],
            { client },
        );
        assert.equal(calls.length, 2);
        assert.equal(report.started.length, 2);
    });

    test('an unbounded call that times out is still a real failure', async () => {
        // Nothing bounded it, so this is the transport giving up, not a live dev server.
        const client = /** @type {any} */ ({ async callTool() { throw timeoutError(); } });
        await assert.rejects(() => runExecutionPlan([runCall('web')], { client }), /Request timed out/);
    });
});

describe('runExecutionPlan — a launch the IDE ran but the command rejected', () => {
    test('a non-zero exit code is reported as failed, not as started', async () => {
        const { client } = mockClient((name) =>
            name === TERMINAL_TOOL
                ? { command_exit_code: 127, command_output: 'zsh:1: command not found: npm' }
                : 'ok');
        const log = mockLog();

        const report = await runExecutionPlan(
            [termCall('api', 'npm run api'), runCall('web')],
            { client, log },
        );
        assert.deepEqual(report.started.map((c) => c.name), ['web'], 'the rest of the plan still runs');
        assert.deepEqual(report.failed.map(({ call }) => call.name), ['api']);
        assert.ok(log.lines.some((line) => line.includes('command not found')));
    });
});
