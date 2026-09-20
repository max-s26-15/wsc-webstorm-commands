/**
 * Phase 9 — the finished flag table, exercised through runCli() end to end.
 *
 * Every test here drives the *whole* pipeline (args → project → preset → MCP → resolve →
 * plan → launch) with a fake McpClient injected, so the exact wording of --dry-run and the
 * exact exit codes are pinned without a live IDE. test/cli.test.js owns the individual
 * flags' edge cases; this file owns the table itself — one describe per row — plus the
 * seams between rows, which is where a "glue everything together" phase actually breaks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli.js';
import { formatRunConfigs } from '../src/list.js';
import { fakeCliDeps } from '../test-utils/fake-cli-deps.js';
import { tmpIdeaProject, tmpProject } from '../test-utils/tmp-dir.js';

/**
 * Run the CLI inside a throwaway WebStorm project.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {string} [opts.config] - contents of .idea/webstorm-commands.json
 * @param {boolean} [opts.idea] - also write the demo-app .idea run configurations,
 *   which is what the no-IDE paths read
 * @param {object} [opts.deps] - passed through to fakeCliDeps (port, ports, tty, …)
 */
async function wsc(argv, opts = {}) {
    const project = opts.idea
        ? await tmpIdeaProject({ presets: opts.config })
        : await tmpProject(opts.config);

    try {
        const h = fakeCliDeps({ cwd: project.dir, ...opts.deps });
        const code = await runCli(argv, h.deps);
        return {
            code,
            dir: project.dir,
            stdout: h.stdout(),
            stderr: h.stderr(),
            output: h.output(),
            executed: h.executed,
            contexts: h.executeContexts,
            configured: h.configured,
            fellBack: h.fellBack,
            calls: h.calls,
            closed: h.closed,
        };
    } finally {
        await project.cleanup();
    }
}

/** @param {Record<string, Array<{ name: string, mode?: string }>>} presets */
const withPresets = (presets, defaultPreset) =>
    JSON.stringify(defaultPreset ? { defaultPreset, presets } : { presets });

/** @param {{ executed: any[] }} result — what the launch seam was actually handed. */
const launched = (result) => result.executed.flat().map((entry) => `${entry.name}:${entry.mode}`);

// ── wsc ──────────────────────────────────────────────────────────────────────
describe('flag table — wsc', () => {
    test('launches the default preset, in the order it was configured', async () => {
        const result = await wsc([], {
            config: withPresets({ default: [{ name: 'api' }, { name: 'web', mode: 'debug' }] }),
        });

        assert.equal(result.code, 0);
        assert.deepEqual(launched(result), ['api:run', 'web:debug']);
    });

    test('defaultPreset picks which preset "no arguments" means', async () => {
        const result = await wsc([], {
            config: withPresets({ default: [{ name: 'api' }], morning: [{ name: 'shared' }] }, 'morning'),
        });

        assert.equal(result.code, 0);
        assert.deepEqual(launched(result), ['shared:run']);
    });

    test('nothing configured and nothing named is explained, not silently launched', async () => {
        const result = await wsc([], { config: withPresets({ default: [] }) });

        assert.equal(result.code, 1);
        assert.deepEqual(result.executed, []);
        assert.match(result.output, /nothing to launch/);
        assert.match(result.output, /--configure/);
    });
});

// ── wsc web:debug api ───────────────────────────────────────────────────
describe('flag table — wsc web:debug api', () => {
    test('the command line overrides the preset mode and keeps the preset position', async () => {
        const result = await wsc(['web:debug', 'api'], {
            config: withPresets({ default: [{ name: 'web' }, { name: 'shared' }] }),
        });

        assert.equal(result.code, 0);
        // web stays first because the preset put it there; only its mode changed.
        assert.deepEqual(launched(result), ['web:debug', 'shared:run', 'api:run']);
    });

    test('a name that ends in :debug is a name, not a mode', async () => {
        // demo-app really has a configuration called `api > repro:stale-job:debug`.
        const result = await wsc(['api > repro:stale-job:debug']);

        assert.equal(result.code, 0);
        assert.deepEqual(launched(result), ['api > repro:stale-job:debug:run']);
    });

    test('a typo in the third name launches none of the first two', async () => {
        const result = await wsc(['web', 'api', 'sharde']);

        assert.equal(result.code, 1);
        assert.deepEqual(result.executed, [], 'resolution is atomic: all names, or nothing');
        assert.match(result.output, /Did you mean: shared/);
    });
});

// ── -c, --configure ──────────────────────────────────────────────────────────
describe('flag table — -c/--configure', () => {
    test('opens the screen with the IDE list, and launches nothing', async () => {
        const result = await wsc(['-c'], { config: withPresets({ default: [{ name: 'api' }] }) });

        assert.equal(result.code, 0);
        assert.equal(result.configured.length, 1);
        assert.equal(result.configured[0].configs.length, 13);
        assert.deepEqual(result.executed, []);
    });

    test('refuses the flags that only steer a launch', async () => {
        const result = await wsc(['-c', '--dry-run']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--configure launches nothing, so --dry-run would be ignored/);
    });
});

// ── -l, --list ───────────────────────────────────────────────────────────────
describe('flag table — -l/--list', () => {
    test('prints every configuration the IDE reports, one per line, on stdout', async () => {
        const result = await wsc(['--list']);

        assert.equal(result.code, 0);
        const lines = result.stdout.trimEnd().split('\n');
        assert.equal(lines.length, 13);
        assert.match(lines[0], /^Repro: Stale Job Cleanup\s+Node\.js$/);
        assert.match(result.stdout, /^web\s+npm$/m);
        assert.match(result.stdout, /^api > repro:stale-job:debug\s+npm$/m);
    });

    test('-l is the short form', async () => {
        const result = await wsc(['-l']);
        assert.equal(result.code, 0);
        assert.equal(result.stdout.trimEnd().split('\n').length, 13);
    });

    test('only the listing goes to stdout — diagnostics stay pipeable away', async () => {
        // This is the flag src/log.js' stdout/stderr split exists for: `wsc --list | grep`
        // must see configuration names and nothing else.
        const result = await wsc(['--list']);

        assert.match(result.stderr, /13 run configuration\(s\) reported by the IDE/);
        assert.doesNotMatch(result.stdout, /run configuration\(s\)/);
        assert.doesNotMatch(result.stdout, /\x1b\[/, 'a listing is never coloured');
    });

    test('asks the IDE for the catalogue and nothing else, then closes the session', async () => {
        const result = await wsc(['--list'], { config: withPresets({ default: [{ name: 'api' }] }) });

        assert.deepEqual(
            result.calls.filter((call) => call.type === 'call').map((call) => call.name),
            ['get_run_configurations'],
        );
        assert.deepEqual(result.executed, [], 'listing is not launching');
        assert.equal(result.closed, true);

        // One MCP Server serves every open IDE window, so the listing has to say which
        // project it is asking about — exactly as a launch does.
        const [connect] = result.calls;
        assert.equal(connect.type, 'connect');
        assert.equal(connect.projectPath, result.dir);
    });

    test('the MCP session stays open until the listing has been read', async () => {
        // The bug this codebase has shipped twice: a bare `return p` inside try/finally
        // runs the finally *before* p settles, tearing the transport down mid-call.
        const { dir, cleanup } = await tmpProject();
        try {
            let openWhileReading = null;
            const h = fakeCliDeps({
                cwd: dir,
                callTool: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    openWhileReading = h.closed;
                    return { configurations: [{ name: 'web', description: 'npm' }] };
                },
            });

            assert.equal(await runCli(['--list'], h.deps), 0);
            assert.equal(openWhileReading, false, 'the session must outlive the call');
            assert.equal(h.closed, true, 'and still be closed afterwards');
        } finally {
            await cleanup();
        }
    });

    test('a project with no configurations is an empty answer, not a failure', async () => {
        const result = await wsc(['--list'], { deps: { configurations: { configurations: [] } } });

        assert.equal(result.code, 0);
        assert.equal(result.stdout, '', 'a pipe sees exactly zero lines');
        assert.match(result.stderr, /no run configurations found/);
    });

    test('does not depend on the preset file, which it never uses', async () => {
        // The listing is the IDE's own catalogue; a preset is wsc's selection out of it.
        // Reading presets first would break --list in the project that needs it most —
        // the one that is not configured yet, or was hand-edited into invalid JSON.
        const broken = '{ "presets": { "default": [ }';

        const listing = await wsc(['--list'], { config: broken });
        assert.equal(listing.code, 0);
        assert.equal(listing.stdout.trimEnd().split('\n').length, 13);

        const launch = await wsc([], { config: broken });
        assert.equal(launch.code, 1, 'a launch still reports the broken config');
    });

    test('refuses configuration names: it prints all of them either way', async () => {
        const result = await wsc(['--list', 'web']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--list takes no configuration names/);
        assert.deepEqual(result.calls, [], 'rejected before the IDE is contacted');
    });

    test('refuses --configure: printing and editing are two different intents', async () => {
        const result = await wsc(['--list', '--configure']);

        assert.equal(result.code, 2);
        assert.match(result.output, /pick one/);
        assert.deepEqual(result.calls, []);
    });

    for (const flag of ['--target=terminal', '--debug-port=9400', '--dry-run', '--preset=backend']) {
        test(`refuses ${flag}, which would be silently ignored`, async () => {
            const result = await wsc(['--list', flag], { config: withPresets({ backend: [{ name: 'api' }] }) });

            assert.equal(result.code, 2);
            assert.match(result.output, /--list prints the IDE's own catalogue, so --\S+ would be ignored/);
            assert.deepEqual(result.calls, []);
        });
    }

    test('a flag with a falsy value still counts as one the user passed', async () => {
        // parseArgs leaves an *absent* flag out of `values` entirely, so the check has to
        // be an own-key one: `--preset ""` is something that was typed, however empty.
        const result = await wsc(['--list', '--preset', '']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--preset would be ignored/);
    });

    test('names every ignored flag it found, not just the first', async () => {
        const result = await wsc(['--list', '--dry-run', '--preset', 'backend']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--dry-run and --preset would be ignored/);
    });

    test('an unreachable IDE falls back to what WebStorm saved in .idea/', async () => {
        const result = await wsc(['--list', '--fallback=terminal'], { idea: true, deps: { port: null } });

        assert.equal(result.code, 0);
        assert.equal(result.stdout.trimEnd().split('\n').length, 13);
        assert.match(result.stdout, /^web\s+npm$/m);
    });

    test('and says so, because that listing can be out of date', async () => {
        const result = await wsc(['--list', '--fallback=terminal'], { idea: true, deps: { port: null } });

        assert.match(result.stderr, /WebStorm is not answering/);
        assert.match(result.stderr, /\.idea\/workspace\.xml and \.idea\/runConfigurations\//);
        assert.match(result.stderr, /has not written out yet is missing/);
        // The two listings must never read alike: this one is what the IDE *saved*, and a
        // reader who cannot tell them apart has no way to know it may be out of date.
        assert.match(result.stderr, /run configuration\(s\) saved by the IDE/);
        assert.doesNotMatch(result.stderr, /reported by the IDE/);
        assert.deepEqual(result.fellBack, [], 'a listing never hands over to the terminal launcher');
    });

    test('--fallback=retry lists from the IDE once it answers', async () => {
        const result = await wsc(['--list'], {
            deps: { port: null, fallbackChoice: { kind: 'connected', port: 64542 } },
        });

        assert.equal(result.code, 0);
        assert.equal(result.stdout.trimEnd().split('\n').length, 13);
        assert.match(result.stderr, /MCP Server answered on 64542/);
    });

    test('the without-IDE option is offered in listing wording, not launch wording', async () => {
        /** @type {any[]} */
        const asked = [];
        await wsc(['--list'], {
            deps: {
                port: null,
                fallbackChoice: (flags, _retry, opts) => {
                    asked.push({ flags, opts });
                    return { kind: 'cancelled' };
                },
            },
        });

        assert.equal(asked.length, 1);
        assert.match(asked[0].opts.withoutIdeLabel, /List what WebStorm last saved/);
    });

    test('an unreachable IDE with nobody to ask names the flags that would answer', async () => {
        const result = await wsc(['--list'], { deps: { port: null } });

        assert.equal(result.code, 1);
        assert.match(result.output, /--fallback=retry/);
        assert.match(result.output, /--fallback=terminal/);
    });
});

// ── --preset <name> ──────────────────────────────────────────────────────────
describe('flag table — --preset <name>', () => {
    test('launches a different named preset', async () => {
        const result = await wsc(['--preset', 'backend'], {
            config: withPresets({ default: [{ name: 'api' }], backend: [{ name: 'shared', mode: 'debug' }] }),
        });

        assert.equal(result.code, 0);
        assert.deepEqual(launched(result), ['shared:debug']);
    });

    test('a preset that does not exist is a named error, not a stack trace', async () => {
        const result = await wsc(['--preset', 'nope'], { config: withPresets({ default: [{ name: 'api' }] }) });

        assert.equal(result.code, 1);
        assert.match(result.output, /unknown preset "nope" \(known presets: default\)/);
        assert.deepEqual(result.executed, []);
    });

    test('names on the command line still apply on top of the chosen preset', async () => {
        const result = await wsc(['--preset', 'backend', 'api'], {
            config: withPresets({ backend: [{ name: 'shared' }] }),
        });

        assert.deepEqual(launched(result), ['shared:run', 'api:run']);
    });

    describe('several presets at once', () => {
        const config = withPresets({
            default: [{ name: 'docs' }],
            backend: [{ name: 'api' }, { name: 'shared' }],
            front: [{ name: 'web', mode: 'debug' }, { name: 'shared', mode: 'debug' }],
        });

        test('--preset a b launches both, in the order given', async () => {
            const result = await wsc(['--preset', 'backend', 'front'], { config });

            assert.equal(result.code, 0);
            // shared is in both: it keeps backend's position and takes front's mode.
            assert.deepEqual(launched(result), ['api:run', 'shared:debug', 'web:debug']);
        });

        test('repeating the flag means the same thing', async () => {
            const spelled = await wsc(['--preset', 'backend', '--preset', 'front'], { config });
            const listed = await wsc(['--preset', 'backend', 'front'], { config });

            assert.deepEqual(launched(spelled), launched(listed));
        });

        test('the order typed is the order launched', async () => {
            const result = await wsc(['--preset', 'front', 'backend'], { config });

            assert.deepEqual(launched(result), ['web:debug', 'shared:run', 'api:run']);
        });

        test('a name that is not a preset stays a configuration, on top of the presets', async () => {
            const result = await wsc(['--preset', 'backend', 'front', 'docs:debug'], { config });

            assert.deepEqual(launched(result), ['api:run', 'shared:debug', 'web:debug', 'docs:debug']);
        });

        test('an unknown preset in the list is named, and nothing launches', async () => {
            const result = await wsc(['--preset', 'backend', '--preset', 'nope'], { config });

            assert.equal(result.code, 1);
            assert.match(result.output, /unknown preset "nope" \(known presets: default, backend, front\)/);
            assert.deepEqual(result.executed, []);
        });

        test('--dry-run says which presets it is combining', async () => {
            const result = await wsc(['--preset', 'backend', 'front', '--dry-run'], { config });

            assert.equal(result.code, 0);
            assert.deepEqual(result.executed, []);
            assert.match(result.stdout, /^api\s+run\s+\(preset\)$/m);
        });

        test('--configure edits one preset, so it refuses two — either spelling', async () => {
            for (const argv of [['-c', '--preset', 'backend', 'front'], ['-c', '--preset', 'backend', '--preset', 'front']]) {
                const result = await wsc(argv, { config });

                assert.equal(result.code, 2, argv.join(' '));
                assert.match(result.output, /--configure/);
                assert.match(result.output, /one preset/);
                assert.deepEqual(result.configured, []);
            }
        });
    });
});

// ── --target=run-window|terminal ─────────────────────────────────────────────
describe('flag table — --target', () => {
    test('run-window is the default and uses the IDE\'s own Run/Debug tabs', async () => {
        const result = await wsc(['--dry-run', 'web']);

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_run_configuration {2,}web/);
    });

    test('--target=terminal rebuilds the command and opens a Terminal tab', async () => {
        const result = await wsc(['--dry-run', '--target=terminal', 'web']);

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_terminal_command {2,}npm run web/);
    });

    test('a target that does not exist is a usage error, before the IDE is contacted', async () => {
        const result = await wsc(['--target=tmux', 'web']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--target: expected one of run-window, terminal, got "tmux"/);
        assert.deepEqual(result.calls, []);
    });

    test(':debug goes through a Terminal tab whatever --target says, and says why', async () => {
        const result = await wsc(['--dry-run', '--target=run-window', 'api:debug']);

        assert.match(result.stdout, /→ execute_terminal_command/);
        assert.match(result.stderr, /execute_run_configuration has no debug parameter/);
    });
});

// ── --dry-run ────────────────────────────────────────────────────────────────
describe('flag table — --dry-run', () => {
    test('prints the exact plan and the exact calls, and launches nothing', async () => {
        const result = await wsc(['--dry-run', 'web', 'api:debug'], {
            config: withPresets({ default: [{ name: 'shared' }] }),
        });

        assert.equal(result.code, 0);
        assert.equal(
            result.stdout,
            'shared  run    (preset)\n' +
                'web     run    (cli)\n' +
                'api     debug  (cli)\n' +
                '→ execute_run_configuration  shared\n' +
                '→ execute_run_configuration  web\n' +
                '→ execute_terminal_command   NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }' +
                '--inspect-brk=127.0.0.1:9229" npm run api\n',
        );
        assert.match(result.stderr, /^would launch 3 configuration\(s\) via run-window:$/m);
        assert.deepEqual(result.executed, [], 'a dry run must never reach the execution seam');
    });

    test(':terminal opens a Terminal tab for that entry only, and says so in the header', async () => {
        const result = await wsc(['--dry-run', 'shared', 'web:terminal'], { idea: true });

        assert.equal(result.code, 0);
        // The command line itself is read off .idea/ (and may carry a PATH= for the
        // project's .nvmrc, which depends on this machine), so only its shape is pinned.
        const [shared, web, runCall, terminalCall, ...rest] = result.stdout.split('\n');
        assert.equal(shared, 'shared  run       (cli)');
        assert.equal(web, 'web     terminal  (cli)');
        assert.equal(runCall, '→ execute_run_configuration  shared');
        assert.match(terminalCall, /^→ execute_terminal_command {3}cd web && .*npm run dev$/);
        assert.deepEqual(rest, ['']);
        assert.match(result.stderr, /^would launch 2 configuration\(s\) via run-window \+ terminal:$/m);
        assert.doesNotMatch(result.stderr, /inspector|debug/i, 'nothing was rerouted, so nothing is announced');
        assert.deepEqual(result.executed, [], 'a dry run must never reach the execution seam');
    });

    test('each Terminal tab is titled after its configuration: the launch gets a session of that name', async () => {
        // The IDE titles a tab after the MCP client that opened it (see connectMcp), so the
        // launch is handed a way to open one session per tab, each called by the entry's name.
        const result = await wsc(['shared', 'web:terminal', 'api:terminal'], { idea: true });

        assert.equal(result.code, 0);
        const [ctx] = result.contexts;
        assert.deepEqual(ctx.calls.map((call) => call.tabName), [undefined, 'web', 'api']);

        await ctx.connectAs('web');
        const named = result.calls.filter((c) => c.type === 'connect' && c.clientName !== undefined);
        assert.deepEqual(named.map((c) => c.clientName), ['web']);
        assert.equal(named[0].port, 64542, 'the same MCP Server as the shared session');
        assert.ok(named[0].projectPath, 'and the same project — the IDE needs it on every session');
    });

    test('a preset entry with mode terminal launches the same way as :terminal', async () => {
        const result = await wsc(['--dry-run'], {
            idea: true,
            config: withPresets({ default: [{ name: 'shared' }, { name: 'web', mode: 'terminal' }] }),
        });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_terminal_command +cd web && .*npm run dev$/m);
        assert.match(result.stderr, /via run-window \+ terminal:$/m);
    });

    test('--target=terminal alone keeps the plain header: the whole run is already a terminal run', async () => {
        const result = await wsc(['--dry-run', '--target=terminal', 'web:terminal'], { idea: true });

        assert.equal(result.code, 0);
        assert.match(result.stderr, /via terminal:$/m);
    });

    test(':terminal on a configuration that cannot be a command is refused before anything is printed', async () => {
        const result = await wsc(['--dry-run', 'shared', 'Repro: Stale Job Cleanup:terminal']);

        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(result.output, /Node\.js/);
        assert.match(result.output, /Use :run/);
    });

    test('--debug-port moves the inspector port the plan prints', async () => {
        const result = await wsc(['--dry-run', '--debug-port', '9400', 'web:debug', 'api:debug']);

        assert.equal(result.code, 0);
        assert.match(result.stdout, /--inspect-brk=127\.0\.0\.1:9400" npm run web/);
        assert.match(result.stdout, /--inspect-brk=127\.0\.0\.1:9401" npm run api/);
    });

    test('a configuration that cannot be rebuilt is refused before anything is printed', async () => {
        // "Repro: Stale Job Cleanup" is a Node.js configuration: MCP reports no entry
        // file for it, so there is no command line to write into a Terminal tab.
        const result = await wsc(['--dry-run', '--target=terminal', 'Repro: Stale Job Cleanup']);

        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.match(result.output, /Node\.js/);
    });
});

// ── the phase-6 caveat: where a terminal command line comes from ─────────────
describe('terminal commands are read from .idea/, not guessed from the name', () => {
    test('--target=terminal runs the configuration\'s real definition', async () => {
        // The caveat: MCP reports only the name, so wsc used to send `npm run web` —
        // and demo-app has no root `web` script, so that tab died on arrival.
        const result = await wsc(['--dry-run', '--target=terminal', 'web'], { idea: true });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_terminal_command +cd web &&/);
        assert.match(result.stdout, /npm run dev$/m);
        assert.doesNotMatch(result.stdout, /npm run web/);
    });

    test(':debug rebuilds the real command too, with the inspector flag on it', async () => {
        const result = await wsc(['--dry-run', 'api:debug'], { idea: true });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /cd api &&.*--inspect-brk=127\.0\.0\.1:9229" npm run debug$/m);
    });

    test('the run-window path is unchanged: the IDE gets the name and owns the rest', async () => {
        const result = await wsc(['--dry-run', 'web'], { idea: true });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_run_configuration {2,}web$/m);
        assert.doesNotMatch(result.stdout, /npm run/);
    });

    test('a name .idea/ has not been written for falls back to the guess, and says so', async () => {
        // No .idea/ run configurations at all is the extreme of "the IDE has not saved it
        // yet" — every entry has to be guessed, so every one is named.
        const result = await wsc(['--dry-run', '--target=terminal', 'web']);

        assert.equal(result.code, 0);
        assert.match(result.stdout, /→ execute_terminal_command {2,}npm run web/);
        assert.match(result.stderr, /web is not in \.idea\/workspace\.xml/);
        assert.match(result.stderr, /rebuilt from the configuration name/);
    });

    test('nothing is said about a guess when there was none to make', async () => {
        const result = await wsc(['--dry-run', '--target=terminal', 'web'], { idea: true });
        assert.doesNotMatch(result.stderr, /rebuilt from the configuration name/);
    });

    test('a Node.js configuration reaches a terminal now that .idea/ names its file', async () => {
        // Refused outright before the fix — MCP knows of no entry file to run.
        const result = await wsc(
            ['--dry-run', '--target=terminal', 'Repro: Stale Job Cleanup'],
            { idea: true },
        );

        assert.equal(result.code, 0);
        assert.match(result.stdout, /node scripts\/reproduce-stale-job-cleanup\.js$/m);
    });

    test('a prefix is resolved before the lookup, so the canonical name is what .idea/ is asked for', async () => {
        // The resolve.js + planBuilder.js seam: `doc` is not a name WebStorm ever wrote,
        // and looking *that* up would silently degrade to the guess.
        const result = await wsc(['--dry-run', '--target=terminal', 'doc'], { idea: true });

        assert.equal(result.code, 0);
        assert.match(result.stdout, /^docs /m);
        assert.match(result.stdout, /cd docs && npm run dev$/m);
        assert.doesNotMatch(result.stderr, /rebuilt from the configuration name/);
    });

    test('.idea/ is not even read when every entry goes to a Run tab', async () => {
        let reads = 0;
        const result = await wsc(['--dry-run', 'web', 'api'], {
            idea: true,
            deps: { readIdeaRunConfigs: async () => (reads++, []) },
        });

        assert.equal(result.code, 0);
        assert.equal(reads, 0, 'the default path must not pay for a disk read it cannot use');
    });
});

// ── --fallback=retry|terminal ────────────────────────────────────────────────
describe('flag table — --fallback', () => {
    test('=terminal launches without the IDE instead of asking', async () => {
        const result = await wsc(['--fallback=terminal', 'web'], { idea: true, deps: { port: null } });

        assert.equal(result.code, 0);
        assert.equal(result.fellBack.length, 1);
        assert.deepEqual(result.fellBack[0].positionals, ['web']);
        assert.deepEqual(result.calls, [], 'the IDE was never contacted');
    });

    test('=terminal still honours --dry-run, which is the fallback\'s own half of that guard', async () => {
        const result = await wsc(['--fallback=terminal', '--dry-run', 'web'], {
            idea: true,
            deps: { port: null },
        });

        assert.equal(result.code, 0);
        assert.equal(result.fellBack[0].dryRun, true);
    });

    test('=retry re-probes and carries on with the IDE when it comes back', async () => {
        const result = await wsc(['web'], {
            deps: { port: null, fallbackChoice: { kind: 'connected', port: 64542 } },
        });

        assert.equal(result.code, 0);
        assert.deepEqual(launched(result), ['web:run']);
        assert.equal(result.calls[0].port, 64542);
    });

    test('a mode that does not exist is a usage error, before the IDE is contacted', async () => {
        const result = await wsc(['--fallback=maybe', 'web']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--fallback: expected one of retry, terminal, got "maybe"/);
        assert.deepEqual(result.calls, []);
    });

    test('=terminal with --configure is refused: there is nothing to launch', async () => {
        const result = await wsc(['--configure', '--fallback=terminal']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--configure has nothing to launch in a terminal/);
    });

    test('Ctrl-C at the unreachable-IDE prompt exits 130 without launching', async () => {
        const result = await wsc(['web'], {
            deps: { port: null, fallbackChoice: { kind: 'cancelled' } },
        });

        assert.equal(result.code, 130);
        assert.deepEqual(result.executed, []);
        assert.deepEqual(result.fellBack, []);
    });
});

// ── the listing's own formatting ─────────────────────────────────────────────
describe('formatRunConfigs', () => {
    test('aligns the description column against the longest name', async () => {
        const text = formatRunConfigs([
            { name: 'web', description: 'npm' },
            { name: 'Repro: Stale Job Cleanup', description: 'Node.js' },
        ]);

        assert.deepEqual(text.split('\n'), [
            'web                       npm',
            'Repro: Stale Job Cleanup  Node.js',
        ]);
    });

    test('a line ends where its content does, so a pipe sees no trailing padding', () => {
        const text = formatRunConfigs([{ name: 'a-very-long-name' }, { name: 'short' }]);

        assert.deepEqual(text.split('\n'), ['a-very-long-name', 'short']);
    });

    test('an empty catalogue formats to nothing at all', () => {
        assert.equal(formatRunConfigs([]), '');
    });
});
