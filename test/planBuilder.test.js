import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
    DEBUG_FLAG,
    DEBUG_HOST,
    DEBUG_PORT_BASE,
    DEFAULT_TARGET,
    EXEC_TARGETS,
    UnsupportedLaunchError,
    buildExecutionPlan,
    buildTerminalCommand,
    debugEnvPrefix,
    debugNote,
    debugPortsOf,
    executionNotes,
    formatExecutionPlan,
    guessedCommands,
    needsTerminalCommands,
    PIPED_TERMINAL_NOTE,
    shellQuote,
    splitNpmConfigName,
    usesPipedTerminal,
} from '../src/exec/planBuilder.js';
import { DEBUG_CONFIGURATION_TOOL, RUN_CONFIGURATION_TOOL, TERMINAL_TAB_TOOL, TERMINAL_TOOL } from '../src/mcp/execute.js';
import { buildLaunchPlan, normalizeRunConfigs } from '../src/resolve.js';
import { skipWithoutPosixSh } from '../test-utils/shells.js';

const require = createRequire(import.meta.url);
/** The demo-app payload — 13 configurations, including two debug scripts. */
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

/**
 * Resolve names the same way the CLI does, so the tests exercise real PlanEntry shapes.
 *
 * @param {...string} tokens - `name`, `name:debug` or `name:terminal`
 */
function plan(...tokens) {
    const requests = tokens.map((token) => {
        const mode = ['debug', 'terminal'].find((m) => token.endsWith(`:${m}`)) ?? 'run';
        return { name: mode === 'run' ? token : token.slice(0, -`:${mode}`.length), mode };
    });
    return buildLaunchPlan({ configs: CONFIGS, requests });
}

describe('shellQuote', () => {
    test('leaves an ordinary script name bare', () => {
        assert.equal(shellQuote('bundle:build'), 'bundle:build');
        assert.equal(shellQuote('packages/client'), 'packages/client');
    });

    test('quotes anything with a space or a shell metacharacter', () => {
        assert.equal(shellQuote('my app'), "'my app'");
        assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'");
        assert.equal(shellQuote('a > b'), "'a > b'");
    });

    test('escapes an embedded single quote instead of ending the quoting', () => {
        assert.equal(shellQuote("it's"), "'it'\\''s'");
    });

    test('quotes the empty string rather than dropping the argument', () => {
        assert.equal(shellQuote(''), "''");
    });
});

describe('splitNpmConfigName', () => {
    test('a root script has no workspace', () => {
        assert.deepEqual(splitNpmConfigName('web'), { workspace: null, script: 'web' });
    });

    test('splits the IDE\'s "directory > script" naming', () => {
        assert.deepEqual(splitNpmConfigName('client > bundle:build'), {
            workspace: 'client',
            script: 'bundle:build',
        });
    });

    test('a script name full of colons survives intact', () => {
        // The demo-app configuration that broke the naive ":debug" split in phase 3.
        assert.deepEqual(splitNpmConfigName('api > repro:stale-job:debug'), {
            workspace: 'api',
            script: 'repro:stale-job:debug',
        });
    });

    test('a nested directory keeps its slashes on the left of the separator', () => {
        assert.deepEqual(splitNpmConfigName('packages/client > build'), {
            workspace: 'packages/client',
            script: 'build',
        });
    });

    test('cuts at the last separator, so the script is always the final segment', () => {
        assert.deepEqual(splitNpmConfigName('a > b > c'), { workspace: 'a > b', script: 'c' });
    });

    test('a bare ">" is not a separator — only " > " is', () => {
        assert.deepEqual(splitNpmConfigName('a>b'), { workspace: null, script: 'a>b' });
    });
});

describe('buildTerminalCommand', () => {
    /** @param {string} name */
    const config = (name) => CONFIGS.find((c) => c.name === name);

    test('a root npm script becomes a plain npm run', () => {
        assert.equal(buildTerminalCommand(config('web'), 'run'), 'npm run web');
    });

    test('a workspace script cd\'s first — the IDE terminal opens at the project root', () => {
        assert.equal(
            buildTerminalCommand(config('client > bundle:build'), 'run'),
            'cd client && npm run bundle:build',
        );
    });

    test('debug mode prefixes a NODE_OPTIONS assignment carrying --inspect-brk', () => {
        assert.equal(
            buildTerminalCommand(config('api'), 'debug'),
            `${debugEnvPrefix(DEBUG_PORT_BASE)} npm run api`,
        );
        assert.match(buildTerminalCommand(config('api'), 'debug'), /--inspect-brk=127\.0\.0\.1:9229/);
    });

    test('an explicit port lands in the command, not the default one', () => {
        assert.equal(
            buildTerminalCommand(config('api'), 'debug', { debugPort: 9333 }),
            `${debugEnvPrefix(9333)} npm run api`,
        );
    });

    test('a run entry never mentions the inspector, port or not', () => {
        assert.equal(buildTerminalCommand(config('api'), 'run', { debugPort: 9333 }), 'npm run api');
    });

    test('debug of a workspace script keeps the cd ahead of the env assignment', () => {
        assert.equal(
            buildTerminalCommand(config('api > repro:stale-job:debug'), 'debug'),
            `cd api && ${debugEnvPrefix(DEBUG_PORT_BASE)} npm run repro:stale-job:debug`,
        );
    });

    test('a non-npm configuration is refused rather than guessed at', () => {
        // "Repro: Stale Job Cleanup" is a Node.js configuration: the IDE reports no
        // entry file for it, so there is nothing to rebuild a command line from.
        assert.throws(
            () => buildTerminalCommand(config('Repro: Stale Job Cleanup'), 'run'),
            (err) => {
                assert.ok(err instanceof UnsupportedLaunchError);
                assert.equal(err.name, 'UnsupportedLaunchError');
                assert.match(err.message, /cannot run "Repro: Stale Job Cleanup" in a terminal/);
                assert.match(err.message, /"Node.js"/);
                assert.match(err.message, /--target=terminal/);
                return true;
            },
        );
    });

    test('debug of a non-npm configuration explains debugging, not --target', () => {
        assert.throws(
            () => buildTerminalCommand(config('Repro: Stale Job Cleanup'), 'debug'),
            (err) => {
                assert.match(err.message, /cannot debug "Repro: Stale Job Cleanup"/);
                assert.match(err.message, /without :debug/);
                return true;
            },
        );
    });

    test('a configuration with no description at all is refused too', () => {
        assert.throws(
            () => buildTerminalCommand({ name: 'mystery' }, 'run'),
            /of an unknown type/,
        );
    });
});

describe('buildExecutionPlan — tool choice', () => {
    test('run-window is the default target', () => {
        assert.equal(DEFAULT_TARGET, 'run-window');
        assert.deepEqual([...EXEC_TARGETS], ['run-window', 'terminal']);
    });

    test('a run entry goes to execute_run_configuration by name', () => {
        const [call] = buildExecutionPlan({ plan: plan('web') });
        assert.equal(call.tool, RUN_CONFIGURATION_TOOL);
        assert.deepEqual(call.arguments, { configurationName: 'web', waitForExit: false });
        assert.equal(call.note, undefined);
    });

    test('the whole plan keeps its order and carries name and mode for reporting', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api', 'shared') });
        assert.deepEqual(calls.map((c) => [c.name, c.mode]), [
            ['web', 'run'],
            ['api', 'run'],
            ['shared', 'run'],
        ]);
    });

    test('projectPath is never added here — the client injects it into every call', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug'), target: 'terminal' });
        for (const call of calls) {
            assert.equal('projectPath' in call.arguments, false, `${call.tool} must not carry projectPath`);
        }
    });

    test('--target=terminal sends even a plain run through the Terminal window', () => {
        const [call] = buildExecutionPlan({ plan: plan('web'), target: 'terminal' });
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, 'npm run web');
        assert.equal(call.arguments.reuseExistingTerminalWindow, false, 'one new tab per configuration');
        assert.equal(call.arguments.executeInShell, true);
        assert.equal(call.note, undefined, 'an explicit target needs no explanation');
    });

    test('a debug entry is rerouted to the terminal even under the default target', () => {
        // execute_run_configuration has no debug parameter, so this is the only route.
        const [call] = buildExecutionPlan({ plan: plan('api:debug') });
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, `${debugEnvPrefix(DEBUG_PORT_BASE)} npm run api`);
        assert.equal(call.note, debugNote([DEBUG_PORT_BASE]), 'the reroute must be said out loud, not done silently');
    });

    test('with the IDE plugin\'s debug tool, a debug entry opens a real Debug tab instead', () => {
        const [call] = buildExecutionPlan({ plan: plan('api:debug'), debugTool: true });
        assert.equal(call.tool, DEBUG_CONFIGURATION_TOOL);
        assert.deepEqual(call.arguments, { configurationName: 'api' });
        // Nothing was rerouted and no inspector port is involved: the IDE attaches itself.
        assert.equal(call.note, undefined);
        assert.equal(call.debugPort, undefined);
    });

    test('the debug tool is for :debug only — a plain run still uses the Run window', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug', 'shared'), debugTool: true });
        assert.deepEqual(calls.map((c) => c.tool), [
            RUN_CONFIGURATION_TOOL,
            DEBUG_CONFIGURATION_TOOL,
            RUN_CONFIGURATION_TOOL,
        ]);
    });

    test('an explicit --target=terminal still wins over the debug tool', () => {
        // The user named the terminal, so a debug entry keeps its inspector and its port.
        const [call] = buildExecutionPlan({ plan: plan('api:debug'), target: 'terminal', debugTool: true });
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.debugPort, DEBUG_PORT_BASE);
    });

    test('ports are counted over the entries that use one, not over every :debug', () => {
        // Only the terminal entries occupy an inspector port; the ones the IDE debugs itself
        // must not burn numbers, or "attach to port 9230" would name a port nothing listens on.
        const calls = buildExecutionPlan({ plan: plan('api:debug', 'web'), target: 'terminal', debugTool: true });
        assert.deepEqual(debugPortsOf(calls), [DEBUG_PORT_BASE]);
    });

    test('a mixed plan splits per entry, not per run', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug', 'shared') });
        assert.deepEqual(calls.map((c) => c.tool), [
            RUN_CONFIGURATION_TOOL,
            TERMINAL_TOOL,
            RUN_CONFIGURATION_TOOL,
        ]);
    });

    test('the terminal call bounds how long the CLI waits for it', () => {
        // Bounded on both sides: the argument for IDE builds that honour it, and
        // call.timeoutMs for this one, which does not.
        const [call] = buildExecutionPlan({ plan: plan('web'), target: 'terminal' });
        assert.equal(typeof call.arguments.timeout, 'number');
        assert.equal(call.timeoutMs, call.arguments.timeout);
        assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 5000, 'must not serialise the run');
        assert.equal(typeof call.arguments.maxLinesCount, 'number');
    });

    test('a run-window launch is left unbounded — it returns as soon as the process starts', () => {
        const [call] = buildExecutionPlan({ plan: plan('web') });
        assert.equal(call.timeoutMs, undefined);
    });

    test('an empty plan produces no calls', () => {
        assert.deepEqual(buildExecutionPlan({ plan: [] }), []);
    });

    test('an unlaunchable entry throws before any call is built — building stays atomic', () => {
        const entries = plan('web', 'Repro: Stale Job Cleanup', 'api');
        assert.throws(
            () => buildExecutionPlan({ plan: entries, target: 'terminal' }),
            UnsupportedLaunchError,
        );
    });

    test('that same plan is fine under run-window — only the terminal path needs a command', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'Repro: Stale Job Cleanup') });
        assert.deepEqual(calls.map((c) => c.tool), [RUN_CONFIGURATION_TOOL, RUN_CONFIGURATION_TOOL]);
    });
});

describe('buildExecutionPlan — the :terminal mode', () => {
    test('a terminal entry goes through the Terminal window under the default target', () => {
        const [call] = buildExecutionPlan({ plan: plan('web:terminal') });
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, 'npm run web');
        assert.equal(call.arguments.reuseExistingTerminalWindow, false, 'one new tab per configuration');
        assert.equal(call.mode, 'terminal');
    });

    test('it needs no explanation and no inspector port: nothing was rerouted, nothing is debugged', () => {
        const [call] = buildExecutionPlan({ plan: plan('web:terminal') });
        assert.equal(call.note, undefined);
        assert.equal(call.debugPort, undefined);
        assert.doesNotMatch(String(call.arguments.command), /inspect/);
    });

    test('only that entry moves: its neighbours keep their own tools', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:terminal', 'shared') });
        assert.deepEqual(calls.map((call) => call.tool), [RUN_CONFIGURATION_TOOL, TERMINAL_TOOL, RUN_CONFIGURATION_TOOL]);
    });

    test('a terminal entry does not consume a debug port', () => {
        const calls = buildExecutionPlan({ plan: plan('web:debug', 'api:terminal', 'docs:debug') });
        assert.deepEqual(calls.map((call) => call.debugPort), [9229, undefined, 9230]);
    });

    test('the debug tool changes nothing for it — it is not a debug entry', () => {
        const calls = buildExecutionPlan({ plan: plan('web:terminal', 'api:debug'), debugTool: true });
        assert.deepEqual(calls.map((call) => call.tool), [TERMINAL_TOOL, DEBUG_CONFIGURATION_TOOL]);
    });

    test('a command line is needed for it, so the CLI knows to read .idea/', () => {
        assert.equal(needsTerminalCommands(plan('web:terminal'), 'run-window'), true);
        assert.equal(needsTerminalCommands(plan('web', 'api'), 'run-window'), false);
    });

    test('a non-npm configuration is refused before any call is issued, and the hint names :run', () => {
        assert.throws(
            () => buildExecutionPlan({ plan: plan('web', 'Repro: Stale Job Cleanup:terminal') }),
            (err) => {
                assert.ok(err instanceof UnsupportedLaunchError);
                assert.equal(err.mode, 'terminal');
                assert.match(err.message, /cannot run "Repro: Stale Job Cleanup" in a terminal/);
                assert.match(err.message, /:run/);
                assert.doesNotMatch(err.message, /Drop --target=terminal/);
                return true;
            },
        );
    });
});

describe('buildExecutionPlan — the name of a Terminal tab', () => {
    test('every terminal call carries the configuration name as its tab name', () => {
        const calls = buildExecutionPlan({ plan: plan('web:terminal', 'api:debug') });
        assert.deepEqual(calls.map((call) => call.tabName), ['web', 'api']);
    });

    test('so does a plain run under --target=terminal', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api'), target: 'terminal' });
        assert.deepEqual(calls.map((call) => call.tabName), ['web', 'api']);
    });

    test('a Run-window or Debug-tool call has no tab to name', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug'), debugTool: true });
        assert.deepEqual(calls.map((call) => call.tabName), [undefined, undefined]);
    });

    test('the name is the whole name, colons and spaces included', () => {
        const [call] = buildExecutionPlan({ plan: plan('client > bundle:build:terminal') });
        assert.equal(call.tabName, 'client > bundle:build');
    });
});

describe('debugEnvPrefix — finding #3, an inherited NODE_OPTIONS', { skip: skipWithoutPosixSh }, () => {
    /**
     * Run a built prefix through a real POSIX shell and read the result back.
     *
     * The command is only ever interpreted by a shell (the IDE runs it in the terminal's
     * own zsh — verified live), so asserting on the string alone would only pin the
     * spelling. This pins the behaviour.
     *
     * @param {string} prefix - from debugEnvPrefix()
     * @param {string} [inherited] - NODE_OPTIONS already exported, if any
     */
    const nodeOptionsUnderSh = (prefix, inherited) =>
        execFileSync('/bin/sh', ['-c', `${prefix} printenv NODE_OPTIONS`], {
            env: inherited === undefined ? { PATH: process.env.PATH } : { PATH: process.env.PATH, NODE_OPTIONS: inherited },
            encoding: 'utf8',
        }).trim();

    test('an existing NODE_OPTIONS is extended, not replaced', () => {
        assert.equal(
            nodeOptionsUnderSh(debugEnvPrefix(9229), '--enable-source-maps --max-old-space-size=512'),
            `--enable-source-maps --max-old-space-size=512 ${DEBUG_FLAG}=${DEBUG_HOST}:9229`,
        );
    });

    test('an unset NODE_OPTIONS yields the inspector flag alone, with no stray space', () => {
        assert.equal(nodeOptionsUnderSh(debugEnvPrefix(9229)), `${DEBUG_FLAG}=${DEBUG_HOST}:9229`);
    });

    test('an inherited value keeps its spaces — the expansion stays one word', () => {
        // Unquoted, `--title=my app` would arrive as two arguments and NODE_OPTIONS would
        // be truncated at the space.
        assert.equal(
            nodeOptionsUnderSh(debugEnvPrefix(9229), '--title=my app'),
            `--title=my app ${DEBUG_FLAG}=${DEBUG_HOST}:9229`,
        );
    });

    test('the whole command still runs as one line through the shell', () => {
        const command = `${debugEnvPrefix(9231)} printenv NODE_OPTIONS`;
        assert.equal(
            execFileSync('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).trim(),
            `${DEBUG_FLAG}=${DEBUG_HOST}:9231`,
        );
    });

    test('the inspector is bound to loopback, never to every interface', () => {
        assert.match(debugEnvPrefix(9229), /--inspect-brk=127\.0\.0\.1:9229/);
        assert.doesNotMatch(debugEnvPrefix(9229), /0\.0\.0\.0/);
    });
});

describe('buildExecutionPlan — finding #2, one inspector port per debug entry', () => {
    /** @param {import('../src/exec/planBuilder.js').McpCall[]} calls */
    const commands = (calls) => calls.map((call) => String(call.arguments.command ?? ''));

    test('two debug entries never share a port', () => {
        const calls = buildExecutionPlan({ plan: plan('web:debug', 'api:debug') });
        assert.deepEqual(debugPortsOf(calls), [DEBUG_PORT_BASE, DEBUG_PORT_BASE + 1]);
        assert.equal(new Set(debugPortsOf(calls)).size, 2, 'a shared port cannot bind twice');
        assert.match(commands(calls)[0], /:9229"/);
        assert.match(commands(calls)[1], /:9230"/);
    });

    test('run entries in between do not consume a port', () => {
        // Otherwise the numbers would depend on unrelated entries and stop being
        // predictable from the plan the CLI just printed.
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug', 'shared', 'docs:debug') });
        assert.deepEqual(debugPortsOf(calls), [DEBUG_PORT_BASE, DEBUG_PORT_BASE + 1]);
        assert.deepEqual(calls.map((call) => call.debugPort), [undefined, 9229, undefined, 9230]);
    });

    test('--target=terminal does not turn a run entry into a debug one', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api'), target: 'terminal' });
        assert.deepEqual(debugPortsOf(calls), []);
        for (const command of commands(calls)) assert.doesNotMatch(command, /inspect/);
    });

    test('debugPortBase moves the whole range', () => {
        const calls = buildExecutionPlan({ plan: plan('web:debug', 'api:debug'), debugPortBase: 9500 });
        assert.deepEqual(debugPortsOf(calls), [9500, 9501]);
        assert.match(commands(calls)[0], /--inspect-brk=127\.0\.0\.1:9500/);
    });

    test('the same plan always produces the same ports', () => {
        // Deterministic on purpose: the port printed for an entry is the port WebStorm
        // has to attach to, so it may not drift between two runs of the same command.
        const once = debugPortsOf(buildExecutionPlan({ plan: plan('api:debug', 'web:debug') }));
        const twice = debugPortsOf(buildExecutionPlan({ plan: plan('api:debug', 'web:debug') }));
        assert.deepEqual(once, twice);
    });

    test('the note explains the port range once, not per entry', () => {
        const calls = buildExecutionPlan({ plan: plan('web:debug', 'api:debug') });
        assert.deepEqual(executionNotes(calls), [debugNote([9229, 9230])]);
        assert.match(executionNotes(calls)[0], /ports 9229-9230, one per entry/);
    });

    test('the note names the ports the plan really assigned, not the built-in default', () => {
        // The note used to be a module-level constant built from DEBUG_PORT_BASE, so it
        // said "9229" while the commands next to it used 9400 — the flag's own warning
        // contradicting the flag.
        const calls = buildExecutionPlan({
            plan: plan('web:debug', 'api:debug', 'shared:debug'),
            debugPortBase: 9400,
        });
        const [note] = executionNotes(calls);

        assert.deepEqual(debugPortsOf(calls), [9400, 9401, 9402]);
        assert.match(note, /ports 9400-9402/);
        assert.doesNotMatch(note, /9229/, 'the default port may not appear in a moved range');
    });

    test('a single debug entry is told its one port, not a range of one', () => {
        const [note] = executionNotes(buildExecutionPlan({ plan: plan('api:debug'), debugPortBase: 9400 }));
        assert.match(note, /--inspect-brk=127\.0\.0\.1:9400/);
        assert.doesNotMatch(note, /9400-9400/);
        assert.doesNotMatch(note, /9229/);
    });
});

describe('executionNotes', () => {
    test('four debug entries are one reroute, not four warnings', () => {
        const calls = buildExecutionPlan({ plan: plan('web:debug', 'api:debug', 'shared:debug') });
        assert.equal(executionNotes(calls).length, 1);
        assert.deepEqual(executionNotes(calls), [debugNote(debugPortsOf(calls))]);
    });

    test('a plan with nothing to explain says nothing', () => {
        assert.deepEqual(executionNotes(buildExecutionPlan({ plan: plan('web') })), []);
    });
});

describe('formatExecutionPlan', () => {
    test('shows the tool and the payload that would be sent', () => {
        const text = formatExecutionPlan(buildExecutionPlan({ plan: plan('web', 'api:debug') }));
        assert.match(text, /execute_run_configuration\s+web/);
        assert.match(text, /execute_terminal_command\s+NODE_OPTIONS=/);
        assert.match(text, /--inspect-brk=127\.0\.0\.1:9229" npm run api/);
    });

    test('reports an empty plan in words rather than aligning nothing', () => {
        assert.equal(formatExecutionPlan([]), 'nothing to launch');
    });
});

describe('buildExecutionPlan — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const customPlan = (requests = []) => buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests });

    test('is one Terminal call: the commands joined with &&, in a tab named after the entry', () => {
        const [call] = buildExecutionPlan({ plan: customPlan() });

        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, 'npm i && npm run seed');
        assert.equal(call.arguments.reuseExistingTerminalWindow, false);
        assert.equal(call.tabName, 'seed db');
        assert.equal(call.mode, 'terminal');
        assert.equal(call.commandSource, 'custom');
    });

    test('is a Terminal call under either target, with no inspector port and no note', () => {
        for (const target of EXEC_TARGETS) {
            const [call] = buildExecutionPlan({ plan: customPlan(), target });
            assert.equal(call.tool, TERMINAL_TOOL);
            assert.equal(call.debugPort, undefined);
            assert.equal(call.note, undefined);
        }
    });

    test('never asks commandFor: there is no .idea/ definition to look up', () => {
        const commandFor = () => assert.fail('a custom entry has no run configuration');
        assert.doesNotThrow(() => buildExecutionPlan({ plan: customPlan(), commandFor }));
    });

    test('does not shift the inspector ports of the :debug entries around it', () => {
        const calls = buildExecutionPlan({ plan: customPlan([{ name: 'web', mode: 'debug' }]) });
        assert.deepEqual(calls.map((call) => call.debugPort), [undefined, DEBUG_PORT_BASE]);
    });

    test('is not reported as a guessed command line', () => {
        assert.deepEqual(guessedCommands(buildExecutionPlan({ plan: customPlan() })), []);
    });
});

describe('needsTerminalCommands — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i'] };

    test('a plan of only custom entries needs no .idea/ read, whatever the target', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed] });
        assert.equal(needsTerminalCommands(plan, 'run-window'), false);
        assert.equal(needsTerminalCommands(plan, 'terminal'), false);
    });

    test('a :terminal configuration next to one still does', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests: [{ name: 'web', mode: 'terminal' }] });
        assert.equal(needsTerminalCommands(plan, 'run-window'), true);
    });
});

describe('buildExecutionPlan — a real Terminal tab through the wsc IDE plugin', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a custom entry is opened by the plugin, which titles the tab itself', () => {
        const [call] = buildExecutionPlan({ plan: buildLaunchPlan({ configs: CONFIGS, preset: [seed] }), terminalTool: true });

        assert.equal(call.tool, TERMINAL_TAB_TOOL);
        assert.deepEqual(call.arguments, { tabName: 'seed db', command: 'npm i && npm run seed' });
        // The title travels as an argument, so no session has to be opened under the name, and
        // the call answers at once, so there is no client-side bound to apply either.
        assert.equal(call.tabName, undefined);
        assert.equal(call.timeoutMs, undefined);
        assert.equal(call.commandSource, 'custom');
    });

    test('every other terminal launch goes the same way: :terminal, --target=terminal and :debug', () => {
        const calls = buildExecutionPlan({ plan: plan('web:terminal', 'api:debug'), terminalTool: true });

        assert.deepEqual(calls.map((call) => call.tool), [TERMINAL_TAB_TOOL, TERMINAL_TAB_TOOL]);
        assert.deepEqual(calls.map((call) => call.arguments.tabName), ['web', 'api']);
        assert.equal(calls[0].arguments.command, 'npm run web');
        // The inspector port and the reroute note are about the command, not about the tab.
        assert.equal(calls[1].debugPort, DEBUG_PORT_BASE);
        assert.match(String(calls[1].arguments.command), new RegExp(`${DEBUG_FLAG}=${DEBUG_HOST}:${DEBUG_PORT_BASE}`));
        assert.equal(executionNotes(calls).length, 1);

        const [target] = buildExecutionPlan({ plan: plan('web'), target: 'terminal', terminalTool: true });
        assert.equal(target.tool, TERMINAL_TAB_TOOL);
    });

    test('a Run-window entry and a Debug-tool entry are untouched by it', () => {
        const calls = buildExecutionPlan({ plan: plan('web', 'api:debug'), terminalTool: true, debugTool: true });
        assert.deepEqual(calls.map((call) => call.tool), [RUN_CONFIGURATION_TOOL, DEBUG_CONFIGURATION_TOOL]);
    });

    test('without the plugin nothing changes: the IDE\'s own terminal tool, with a named session', () => {
        const [call] = buildExecutionPlan({ plan: buildLaunchPlan({ configs: CONFIGS, preset: [seed] }) });
        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.tabName, 'seed db');
    });

    test('--dry-run prints the command it will type into the tab', () => {
        const calls = buildExecutionPlan({ plan: buildLaunchPlan({ configs: CONFIGS, preset: [seed] }), terminalTool: true });
        assert.equal(formatExecutionPlan(calls), `→ ${TERMINAL_TAB_TOOL}  npm i && npm run seed`);
    });
});

describe('usesPipedTerminal', () => {
    test('true only for the IDE\'s own terminal tool, which has no real terminal behind it', () => {
        const piped = buildExecutionPlan({ plan: plan('web:terminal', 'shared') });
        const real = buildExecutionPlan({ plan: plan('web:terminal', 'shared'), terminalTool: true });

        assert.equal(usesPipedTerminal(piped), true);
        assert.equal(usesPipedTerminal(real), false);
        assert.equal(usesPipedTerminal(buildExecutionPlan({ plan: plan('shared') })), false);
    });

    test('the warning names what goes missing and where to get a real tab', () => {
        assert.match(PIPED_TERMINAL_NOTE, /not a real terminal/);
        assert.match(PIPED_TERMINAL_NOTE, /Ctrl-C/);
        assert.match(PIPED_TERMINAL_NOTE, /wsc IDE plugin/);
    });
});
