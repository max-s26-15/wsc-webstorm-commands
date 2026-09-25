import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    CONFIG_DIR,
    CONFIG_FILE,
    DEFAULT_PRESET,
    PresetConfigError,
    SCHEMA_VERSION,
    configPath,
    deletePreset,
    emptyConfig,
    findProjectRoot,
    getPreset,
    hasPreset,
    isCustomEntry,
    listPresets,
    MIGRATIONS,
    migrateConfig,
    parseConfig,
    readPresets,
    serializeConfig,
    setPreset,
    writeFileAtomic,
    renameWithRetry,
    writePresets,
} from '../src/presets/store.js';
import { tmpArtifacts, tmpDir, tmpProject } from '../test-utils/tmp-dir.js';

const STORE_URL = pathToFileURL(fileURLToPath(new URL('../src/presets/store.js', import.meta.url))).href;

/** A config exercising every field, including ones this build does not know. */
const SAMPLE = {
    version: 1,
    defaultPreset: 'default',
    presets: {
        default: [
            { name: 'web', mode: 'debug' },
            { name: 'api', mode: 'run' },
        ],
        backend: [{ name: 'mailer', mode: 'run' }],
    },
};

describe('findProjectRoot', () => {
    test('finds the directory containing .idea/', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            assert.equal(await findProjectRoot(dir), await fs.realpath(dir));
        } finally {
            await cleanup();
        }
    });

    test('walks up from a nested directory', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const nested = path.join(dir, 'packages', 'api', 'src');
            await fs.mkdir(nested, { recursive: true });
            assert.equal(await findProjectRoot(nested), await fs.realpath(dir));
        } finally {
            await cleanup();
        }
    });

    test('stops at the nearest .idea/ when projects are nested', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const inner = path.join(dir, 'inner');
            await fs.mkdir(path.join(inner, CONFIG_DIR), { recursive: true });
            assert.equal(await findProjectRoot(inner), await fs.realpath(inner));
        } finally {
            await cleanup();
        }
    });

    test('a project reached through a symlink resolves to its real path', async () => {
        // macOS's temp dir is /var/…, a symlink to /private/var/…; the IDE knows a project
        // by its real path, so the root handed to it (projectPath) has to be that one.
        const { dir, cleanup } = await tmpProject();
        const { dir: links, cleanup: cleanupLinks } = await tmpDir();
        try {
            const link = path.join(links, 'linked-project');
            await fs.symlink(dir, link, 'dir');
            assert.equal(await findProjectRoot(path.join(link)), await fs.realpath(dir));
        } finally {
            await cleanupLinks();
            await cleanup();
        }
    });

    test('returns null when no .idea/ exists up to the filesystem root', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            // /tmp itself must not contain .idea/ for this to be meaningful.
            const root = await findProjectRoot(dir);
            assert.ok(root === null || !root.startsWith(dir), 'no project root inside a bare tmp dir');
        } finally {
            await cleanup();
        }
    });

    test('ignores a file named .idea', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            await fs.writeFile(path.join(dir, CONFIG_DIR), 'not a directory');
            const root = await findProjectRoot(dir);
            assert.ok(root === null || root !== dir);
        } finally {
            await cleanup();
        }
    });
});

describe('configPath / emptyConfig', () => {
    test('builds the path inside .idea/', () => {
        assert.equal(configPath('/home/me/project'), path.join('/home/me/project', CONFIG_DIR, CONFIG_FILE));
    });

    test('an empty config is valid and has no presets', () => {
        const config = emptyConfig();
        assert.equal(config.version, SCHEMA_VERSION);
        assert.equal(config.defaultPreset, DEFAULT_PRESET);
        assert.deepEqual(config.presets, {});
    });
});

describe('parseConfig — valid input', () => {
    test('round-trips a full config', () => {
        assert.deepEqual(parseConfig(JSON.stringify(SAMPLE)), SAMPLE);
    });

    test('fills in missing version and defaultPreset', () => {
        const config = parseConfig('{"presets":{}}');
        assert.equal(config.version, SCHEMA_VERSION);
        assert.equal(config.defaultPreset, DEFAULT_PRESET);
    });

    test('accepts a config with no presets key at all', () => {
        assert.deepEqual(parseConfig('{}').presets, {});
    });

    test('defaults a missing entry mode to run', () => {
        const config = parseConfig('{"presets":{"default":[{"name":"api"}]}}');
        assert.equal(config.presets.default[0].mode, 'run');
    });

    test('keeps unknown top-level keys — a newer wsc may have written them', () => {
        const config = parseConfig('{"version":1,"presets":{},"futureFlag":{"a":1}}');
        assert.deepEqual(config.futureFlag, { a: 1 });
    });

    test('keeps unknown keys inside a preset entry', () => {
        const config = parseConfig('{"presets":{"default":[{"name":"api","mode":"run","color":"red"}]}}');
        assert.equal(config.presets.default[0].color, 'red');
    });

    test('upgrades an older schema version', () => {
        assert.equal(parseConfig('{"version":0,"presets":{}}').version, SCHEMA_VERSION);
    });
});

describe('parseConfig — rejected input', () => {
    /** @param {string} text @param {RegExp} message */
    const rejects = (text, message) => {
        assert.throws(() => parseConfig(text, '/p/.idea/c.json'), (err) => {
            assert.ok(err instanceof PresetConfigError);
            assert.equal(err.filePath, '/p/.idea/c.json');
            assert.match(err.message, /^\/p\/\.idea\/c\.json: /, 'the message must name the file to fix');
            assert.match(err.detail, message);
            return true;
        });
    };

    test('malformed JSON', () => rejects('{not json', /invalid JSON/));
    test('a JSON array', () => rejects('[]', /expected a JSON object/));
    test('JSON null', () => rejects('null', /expected a JSON object/));
    test('a non-integer version', () => rejects('{"version":"1"}', /"version" must be an integer/));
    test('a fractional version', () => rejects('{"version":1.5}', /"version" must be an integer/));
    test('a version from a newer wsc', () =>
        rejects(`{"version":${SCHEMA_VERSION + 1}}`, /written by a newer version of wsc/));
    test('a non-string defaultPreset', () => rejects('{"defaultPreset":5}', /"defaultPreset" must be a string/));
    test('presets as an array', () => rejects('{"presets":[]}', /"presets" must be an object/));
    test('a preset that is not an array', () => rejects('{"presets":{"a":{}}}', /preset "a" must be an array/));
    test('an entry that is neither an object nor a name', () =>
        rejects('{"presets":{"a":[42]}}', /preset "a" entry 0 must be an object/));
    test('a bare string entry once the schema is current', () =>
        rejects(`{"version":${SCHEMA_VERSION},"presets":{"a":["api"]}}`, /entry 0 must be an object/));
    test('an entry without a name', () =>
        rejects('{"presets":{"a":[{"mode":"run"}]}}', /entry 0 is missing a non-empty "name"/));
    test('an entry with an empty name', () =>
        rejects('{"presets":{"a":[{"name":""}]}}', /entry 0 is missing a non-empty "name"/));
    test('an unknown mode', () =>
        rejects('{"presets":{"a":[{"name":"api","mode":"profile"}]}}', /expected run, debug or terminal/));

    test('terminal is a mode, and survives a round trip', () => {
        const config = parseConfig('{"presets":{"default":[{"name":"web","mode":"terminal"}]}}');
        assert.deepEqual(config.presets.default, [{ name: 'web', mode: 'terminal' }]);
        assert.deepEqual(parseConfig(serializeConfig(config)).presets.default, config.presets.default);
    });

    test('names the offending entry index, not just the preset', () => {
        assert.throws(
            () => parseConfig('{"presets":{"backend":[{"name":"a"},{"name":"b","mode":"x"}]}}'),
            /preset "backend" entry 1/,
        );
    });
});

describe('migrations', () => {
    test('every version below the current one has a migration', () => {
        for (let version = 0; version < SCHEMA_VERSION; version++) {
            assert.equal(typeof MIGRATIONS[version], 'function', `missing migration from schema ${version}`);
        }
    });

    test('a config with no version is treated as v0 and upgraded', () => {
        assert.equal(parseConfig('{"presets":{}}').version, SCHEMA_VERSION);
    });

    test('v0 bare-string entries become full entries in run mode', () => {
        const config = parseConfig('{"presets":{"default":["web","api"]}}');
        assert.deepEqual(config.presets.default, [
            { name: 'web', mode: 'run' },
            { name: 'api', mode: 'run' },
        ]);
    });

    test('v0 tolerates a preset mixing strings and full entries', () => {
        const config = parseConfig('{"presets":{"default":["web",{"name":"api","mode":"debug"}]}}');
        assert.deepEqual(config.presets.default, [
            { name: 'web', mode: 'run' },
            { name: 'api', mode: 'debug' },
        ]);
    });

    test('names containing colons survive the v0 shorthand untouched', () => {
        // Mode parsing belongs to the resolver; the store must not guess here.
        const config = parseConfig('{"presets":{"default":["api > repro:stale-job:debug"]}}');
        assert.deepEqual(config.presets.default, [
            { name: 'api > repro:stale-job:debug', mode: 'run' },
        ]);
    });

    test('migration keeps unknown top-level fields', () => {
        const config = parseConfig('{"presets":{"default":["api"]},"futureFlag":7}');
        assert.equal(config.futureFlag, 7);
        assert.equal(config.version, SCHEMA_VERSION);
    });

    test('migration keeps defaultPreset', () => {
        assert.equal(parseConfig('{"defaultPreset":"backend","presets":{}}').defaultPreset, 'backend');
    });

    test('a config already at the current version is passed through unchanged', () => {
        const config = { ...emptyConfig(), presets: { default: [{ name: 'api', mode: 'debug' }] } };
        assert.deepEqual(migrateConfig(structuredClone(config)), config);
    });

    test('migrateConfig refuses a version it has no path from', () => {
        assert.throws(
            () => migrateConfig({ version: -5, defaultPreset: 'default', presets: {} }, '/p/c.json'),
            (err) => {
                assert.ok(err instanceof PresetConfigError);
                assert.match(err.detail, /no migration path from schema version -5/);
                return true;
            },
        );
    });

    test('a broken v0 preset still fails validation after migration', () => {
        // Migration is not a licence to accept nonsense — the validator runs last.
        assert.throws(() => parseConfig('{"presets":{"a":[{"name":"api","mode":"profile"}]}}'), PresetConfigError);
    });

    test('reading a v0 file does not rewrite it on disk', async () => {
        const legacy = '{"presets":{"default":["web","api"]}}';
        const { dir, cleanup } = await tmpProject(legacy);
        try {
            const config = await readPresets(dir);
            assert.equal(config.version, SCHEMA_VERSION, 'migrated in memory');
            assert.equal(await fs.readFile(configPath(dir), 'utf8'), legacy, 'but untouched on disk');
        } finally {
            await cleanup();
        }
    });

    test('the upgrade is persisted by the next write', async () => {
        const { dir, cleanup } = await tmpProject('{"presets":{"default":["web"]}}');
        try {
            await writePresets(dir, await readPresets(dir));

            const onDisk = JSON.parse(await fs.readFile(configPath(dir), 'utf8'));
            assert.equal(onDisk.version, SCHEMA_VERSION);
            assert.deepEqual(onDisk.presets.default, [{ name: 'web', mode: 'run' }]);
        } finally {
            await cleanup();
        }
    });

    test('migrating twice changes nothing the second time', async () => {
        const { dir, cleanup } = await tmpProject('{"presets":{"default":["web","api"]}}');
        try {
            await writePresets(dir, await readPresets(dir));
            const first = await fs.readFile(configPath(dir), 'utf8');

            await writePresets(dir, await readPresets(dir));
            assert.equal(await fs.readFile(configPath(dir), 'utf8'), first);
        } finally {
            await cleanup();
        }
    });
});

describe('serializeConfig', () => {
    test('ends with a newline', () => {
        assert.ok(serializeConfig(emptyConfig()).endsWith('}\n'));
    });

    test('uses two-space indentation', () => {
        assert.match(serializeConfig(SAMPLE), /\n {2}"version"/);
    });

    test('writes known keys in a fixed order', () => {
        const text = serializeConfig({ presets: {}, defaultPreset: 'x', version: 1, zzz: 1 });
        assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'defaultPreset', 'presets', 'zzz']);
    });

    test('sorts unknown keys so output is deterministic', () => {
        const text = serializeConfig({ ...emptyConfig(), zeta: 1, alpha: 2 });
        const keys = Object.keys(JSON.parse(text));
        assert.deepEqual(keys.slice(3), ['alpha', 'zeta']);
    });

    test('puts name and mode first inside an entry', () => {
        const text = serializeConfig({
            ...emptyConfig(),
            presets: { default: [{ color: 'red', mode: 'debug', name: 'api' }] },
        });
        assert.deepEqual(Object.keys(JSON.parse(text).presets.default[0]), ['name', 'mode', 'color']);
    });

    test('is idempotent — rewriting an unchanged config produces identical bytes', () => {
        const once = serializeConfig(SAMPLE);
        assert.equal(serializeConfig(parseConfig(once)), once);
    });
});

describe('readPresets', () => {
    test('returns an empty config when the file does not exist', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            assert.deepEqual(await readPresets(dir), emptyConfig());
        } finally {
            await cleanup();
        }
    });

    test('returns an empty config when .idea/ does not exist either', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            assert.deepEqual(await readPresets(dir), emptyConfig());
        } finally {
            await cleanup();
        }
    });

    test('reads an existing config', async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify(SAMPLE));
        try {
            assert.deepEqual(await readPresets(dir), SAMPLE);
        } finally {
            await cleanup();
        }
    });

    test('propagates read errors other than "file missing"', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            // A directory where the config should be: readable path, unreadable file.
            await fs.mkdir(configPath(dir));
            await assert.rejects(() => readPresets(dir), (err) => {
                assert.ok(!(err instanceof PresetConfigError), 'an I/O failure is not a config error');
                assert.equal(err.code, 'EISDIR');
                return true;
            });
        } finally {
            await cleanup();
        }
    });

    test('throws with the real path when the file is corrupt', async () => {
        const { dir, cleanup } = await tmpProject('{broken');
        try {
            await assert.rejects(() => readPresets(dir), (err) => {
                assert.ok(err instanceof PresetConfigError);
                assert.equal(err.filePath, configPath(dir));
                return true;
            });
        } finally {
            await cleanup();
        }
    });
});

describe('writePresets', () => {
    test('round-trips through the filesystem', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await writePresets(dir, SAMPLE);
            assert.deepEqual(await readPresets(dir), SAMPLE);
        } finally {
            await cleanup();
        }
    });

    test('creates .idea/ when the project does not have one yet', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const written = await writePresets(dir, SAMPLE);
            assert.equal(written, configPath(dir));
            assert.deepEqual(await readPresets(dir), SAMPLE);
        } finally {
            await cleanup();
        }
    });

    test('does not drop unknown fields across a read/write cycle', async () => {
        const original = '{"version":1,"defaultPreset":"default","presets":{"default":[{"name":"api","mode":"run","note":"keep me"}]},"futureFlag":true}';
        const { dir, cleanup } = await tmpProject(original);
        try {
            await writePresets(dir, await readPresets(dir));
            const reread = await readPresets(dir);
            assert.equal(reread.futureFlag, true);
            assert.equal(reread.presets.default[0].note, 'keep me');
        } finally {
            await cleanup();
        }
    });

    test('leaves no temp files behind', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await writePresets(dir, SAMPLE);
            assert.deepEqual(await tmpArtifacts(path.join(dir, CONFIG_DIR)), []);
        } finally {
            await cleanup();
        }
    });

    test('preserves the existing file permissions', {
        skip: process.platform === 'win32' && 'Windows has no POSIX permission bits',
    }, async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify(SAMPLE));
        try {
            const file = configPath(dir);
            await fs.chmod(file, 0o640);
            await writePresets(dir, SAMPLE);
            assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
        } finally {
            await cleanup();
        }
    });

    test('rewriting an unchanged config produces byte-identical output', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await writePresets(dir, SAMPLE);
            const first = await fs.readFile(configPath(dir), 'utf8');
            await writePresets(dir, await readPresets(dir));
            assert.equal(await fs.readFile(configPath(dir), 'utf8'), first);
        } finally {
            await cleanup();
        }
    });
});

describe('renameWithRetry — Windows refuses a rename onto a file that is busy', () => {
    /** A rename that fails with `code` for the first `failures` calls, then succeeds. */
    const flaky = (code, failures) => {
        const calls = [];
        const rename = async (from, to) => {
            calls.push([from, to]);
            if (calls.length <= failures) throw Object.assign(new Error(`${code}: rename`), { code });
        };
        return { rename, calls };
    };

    test('a transient EPERM on Windows is retried until the rename goes through', async () => {
        const { rename, calls } = flaky('EPERM', 2);
        await renameWithRetry('a.tmp', 'a', { rename, platform: 'win32', delayMs: 0 });
        assert.equal(calls.length, 3);
    });

    test('EACCES and EBUSY are the same kind of busy', async () => {
        for (const code of ['EACCES', 'EBUSY']) {
            const { rename, calls } = flaky(code, 1);
            await renameWithRetry('a.tmp', 'a', { rename, platform: 'win32', delayMs: 0 });
            assert.equal(calls.length, 2, code);
        }
    });

    test('it gives up after a bounded number of attempts, with the last error', async () => {
        const { rename, calls } = flaky('EPERM', Infinity);
        await assert.rejects(renameWithRetry('a.tmp', 'a', { rename, platform: 'win32', delayMs: 0, attempts: 4 }), { code: 'EPERM' });
        assert.equal(calls.length, 4);
    });

    test('elsewhere an EPERM is a real refusal and is not retried', async () => {
        const { rename, calls } = flaky('EPERM', 1);
        await assert.rejects(renameWithRetry('a.tmp', 'a', { rename, platform: 'linux', delayMs: 0 }), { code: 'EPERM' });
        assert.equal(calls.length, 1);
    });

    test('an error that is not about a busy file is not retried on Windows either', async () => {
        const { rename, calls } = flaky('ENOENT', 1);
        await assert.rejects(renameWithRetry('a.tmp', 'a', { rename, platform: 'win32', delayMs: 0 }), { code: 'ENOENT' });
        assert.equal(calls.length, 1);
    });
});

describe('writeFileAtomic — durability', () => {
    test('a failure before the rename leaves the original file untouched', async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify(SAMPLE));
        try {
            const file = configPath(dir);
            const before = await fs.readFile(file, 'utf8');

            await assert.rejects(() =>
                writeFileAtomic(file, 'REPLACEMENT', {
                    beforeRename: () => { throw new Error('crash'); },
                }));

            assert.equal(await fs.readFile(file, 'utf8'), before, 'the old content must survive');
            assert.deepEqual(await tmpArtifacts(path.join(dir, CONFIG_DIR)), [], 'the temp file must be cleaned up');
        } finally {
            await cleanup();
        }
    });

    test('the temp file lives in the target directory, not the OS temp dir', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            let seen = [];
            await writeFileAtomic(configPath(dir), 'x', {
                beforeRename: async () => { seen = await tmpArtifacts(path.join(dir, CONFIG_DIR)); },
            });
            // rename() is only atomic within one filesystem — a temp elsewhere would break that.
            assert.equal(seen.length, 1, 'exactly one temp file, next to the target');
        } finally {
            await cleanup();
        }
    });

    test('the target is never partially visible during a write', async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify(SAMPLE));
        try {
            const file = configPath(dir);
            const big = `${JSON.stringify({ ...SAMPLE, filler: 'x'.repeat(2_000_000) }, null, 2)}\n`;

            await writeFileAtomic(file, big, {
                beforeRename: async () => {
                    // Mid-write, a concurrent reader must still see the complete old file.
                    JSON.parse(await fs.readFile(file, 'utf8'));
                },
            });

            assert.equal((await fs.readFile(file, 'utf8')).length, big.length);
        } finally {
            await cleanup();
        }
    });

    test('concurrent writers cannot interleave into a corrupt file', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const configs = Array.from({ length: 20 }, (_, i) => ({
                ...emptyConfig(),
                presets: { default: [{ name: `config-${i}`, mode: 'run' }] },
            }));

            await Promise.all(configs.map((config) => writePresets(dir, config)));

            const result = await readPresets(dir);
            assert.match(result.presets.default[0].name, /^config-\d+$/, 'the winner must be one complete write');
            assert.deepEqual(await tmpArtifacts(path.join(dir, CONFIG_DIR)), []);
        } finally {
            await cleanup();
        }
    });

    test('SIGKILL during a write never corrupts the config', async () => {
        const { dir, cleanup } = await tmpProject(JSON.stringify(SAMPLE));
        try {
            const file = configPath(dir);

            for (let attempt = 0; attempt < 5; attempt++) {
                const child = spawn(process.execPath, ['--input-type=module', '-e', writerLoopSource(dir)], {
                    stdio: ['ignore', 'pipe', 'inherit'],
                });

                // Wait until the child is actually writing before pulling the plug.
                await new Promise((resolve) => child.stdout.once('data', resolve));
                await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 15));
                child.kill('SIGKILL');
                await new Promise((resolve) => child.once('exit', resolve));

                // The invariant: whatever we find is a complete, parseable config.
                const text = await fs.readFile(file, 'utf8');
                assert.doesNotThrow(() => parseConfig(text, file), `attempt ${attempt}: config was corrupt`);
            }
        } finally {
            await cleanup();
        }
    });
});

/**
 * Source for a child process that writes the config in a tight loop until killed.
 *
 * @param {string} dir
 * @returns {string}
 */
function writerLoopSource(dir) {
    return `
        import { writePresets, emptyConfig } from ${JSON.stringify(STORE_URL)};
        const filler = 'x'.repeat(400_000);
        let i = 0;
        process.stdout.write('go');
        for (;;) {
            await writePresets(${JSON.stringify(dir)}, {
                ...emptyConfig(),
                presets: { default: [{ name: 'run-' + i++, mode: 'run', filler }] },
            });
        }
    `;
}

describe('inherited property names', () => {
    // A preset — or a run configuration — may legitimately be named after an
    // Object.prototype member. Every lookup must be an own-property check.
    const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

    for (const name of INHERITED) {
        test(`getPreset("${name}") returns an empty list instead of throwing`, () => {
            assert.deepEqual(getPreset(emptyConfig(), name), []);
        });

        test(`hasPreset("${name}") is false on an empty config`, () => {
            assert.equal(hasPreset(emptyConfig(), name), false);
        });
    }

    test('a preset really named "constructor" round-trips', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const config = setPreset(emptyConfig(), 'constructor', [{ name: 'api', mode: 'debug' }]);
            await writePresets(dir, config);

            const reread = await readPresets(dir);
            assert.equal(hasPreset(reread, 'constructor'), true);
            assert.deepEqual(getPreset(reread, 'constructor'), [{ name: 'api', mode: 'debug' }]);
        } finally {
            await cleanup();
        }
    });

    test('a preset named "__proto__" survives parsing as an own property', () => {
        // A plain `obj[name] = …` would hit the prototype setter and drop it silently.
        const config = parseConfig('{"presets":{"__proto__":[{"name":"api"}],"real":[]}}');

        assert.deepEqual(Object.keys(config.presets).sort(), ['__proto__', 'real']);
        assert.deepEqual(getPreset(config, '__proto__'), [{ name: 'api', mode: 'run' }]);
    });

    test('parsing a "__proto__" preset does not change any prototype', () => {
        const config = parseConfig('{"presets":{"__proto__":[{"name":"api"}]}}');

        assert.equal(Object.getPrototypeOf(config.presets), Object.prototype);
        assert.equal({}.name, undefined, 'Object.prototype must be untouched');
    });

    test('a "__proto__" preset round-trips through the file', async () => {
        const { dir, cleanup } = await tmpProject('{"presets":{"__proto__":[{"name":"api","mode":"debug"}]}}');
        try {
            await writePresets(dir, await readPresets(dir));
            assert.deepEqual(getPreset(await readPresets(dir), '__proto__'), [{ name: 'api', mode: 'debug' }]);
        } finally {
            await cleanup();
        }
    });

    test('defaultPreset may name an inherited member without crashing', () => {
        const config = parseConfig('{"defaultPreset":"toString","presets":{}}');
        assert.deepEqual(getPreset(config), []);
    });
});

describe('preset accessors', () => {
    test('getPreset returns the default preset when no name is given', () => {
        assert.deepEqual(getPreset(SAMPLE), SAMPLE.presets.default);
    });

    test('getPreset returns an empty array for an unknown preset', () => {
        assert.deepEqual(getPreset(SAMPLE, 'nope'), []);
    });

    test('getPreset returns a copy — mutating it does not touch the config', () => {
        const entries = getPreset(SAMPLE);
        entries.push({ name: 'injected', mode: 'run' });
        assert.equal(SAMPLE.presets.default.length, 2);
    });

    test('setPreset returns a new config and leaves the original alone', () => {
        const updated = setPreset(SAMPLE, 'default', [{ name: 'shared', mode: 'run' }]);
        assert.deepEqual(updated.presets.default, [{ name: 'shared', mode: 'run' }]);
        assert.equal(SAMPLE.presets.default.length, 2, 'the input config must not be mutated');
        assert.deepEqual(updated.presets.backend, SAMPLE.presets.backend, 'other presets survive');
    });

    test('setPreset can add a preset that did not exist', () => {
        const updated = setPreset(emptyConfig(), 'frontend', [{ name: 'docs', mode: 'debug' }]);
        assert.deepEqual(listPresets(updated), ['frontend']);
    });

    test('listPresets returns names in insertion order', () => {
        assert.deepEqual(listPresets(SAMPLE), ['default', 'backend']);
    });
});

describe('deletePreset', () => {
    test('removes only the named preset and preserves the order of the rest', () => {
        const three = setPreset(SAMPLE, 'frontend', [{ name: 'docs', mode: 'run' }]);
        const { config } = deletePreset(three, 'backend');
        assert.deepEqual(listPresets(config), ['default', 'frontend']);
    });

    test('does not mutate the input config', () => {
        const before = JSON.parse(JSON.stringify(SAMPLE));
        deletePreset(SAMPLE, 'backend');
        assert.deepEqual(SAMPLE, before);
    });

    test('returns the entries the deleted preset held', () => {
        const { entries } = deletePreset(SAMPLE, 'backend');
        assert.deepEqual(entries, SAMPLE.presets.backend);
    });

    test('mutating the returned entries does not touch the input config', () => {
        const { entries } = deletePreset(SAMPLE, 'backend');
        entries.push({ name: 'injected', mode: 'run' });
        assert.equal(SAMPLE.presets.backend.length, 1);
    });

    test('defaultReset is false, and defaultPreset untouched, when deleting a non-default preset', () => {
        const { config, defaultReset } = deletePreset(SAMPLE, 'backend');
        assert.equal(defaultReset, false);
        assert.equal(config.defaultPreset, 'default');
    });

    test('defaultReset is true, and defaultPreset resets to DEFAULT_PRESET, when deleting the default preset', () => {
        const { config, defaultReset } = deletePreset(SAMPLE, 'default');
        assert.equal(defaultReset, true);
        assert.equal(config.defaultPreset, DEFAULT_PRESET);
    });

    test('deleting a preset literally named "default" still resets defaultPreset to DEFAULT_PRESET', () => {
        const config = setPreset(emptyConfig(), 'default', [{ name: 'web', mode: 'run' }]);
        const { config: after, defaultReset } = deletePreset(config, 'default');
        assert.equal(defaultReset, true);
        assert.equal(after.defaultPreset, DEFAULT_PRESET);
        assert.deepEqual(listPresets(after), []);
    });

    test('throws a plain Error for a preset name that does not exist', () => {
        assert.throws(() => deletePreset(SAMPLE, 'nope'), (err) => err instanceof Error && !(err instanceof TypeError));
    });

    for (const name of ['constructor', 'toString', '__proto__']) {
        test(`deletes a preset named "${name}" and round-trips the rest through serializeConfig`, () => {
            const config = parseConfig(
                JSON.stringify({ presets: { [name]: [{ name: 'api' }], real: [{ name: 'web' }] } }),
            );

            const { config: after, entries } = deletePreset(config, name);

            assert.deepEqual(entries, [{ name: 'api', mode: 'run' }]);
            assert.equal(hasPreset(after, name), false);
            assert.deepEqual(listPresets(after), ['real']);
            assert.equal(Object.getPrototypeOf(after.presets), Object.prototype);
            assert.equal({}.name, undefined, 'Object.prototype must be untouched');

            const reparsed = parseConfig(serializeConfig(after));
            assert.deepEqual(listPresets(reparsed), ['real']);
            assert.equal(hasPreset(reparsed, name), false);
        });
    }

    test('unknown top-level keys survive a serializeConfig round-trip after a delete', () => {
        const config = parseConfig(
            JSON.stringify({
                presets: { default: [{ name: 'web' }], backend: [{ name: 'mailer' }] },
                futureField: 'kept',
            }),
        );

        const { config: after } = deletePreset(config, 'backend');
        const reparsed = parseConfig(serializeConfig(after));

        assert.equal(reparsed.futureField, 'kept');
        assert.deepEqual(listPresets(reparsed), ['default']);
    });
});

describe('custom command entries', () => {
    const custom = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const parse = (entries) => parseConfig(JSON.stringify({ version: 1, presets: { default: entries } }));

    test('an entry with commands parses as a custom entry', () => {
        const [entry] = parse([custom]).presets.default;
        assert.deepEqual(entry, custom);
        assert.equal(isCustomEntry(entry), true);
    });

    test('mode may be left out: a custom entry is always a terminal one', () => {
        const [entry] = parse([{ name: 'seed db', commands: ['npm i'] }]).presets.default;
        assert.equal(entry.mode, 'terminal');
    });

    test('a run-configuration entry is not a custom one', () => {
        assert.equal(isCustomEntry({ name: 'web', mode: 'run' }), false);
    });

    for (const mode of ['run', 'debug']) {
        test(`mode "${mode}" contradicts commands and is refused`, () => {
            assert.throws(
                () => parse([{ ...custom, mode }]),
                (err) => err instanceof PresetConfigError && /mode must be "terminal"/.test(err.detail),
            );
        });
    }

    for (const [label, commands] of [
        ['an empty list', []],
        ['a string', 'npm i'],
        ['an empty command', ['']],
        ['a blank command', ['  ']],
        ['a non-string', [1]],
        ['a command with a newline', ['npm i\nnpm run seed']],
        ['a command with a carriage return', ['a\rb']],
        ['a command with an escape character', ['echo \u001b[2J']],
        ['a command with a NUL', ['a\u0000b']],
        ['a command with DEL', ['a\u007fb']],
        ['a command with a C1 control', ['a\u0085b']],
    ]) {
        test(`commands that are ${label} are refused, naming the entry`, () => {
            assert.throws(
                () => parse([{ name: 'ok', mode: 'run' }, { name: 'seed db', commands }]),
                (err) => err instanceof PresetConfigError
                    && /preset "default" entry 1/.test(err.detail)
                    && /"commands" must be a non-empty list of non-empty strings without control characters/.test(err.detail),
            );
        });
    }

    test('a tab inside a name is fine', () => {
        const [entry] = parse([{ name: 'seed\tdb', commands: ['echo hi'] }]).presets.default;
        assert.equal(entry.name, 'seed\tdb');
    });

    test('a tab inside a command is fine', () => {
        const [entry] = parse([{ name: 'seed db', commands: ['printf "a\tb"'] }]).presets.default;
        assert.deepEqual(entry.commands, ['printf "a\tb"']);
    });

    for (const [label, name] of [
        ['a newline', 'build: npm run build\n  lint: npm run lint'],
        ['a carriage return', 'a\rb'],
        ['an escape sequence', 'x\u001b[2J\u001b[H'],
        ['a NUL', 'a\u0000b'],
        ['DEL', 'a\u007fb'],
        ['a C1 control', 'a\u009bb'],
    ]) {
        test(`a custom name with ${label} is refused, naming the entry`, () => {
            assert.throws(
                () => parse([{ name: 'ok', mode: 'run' }, { name, commands: ['echo hi'] }]),
                (err) => err instanceof PresetConfigError
                    && /preset "default" entry 1/.test(err.detail)
                    && /"name" must not contain control characters/.test(err.detail),
            );
        });
    }

    test('serializes commands right after mode, keeps unknown keys, and rewriting is a no-op', () => {
        const text = serializeConfig(parse([{ zeta: 1, commands: ['npm i'], name: 'seed db', mode: 'terminal' }]));
        const written = JSON.parse(text).presets.default[0];

        assert.deepEqual(Object.keys(written), ['name', 'mode', 'commands', 'zeta']);
        assert.equal(serializeConfig(parseConfig(text)), text);
    });

    test('a custom entry may be called like a member of Object.prototype', () => {
        for (const name of ['constructor', '__proto__', 'toString']) {
            const [entry] = parse([{ name, commands: ['echo hi'] }]).presets.default;
            assert.equal(entry.name, name);
            assert.deepEqual(entry.commands, ['echo hi']);
        }
    });
});
