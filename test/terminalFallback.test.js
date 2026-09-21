import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runTerminalFallback } from '../src/fallback/terminalFallback.js';
import { NPM_TYPE } from '../src/fallback/ideaRunConfigs.js';
import { createLogger } from '../src/log.js';
import { fakeStream } from '../test-utils/capture.js';

const ROOT = '/projects/demo-app';

/**
 * The catalogue the IDE would have saved to disk. Shaped exactly like what
 * readIdeaRunConfigs() returns, so nothing here depends on the XML parser.
 *
 * @param {string} name
 * @param {object} [extra]
 */
const npm = (name, extra = {}) => ({
    name,
    description: 'npm',
    type: NPM_TYPE,
    command: 'run',
    dir: `${ROOT}/${name.split(' > ')[0]}`,
    scripts: ['dev'],
    ...extra,
});

const CONFIGS = [
    npm('web'),
    npm('api'),
    npm('api > repro:stale-job:debug', { dir: `${ROOT}/api`, scripts: ['repro:stale-job:debug'] }),
    npm('addon-client'),
    npm('addon-server'),
];

/**
 * @param {object} [opts]
 * @param {string[]} [opts.positionals]
 * @param {{ name: string, mode: import('../src/modes.js').LaunchMode }[]} [opts.presetEntries]
 * @param {any[] | null} [opts.configs] - null means "the IDE saved nothing"
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.debugPortBase]
 * @param {boolean} [opts.terminal] - false: no emulator installed, so the pool is used
 */
const run = async (opts = {}) => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const opened = [];
    const pooled = [];

    const adapter = { id: 'gnome-terminal', opens: 'tab' };
    const code = await runTerminalFallback({
        presetName: 'default',
        presetEntries: opts.presetEntries ?? [],
        positionals: opts.positionals ?? [],
        projectRoot: ROOT,
        debugPortBase: opts.debugPortBase ?? 9229,
        dryRun: opts.dryRun,
        env: {},
        log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
        readConfigs: async () => opts.configs ?? CONFIGS,
        findTerminal: async () => (opts.terminal === false ? null : { adapter, bin: {} }),
        openTabs: async (tabs, tabOpts) => { opened.push({ tabs, opts: tabOpts }); },
        runPool: async (tabs) => { pooled.push(tabs); return 0; },
        findBusyPorts: async () => [],
    });

    return { code, opened, pooled, out: stdout.text(), err: stderr.text(), all: stdout.text() + stderr.text() };
};

describe('runTerminalFallback — what it can launch', () => {
    test('launches the preset in tabs, in the order it was configured', async () => {
        const { code, opened, out } = await run({
            presetEntries: [{ name: 'web', mode: 'run' }, { name: 'api', mode: 'run' }],
        });

        assert.equal(code, 0);
        assert.equal(opened.length, 1);
        assert.deepEqual(opened[0].tabs.map((tab) => tab.name), ['web', 'api']);
        assert.deepEqual(opened[0].tabs.map((tab) => tab.command), [
            'cd web && npm run dev',
            'cd api && npm run dev',
        ]);
        assert.equal(opened[0].opts.cwd, ROOT, 'every command is written relative to the project root');
        assert.match(out, /web/);
    });

    test('the command line adds to the preset, and overrides its mode', async () => {
        const { opened } = await run({
            presetEntries: [{ name: 'web', mode: 'run' }],
            positionals: ['web:debug', 'api'],
        });

        assert.deepEqual(opened[0].tabs.map((tab) => `${tab.name}:${tab.mode}`), ['web:debug', 'api:run']);
    });

    test('a name is resolved the way the IDE path resolves it — prefix included', async () => {
        const { opened } = await run({ positionals: ['we'] });
        assert.equal(opened[0].tabs[0].name, 'web');
    });

    test('a configuration whose name ends in :debug is not split', async () => {
        // The exact hazard the main path avoids with isKnownName. Here the list of real
        // names comes off disk, so the fallback can do the same — which is why src/cli.js
        // hands over the raw tokens instead of pre-split requests.
        const { opened } = await run({ positionals: ['api > repro:stale-job:debug'] });

        assert.equal(opened[0].tabs.length, 1);
        assert.equal(opened[0].tabs[0].name, 'api > repro:stale-job:debug');
        assert.equal(opened[0].tabs[0].mode, 'run');
        assert.equal(opened[0].tabs[0].command, 'cd api && npm run repro:stale-job:debug');
    });
});

describe('runTerminalFallback — refusing before anything starts', () => {
    test('a project the IDE never saved anything for is refused, naming where it looked', async () => {
        await assert.rejects(
            () => run({ configs: [], positionals: ['web'] }),
            (err) => err.name === 'FallbackError'
                && /saved no run configurations/.test(err.message)
                && /\.idea\/workspace\.xml/.test(err.message),
        );
    });

    test('an unknown name is refused, and says the list came off disk', async () => {
        // A weaker claim than the main path's "no such configuration": the IDE may well
        // know it and simply not have written it out yet. Saying so is the difference
        // between "you made a typo" and "wsc looked in the wrong place".
        await assert.rejects(
            () => run({ positionals: ['wbe'] }),
            (err) => err.name === 'FallbackError'
                && /unknown run configuration "wbe"/.test(err.message)
                && /Did you mean: web/.test(err.message)
                && /WebStorm saved/.test(err.message),
        );
    });

    test('an ambiguous prefix is refused rather than guessed at', async () => {
        await assert.rejects(
            () => run({ positionals: ['addon'] }),
            (err) => err.name === 'AmbiguousNameError' && /addon-client, addon-server/.test(err.message),
        );
    });

    test('an empty preset with nothing named is refused', async () => {
        await assert.rejects(() => run({}), (err) => err.name === 'FallbackError' && /nothing to launch/.test(err.message));
    });

    test('a configuration it cannot rebuild stops the whole run, before the first tab', async () => {
        // Atomic, like buildExecutionPlan(): an unlaunchable entry must not leave the two
        // before it already running.
        const configs = [npm('web'), { name: 'db', description: 'docker-deploy', type: 'docker-deploy' }];
        const { opened } = await run({ configs, positionals: ['web'] }).catch(() => ({ opened: [] }));
        assert.equal(opened.length, 1, 'the launchable one alone is fine');

        await assert.rejects(
            () => run({ configs, positionals: ['web', 'db'] }),
            (err) => err.name === 'FallbackError' && /cannot launch "db"/.test(err.message),
        );
    });

    test('a --debug-port with no room left is a usage error, not a broken launch', async () => {
        await assert.rejects(
            () => run({ positionals: ['web:debug', 'api:debug'], debugPortBase: 65535 }),
            (err) => err.name === 'UsageError' && /past the highest port there is/.test(err.message),
        );
    });
});

describe('runTerminalFallback — terminal entries', () => {
    test(':terminal is the same launch as :run here: every tab is already an OS terminal', async () => {
        const { opened } = await run({ positionals: ['web:terminal', 'api'] });

        assert.equal(opened[0].tabs[0].mode, 'terminal');
        assert.equal(opened[0].tabs[0].command, 'cd web && npm run dev');
        assert.equal(opened[0].tabs[0].debugPort, undefined);
        assert.doesNotMatch(opened[0].tabs[0].command, /inspect/);
    });

    test('a terminal entry between two debug ones does not consume a port', async () => {
        const { opened } = await run({ positionals: ['web:debug', 'api:terminal', 'addon-client:debug'] });
        assert.deepEqual(opened[0].tabs.map((tab) => tab.debugPort), [9229, undefined, 9230]);
    });

    test('it says nothing about debugging', async () => {
        const { err } = await run({ positionals: ['web:terminal'] });
        assert.doesNotMatch(err, /inspect-brk|Nothing attaches/);
    });
});

describe('runTerminalFallback — debug entries', () => {
    test('each debug entry gets its own inspector port, counting up in plan order', async () => {
        const { opened } = await run({ positionals: ['web:debug', 'api:debug'], debugPortBase: 9300 });

        assert.deepEqual(opened[0].tabs.map((tab) => tab.debugPort), [9300, 9301]);
        assert.match(opened[0].tabs[0].command, /--inspect-brk=127\.0\.0\.1:9300/);
        assert.match(opened[0].tabs[1].command, /--inspect-brk=127\.0\.0\.1:9301/);
    });

    test('a run entry between two debug ones does not consume a port', async () => {
        const { opened } = await run({ positionals: ['web:debug', 'api', 'addon-client:debug'] });
        assert.deepEqual(opened[0].tabs.map((tab) => tab.debugPort), [9229, undefined, 9230]);
    });

    test('says out loud that nothing will attach to the inspector by itself', async () => {
        // The IDE path's note explains a reroute; here nothing was rerouted, and the thing
        // the user has to know is the opposite one — the process is waiting for a debugger
        // that nobody is going to send.
        const { err } = await run({ positionals: ['web:debug'] });

        assert.match(err, /Nothing attaches automatically/);
        assert.match(err, /127\.0\.0\.1:9229/);
        assert.doesNotMatch(err, /execute_run_configuration/, 'that is the IDE path\'s reason, not this one');
    });

    test('a plain run says nothing about debugging', async () => {
        const { err } = await run({ positionals: ['web'] });
        assert.doesNotMatch(err, /inspect-brk/);
    });
});

describe('runTerminalFallback — --dry-run and the pool', () => {
    test('--dry-run prints the exact commands and starts nothing', async () => {
        // src/cli.js returns before executePlan() on a dry run, but this path never reaches
        // that guard: it is chosen while the CLI is still deciding how to reach the IDE.
        // Without the second half of the guard, `wsc --dry-run --fallback=terminal` would
        // open real windows.
        const { code, opened, pooled, out, err } = await run({ positionals: ['web:debug'], dryRun: true });

        assert.equal(code, 0);
        assert.deepEqual(opened, [], 'no tabs');
        assert.deepEqual(pooled, [], 'and no pool either');
        assert.match(out, /→ web\s+cd web && NODE_OPTIONS=.*npm run dev/);
        assert.match(err, /would launch 1 configuration\(s\) without the IDE/);
    });

    test('with no emulator anywhere, everything is merged — and the CLI says so first', async () => {
        const { code, opened, pooled, err } = await run({ positionals: ['web', 'api'], terminal: false });

        assert.equal(code, 0);
        assert.deepEqual(opened, []);
        assert.equal(pooled.length, 1);
        assert.deepEqual(pooled[0].map((tab) => tab.name), ['web', 'api']);
        assert.match(err, /no terminal emulator found/);
        assert.match(err, /Ctrl-C stops all of them/);
    });

    test('the pool\'s exit code is the run\'s exit code', async () => {
        const stdout = fakeStream();
        const stderr = fakeStream();
        const code = await runTerminalFallback({
            presetName: 'default',
            presetEntries: [],
            positionals: ['web'],
            projectRoot: ROOT,
            debugPortBase: 9229,
            env: {},
            log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
            readConfigs: async () => CONFIGS,
            findTerminal: async () => null,
            runPool: async () => 1,
            findBusyPorts: async () => [],
        });

        assert.equal(code, 1);
    });

    test('a busy inspector port is warned about on a dry run too', async () => {
        const stdout = fakeStream();
        const stderr = fakeStream();
        await runTerminalFallback({
            presetName: 'default',
            presetEntries: [],
            positionals: ['web:debug'],
            projectRoot: ROOT,
            debugPortBase: 9229,
            dryRun: true,
            env: {},
            log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
            readConfigs: async () => CONFIGS,
            findBusyPorts: async (ports) => ports,
        });

        assert.match(stderr.text(), /inspector port 9229 already in use/);
    });
});

describe('runTerminalFallback — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a custom entry becomes a tab titled after it, running the joined commands', async () => {
        const { code, opened } = await run({ presetEntries: [{ name: 'web', mode: 'run' }, seed] });

        assert.equal(code, 0);
        assert.deepEqual(opened[0].tabs.map((tab) => tab.name), ['web', 'seed db']);
        assert.equal(opened[0].tabs[1].command, 'npm i && npm run seed');
    });

    test('a preset of only custom commands needs no run configuration saved at all', async () => {
        const { code, opened } = await run({ configs: [], presetEntries: [seed] });

        assert.equal(code, 0);
        assert.deepEqual(opened[0].tabs, [{ name: 'seed db', mode: 'terminal', command: 'npm i && npm run seed' }]);
    });

    test('naming a run configuration still needs the catalogue, custom entries or not', async () => {
        await assert.rejects(
            () => run({ configs: [], presetEntries: [seed], positionals: ['web'] }),
            (err) => err.name === 'FallbackError' && /saved no run configurations/.test(err.message),
        );
    });

    test('a preset with a run configuration in it still needs the catalogue', async () => {
        await assert.rejects(
            () => run({ configs: [], presetEntries: [seed, { name: 'web', mode: 'run' }] }),
            (err) => err.name === 'FallbackError' && /saved no run configurations/.test(err.message),
        );
    });

    test('the commands are announced before the tabs open', async () => {
        const { err } = await run({ presetEntries: [seed] });
        assert.match(err, /custom commands from the preset:\n {2}seed db: npm i && npm run seed\n/);
    });

    test('--dry-run prints the command and opens nothing', async () => {
        const { code, opened, out } = await run({ presetEntries: [seed], dryRun: true });

        assert.equal(code, 0);
        assert.equal(opened.length, 0);
        assert.match(out, /^→ seed db {2}npm i && npm run seed$/m);
    });

    test('with no terminal emulator the single-window pool gets the same tab', async () => {
        const { pooled } = await run({ presetEntries: [seed], terminal: false });
        assert.equal(pooled[0][0].command, 'npm i && npm run seed');
    });
});
