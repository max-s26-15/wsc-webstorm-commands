import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import {
    NODE_TYPE,
    NPM_TYPE,
    buildFallbackCommand,
    parseRunConfigurations,
    readIdeaRunConfigs,
} from '../src/fallback/ideaRunConfigs.js';
import { tmpDir, tmpIdeaProject, tmpProject } from '../test-utils/tmp-dir.js';
import { skipWithoutPosixSh } from '../test-utils/shells.js';

const require = createRequire(import.meta.url);
/** The 13 configurations the live IDE reports for the same project, over MCP. */
const MCP_NAMES = require('./fixtures/run-configurations.json').configurations.map((c) => c.name);

const WORKSPACE_XML = readFileSync(new URL('./fixtures/idea-workspace.xml', import.meta.url), 'utf8');
const SHARED_XML = readFileSync(new URL('./fixtures/idea-shared-node.xml', import.meta.url), 'utf8');

const ROOT = '/projects/demo-app';
const HOME = '/home/dev';
const ctx = { projectRoot: ROOT, homeDir: HOME };

/**
 * @param {string} name
 * @param {import('../src/fallback/ideaRunConfigs.js').IdeaRunConfig[]} configs
 */
const byName = (name, configs) => /** @type {any} */ (configs.find((config) => config.name === name));

describe('parseRunConfigurations — the real workspace.xml', () => {
    const configs = parseRunConfigurations(WORKSPACE_XML, ctx);

    test('reads every npm configuration the IDE saved, once', () => {
        // The captured file holds 29 <configuration> elements for 12 distinct
        // configurations: workspace.xml repeats them. Without deduplication the resolver
        // would report every name as ambiguous with itself.
        assert.equal(WORKSPACE_XML.split('<configuration').length - 1, 29);
        assert.equal(configs.length, 12);
        assert.equal(new Set(configs.map((c) => c.name)).size, 12);
    });

    test('decodes the entity in a generated name', () => {
        // `client &gt; bundle:build` on disk. A name left encoded matches nothing a user
        // could ever type, and this is the shape of every auto-generated npm name.
        assert.ok(byName('client > bundle:build', configs), `names: ${configs.map((c) => c.name).join(', ')}`);
    });

    test('carries the real package.json directory and script, not a guess from the name', () => {
        // The whole reason this file exists: the configuration called "web" runs the
        // script `dev` in web/package.json. Nothing about that is inferable from the
        // name — there is no `web` script anywhere in the project.
        const web = byName('web', configs);
        assert.equal(web.type, NPM_TYPE);
        assert.equal(web.description, 'npm');
        assert.deepEqual(web.scripts, ['dev']);
        assert.equal(web.command, 'run');
        // Macros are substituted into the IDE's own text, so its '/' stays — on Windows too.
        assert.equal(web.dir, `${ROOT}/web`);
    });

    test('expands $PROJECT_DIR$ and $USER_HOME$', () => {
        const client = byName('client > bundle:build', configs);
        assert.equal(client.dir, `${ROOT}/gateway/addon/client`);

        const web = byName('web', configs);
        assert.equal(web.interpreter, `${HOME}/.nvm/versions/node/v14.21.3/bin/node`);
    });

    test('a node-interpreter of "project" is not a path to pin', () => {
        assert.equal(byName('client > bundle:build', configs).interpreter, undefined);
    });
});

describe('parseRunConfigurations — shapes that must not slip through', () => {
    test('reads a shared Node.js configuration, with its working directory', () => {
        const [repro] = parseRunConfigurations(SHARED_XML, ctx);
        assert.equal(repro.name, 'Repro: Stale Job Cleanup');
        assert.equal(repro.type, NODE_TYPE);
        assert.equal(repro.description, 'Node.js');
        assert.equal(repro.dir, `${ROOT}/api`);
        assert.equal(repro.file, `${ROOT}/api/scripts/reproduce-stale-job-cleanup.js`);
    });

    test('reads the Node parameters of a Node.js configuration', () => {
        const xml = `<component name="RunManager"><configuration name="app" type="${NODE_TYPE}"
            node-parameters="--require ./setup.js --max-old-space-size=4096"
            path-to-js-file="$PROJECT_DIR$/src/index.js" working-dir="$PROJECT_DIR$"><method v="2" /></configuration></component>`;
        const [app] = parseRunConfigurations(xml, ctx);
        assert.equal(app.nodeArgs, '--require ./setup.js --max-old-space-size=4096');
    });

    test('ignores template configurations, named or not', () => {
        // `default="true"` is an "Edit configuration templates…" entry: it launches nothing,
        // so offering it would be offering a phantom. The attribute is the marker, not the
        // absence of a name — the IDE writes `default="false"` explicitly on the real ones,
        // so a template that does carry one must not slip through on that alone.
        const xml = `<component name="RunManager">
            <configuration default="true" type="${NPM_TYPE}" factoryName="npm" />
            <configuration default="true" name="npm template" type="${NPM_TYPE}" />
            <configuration default="false" name="real" type="${NPM_TYPE}"><command value="run" /><scripts>
                <script value="dev" /></scripts></configuration>
        </component>`;
        assert.deepEqual(parseRunConfigurations(xml, ctx).map((c) => c.name), ['real']);
    });

    test('ignores <configuration> elements outside the two run-configuration components', () => {
        const xml = `<project>
            <component name="ProjectModuleManager">
                <configuration name="not a run configuration" type="${NPM_TYPE}" />
            </component>
        </project>`;
        assert.deepEqual(parseRunConfigurations(xml, ctx), []);
    });

    test('ignores commented-out configurations', () => {
        const xml = `<component name="RunManager">
            <!-- <configuration name="kept just in case" type="${NPM_TYPE}" /> -->
            <configuration name="real" type="${NPM_TYPE}" />
        </component>`;
        assert.deepEqual(parseRunConfigurations(xml, ctx).map((c) => c.name), ['real']);
    });

    test('an unsupported type keeps its raw id, so the refusal can name it', () => {
        const xml = '<component name="RunManager"><configuration name="docker" type="docker-deploy" /></component>';
        const [docker] = parseRunConfigurations(xml, ctx);
        assert.equal(docker.description, 'docker-deploy');
    });

    test('reads environment variables, and an env called __proto__ does not poison anything', () => {
        // A legal env var name that a plain `obj[name] = value` would turn into a prototype
        // mutation — the same hazard preset names have, per the house rule.
        const xml = `<component name="RunManager"><configuration name="x" type="${NPM_TYPE}">
            <envs>
              <env name="PORT" value="3000" />
              <env name="__proto__" value="polluted" />
              <env name="ROOT" value="$PROJECT_DIR$/logs" />
            </envs></configuration></component>`;
        const [config] = parseRunConfigurations(xml, ctx);

        assert.equal(config.envs?.PORT, '3000');
        assert.equal(config.envs?.ROOT, `${ROOT}/logs`);

        // Kept as a real, own entry — `obj['__proto__'] = value` would silently drop it
        // (assigning a string to __proto__ is a no-op), so the tab would run without an
        // environment variable the IDE says it needs.
        assert.equal(Object.hasOwn(/** @type {object} */ (config.envs), '__proto__'), true);
        assert.equal(Object.getPrototypeOf({}).polluted, undefined);
        assert.match(
            buildFallbackCommand({ ...config, dir: ROOT, scripts: ['dev'] }, 'run', { projectRoot: ROOT }),
            /__proto__=polluted/,
        );
    });

    test('a self-closing configuration is read as well as a nested one', () => {
        const xml = `<component name="RunManager">
            <configuration name="closed" type="${NPM_TYPE}" />
            <configuration name="open" type="${NPM_TYPE}"></configuration>
        </component>`;
        assert.deepEqual(parseRunConfigurations(xml, ctx).map((c) => c.name), ['closed', 'open']);
    });
});

describe('readIdeaRunConfigs', () => {
    test('reports exactly the names the live IDE reports over MCP', async () => {
        // The claim the whole fallback rests on: what WebStorm saved to disk is the same
        // list get_run_configurations answers with. Both fixtures come from demo-app.
        const project = await tmpIdeaProject();
        try {
            const configs = await readIdeaRunConfigs(project.dir);
            assert.deepEqual(configs.map((c) => c.name).sort(), [...MCP_NAMES].sort());
        } finally {
            await project.cleanup();
        }
    });

    test('shared configurations come first, in the order the IDE lists them', async () => {
        const project = await tmpIdeaProject();
        try {
            const configs = await readIdeaRunConfigs(project.dir);
            assert.equal(configs[0].name, 'Repro: Stale Job Cleanup');
        } finally {
            await project.cleanup();
        }
    });

    test('a project with no saved run configurations is empty, not an error', async () => {
        const project = await tmpProject();
        try {
            assert.deepEqual(await readIdeaRunConfigs(project.dir), []);
        } finally {
            await project.cleanup();
        }
    });

    test('a configuration that pins no interpreter gets the one .nvmrc names; a pinned one keeps its own', async () => {
        // The bug this pins: `int` (a Node.js configuration with no path-to-node) and every
        // npm configuration stored as `project` used to leave PATH alone, so the tab ran
        // whatever node the shell defaulted to — v20 here, for a project the IDE runs on v14.
        const project = await tmpIdeaProject();
        const home = await tmpDir('wsc-home-');
        try {
            const bin = path.join(home.dir, '.nvm', 'versions', 'node', 'v20.20.0', 'bin');
            await fs.mkdir(bin, { recursive: true });
            await fs.writeFile(path.join(bin, 'node'), '');
            await fs.writeFile(path.join(project.dir, '.nvmrc'), '20\n');

            const configs = await readIdeaRunConfigs(project.dir, { homeDir: home.dir, env: {} });

            assert.equal(byName('client > bundle:build', configs).interpreter, path.join(bin, 'node'));
            // `web` pins v14.21.3 in the fixture; the project setting must not override it.
            assert.equal(
                byName('web', configs).interpreter,
                `${home.dir}/.nvm/versions/node/v14.21.3/bin/node`,
            );
        } finally {
            await home.cleanup();
            await project.cleanup();
        }
    });

    test('without a resolvable .nvmrc a configuration that pins nothing stays unpinned', async () => {
        const project = await tmpIdeaProject();
        const home = await tmpDir('wsc-home-');
        try {
            const configs = await readIdeaRunConfigs(project.dir, { homeDir: home.dir, env: {} });
            assert.equal(byName('client > bundle:build', configs).interpreter, undefined);
        } finally {
            await home.cleanup();
            await project.cleanup();
        }
    });

    test('a shared copy wins over the one remembered in workspace.xml', async () => {
        const project = await tmpIdeaProject({ workspace: false });
        try {
            const shared = path.join(project.dir, '.idea', 'runConfigurations');
            await fs.writeFile(
                path.join(shared, 'web.xml'),
                `<component name="ProjectRunConfigurationManager"><configuration name="web" type="${NPM_TYPE}">
                    <package-json value="$PROJECT_DIR$/shared-copy/package.json" />
                    <command value="run" /><scripts><script value="start" /></scripts>
                </configuration></component>`,
            );
            await fs.copyFile(
                new URL('./fixtures/idea-workspace.xml', import.meta.url),
                path.join(project.dir, '.idea', 'workspace.xml'),
            );

            const configs = await readIdeaRunConfigs(project.dir);
            assert.deepEqual(byName('web', configs).scripts, ['start']);
            assert.equal(configs.filter((c) => c.name === 'web').length, 1);
        } finally {
            await project.cleanup();
        }
    });

    test('a directory that is not a project at all yields nothing rather than throwing', async () => {
        assert.deepEqual(await readIdeaRunConfigs('/nowhere/at/all'), []);
    });
});

describe('buildFallbackCommand', () => {
    /** @param {object} extra */
    const npm = (extra) => /** @type {any} */ ({ name: 'x', description: 'npm', type: NPM_TYPE, command: 'run', ...extra });

    test('a root-level script gets no cd', () => {
        const command = buildFallbackCommand(npm({ dir: ROOT, scripts: ['dev'] }), 'run', { projectRoot: ROOT });
        assert.equal(command, 'npm run dev');
    });

    test('a workspace script cds first, relative to the project root', () => {
        const config = npm({ dir: path.join(ROOT, 'gateway/addon/client'), scripts: ['bundle:build'] });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            'cd gateway/addon/client && npm run bundle:build',
        );
    });

    test('debug mode reuses the IDE path\'s NODE_OPTIONS prefix, verbatim', async () => {
        // Imported here rather than at the top so the assertion is visibly against
        // planBuilder's own function: the two paths must produce byte-identical prefixes,
        // or "attach to port 9230" means two different things depending on the path.
        const { debugEnvPrefix } = await import('../src/exec/planBuilder.js');
        const config = npm({ dir: ROOT, scripts: ['dev'] });

        assert.equal(
            buildFallbackCommand(config, 'debug', { projectRoot: ROOT, debugPort: 9231 }),
            `${debugEnvPrefix(9231)} npm run dev`,
        );
    });

    test('the pinned interpreter goes on PATH, so the tab uses the node the IDE would', () => {
        const config = npm({ dir: ROOT, scripts: ['dev'], interpreter: `${HOME}/.nvm/versions/node/v14.21.3/bin/node` });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            `PATH=${HOME}/.nvm/versions/node/v14.21.3/bin:"$PATH" npm run dev`,
        );
    });

    test('environment variables are quoted, the NODE_OPTIONS prefix is not', () => {
        const config = npm({ dir: ROOT, scripts: ['dev'], envs: { TOKEN: 'a b c' } });
        const command = buildFallbackCommand(config, 'debug', { projectRoot: ROOT, debugPort: 9229 });

        assert.match(command, /TOKEN='a b c'/);
        // Quoting this one is what would stop the expansion it exists for.
        assert.match(command, /NODE_OPTIONS="\$\{NODE_OPTIONS:\+\$NODE_OPTIONS }--inspect-brk=127\.0\.0\.1:9229"/);
    });

    test('a Node.js configuration keeps its Node parameters between `node` and the file', () => {
        // They are flags to node itself, so they must come before the file: after it they
        // would be the program's own arguments and node would never see them.
        const config = /** @type {any} */ ({
            name: 'app',
            description: 'Node.js',
            type: NODE_TYPE,
            dir: ROOT,
            file: path.join(ROOT, 'src/index.js'),
            nodeArgs: '--require ./setup.js',
            args: '--verbose',
        });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            'node --require ./setup.js src/index.js --verbose',
        );
    });

    test('a script name that needs quoting gets it', () => {
        const config = npm({ dir: ROOT, scripts: ["it's weird"] });
        assert.equal(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), "npm run 'it'\\''s weird'");
    });

    test('a colon-heavy script name is left bare — it needs no quoting', () => {
        const config = npm({ dir: path.join(ROOT, 'api'), scripts: ['repro:stale-job:debug'] });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            'cd api && npm run repro:stale-job:debug',
        );
    });

    test('an npm command other than run is complete on its own', () => {
        const config = npm({ dir: ROOT, command: 'install', scripts: [] });
        assert.equal(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), 'npm install');
    });

    test('the configuration\'s own arguments are passed through npm\'s -- separator', () => {
        const config = npm({ dir: ROOT, scripts: ['dev'], args: '--port 3000' });
        assert.equal(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), 'npm run dev -- --port 3000');
    });

    test('a Node.js configuration runs its file, relative to its working directory', () => {
        const config = /** @type {any} */ ({
            name: 'Repro',
            description: 'Node.js',
            type: NODE_TYPE,
            dir: path.join(ROOT, 'api'),
            file: path.join(ROOT, 'api/scripts/repro.js'),
            args: '--verbose',
        });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            'cd api && node scripts/repro.js --verbose',
        );
    });

    test('a type it cannot rebuild is refused, naming the type', () => {
        const config = /** @type {any} */ ({ name: 'db', description: 'docker-deploy', type: 'docker-deploy' });
        assert.throws(
            () => buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            (err) => err.name === 'FallbackError' && /docker-deploy/.test(err.message) && /cannot launch "db"/.test(err.message),
        );
    });

    test('a debug request for a type it cannot rebuild says "cannot debug"', () => {
        const config = /** @type {any} */ ({ name: 'db', description: 'docker-deploy', type: 'docker-deploy' });
        assert.throws(
            () => buildFallbackCommand(config, 'debug', { projectRoot: ROOT }),
            /cannot debug "db"/,
        );
    });

    test('several npm scripts in one configuration are refused rather than guessed at', () => {
        const config = npm({ dir: ROOT, scripts: ['build', 'dev'] });
        assert.throws(
            () => buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            (err) => err.name === 'FallbackError' && /runs 2 npm scripts/.test(err.message),
        );
    });

    test('an environment variable name that is not an identifier is refused, not pasted in', () => {
        const config = npm({ dir: ROOT, scripts: ['dev'], envs: { 'X; touch /tmp/pwned': '1' } });
        assert.throws(
            () => buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            (err) =>
                err.name === 'FallbackError' &&
                /not a plain identifier/.test(err.message) &&
                /"X; touch \/tmp\/pwned"/.test(err.message),
        );
    });

    test('an ordinary environment variable name still passes', () => {
        // The guard is a refusal, so it has to be narrow: a leading underscore and digits
        // after the first character are both legal, and both appear in real projects.
        const config = npm({ dir: ROOT, scripts: ['dev'], envs: { _PORT_2: '3000' } });
        assert.equal(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), "_PORT_2=3000 npm run dev");
    });

    test('a hand-edited npm command is one word, not a second command', () => {
        const config = npm({ dir: ROOT, command: 'install; touch pwned', scripts: [] });
        assert.equal(
            buildFallbackCommand(config, 'run', { projectRoot: ROOT }),
            "npm 'install; touch pwned'",
        );
    });

    test('a Node.js configuration with no file is refused', () => {
        const config = /** @type {any} */ ({ name: 'broken', description: 'Node.js', type: NODE_TYPE, dir: ROOT });
        assert.throws(() => buildFallbackCommand(config, 'run', { projectRoot: ROOT }), /names no file to run/);
    });
});

describe('buildFallbackCommand — a hostile .idea file cannot run a second command', { skip: skipWithoutPosixSh }, () => {
    // .idea/runConfigurations/*.xml is normally checked into the repository, so its
    // contents are as untrusted as any other file a clone brings with it. These pin the
    // behaviour rather than the spelling: the built line is handed to a real shell, and
    // the question asked is the only one that matters — did a second process run?
    const sh = promisify(execFile);

    /**
     * @param {string} command
     * @param {string} cwd
     */
    const run = (command, cwd) =>
        // npm is stubbed out: nothing here is about npm, only about how the shell splits
        // the line, and a real `npm install` in a temp directory would be slow and online.
        sh('/bin/sh', ['-c', `npm() { :; }\n${command}`], { cwd });

    /** @param {object} extra */
    const npm = (extra) => /** @type {any} */ ({ name: 'x', description: 'npm', type: NPM_TYPE, command: 'run', dir: ROOT, ...extra });

    test('an npm subcommand out of the XML cannot become a command of its own', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const marker = path.join(dir, 'pwned');
            const config = npm({ command: `install; touch ${marker}`, scripts: [] });

            await run(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), dir);
            assert.equal(existsSync(marker), false, 'the subcommand ran as a second command');

            // Control: unquoted, the very same text does create the file — so the
            // assertion above discriminates instead of passing for its own reasons.
            const control = path.join(dir, 'control');
            await run(`npm install; touch ${control}`, dir);
            assert.equal(existsSync(control), true);
        } finally {
            await cleanup();
        }
    });

    test('an environment value out of the XML is data, not a substitution', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const marker = path.join(dir, 'pwned');
            const config = npm({ scripts: ['dev'], envs: { TOKEN: `$(touch ${marker})` } });

            await run(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), dir);
            assert.equal(existsSync(marker), false, 'the value was expanded by the shell');

            const control = path.join(dir, 'control');
            await run(`TOKEN=$(touch ${control}) npm run dev`, dir);
            assert.equal(existsSync(control), true);
        } finally {
            await cleanup();
        }
    });

    test('the refused environment name is refused because it would really have run', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const marker = path.join(dir, 'pwned');
            // The trailing `#` comments out the `='1' npm run dev` the assignment would
            // have become, which is what makes the payload a clean second command.
            const name = `X; touch ${marker} #`;
            const config = npm({ scripts: ['dev'], envs: { [name]: '1' } });

            assert.throws(() => buildFallbackCommand(config, 'run', { projectRoot: ROOT }), /not a plain identifier/);

            // What the refusal is avoiding: an assignment prefix cannot be quoted, so the
            // name goes into the line as-is or not at all. As-is, this is two commands.
            await run(`${name}='1' npm run dev`, dir).catch(() => {});
            assert.equal(existsSync(marker), true, 'the name is harmless after all — the guard is pointless');
        } finally {
            await cleanup();
        }
    });

    test('a script name out of the XML cannot become a command of its own', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const marker = path.join(dir, 'pwned');
            const config = npm({ scripts: [`dev; touch ${marker}`] });

            await run(buildFallbackCommand(config, 'run', { projectRoot: ROOT }), dir);
            assert.equal(existsSync(marker), false);
        } finally {
            await cleanup();
        }
    });
});
