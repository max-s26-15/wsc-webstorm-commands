import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OPTIONS } from '../src/args.js';
import { runCli } from '../src/cli.js';
import { DEBUG_PORT_BASE, debugEnvPrefix } from '../src/exec/planBuilder.js';
import { McpConnectError } from '../src/mcp/client.js';
import { captureOutput } from '../test-utils/capture.js';
import { occupyPort } from '../test-utils/fake-server.js';
import { FIXTURE, fakeCliDeps } from '../test-utils/fake-cli-deps.js';
import { tmpDir, tmpIdeaProject, tmpProject } from '../test-utils/tmp-dir.js';

const require = createRequire(import.meta.url);
/** @type {{ version: string }} */
const pkg = require('../package.json');

describe('runCli — flags', () => {
    test('--help exits 0 and prints usage', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['--help'], h.deps), 0);
        assert.match(h.stdout(), /Usage:/);
        assert.match(h.stdout(), /--preset/);
    });

    test('-h is an alias for --help', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['-h'], h.deps), 0);
        assert.match(h.stdout(), /Usage:/);
    });

    test('--version prints the package version', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['--version'], h.deps), 0);
        assert.equal(h.stdout().trim(), pkg.version);
    });

    test('-v is an alias for --version', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['-v'], h.deps), 0);
        assert.equal(h.stdout().trim(), pkg.version);
    });

    test('help wins over version when both are passed', async () => {
        const h = fakeCliDeps();
        await runCli(['--help', '--version'], h.deps);
        assert.match(h.stdout(), /Usage:/);
    });

    test('an unknown flag exits 2, names the flag and prints usage', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['--nope'], h.deps), 2);
        assert.match(h.output(), /--nope/);
        assert.match(h.output(), /Usage:/);
    });

    test('--help works outside a project — no IDE contact', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['--help'], h.deps), 0);
            assert.deepEqual(h.calls, [], 'the IDE must not be contacted for --help');
        } finally {
            await cleanup();
        }
    });
});

describe('runCli — real defaults', () => {
    test('falls back to the real process streams when no deps are injected', async () => {
        // Covers the default wiring that every other test bypasses.
        const { result, stdout } = await captureOutput(() => runCli(['--help']));
        assert.equal(result, 0);
        assert.match(stdout, /Usage:/);
    });

    test('--version through the real defaults', async () => {
        const { result, stdout } = await captureOutput(() => runCli(['--version']));
        assert.equal(result, 0);
        assert.equal(stdout.trim(), pkg.version);
    });
});

describe('runCli — project and preset', () => {
    test('exits 1 outside a WebStorm project', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /no WebStorm project found/);
        } finally {
            await cleanup();
        }
    });

    test('--project overrides the search', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: '/' });
            assert.equal(await runCli(['--project', dir, 'web'], h.deps), 0);
            assert.equal(h.calls[0].projectPath, await realpath(dir), 'projectPath goes to the IDE');
        } finally {
            await cleanup();
        }
    });

    test('--project through a symlink hands the IDE the real path', async () => {
        // The IDE knows a project by its real path (macOS: /var → /private/var).
        const { dir, cleanup } = await tmpProject();
        const { dir: links, cleanup: cleanupLinks } = await tmpDir();
        try {
            const link = path.join(links, 'linked-project');
            await symlink(dir, link, 'dir');
            const h = fakeCliDeps({ cwd: '/' });
            assert.equal(await runCli(['--project', link, 'web'], h.deps), 0);
            assert.equal(h.calls[0].projectPath, await realpath(dir));
        } finally {
            await cleanupLinks();
            await cleanup();
        }
    });

    test('--project accepts a relative path and passes an absolute one to the IDE', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: path.dirname(dir) });
            assert.equal(await runCli(['--project', path.basename(dir), 'web'], h.deps), 0);
            assert.equal(h.calls[0].projectPath, await realpath(dir));
        } finally {
            await cleanup();
        }
    });

    test('--project on a missing directory exits 1 instead of looking empty', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['--project', '/no/such/place', 'web'], h.deps), 1);
        assert.match(h.output(), /--project: no such directory: \/no\/such\/place/);
        assert.deepEqual(h.calls, [], 'the IDE must not be contacted for an invalid project');
    });

    test('--project on a file rather than a directory exits 1', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const file = path.join(dir, 'not-a-dir');
            await writeFile(file, '');
            const h = fakeCliDeps();
            assert.equal(await runCli(['--project', file, 'web'], h.deps), 1);
            assert.match(h.output(), /--project: not a directory/);
        } finally {
            await cleanup();
        }
    });

    test('--project on a directory without .idea/ exits 1', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const h = fakeCliDeps();
            assert.equal(await runCli(['--project', dir, 'web'], h.deps), 1);
            assert.match(h.output(), /not a WebStorm project \(no \.idea\/ in/);
        } finally {
            await cleanup();
        }
    });

    test('launches the default preset when no names are given', async () => {
        const config = JSON.stringify({ presets: { default: [{ name: 'api', mode: 'debug' }] } });
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli([], h.deps), 0);
            assert.match(h.output(), /api +debug +\(preset\)/);
        } finally {
            await cleanup();
        }
    });

    test('--preset selects another preset', async () => {
        const config = JSON.stringify({
            presets: { default: [{ name: 'api' }], backend: [{ name: 'mailer', mode: 'debug' }] },
        });
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['--preset', 'backend'], h.deps), 0);
            assert.match(h.output(), /mailer +debug/);
            assert.doesNotMatch(h.output(), /api/);
        } finally {
            await cleanup();
        }
    });

    test('an unknown preset exits 1 and lists the known ones', async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify({ presets: { backend: [] } }));
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['--preset', 'ghost'], h.deps), 1);
            assert.match(h.output(), /unknown preset "ghost".*backend/s);
        } finally {
            await cleanup();
        }
    });

    test('a defaultPreset naming no preset exits 1 and says so — not "empty"', async () => {
        const config = JSON.stringify({ defaultPreset: 'typo', presets: { backend: [{ name: 'api' }] } });
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli([], h.deps), 1);
            assert.match(h.output(), /defaultPreset "typo" does not exist/);
            assert.match(h.output(), /known presets: backend/);
            assert.doesNotMatch(h.output(), /is empty/, 'a missing preset is not an empty one');
        } finally {
            await cleanup();
        }
    });

    test('a broken defaultPreset only warns when the user named configurations', async () => {
        const config = JSON.stringify({ defaultPreset: 'typo', presets: { backend: [{ name: 'api' }] } });
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['web'], h.deps), 0, 'an explicit request still runs');
            assert.match(h.output(), /defaultPreset "typo" does not exist/);
            assert.match(h.output(), /web +run/);
        } finally {
            await cleanup();
        }
    });

    test('an unconfigured project keeps the friendly first-run message', async () => {
        // No presets at all is "not set up yet", not "misconfigured".
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli([], h.deps), 1);
            assert.match(h.output(), /nothing to launch/);
            assert.doesNotMatch(h.output(), /does not exist/);
        } finally {
            await cleanup();
        }
    });

    for (const name of ['constructor', 'toString', '__proto__']) {
        test(`--preset ${name} is a clean error, not a crash`, async () => {
            const { dir, cleanup } = await tmpProject(JSON.stringify({ presets: { backend: [] } }));
            try {
                const h = fakeCliDeps({ cwd: dir });
                assert.equal(await runCli(['--preset', name], h.deps), 1);
                assert.match(h.output(), new RegExp(`unknown preset "${name.replace('__', '__')}"`));
                assert.doesNotMatch(h.output(), /is not iterable/);
            } finally {
                await cleanup();
            }
        });
    }

    test('a preset genuinely named "constructor" can be launched', async () => {
        const config = JSON.stringify({
            defaultPreset: 'constructor',
            presets: { constructor: [{ name: 'api', mode: 'debug' }] },
        });
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli([], h.deps), 0);
            assert.match(h.output(), /api +debug +\(preset\)/);
        } finally {
            await cleanup();
        }
    });

    test('a corrupt config exits 1 and names the file', async () => {
        const { dir, cleanup } = await tmpProject('{broken');
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /webstorm-commands\.json.*invalid JSON/);
        } finally {
            await cleanup();
        }
    });

    test('an empty plan exits 1 rather than silently doing nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli([], h.deps), 1);
            assert.match(h.output(), /nothing to launch/);
        } finally {
            await cleanup();
        }
    });
});

describe('runCli — resolution', () => {
    /** @param {string[]} argv @param {string} [config] */
    const inProject = async (argv, config) => {
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            const code = await runCli(argv, h.deps);
            return { code, output: h.output(), calls: h.calls, closed: h.closed };
        } finally {
            await cleanup();
        }
    };

    test('resolves the phase-3 acceptance example', async () => {
        const { code, output } = await inProject(['web:debug', 'client > bundle:build']);
        assert.equal(code, 0);
        assert.match(output, /web +debug +\(cli\)/);
        assert.match(output, /client > bundle:build +run +\(cli\)/);
    });

    test('a name ending in :debug is kept whole', async () => {
        const { code, output } = await inProject(['api > repro:stale-job:debug']);
        assert.equal(code, 0);
        assert.match(output, /api > repro:stale-job:debug +run/);
    });

    test('a prefix resolves to the full name', async () => {
        const { output } = await inProject(['doc']);
        assert.match(output, /docs +run/);
    });

    test('an unknown name exits 1 with a suggestion', async () => {
        const { code, output } = await inProject(['wbe']);
        assert.equal(code, 1);
        assert.match(output, /unknown run configuration "wbe"/);
        assert.match(output, /Did you mean: web/);
    });

    test('an ambiguous prefix exits 1 and lists the candidates', async () => {
        const { code, output } = await inProject(['addon']);
        assert.equal(code, 1);
        assert.match(output, /addon-client.*addon-server/);
    });

    test('the command line overrides the preset mode', async () => {
        const config = JSON.stringify({ presets: { default: [{ name: 'web', mode: 'run' }] } });
        const { output } = await inProject(['web:debug'], config);
        assert.match(output, /web +debug +\(cli\)/);
        // Counted over the plan's own lines rather than the whole output: an override must
        // not duplicate the preset entry, but other lines (a warning naming the
        // configuration, for instance) legitimately mention it too.
        const planLines = output.match(/^web +(?:run|debug) +\((?:preset|cli)\)$/gm) ?? [];
        assert.equal(planLines.length, 1, 'the configuration must appear in the plan once');
    });

    test('nothing is launched yet — this phase only prints the plan', async () => {
        const { calls } = await inProject(['web']);
        const toolCalls = calls.filter((c) => c.type === 'call').map((c) => c.name);
        assert.deepEqual(toolCalls, ['get_run_configurations'], 'no execute_* call may happen in phase 3');
    });

    test('the MCP session is closed even when resolution fails', async () => {
        const { code, closed } = await inProject(['wbe']);
        assert.equal(code, 1);
        assert.equal(closed, true, 'a failed run must not leak the connection');
    });
});

describe('runCli — the --dry-run execution seam', () => {
    /**
     * These two tests are the guard rail for phase 6: when executePlan() starts really
     * launching things, removing or moving the --dry-run check makes them fail.
     *
     * @param {string[]} argv
     */
    const inProject = async (argv) => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            const code = await runCli(argv, h.deps);
            return { code, output: h.output(), executed: h.executed };
        } finally {
            await cleanup();
        }
    };

    test('--dry-run never reaches the execution seam', async () => {
        const { code, output, executed } = await inProject(['--dry-run', 'web:debug']);
        assert.equal(code, 0);
        assert.deepEqual(executed, [], '--dry-run must not call executePlan');
        assert.match(output, /would launch/);
        assert.match(output, /web +debug/);
    });

    test('without --dry-run the plan does reach the execution seam', async () => {
        const { code, output, executed } = await inProject(['web:debug']);
        assert.equal(code, 0);
        assert.equal(executed.length, 1, 'executePlan must receive the plan');
        assert.deepEqual(executed[0].map((e) => [e.name, e.mode]), [['web', 'debug']]);
        assert.match(output, /launching/);
    });

    test('the real seam launches through execute_run_configuration', async () => {
        // The path a user actually hits: no executePlan injected.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            delete h.deps.executePlan;
            assert.equal(await runCli(['web', 'api'], h.deps), 0);

            const launches = h.calls.filter((c) => c.type === 'call' && c.name === 'execute_run_configuration');
            assert.deepEqual(launches.map((c) => c.args.configurationName), ['web', 'api']);
            assert.equal(launches.every((c) => c.args.waitForExit === false), true, 'a launch must never wait');
            assert.match(h.output(), /started 2 configuration\(s\)/);
        } finally {
            await cleanup();
        }
    });

    test('--dry-run still fails on an unknown name — resolution happens first', async () => {
        const { code, output, executed } = await inProject(['--dry-run', 'wbe']);
        assert.equal(code, 1);
        assert.deepEqual(executed, []);
        assert.match(output, /Did you mean: web/);
    });

    test('every declared flag is consulted by the CLI', async () => {
        // Catches the general "flag is parsed but silently ignored" class of bug.
        const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
        for (const flag of Object.keys(OPTIONS)) {
            assert.match(source, new RegExp(`values(\\.|\\['|\\[")${flag}`), `--${flag} is never read`);
        }
    });
});

describe('runCli — --configure', () => {
    /** @param {string[]} argv @param {string} [config] */
    const inProject = async (argv, config) => {
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ cwd: dir });
            const code = await runCli(argv, h.deps);
            return { code, dir, output: h.output(), configured: h.configured, executed: h.executed };
        } finally {
            await cleanup();
        }
    };

    test('-c opens the configure screen with the IDE list and the current preset', async () => {
        const config = JSON.stringify({ presets: { default: [{ name: 'api', mode: 'debug' }] } });
        const { code, configured, executed } = await inProject(['-c'], config);

        assert.equal(code, 0);
        assert.equal(configured.length, 1);
        assert.equal(configured[0].configs.length, 13);
        assert.equal(configured[0].presetName, 'default');
        assert.deepEqual(configured[0].config.presets.default, [{ name: 'api', mode: 'debug' }]);
        assert.deepEqual(executed, [], 'configuring must never launch anything');
    });

    test('--configure is the long form of -c', async () => {
        const { code, configured } = await inProject(['--configure']);
        assert.equal(code, 0);
        assert.equal(configured.length, 1);
    });

    test('--preset chooses which preset is edited', async () => {
        const config = JSON.stringify({ presets: { backend: [{ name: 'api' }] } });
        const { configured } = await inProject(['-c', '--preset', 'backend'], config);
        assert.equal(configured[0].presetName, 'backend');
    });

    test('-c can create a preset that does not exist yet', async () => {
        // Without --configure this is a fatal "unknown preset"; here it is the point.
        const config = JSON.stringify({ presets: { backend: [] } });
        const { code, configured, output } = await inProject(['-c', '--preset', 'frontend'], config);

        assert.equal(code, 0);
        assert.equal(configured[0].presetName, 'frontend');
        assert.doesNotMatch(output, /unknown preset/);
    });

    test('-c works when the defaultPreset is broken — that is what it fixes', async () => {
        const config = JSON.stringify({ defaultPreset: 'typo', presets: { backend: [{ name: 'api' }] } });
        const { code, configured, output } = await inProject(['-c'], config);

        assert.equal(code, 0);
        assert.equal(configured[0].presetName, 'typo');
        assert.doesNotMatch(output, /does not exist/);
    });

    test('-c on an unconfigured project does not hit the "nothing to launch" path', async () => {
        const { code, configured, output } = await inProject(['-c']);
        assert.equal(code, 0);
        assert.equal(configured.length, 1);
        assert.doesNotMatch(output, /nothing to launch/);
    });

    test('-c opens even when the preset names a configuration the IDE dropped', async () => {
        // Launching would fail on the stale entry, and --configure is how you remove it,
        // so the screen must open before the plan is ever built.
        const config = JSON.stringify({ presets: { default: [{ name: 'deleted-in-the-ide', mode: 'run' }] } });
        const { code, configured, output } = await inProject(['-c'], config);

        assert.equal(code, 0);
        assert.equal(configured.length, 1);
        assert.doesNotMatch(output, /unknown run configuration/);
    });

    test('without -c the same stale preset is a hard failure', async () => {
        const config = JSON.stringify({ presets: { default: [{ name: 'deleted-in-the-ide', mode: 'run' }] } });
        const { code, output } = await inProject([], config);

        assert.equal(code, 1);
        assert.match(output, /unknown run configuration "deleted-in-the-ide".*from the preset/s);
    });

    test('-c --preset toString opens a new preset instead of crashing', async () => {
        const { code, configured } = await inProject(['-c', '--preset', 'toString']);
        assert.equal(code, 0);
        assert.equal(configured[0].presetName, 'toString');
    });

    test('-c rejects positionals rather than silently ignoring them', async () => {
        const { code, configured, output } = await inProject(['-c', 'web']);
        assert.equal(code, 2);
        assert.match(output, /--configure takes no configuration names/);
        assert.deepEqual(configured, []);
    });

    test('the MCP session stays open while the configure screen is up', async () => {
        // The twin of "the MCP session stays open until the launch has finished": a bare
        // `return runConfigure(...)` inside run()'s try/finally runs the finally first, so
        // close() tore the transport down as the first prompt was drawn. Nothing in the
        // screen needs the IDE *today*, which is exactly why this went unnoticed.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            let openWhileConfiguring = null;
            h.deps.runConfigure = async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                openWhileConfiguring = h.closed;
                return 0;
            };

            assert.equal(await runCli(['-c'], h.deps), 0);
            assert.equal(openWhileConfiguring, false, 'the session must outlive the screen');
            assert.equal(h.closed, true, 'and still be closed afterwards');
        } finally {
            await cleanup();
        }
    });

    test('the exit code of the configure screen is passed through', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            h.deps.runConfigure = async () => 130;
            assert.equal(await runCli(['-c'], h.deps), 130);
        } finally {
            await cleanup();
        }
    });
});

describe('runCli — MCP failures', () => {
    test('exits 1 with instructions when the MCP Server is unreachable', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, port: null });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /cannot reach WebStorm's MCP Server/);
            assert.match(h.output(), /Settings → Tools → MCP Server/);
        } finally {
            await cleanup();
        }
    });

    test('an invalid --mcp-port is a usage error, not a stack trace', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            delete h.deps.discoverPort; // exercise the real discoverPort validation
            assert.equal(await runCli(['--mcp-port', 'abc', 'web'], h.deps), 2);
            assert.match(h.output(), /--mcp-port: "abc" is not a valid port/);
            assert.doesNotMatch(h.output(), /at discoverPort/);
        } finally {
            await cleanup();
        }
    });

    test('an invalid WSC_MCP_PORT is reported the same way', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            delete h.deps.discoverPort;
            h.deps.env = { NO_COLOR: '1', WSC_MCP_PORT: 'nope' };
            assert.equal(await runCli(['web'], h.deps), 2);
            assert.match(h.output(), /WSC_MCP_PORT: "nope" is not a valid port/);
        } finally {
            await cleanup();
        }
    });

    test('a tool error is reported as a message, not a crash', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({
                cwd: dir,
                callTool: () => {
                    const err = new Error('MCP tool "get_run_configurations" failed: nope');
                    err.name = 'McpToolError';
                    throw err;
                },
            });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /failed: nope/);
        } finally {
            await cleanup();
        }
    });

    test('an SDK protocol error is reported as a message too', async () => {
        // Reading the configuration list can drop the connection or run out of time just
        // like a launch can, and that path never reaches executePlan's translation — so
        // KNOWN_ERRORS has to carry McpError in its own right.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({
                cwd: dir,
                callTool: () => {
                    throw Object.assign(new Error('MCP error -32001: Request timed out'), {
                        name: 'McpError',
                        code: -32001,
                    });
                },
            });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /Request timed out/);
            assert.doesNotMatch(h.output(), /node_modules/);
        } finally {
            await cleanup();
        }
    });

    test('an unexpected error keeps its stack instead of being swallowed', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, callTool: () => { throw new Error('boom'); } });
            await assert.rejects(() => runCli(['web'], h.deps), /boom/);
        } finally {
            await cleanup();
        }
    });

    test('a handshake that fails after the probe succeeded is a message, not a stack trace', async () => {
        // Phase 10 finding. discoverPort() probes /sse and connectMcp() then opens the
        // session over a second request; the IDE can quit in between, and a range scan can
        // hand back a port that belongs to something else. The SDK's StreamableHTTPError is
        // named "Error", so this used to leave KNOWN_ERRORS and print a V8 stack trace.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            h.deps.connectMcp = async () => {
                throw new McpConnectError(new URL('http://127.0.0.1:64542/stream'), new Error('socket hang up'));
            };
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /could not open an MCP session on 127\.0\.0\.1:64542/);
            assert.match(h.output(), /socket hang up/);
            assert.doesNotMatch(h.output(), /node_modules/);
        } finally {
            await cleanup();
        }
    });

    test('a get_run_configurations payload wsc cannot read is a message, not a stack trace', async () => {
        // The plan's own top risk: the IDE's tool signatures changing between WebStorm
        // versions. normalizeRunConfigs threw a bare TypeError, which reads as a bug in wsc
        // and was rethrown out of runCli().
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, configurations: 'Everything is fine.' });
            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /does not understand/);
            assert.match(h.output(), /wsc-mcp-probe/);
            assert.doesNotMatch(h.output(), /at normalizeRunConfigs/);
        } finally {
            await cleanup();
        }
    });

    test('--list reports an unreadable payload the same way', async () => {
        // Same call, a different caller: --list has its own normalizeRunConfigs.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, configurations: { configurations: [{ description: 'npm' }] } });
            assert.equal(await runCli(['--list'], h.deps), 1);
            assert.match(h.output(), /run configuration 0 has no name/);
            assert.equal(h.stdout(), '', 'nothing may reach a pipe when the payload was not understood');
        } finally {
            await cleanup();
        }
    });

    test('a failing close() does not replace the run\'s own outcome', async () => {
        // The SDK rejects every in-flight request when the transport drops and then throws
        // the same error again from close(), so without the catch in withMcpSession a
        // launch that died mid-call would be reported as a bare "Connection closed" from
        // the finally block, with the real cause lost.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({
                cwd: dir,
                callTool: () => {
                    const err = new Error('MCP tool "get_run_configurations" failed: the real cause');
                    err.name = 'McpToolError';
                    throw err;
                },
            });
            const inner = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => {
                const client = await inner(...args);
                return { ...client, close: async () => { throw new Error('Connection closed'); } };
            };

            assert.equal(await runCli(['web'], h.deps), 1);
            assert.match(h.output(), /the real cause/);
            assert.doesNotMatch(h.output(), /Connection closed/);
        } finally {
            await cleanup();
        }
    });

    test('a successful run survives a failing close() too', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            const inner = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => {
                const client = await inner(...args);
                return { ...client, close: async () => { throw new Error('Connection closed'); } };
            };

            assert.equal(await runCli(['web'], h.deps), 0, 'the launch succeeded; closing is bookkeeping');
        } finally {
            await cleanup();
        }
    });
});

describe('runCli — --target and launching', () => {
    /**
     * @param {string[]} argv
     * @param {object} [opts] - passed straight to fakeCliDeps (callTool, configurations…)
     */
    const inProject = async (argv, opts = {}) => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, ...opts });
            delete h.deps.executePlan; // exercise the real seam
            const code = await runCli(argv, h.deps);
            const launches = h.calls.filter((c) => c.type === 'call' && c.name.startsWith('execute_'));
            return { code, output: h.output(), launches };
        } finally {
            await cleanup();
        }
    };

    /** Same, but the caller decides when to clean up (so it can assert on the output). */
    const inProjectRaw = async (argv, opts = {}) => {
        const { dir, cleanup } = await tmpProject();
        const h = fakeCliDeps({ cwd: dir, ...opts });
        delete h.deps.executePlan;
        const code = await runCli(argv, h.deps);
        return { dir: { code, output: h.output() }, cleanup };
    };

    test('--target=terminal launches through the Terminal window instead', async () => {
        const { code, launches } = await inProject(['--target=terminal', 'web']);
        assert.equal(code, 0);
        assert.deepEqual(launches.map((c) => c.name), ['execute_terminal_command']);
        assert.equal(launches[0].args.command, 'npm run web');
        assert.equal(launches[0].args.reuseExistingTerminalWindow, false);
    });

    test('an unknown --target is a usage error, before the IDE is contacted', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['--target=tmux', 'web'], h.deps), 2);
            assert.match(h.output(), /--target: expected one of run-window, terminal/);
            assert.deepEqual(h.calls, [], 'a bad flag must not open an MCP connection');
        } finally {
            await cleanup();
        }
    });

    test(':debug is rerouted to a terminal with --inspect-brk, and says so', async () => {
        const { code, output, launches } = await inProject(['api:debug']);
        assert.equal(code, 0);
        assert.deepEqual(launches.map((c) => c.name), ['execute_terminal_command']);
        assert.equal(launches[0].args.command, `${debugEnvPrefix(DEBUG_PORT_BASE)} npm run api`);
        assert.match(output, /debug mode goes through the IDE's Terminal window/);
    });

    test('a plan mixing run and debug uses a different tool for each', async () => {
        const { launches } = await inProject(['web', 'api:debug']);
        assert.deepEqual(launches.map((c) => c.name), [
            'execute_run_configuration',
            'execute_terminal_command',
        ]);
    });

    test('debugging a configuration the CLI cannot rebuild is refused, not run instead', async () => {
        // Silently launching a Node.js configuration in plain run mode after the user
        // asked for :debug would be the worst possible outcome.
        const { code, output, launches } = await inProject(['Repro: Stale Job Cleanup:debug']);
        assert.equal(code, 1);
        assert.deepEqual(launches, [], 'nothing may start when the plan cannot be built');
        assert.match(output, /cannot debug "Repro: Stale Job Cleanup"/);
    });

    test('an unlaunchable entry stops the whole run before the first tab opens', async () => {
        const { code, launches } = await inProject([
            '--target=terminal',
            'web',
            'Repro: Stale Job Cleanup',
        ]);
        assert.equal(code, 1);
        assert.deepEqual(launches, [], 'building the execution plan stays atomic');
    });

    test('--dry-run shows the exact calls, and still starts nothing', async () => {
        const { code, output, launches } = await inProject(['--dry-run', '--target=terminal', 'api:debug']);
        assert.equal(code, 0);
        assert.deepEqual(launches, []);
        assert.match(output, /would launch 1 configuration\(s\) via terminal/);
        assert.match(output, /execute_terminal_command\s+NODE_OPTIONS=/);
        assert.match(output, /--inspect-brk=127\.0\.0\.1:9229" npm run api/);
    });

    test('the MCP session stays open until the launch has finished', async () => {
        // A bare `return executePlan(...)` inside try/finally runs the finally *before*
        // the returned promise settles: close() then tears the transport down mid-launch
        // and every execute_* call comes back "Connection closed" against a real IDE.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            let openWhileLaunching = null;
            h.deps.executePlan = async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                openWhileLaunching = h.closed;
                return 0;
            };

            assert.equal(await runCli(['web'], h.deps), 0);
            assert.equal(openWhileLaunching, false, 'the session must outlive the launch');
            assert.equal(h.closed, true, 'and still be closed afterwards');
        } finally {
            await cleanup();
        }
    });

    test('a session that fails to close does not overwrite the run\'s own outcome', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            const connect = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => {
                const client = await connect(...args);
                return { ...client, close: async () => { throw new Error('Connection closed'); } };
            };

            assert.equal(await runCli(['web'], h.deps), 0);
        } finally {
            await cleanup();
        }
    });

    test('--dry-run reports an unlaunchable entry too — validation is not deferred', async () => {
        // The execution plan is built ahead of the guard, so a dry run is a real check
        // and not just a pretty-printer for the launch plan.
        const { code, output } = await inProject([
            '--dry-run',
            '--target=terminal',
            'Repro: Stale Job Cleanup',
        ]);
        assert.equal(code, 1);
        assert.match(output, /cannot run "Repro: Stale Job Cleanup" in a terminal/);
    });

    test('a transport failure mid-launch is a message, not a stack trace', async () => {
        // Reproduced live: execute_* against a dropped session rejects with the SDK's own
        // McpError, which is not a WscError and was not in KNOWN_ERRORS, so runCli rethrew
        // it and the user got a V8 stack trace through node_modules.
        const { dir, cleanup } = await inProjectRaw(['web'], {
            callTool: (name) => {
                if (name === 'get_run_configurations') return FIXTURE;
                throw Object.assign(new Error('MCP error -32000: Connection closed'), {
                    name: 'McpError',
                    code: -32000,
                });
            },
        });
        assert.equal(dir.code, 1, 'a dead connection is a runtime error, not a crash');
        assert.doesNotMatch(dir.output, /node_modules/, 'no stack trace may reach the user');
        assert.match(dir.output, /the IDE stopped answering mid-launch/);
        assert.match(dir.output, /Connection closed/);
        await cleanup();
    });

    test('a genuine bug during a launch still keeps its stack', async () => {
        // Only McpError is translated; anything else is a defect and must not be dressed up.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({
                cwd: dir,
                callTool: (name) => {
                    if (name === 'get_run_configurations') return FIXTURE;
                    throw new TypeError('boom');
                },
            });
            delete h.deps.executePlan;
            await assert.rejects(() => runCli(['web'], h.deps), /boom/);
        } finally {
            await cleanup();
        }
    });

    test('one rejected launch fails the run but never cancels the others', async () => {
        const { code, output, launches } = await inProject(['web', 'api', 'shared'], {
            callTool: (name, args) => {
                if (name === 'get_run_configurations') return FIXTURE;
                if (args.configurationName === 'api') {
                    const err = new Error('MCP tool "execute_run_configuration" failed: nope');
                    err.name = 'McpToolError';
                    err.detail = 'nope';
                    throw err;
                }
                return 'ok';
            },
        });

        assert.equal(code, 1);
        assert.equal(launches.length, 3, 'web and shared must still be attempted');
        assert.match(output, /api: nope/);
        assert.match(output, /started 2 of 3 configuration\(s\) — failed: api/);
    });
});

describe('runCli — inspector ports', () => {
    /**
     * @param {string[]} argv
     * @param {object} [opts] - passed straight to fakeCliDeps
     */
    const inProject = async (argv, opts = {}) => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, ...opts });
            delete h.deps.executePlan; // exercise the real seam
            const code = await runCli(argv, h.deps);
            const launches = h.calls.filter((c) => c.type === 'call' && c.name.startsWith('execute_'));
            return { code, output: h.output(), launches, calls: h.calls };
        } finally {
            await cleanup();
        }
    };

    test('two :debug entries never collide on the default inspector port', async () => {
        // Reproduced live in the IDE's own terminal before the fix: the second process
        // printed "Starting inspector on 127.0.0.1:9229 failed: address already in use".
        const { code, launches } = await inProject(['web:debug', 'api:debug']);

        assert.equal(code, 0);
        assert.deepEqual(launches.map((c) => c.name), ['execute_terminal_command', 'execute_terminal_command']);
        assert.match(launches[0].args.command, /--inspect-brk=127\.0\.0\.1:9229/);
        assert.match(launches[1].args.command, /--inspect-brk=127\.0\.0\.1:9230/);
    });

    test('the port a debugger waits on is printed, so WebStorm can be attached to it', async () => {
        const { output } = await inProject(['web:debug', 'api:debug']);
        assert.match(output, /started web \(debug, attach to port 9229\)/);
        assert.match(output, /started api \(debug, attach to port 9230\)/);
    });

    test('a plain run entry says nothing about a port', async () => {
        const { output } = await inProject(['web']);
        assert.match(output, /started web \(run\)/);
        assert.doesNotMatch(output, /attach to port/);
    });

    test('--debug-port moves the range', async () => {
        const { code, launches, output } = await inProject(['--debug-port', '9500', 'web:debug', 'api:debug']);
        assert.equal(code, 0);
        assert.match(launches[0].args.command, /--inspect-brk=127\.0\.0\.1:9500/);
        assert.match(launches[1].args.command, /--inspect-brk=127\.0\.0\.1:9501/);
        assert.match(output, /attach to port 9500/);
    });

    test('the reroute warning names the ports --debug-port moved to, not the default range', async () => {
        // The warning used to be a module-level constant frozen at 9229, so it announced
        // a range the commands right below it did not use.
        const { output, launches } = await inProject(['--debug-port', '9400', 'web:debug', 'api:debug']);

        assert.match(output, /ports 9400-9401, one per entry in plan order/);
        assert.doesNotMatch(output, /9229/, 'the default port has nothing to do with this run');
        assert.match(launches[1].args.command, /--inspect-brk=127\.0\.0\.1:9401/);
    });

    test('--dry-run says the same about the ports as a real launch', async () => {
        const { output } = await inProject(['--dry-run', '--debug-port', '9400', 'api:debug']);
        assert.match(output, /--inspect-brk=127\.0\.0\.1:9400/);
        assert.doesNotMatch(output, /9229/);
    });

    test('an invalid --debug-port is a usage error, before the IDE is contacted', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['--debug-port', 'nine', 'web:debug'], h.deps), 2);
            assert.match(h.output(), /--debug-port: "nine" is not a valid port/);
            assert.deepEqual(h.calls, [], 'a bad flag must not open an MCP connection');
        } finally {
            await cleanup();
        }
    });

    test('a --debug-port that runs off the end of the range is refused, and nothing starts', async () => {
        const { code, output, launches } = await inProject(['--debug-port', '65535', 'web:debug', 'api:debug']);
        assert.equal(code, 2);
        assert.deepEqual(launches, [], 'no tab may open on a port that cannot exist');
        assert.match(output, /--debug-port 65535/);
        assert.match(output, /65536/);
    });

    test('a busy inspector port is reported before anything is launched', async () => {
        const { port, close } = await occupyPort();
        try {
            const { code, output, launches } = await inProject(['--dry-run', '--debug-port', String(port), 'api:debug']);
            assert.equal(code, 0, 'a warning, not a refusal — the check is a snapshot');
            assert.deepEqual(launches, []);
            assert.match(output, new RegExp(`inspector port ${port} already in use`));
            assert.match(output, /--debug-port/);
        } finally {
            await close();
        }
    });

    test('a free inspector port is not warned about', async () => {
        const { port, close } = await occupyPort();
        await close(); // known-unused: the OS just handed it back
        const { output } = await inProject(['--dry-run', '--debug-port', String(port), 'api:debug']);
        assert.doesNotMatch(output, /already in use/);
    });

    test('a run-only plan never probes a port at all', async () => {
        const { output } = await inProject(['--dry-run', 'web']);
        assert.doesNotMatch(output, /inspector port/);
    });
});

describe('runCli — --configure and launch-only flags', () => {
    /** @param {string[]} argv */
    const inProject = async (argv) => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            const code = await runCli(argv, h.deps);
            return { code, output: h.output(), configured: h.configured, executed: h.executed };
        } finally {
            await cleanup();
        }
    };

    test('-c --target is refused rather than silently ignored', async () => {
        const { code, output, configured } = await inProject(['-c', '--target=terminal']);
        assert.equal(code, 2);
        assert.match(output, /--configure launches nothing, so --target would be ignored/);
        assert.deepEqual(configured, [], 'the screen must not open on a contradictory command line');
    });

    test('-c --dry-run is refused too — there is no launch to rehearse', async () => {
        const { code, output } = await inProject(['-c', '--dry-run']);
        assert.equal(code, 2);
        assert.match(output, /--dry-run would be ignored/);
    });

    test('-c --debug-port is refused', async () => {
        const { code, output } = await inProject(['-c', '--debug-port', '9500']);
        assert.equal(code, 2);
        assert.match(output, /--debug-port would be ignored/);
    });

    test('several launch flags are named in one message', async () => {
        const { code, output } = await inProject(['-c', '--target=terminal', '--dry-run']);
        assert.equal(code, 2);
        assert.match(output, /--target and --dry-run would be ignored/);
    });

    test('the check happens before the IDE is contacted', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            assert.equal(await runCli(['-c', '--dry-run'], h.deps), 2);
            assert.deepEqual(h.calls, []);
        } finally {
            await cleanup();
        }
    });

    test('an invalid --target with -c is still reported as the -c conflict', async () => {
        // Both are exit 2; the conflict is the more useful thing to say first, because
        // fixing the target value alone would still not do what the user asked.
        const { code, output } = await inProject(['-c', '--target=tmux']);
        assert.equal(code, 2);
        assert.match(output, /--configure launches nothing/);
    });

    test('flags that mean something for --configure are still accepted', async () => {
        const { code, configured } = await inProject(['-c', '--preset', 'backend']);
        assert.equal(code, 0);
        assert.equal(configured.length, 1);
        assert.equal(configured[0].presetName, 'backend');
    });
});

describe('runCli — unreachable IDE: retry and terminal fallback', () => {
    /**
     * @param {string[]} argv
     * @param {object} [opts] - forwarded to fakeCliDeps (port/ports/tty/fallbackChoice)
     * @param {string} [config] - preset file contents
     */
    const unreachable = async (argv, opts = {}, config) => {
        const { dir, cleanup } = await tmpProject(config);
        try {
            const h = fakeCliDeps({ port: null, ...opts, cwd: dir });
            const code = await runCli(argv, h.deps);
            return { ...h, code, dir, output: h.output() };
        } finally {
            await cleanup();
        }
    };

    test('an invalid --fallback is a usage error, before the IDE is contacted', async () => {
        const { code, output, calls } = await unreachable(['--fallback=tmux', 'web'], { port: 64542 });
        assert.equal(code, 2);
        assert.match(output, /--fallback: expected one of retry, terminal, got "tmux"/);
        assert.deepEqual(calls, [], 'nothing was asked of the IDE');
    });

    test('a genuine discovery failure keeps its stack instead of becoming a prompt', async () => {
        // Only a malformed port is a usage error; anything else is a bug in wsc, and the
        // retry screen is the wrong place to hide one.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir });
            h.deps.discoverPort = async () => { throw new TypeError('boom'); };
            await assert.rejects(() => runCli(['web'], h.deps), /boom/);
        } finally {
            await cleanup();
        }
    });

    test('--fallback=terminal hands the launch to the phase-8 seam', async () => {
        const { code, fellBack, executed } = await unreachable(['--fallback=terminal', 'web']);
        assert.equal(code, 0);
        assert.equal(fellBack.length, 1);
        assert.deepEqual(executed, [], 'the IDE execution path never ran');
    });

    test('the fallback seam is handed everything a launch needs that the IDE cannot supply', async () => {
        const { fellBack } = await unreachable(
            ['--fallback=terminal', '--debug-port=9300', 'api:debug'],
            {},
            JSON.stringify({ version: 1, defaultPreset: 'dev', presets: { dev: [{ name: 'web', mode: 'run' }] } }),
        );
        const ctx = fellBack[0];
        assert.equal(ctx.presetName, 'dev');
        assert.deepEqual(ctx.presetEntries, [{ name: 'web', mode: 'run' }]);
        assert.equal(ctx.debugPortBase, 9300);
        assert.ok(ctx.projectRoot.length > 0);

        // Raw, unsplit tokens: deciding whether `api:debug` is a name or a debug request
        // needs the list of real names, which the fallback reads off disk a moment later.
        // Splitting here would throw that away — and `api > repro:stale-job:debug`
        // is a real configuration in this very project.
        assert.deepEqual(ctx.positionals, ['api:debug']);
    });

    test('the fallback is told whether this is a dry run', async () => {
        // This branch returns before the --dry-run guard further down src/cli.js, so the
        // flag has to travel with the hand-over or a dry run would open real windows.
        const { fellBack } = await unreachable(['--fallback=terminal', '--dry-run', 'web']);
        assert.equal(fellBack[0].dryRun, true);

        const plain = await unreachable(['--fallback=terminal', 'web']);
        assert.equal(plain.fellBack[0].dryRun, false);
    });

    test('the real seam refuses loudly when the IDE has saved nothing to disk', async () => {
        // Without the MCP Server, .idea/ is the only list of run configurations there is.
        // A project with none must fail with a message, not report a launch that never
        // happened — and not with a stack trace, which is what leaving FallbackError out
        // of KNOWN_ERRORS would produce.
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, port: null });
            delete h.deps.runTerminalFallback; // the real phase-8 fallback
            assert.equal(await runCli(['--fallback=terminal', 'web'], h.deps), 1);
            assert.match(h.output(), /saved no run configurations/);
            assert.doesNotMatch(h.output(), /at .*terminalFallback\.js/, 'a message, not a stack');
        } finally {
            await cleanup();
        }
    });

    test('the real seam rehearses a launch under --dry-run without starting anything', async () => {
        // The end-to-end version of the two-halves --dry-run guard: this goes through the
        // real fallback, with a real .idea/ to read, and the only thing that keeps it from
        // opening windows is the guard inside it.
        const { dir, cleanup } = await tmpIdeaProject();
        try {
            const h = fakeCliDeps({ cwd: dir, port: null });
            delete h.deps.runTerminalFallback;

            assert.equal(await runCli(['--fallback=terminal', '--dry-run', 'web', 'api:debug'], h.deps), 0);
            assert.match(h.stdout(), /→ web\s+cd web && PATH=.*npm run dev/);
            assert.match(h.stdout(), /→ api\s+cd api && PATH=.*--inspect-brk=127\.0\.0\.1:9229.*npm run debug/);
        } finally {
            await cleanup();
        }
    });

    test('the real seam resolves names against what WebStorm saved, and refuses a typo', async () => {
        const { dir, cleanup } = await tmpIdeaProject();
        try {
            const h = fakeCliDeps({ cwd: dir, port: null });
            delete h.deps.runTerminalFallback;

            assert.equal(await runCli(['--fallback=terminal', '--dry-run', 'wbe'], h.deps), 1);
            assert.match(h.output(), /unknown run configuration "wbe"/);
            assert.match(h.output(), /Did you mean: web/);
        } finally {
            await cleanup();
        }
    });

    test('--fallback=retry reaches the decision without a prompt being possible', async () => {
        // The retry loop itself is unit-tested with an injected clock in
        // test/mcpUnavailablePrompt.test.js; what matters here is that the flag arrives.
        const { asked } = await unreachable(
            ['--fallback=retry', 'web'],
            { fallbackChoice: { kind: 'connected', port: 64542 } },
        );
        assert.deepEqual(asked, [{ fallback: 'retry', interactive: false, terminalAvailable: true }]);
    });

    test('"try again" repeats the same lookup rather than guessing afresh', async () => {
        // The retry thunk closes over --mcp-port, the environment and the scan window; a
        // retry that dropped any of them would quietly probe something else.
        const { code, discoveries, executed } = await unreachable(
            ['--mcp-port', '64542', 'web'],
            {
                ports: [null, 64542],
                fallbackChoice: async (_flags, retryDiscover) => {
                    const port = await retryDiscover();
                    return port === null ? { kind: 'cancelled' } : { kind: 'connected', port };
                },
            },
        );
        assert.equal(code, 0);
        assert.equal(discoveries.length, 2, 'probed once, then once more for the retry');
        assert.deepEqual(discoveries.map((call) => call.explicitPort), ['64542', '64542']);
        assert.equal(executed.length, 1);
    });

    test('a port found on a retry is the one the IDE session is opened on', async () => {
        const { code, calls, executed, fellBack } = await unreachable(
            ['--fallback=retry', 'web'],
            { fallbackChoice: { kind: 'connected', port: 64599 } },
        );
        assert.equal(code, 0);
        assert.equal(calls[0].port, 64599, 'the retried port is used, not the one that failed');
        assert.equal(executed.length, 1, 'launched through the IDE, not the fallback');
        assert.deepEqual(fellBack, []);
    });

    test('a non-interactive run names the escape hatches instead of hanging on a prompt', async () => {
        const { code, output, fellBack } = await unreachable(['web']);
        assert.equal(code, 1);
        assert.match(output, /Settings → Tools → MCP Server/);
        assert.match(output, /--fallback=retry/);
        assert.match(output, /--fallback=terminal/);
        assert.deepEqual(fellBack, [], 'never falls back silently');

        // The give-up message already contains the setup instructions; printing them a
        // second time above it is what the first live run of this branch actually did.
        assert.equal(output.split('Settings → Tools → MCP Server').length - 1, 1);
    });

    test('the instructions are printed above the prompt, where a select has no room for them', async () => {
        const { output } = await unreachable(
            ['web'],
            { tty: true, fallbackChoice: { kind: 'cancelled' } },
        );
        assert.match(output, /Settings → Tools → MCP Server/);
        assert.match(output, /Brave Mode/);
    });

    test('a terminal fallback says why it is not using IDE tabs', async () => {
        const { output } = await unreachable(['--fallback=terminal', 'web']);
        assert.match(output, /WebStorm is not answering — launching without IDE tabs/);
    });

    test('a terminal on one end only is still not somewhere to ask a question', async () => {
        // `wsc | tee log` keeps stdout a pipe; `wsc < /dev/null` keeps stdin one. Either
        // way a drawn prompt would sit there looking exactly like a hung command.
        for (const half of /** @type {const} */ (['stdin', 'stdout'])) {
            const { dir, cleanup } = await tmpProject();
            try {
                const h = fakeCliDeps({ cwd: dir, port: null, tty: true });
                if (half === 'stdin') h.deps.stdin = { isTTY: false };
                else h.deps.stdout = { ...h.deps.stdout, isTTY: false };

                assert.equal(await runCli(['web'], h.deps), 1, `${half} is not a TTY`);
                assert.match(h.output(), /--fallback=retry/);
            } finally {
                await cleanup();
            }
        }
    });

    test('a cancelled prompt exits 130 and launches nothing', async () => {
        const { code, executed, fellBack } = await unreachable(
            ['web'],
            { tty: true, fallbackChoice: { kind: 'cancelled' } },
        );
        assert.equal(code, 130);
        assert.deepEqual(executed, []);
        assert.deepEqual(fellBack, []);
    });

    test('the prompt is only reachable when both ends are a terminal', async () => {
        const { asked } = await unreachable(
            ['web'],
            { tty: true, fallbackChoice: { kind: 'terminal' } },
        );
        assert.deepEqual(asked, [{ fallback: undefined, interactive: true, terminalAvailable: true }]);
    });

    test('a chosen retry that succeeds continues down the main path', async () => {
        const { code, executed } = await unreachable(
            ['web'],
            { tty: true, fallbackChoice: { kind: 'connected', port: 64542 } },
        );
        assert.equal(code, 0);
        assert.equal(executed.length, 1);
    });

    test('--configure is offered a retry but never a terminal that could not run anything', async () => {
        const { asked } = await unreachable(
            ['-c'],
            { tty: true, fallbackChoice: { kind: 'cancelled' } },
        );
        assert.equal(asked[0].terminalAvailable, false);
    });

    test('-c --fallback=terminal is refused rather than silently ignored', async () => {
        const { code, output, calls } = await unreachable(['-c', '--fallback=terminal'], { port: 64542 });
        assert.equal(code, 2);
        assert.match(output, /--configure has nothing to launch in a terminal/);
        assert.deepEqual(calls, []);
    });

    test('-c --fallback=retry is accepted — --configure needs the IDE too', async () => {
        const { code, configured } = await unreachable(
            ['-c', '--fallback=retry'],
            { fallbackChoice: { kind: 'connected', port: 64542 } },
        );
        assert.equal(code, 0);
        assert.equal(configured.length, 1);
    });

    test('an unreachable IDE with --configure reaches the configure screen after a retry', async () => {
        const { code, configured } = await unreachable(
            ['-c'],
            { tty: true, fallbackChoice: { kind: 'connected', port: 64542 } },
        );
        assert.equal(code, 0);
        assert.equal(configured.length, 1);
    });
});

describe('runCli — :debug through the wsc IDE plugin', () => {
    const TOOL = 'debug_run_configuration';

    /**
     * Runs the real execution seam against a fake IDE that lists the given tools.
     *
     * @param {string[]} argv
     * @param {object} [opts] - passed to fakeCliDeps (tools, …)
     * @param {(client: any) => any} [wrap] - wraps the fake client, to break or count a method
     */
    const launch = async (argv, opts = {}, wrap = (client) => client) => {
        const { dir, cleanup } = await tmpProject();
        try {
            const h = fakeCliDeps({ cwd: dir, ...opts });
            delete h.deps.executePlan; // exercise the real seam
            const connect = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => wrap(await connect(...args));
            const code = await runCli(argv, h.deps);
            const tools = h.calls.filter((c) => c.type === 'call').map((c) => c.name);
            return { code, output: h.output(), stdout: h.stdout(), tools, calls: h.calls };
        } finally {
            await cleanup();
        }
    };

    /** The tool names of everything except the catalogue read every run starts with. */
    const launched = (tools) => tools.filter((name) => name !== 'get_run_configurations');

    test('with the plugin, :debug starts a real Debug session and says nothing about the terminal', async () => {
        const { code, output, tools, calls } = await launch(['api:debug'], { tools: [TOOL] });
        assert.equal(code, 0);
        assert.deepEqual(launched(tools), [TOOL]);
        assert.deepEqual(calls.find((c) => c.name === TOOL)?.args, { configurationName: 'api' });
        assert.doesNotMatch(output, /Terminal window/);
        assert.doesNotMatch(output, /wsc IDE plugin/, 'no advice to install what is already installed');
        assert.match(output, /started api \(debug\)/);
    });

    test('without the plugin, :debug keeps the terminal route and points at the plugin', async () => {
        const { code, output, tools } = await launch(['api:debug'], { tools: [] });
        assert.equal(code, 0);
        assert.deepEqual(launched(tools), ['execute_terminal_command']);
        assert.match(output, /debug mode goes through the IDE's Terminal window/);
        assert.match(output, /for a real Debug tab instead, install the wsc IDE plugin/);
    });

    test('an explicit --target=terminal is honoured even when the plugin is there', async () => {
        const { tools, output } = await launch(['--target=terminal', 'api:debug'], { tools: [TOOL] });
        assert.deepEqual(launched(tools), ['execute_terminal_command']);
        // Nothing was rerouted behind the user's back, so there is nothing to explain.
        assert.doesNotMatch(output, /debug mode goes through/);
    });

    test('a plain run never asks the IDE for its tools', async () => {
        // The round trip is only worth making when the plan has a :debug entry in it.
        let asked = 0;
        const { code } = await launch(['web'], { tools: [TOOL] }, (client) => ({
            ...client,
            listTools: async () => (asked++, client.listTools()),
        }));
        assert.equal(code, 0);
        assert.equal(asked, 0);
    });

    test('a tool listing that fails means "no plugin", not a failed launch', async () => {
        const { code, tools, output } = await launch(['api:debug'], { tools: [TOOL] }, (client) => ({
            ...client,
            listTools: async () => { throw new Error('boom'); },
        }));
        assert.equal(code, 0);
        assert.deepEqual(launched(tools), ['execute_terminal_command']);
        assert.match(output, /Terminal window/);
    });

    test('--dry-run shows the debug tool call and starts nothing', async () => {
        const { code, stdout, tools } = await launch(['--dry-run', 'api:debug'], { tools: [TOOL] });
        assert.equal(code, 0);
        assert.match(stdout, /→ debug_run_configuration +api/);
        assert.deepEqual(tools, ['get_run_configurations'], 'a dry run must not call the debug tool');
    });

    test('a mixed plan sends the run to the Run window and the debug to the plugin', async () => {
        const { tools } = await launch(['web', 'api:debug'], { tools: [TOOL] });
        assert.deepEqual(launched(tools), ['execute_run_configuration', TOOL]);
    });
});

describe('runCli — a real Terminal tab through the wsc IDE plugin', () => {
    const TAB_TOOL = 'open_terminal_tab';
    const PIPED = /not a real terminal/;

    /**
     * Runs the real execution seam in a project whose preset holds one custom command.
     *
     * @param {string[]} argv
     * @param {object} [opts] - passed to fakeCliDeps (tools, …)
     * @param {(client: any) => any} [wrap]
     */
    const launch = async (argv, opts = {}, wrap = (client) => client) => {
        const preset = { presets: { default: [{ name: 'ngrok', commands: ['ngrok http 8000'] }] } };
        const { dir, cleanup } = await tmpProject(JSON.stringify(preset));
        try {
            const h = fakeCliDeps({ cwd: dir, ...opts });
            delete h.deps.executePlan; // exercise the real seam
            const connect = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => wrap(await connect(...args));
            const code = await runCli(argv, h.deps);
            const calls = h.calls.filter((c) => c.type === 'call' && c.name !== 'get_run_configurations');
            const named = h.calls.filter((c) => c.type === 'connect' && c.clientName !== undefined);
            return { code, output: h.output(), stdout: h.stdout(), calls, named };
        } finally {
            await cleanup();
        }
    };

    test('with the plugin, the custom command runs in a real shell tab the plugin titles', async () => {
        const { code, output, calls, named } = await launch([], { tools: [TAB_TOOL] });

        assert.equal(code, 0);
        assert.deepEqual(calls.map((c) => [c.name, c.args]), [[TAB_TOOL, { tabName: 'ngrok', command: 'ngrok http 8000' }]]);
        assert.deepEqual(named, [], 'no session has to be opened under the tab\'s name');
        assert.doesNotMatch(output, PIPED);
        assert.match(output, /started ngrok \(terminal\)/);
    });

    test(':terminal and --target=terminal use it too', async () => {
        const { calls } = await launch(['web:terminal'], { tools: [TAB_TOOL] });
        assert.deepEqual(calls.map((c) => c.name), [TAB_TOOL, TAB_TOOL]);
        assert.deepEqual(calls.map((c) => c.args.tabName), ['ngrok', 'web']);
    });

    test('without the plugin, the IDE\'s own tool is used and the run says, once, what that costs', async () => {
        const { code, output, calls } = await launch(['web:terminal'], { tools: [] });

        assert.equal(code, 0);
        assert.deepEqual(calls.map((c) => c.name), ['execute_terminal_command', 'execute_terminal_command']);
        assert.equal(output.match(new RegExp(PIPED, 'g'))?.length, 1);
        assert.match(output, /wsc IDE plugin/);
    });

    test('a failed tool listing means "no plugin", not a failed launch', async () => {
        const { code, output, calls } = await launch([], { tools: [TAB_TOOL] }, (client) => ({
            ...client,
            listTools: async () => { throw new Error('boom'); },
        }));
        assert.equal(code, 0);
        assert.deepEqual(calls.map((c) => c.name), ['execute_terminal_command']);
        assert.match(output, PIPED);
    });

    test('a plan with no terminal tab neither asks for the tools nor warns', async () => {
        // No preset here: `wsc web` is a single Run-window entry.
        const { dir, cleanup } = await tmpProject();
        try {
            let asked = 0;
            const h = fakeCliDeps({ cwd: dir, tools: [TAB_TOOL] });
            delete h.deps.executePlan;
            const connect = h.deps.connectMcp;
            h.deps.connectMcp = async (...args) => {
                const client = await connect(...args);
                return { ...client, listTools: async () => (asked++, client.listTools()) };
            };

            assert.equal(await runCli(['web'], h.deps), 0);
            assert.equal(asked, 0);
            assert.doesNotMatch(h.output(), PIPED);
        } finally {
            await cleanup();
        }
    });

    test('--dry-run shows the plugin\'s call and opens nothing', async () => {
        const { code, stdout, calls } = await launch(['--dry-run'], { tools: [TAB_TOOL] });
        assert.equal(code, 0);
        assert.match(stdout, /→ open_terminal_tab +ngrok http 8000/);
        assert.deepEqual(calls, []);
    });

    test('with both plugin tools, :debug still gets the real Debug tab', async () => {
        const { calls } = await launch(['api:debug'], { tools: [TAB_TOOL, 'debug_run_configuration'] });
        assert.deepEqual(calls.map((c) => c.name), [TAB_TOOL, 'debug_run_configuration']);
    });
});

describe('runCli — --delete-preset', () => {
    const CONFIG = JSON.stringify({
        version: 1,
        defaultPreset: 'default',
        presets: {
            default: [{ name: 'api' }],
            'old-one': [
                { name: 'web' },
                { name: 'api', mode: 'debug' },
                { name: 'seed db', mode: 'terminal', commands: ['npm run seed'] },
            ],
        },
        extra: { kept: true },
    });

    /**
     * Run the CLI in a throwaway project and hand back the preset file as it was left.
     *
     * @param {string[]} argv
     * @param {object} [opts]
     * @param {string} [opts.config]
     * @param {(dir: string) => string[]} [opts.argv] - build argv from the project dir
     * @param {string} [opts.cwd]
     */
    async function deleting(argv, opts = {}) {
        const { dir, cleanup } = await tmpProject(opts.config ?? CONFIG);
        try {
            const h = fakeCliDeps({ cwd: opts.cwd ?? dir });
            // Any contact with the IDE fails the run loudly, instead of passing quietly.
            h.deps.discoverPort = async () => { throw new Error('discoverPort must not be called'); };
            h.deps.connectMcp = async () => { throw new Error('connectMcp must not be called'); };
            const code = await runCli(opts.argv ? opts.argv(dir) : argv, h.deps);
            const file = JSON.parse(await readFile(path.join(dir, '.idea', 'webstorm-commands.json'), 'utf8'));
            return { code, file, dir, stdout: h.stdout(), stderr: h.stderr(), output: h.output() };
        } finally {
            await cleanup();
        }
    }

    test('deletes the preset, keeps the rest of the file, and never contacts the IDE', async () => {
        const result = await deleting(['--delete-preset', 'old-one']);

        assert.equal(result.code, 0);
        assert.equal(Object.hasOwn(result.file.presets, 'old-one'), false);
        assert.deepEqual(result.file.presets.default, [{ name: 'api', mode: 'run' }]);
        assert.deepEqual(result.file.extra, { kept: true }, 'unknown top-level keys survive');
        assert.equal(result.file.defaultPreset, 'default');
        assert.equal(result.stdout, '', 'every message goes to stderr');
    });

    test('lists what the preset held, one label per entry', async () => {
        const { stderr } = await deleting(['--delete-preset', 'old-one']);
        assert.match(stderr, /deleted preset "old-one" from .*webstorm-commands\.json/);
        assert.match(stderr, /\n {2}- web\n {2}- api:debug\n {2}- ⌘ seed db\n/);
    });

    test('an empty preset prints only the header line', async () => {
        const config = JSON.stringify({ presets: { a: [], b: [{ name: 'web' }] } });
        const { code, stderr } = await deleting(['--delete-preset', 'a'], { config });
        assert.equal(code, 0);
        assert.doesNotMatch(stderr, / {2}- /);
    });

    test('an unknown preset exits 1 and names the known ones', async () => {
        const result = await deleting(['--delete-preset', 'nope']);
        assert.equal(result.code, 1);
        assert.match(result.output, /unknown preset "nope" \(known presets: default, old-one\)/);
        assert.ok(Object.hasOwn(result.file.presets, 'old-one'), 'nothing was written');
    });

    test('with no presets at all, says so', async () => {
        const result = await deleting(['--delete-preset', 'x'], { config: JSON.stringify({ presets: {} }) });
        assert.equal(result.code, 1);
        assert.match(result.output, /unknown preset "x" \(no presets configured yet\)/);
    });

    test('an empty name counts as passed, and is just an unknown preset', async () => {
        const result = await deleting(['--delete-preset', '']);
        assert.equal(result.code, 1);
        assert.match(result.output, /unknown preset ""/);
    });

    test('a name that collides with Object.prototype is an unknown preset, not a crash', async () => {
        for (const name of ['constructor', 'toString', '__proto__']) {
            const result = await deleting(['--delete-preset', name]);
            assert.equal(result.code, 1, name);
            assert.match(result.output, /unknown preset/);
        }
    });

    test('deleting the default while others remain resets it, and warns', async () => {
        const config = JSON.stringify({ defaultPreset: 'main', presets: { main: [{ name: 'web' }], other: [] } });
        const result = await deleting(['--delete-preset', 'main'], { config });

        assert.equal(result.code, 0);
        assert.equal(result.file.defaultPreset, 'default');
        assert.deepEqual(Object.keys(result.file.presets), ['other']);
        assert.match(result.stderr, /"main" was the default preset/);
        assert.match(result.stderr, /wsc -c/);
        assert.match(result.stderr, /webstorm-commands\.json/);
    });

    test('deleting the default does not warn when a preset called "default" remains', async () => {
        const config = JSON.stringify({ defaultPreset: 'main', presets: { main: [{ name: 'web' }], default: [] } });
        const result = await deleting(['--delete-preset', 'main'], { config });

        assert.equal(result.code, 0);
        assert.equal(result.file.defaultPreset, 'default');
        assert.deepEqual(Object.keys(result.file.presets), ['default']);
        assert.doesNotMatch(result.stderr, /warn:|wsc -c/);
    });

    test('deleting the default when it is the last preset does not warn', async () => {
        const config = JSON.stringify({ defaultPreset: 'main', presets: { main: [{ name: 'web' }] } });
        const result = await deleting(['--delete-preset', 'main'], { config });

        assert.equal(result.code, 0);
        assert.equal(result.file.defaultPreset, 'default');
        assert.deepEqual(result.file.presets, {});
        assert.doesNotMatch(result.stderr, /wsc -c/);
    });

    test('deleting a preset called "default" that is the default, with others left, warns', async () => {
        const result = await deleting(['--delete-preset', 'default']);
        assert.equal(result.code, 0);
        assert.equal(result.file.defaultPreset, 'default');
        assert.match(result.stderr, /wsc -c/);
    });

    test('--project is honoured', async () => {
        const result = await deleting([], { cwd: '/', argv: (dir) => ['--project', dir, '--delete-preset', 'old-one'] });
        assert.equal(result.code, 0);
        assert.equal(Object.hasOwn(result.file.presets, 'old-one'), false);
    });

    test('refuses configuration names and every other flag, before touching the file', async () => {
        for (const extra of [
            ['web'],
            ['--preset', 'default'],
            ['--configure'],
            ['-c'],
            ['--list'],
            ['--dry-run'],
            ['--fallback=retry'],
            ['--mcp-port', '1234'],
            ['--target', 'terminal'],
            ['--debug-port', '9300'],
        ]) {
            const result = await deleting(['--delete-preset', 'old-one', ...extra]);
            assert.equal(result.code, 2, extra.join(' '));
            assert.ok(Object.hasOwn(result.file.presets, 'old-one'), `${extra.join(' ')}: nothing deleted`);
        }
    });

    test('the refusal names the offending flag', async () => {
        const result = await deleting(['--delete-preset', 'old-one', '--dry-run', '--mcp-port', '1']);
        assert.equal(result.code, 2);
        assert.match(result.output, /--delete-preset edits the preset file, so --mcp-port and --dry-run would be ignored/);
    });

    test('--help lists it', async () => {
        const h = fakeCliDeps();
        assert.equal(await runCli(['--help'], h.deps), 0);
        assert.match(h.stdout(), /--delete-preset <n> delete a preset/);
    });
});
