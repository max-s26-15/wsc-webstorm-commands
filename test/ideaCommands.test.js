/**
 * Phase 10 — the phase-6 caveat, closed.
 *
 * Until now the MCP path rebuilt a terminal command line from the *name* of a run
 * configuration, because `get_run_configurations` reports nothing else. Measured against
 * the demo-app `.idea/` the guess is wrong for 10 of the 13, so
 * `--target=terminal` and every `:debug` could open a tab that dies on "Missing script".
 * These tests pin the fix: MCP stays the catalogue, `.idea/` supplies the command.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { guessedCommandNote, ideaCommandResolver } from '../src/exec/ideaCommands.js';
import { buildExecutionPlan, guessedCommands, needsTerminalCommands } from '../src/exec/planBuilder.js';
import { NODE_TYPE, NPM_TYPE, readIdeaRunConfigs } from '../src/fallback/ideaRunConfigs.js';
import { buildLaunchPlan, normalizeRunConfigs } from '../src/resolve.js';
import { tmpIdeaProject } from '../test-utils/tmp-dir.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** What the live IDE reports over MCP — names and descriptions, nothing else. */
const CONFIGS = normalizeRunConfigs(require('./fixtures/run-configurations.json'));

/**
 * Read the demo-app `.idea/` fixtures into a throwaway project.
 *
 * @param {(ctx: { root: string, disk: import('../src/fallback/ideaRunConfigs.js').IdeaRunConfig[] }) => void | Promise<void>} body
 */
async function withIdea(body) {
    const project = await tmpIdeaProject();
    try {
        await body({ root: project.dir, disk: await readIdeaRunConfigs(project.dir) });
    } finally {
        await project.cleanup();
    }
}

/**
 * A launch plan built the way src/cli.js builds it: MCP names, resolved against MCP.
 *
 * @param {...string} tokens - `name` or `name:debug`
 */
function plan(...tokens) {
    return buildLaunchPlan({
        configs: CONFIGS,
        requests: tokens.map((token) => {
            const debug = token.endsWith(':debug');
            return { name: debug ? token.slice(0, -':debug'.length) : token, mode: debug ? 'debug' : 'run' };
        }),
    });
}

/** The command line each call would run, keyed by configuration name. */
const commands = (calls) => Object.fromEntries(calls.map((call) => [call.name, call.arguments.command]));

describe('ideaCommandResolver — the command comes from .idea/, not from the name', () => {
    test('the guess this replaces was wrong for 10 of demo-app\'s 13 configurations', async () => {
        // The finding itself, pinned as a test: if a future change makes the name-shaped
        // guess correct again, this is the number that should move.
        await withIdea(({ root, disk }) => {
            // The one Node.js configuration is left out because the guess could not express
            // it at all — it threw rather than being wrong, and the assertion below covers
            // that half.
            const npmNames = CONFIGS.filter((c) => c.description === 'npm').map((c) => c.name);
            const entries = plan(...npmNames);
            const guessed = commands(buildExecutionPlan({ plan: entries, target: 'terminal' }));
            const real = commands(buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, root),
            }));

            assert.equal(npmNames.length, 12);
            const agree = Object.keys(real).filter((name) => real[name] === guessed[name]);
            assert.deepEqual(agree, ['api > repro:stale-job:debug', 'mailer > debug:log']);
            assert.equal(Object.keys(real).length - agree.length, 10, '10 wrong commands, plus 1 refusal');
        });
    });

    test('web is `cd web && npm run dev`, not `npm run web`', async () => {
        // The caveat's own example: demo-app has no root `web` script at all, so the
        // guessed command opened a tab that died immediately.
        await withIdea(({ root, disk }) => {
            const [call] = buildExecutionPlan({
                plan: plan('web'),
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, root),
            });
            assert.match(String(call.arguments.command), /^cd web &&/);
            assert.match(String(call.arguments.command), /npm run dev$/);
            assert.equal(call.commandSource, 'idea');
        });
    });

    test('the workspace directory is the real one, not the one the name suggests', async () => {
        // `client > bundle:build` is named after `client`, but the package.json is in
        // gateway/addon/client — a directory the name does not mention.
        await withIdea(({ root, disk }) => {
            const [call] = buildExecutionPlan({
                plan: plan('client > bundle:build'),
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, root),
            });
            assert.equal(call.arguments.command, 'cd gateway/addon/client && npm run bundle:build');
        });
    });

    test(':debug keeps the inspector port the plan assigned it', async () => {
        await withIdea(({ root, disk }) => {
            const calls = buildExecutionPlan({
                plan: plan('web:debug', 'api:debug'),
                commandFor: ideaCommandResolver(disk, root),
            });
            assert.deepEqual(calls.map((call) => call.debugPort), [9229, 9230]);
            assert.match(String(calls[0].arguments.command), /--inspect-brk=127\.0\.0\.1:9229"/);
            assert.match(String(calls[1].arguments.command), /--inspect-brk=127\.0\.0\.1:9230"/);
        });
    });

    test('a Node.js configuration is launchable in a terminal now that the file is known', async () => {
        // The old guess refused every non-npm configuration, because MCP reports no entry
        // file. The XML has one, so this stops being a refusal.
        await withIdea(({ root, disk }) => {
            const [call] = buildExecutionPlan({
                plan: plan('Repro: Stale Job Cleanup'),
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, root),
            });
            assert.match(String(call.arguments.command), /node scripts\/reproduce-stale-job-cleanup\.js$/);
        });
    });

    test('the run-window path is untouched: no command is built at all', async () => {
        await withIdea(({ root, disk }) => {
            let asked = 0;
            const resolver = ideaCommandResolver(disk, root);
            const calls = buildExecutionPlan({
                plan: plan('web', 'api'),
                commandFor: (entry, opts) => (asked++, resolver(entry, opts)),
            });

            assert.equal(asked, 0, 'a run-window entry needs no command line');
            assert.deepEqual(calls.map((call) => call.tool), [
                'execute_run_configuration',
                'execute_run_configuration',
            ]);
            assert.deepEqual(calls.map((call) => call.arguments.configurationName), ['web', 'api']);
        });
    });
});

describe('ideaCommandResolver — a name .idea/ does not know', () => {
    test('falls back to the old name-shaped guess and marks it as one', () => {
        const [call] = buildExecutionPlan({
            plan: plan('web'),
            target: 'terminal',
            commandFor: ideaCommandResolver([], '/project'),
        });

        assert.equal(call.arguments.command, 'npm run web', 'phases 6-9 behaviour, unchanged');
        assert.equal(call.commandSource, 'name');
    });

    test('only the missing ones are marked, not the whole run', async () => {
        await withIdea(({ root, disk }) => {
            // A configuration the IDE reports but has not written out yet.
            const fresh = { name: 'brand-new', description: 'npm' };
            const entries = buildLaunchPlan({
                configs: [...CONFIGS, fresh],
                requests: [{ name: 'web', mode: 'run' }, { name: 'brand-new', mode: 'run' }],
            });
            const calls = buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, root),
            });

            assert.deepEqual(calls.map((call) => call.commandSource), ['idea', 'name']);
            assert.deepEqual(guessedCommands(calls), ['brand-new']);
        });
    });

    test('guessedCommands is empty when nothing consulted .idea/ at all', () => {
        // Without a resolver there was no lookup, so there is no outcome to report — a
        // plain 'name' default here would warn about a fallback that never happened.
        const calls = buildExecutionPlan({ plan: plan('web'), target: 'terminal' });
        assert.equal(calls[0].commandSource, undefined);
        assert.deepEqual(guessedCommands(calls), []);
    });

    test('a run configuration called `constructor` is looked up, not inherited', () => {
        // The house rule: a Map, because `{}["constructor"]` answers with a function.
        const config = { name: 'constructor', description: 'npm' };
        const entries = buildLaunchPlan({ configs: [config], requests: [{ name: 'constructor', mode: 'run' }] });
        const disk = [{ name: 'constructor', description: 'npm', type: NPM_TYPE, dir: '/p/sub', scripts: ['dev'] }];

        const [call] = buildExecutionPlan({
            plan: entries,
            target: 'terminal',
            commandFor: ideaCommandResolver(disk, '/p'),
        });
        assert.equal(call.arguments.command, 'cd sub && npm run dev');
        assert.equal(call.commandSource, 'idea');
    });

    test('a name .idea/ has never heard of does not resolve to Object.prototype', () => {
        // The half of the house rule the case above cannot reach: `constructor` is written
        // into the catalogue, so a plain object shadows the inherited one and looks correct.
        // A name that is *absent* is what tells the two apart — `{}["toString"]` answers
        // with a function rather than undefined, and the resolver would then hand
        // Object.prototype.toString to buildFallbackCommand instead of falling back.
        for (const name of ['toString', 'valueOf', 'hasOwnProperty']) {
            const config = { name, description: 'npm' };
            const entries = buildLaunchPlan({ configs: [config], requests: [{ name, mode: 'run' }] });
            const disk = [{ name: 'web', description: 'npm', type: NPM_TYPE, dir: '/p', scripts: ['dev'] }];

            const [call] = buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, '/p'),
            });
            assert.equal(call.arguments.command, `npm run ${name}`);
            assert.equal(call.commandSource, 'name');
        }
    });
});

describe('ideaCommandResolver — refusals name the flag, not the MCP Server', () => {
    test('a configuration .idea/ says cannot be rebuilt is refused, not guessed at', () => {
        // The whole point: the saved definition is the authority. Falling back to
        // `npm run <name>` here would reintroduce exactly the caveat being fixed.
        const config = { name: 'both', description: 'npm' };
        const entries = buildLaunchPlan({ configs: [config], requests: [{ name: 'both', mode: 'run' }] });
        const disk = [{ name: 'both', description: 'npm', type: NPM_TYPE, dir: '/p', scripts: ['build', 'dev'] }];

        assert.throws(
            () => buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, '/p'),
            }),
            (err) => err.name === 'FallbackError' && /runs 2 npm scripts/.test(err.message),
        );
    });

    test('the refusal points at --target, since the MCP Server is plainly running', () => {
        const config = { name: 'db', description: 'docker-deploy' };
        const entries = buildLaunchPlan({ configs: [config], requests: [{ name: 'db', mode: 'run' }] });
        const disk = [{ name: 'db', description: 'docker-deploy', type: 'docker-deploy' }];

        assert.throws(
            () => buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, '/p'),
            }),
            (err) => /Drop --target=terminal/.test(err.message)
                && !/Start the MCP Server/.test(err.message)
                // The leftover phrasing this replaced: "cannot launch ... without the IDE" while
                // the IDE is the one thing that is plainly still running here.
                && !/without the IDE/.test(err.message),
        );
    });

    test('a :debug refusal says how to get out of debug, not how to get out of --target', () => {
        const config = { name: 'db', description: 'docker-deploy' };
        const entries = buildLaunchPlan({ configs: [config], requests: [{ name: 'db', mode: 'debug' }] });
        const disk = [{ name: 'db', description: 'docker-deploy', type: 'docker-deploy' }];

        assert.throws(
            () => buildExecutionPlan({ plan: entries, commandFor: ideaCommandResolver(disk, '/p') }),
            (err) => /Run it without :debug/.test(err.message) && !/Start the MCP Server/.test(err.message),
        );
    });

    test('a hostile .idea env name is refused on the MCP path too', () => {
        // The house rule travels with the data: `.idea/runConfigurations/*.xml` is normally
        // checked in, and phase 10 put its contents on the IDE path as well. It is refused
        // by the same guard rather than a second copy of one — which is the whole reason
        // buildFallbackCommand() is reused instead of reimplemented here.
        const config = { name: 'evil', description: 'npm' };
        const entries = buildLaunchPlan({ configs: [config], requests: [{ name: 'evil', mode: 'run' }] });
        const disk = [{
            name: 'evil',
            description: 'npm',
            type: NPM_TYPE,
            dir: '/p',
            scripts: ['dev'],
            envs: { 'X; touch /tmp/pwned': '1' },
        }];

        assert.throws(
            () => buildExecutionPlan({
                plan: entries,
                target: 'terminal',
                commandFor: ideaCommandResolver(disk, '/p'),
            }),
            (err) => err.name === 'FallbackError' && /not a plain identifier/.test(err.message),
        );
    });

    test('the no-IDE path keeps its own advice — that is where starting the server is the answer', async () => {
        const { buildFallbackCommand } = await import('../src/fallback/ideaRunConfigs.js');
        const config = { name: 'broken', description: 'Node.js', type: NODE_TYPE, dir: '/p' };

        assert.throws(
            () => buildFallbackCommand(/** @type {any} */ (config), 'run', { projectRoot: '/p' }),
            /Start the MCP Server and re-run/,
        );
    });
});

describe('needsTerminalCommands', () => {
    test('a plain run-window plan needs none, so .idea/ is never read', () => {
        assert.equal(needsTerminalCommands(plan('web', 'api'), 'run-window'), false);
    });

    test('one :debug entry is enough, whatever the target', () => {
        assert.equal(needsTerminalCommands(plan('web', 'api:debug'), 'run-window'), true);
    });

    test('--target=terminal needs them for every entry', () => {
        assert.equal(needsTerminalCommands(plan('web'), 'terminal'), true);
    });

    test('with the IDE\'s debug tool a :debug entry needs none either', () => {
        assert.equal(needsTerminalCommands(plan('web', 'api:debug'), 'run-window', { debugTool: true }), false);
    });

    test('the debug tool does not change what --target=terminal needs', () => {
        assert.equal(needsTerminalCommands(plan('api:debug'), 'terminal', { debugTool: true }), true);
    });

    test('an empty plan needs nothing', () => {
        assert.equal(needsTerminalCommands([], 'terminal'), false);
    });
});

describe('guessedCommandNote', () => {
    test('names the configurations, so the warning is actionable', () => {
        const note = guessedCommandNote(['web', 'api']);
        assert.match(note, /web, api are not in/);
        assert.match(note, /Their command line was rebuilt from the configuration name/);
    });

    test('one configuration reads as one, not as a list of one', () => {
        const note = guessedCommandNote(['web']);
        assert.match(note, /^web is not in/);
        assert.match(note, /Its command line/);
    });

    test('it names where wsc looked, so "not saved yet" is checkable', () => {
        assert.match(guessedCommandNote(['web']), /\.idea\/workspace\.xml/);
    });
});
