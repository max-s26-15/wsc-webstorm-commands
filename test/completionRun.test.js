import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { completeCommand } from '../src/completion/run.js';
import { tmpDir, tmpIdeaProject } from '../test-utils/tmp-dir.js';

const PRESETS = JSON.stringify({ presets: { default: [{ name: 'web' }], backend: [{ name: 'api' }] } });

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
async function complete(cwd, args, env = {}) {
    let out = '';
    let err = '';
    const code = await completeCommand(args, {
        cwd,
        env,
        stdout: { write: (text) => (out += text) },
        stderr: { write: (text) => (err += text) },
    });
    return { code, out, err, lines: out.split('\n').filter(Boolean) };
}

describe('completeCommand — sources', () => {
    test('offers configuration names from .idea/, filtered by the typed prefix', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        try {
            const { code, lines, err } = await complete(project.dir, ['zsh', 'wsc a']);
            assert.equal(code, 0);
            assert.equal(err, '');
            assert.equal(lines[0], 'values');
            for (const name of ['api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server']) {
                assert.ok(lines.includes(name), `${name} missing`);
            }
            assert.equal(lines.includes('web'), false);
        } finally {
            await project.cleanup();
        }
    });

    test('offers preset names after --preset', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        try {
            const { out } = await complete(project.dir, ['zsh', 'wsc --preset ']);
            assert.equal(out, 'values\ndefault\nbackend\n');
        } finally {
            await project.cleanup();
        }
    });

    test('a --project earlier in the line decides which project is read', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            const { out } = await complete(elsewhere.dir, ['zsh', `wsc --project ${project.dir} --preset `]);
            assert.equal(out, 'values\ndefault\nbackend\n');
        } finally {
            await elsewhere.cleanup();
            await project.cleanup();
        }
    });

    test('a --project that is not a WebStorm project offers no names, but flags still work', async () => {
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            assert.equal((await complete(elsewhere.dir, ['zsh', `wsc --project ${elsewhere.dir} a`])).out, 'values\n');
            assert.equal((await complete(elsewhere.dir, ['zsh', 'wsc --ta'])).out, 'values\n--target\n');
        } finally {
            await elsewhere.cleanup();
        }
    });

    test('--project completes directories by asking the shell to', async () => {
        const project = await tmpIdeaProject();
        try {
            assert.equal((await complete(project.dir, ['zsh', 'wsc --project '])).out, 'dirs\n');
        } finally {
            await project.cleanup();
        }
    });
});

describe('completeCommand — failures are silent', () => {
    test('a broken preset file means no presets, but the configurations are still offered', async () => {
        const project = await tmpIdeaProject({ presets: '{ not json' });
        try {
            const presets = await complete(project.dir, ['zsh', 'wsc --preset ']);
            assert.deepEqual([presets.code, presets.out, presets.err], [0, 'values\n', '']);

            const names = await complete(project.dir, ['zsh', 'wsc api:de']);
            assert.equal(names.out, 'values\napi:debug\n');
            assert.equal(names.err, '');
        } finally {
            await project.cleanup();
        }
    });

    test('outside any project there are no names, and still no noise', async () => {
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            const result = await complete(elsewhere.dir, ['zsh', 'wsc a']);
            assert.deepEqual([result.code, result.out, result.err], [0, 'values\n', '']);
        } finally {
            await elsewhere.cleanup();
        }
    });

    test('a project with no saved run configurations offers no names', async () => {
        const project = await tmpIdeaProject({ workspace: false, shared: false });
        try {
            assert.equal((await complete(project.dir, ['zsh', 'wsc a'])).out, 'values\n');
        } finally {
            await project.cleanup();
        }
    });

    test('an unknown shell is answered with none, not an error', async () => {
        const project = await tmpIdeaProject();
        try {
            const result = await complete(project.dir, ['fish', 'wsc a']);
            assert.deepEqual([result.code, result.out, result.err], [0, 'none\n', '']);
            assert.deepEqual(await complete(project.dir, []), { code: 0, out: 'none\n', err: '', lines: ['none'] });
        } finally {
            await project.cleanup();
        }
    });

    test('WSC_COMPLETE_DEBUG=1 says why a source was skipped', async () => {
        const project = await tmpIdeaProject({ presets: '{ not json' });
        try {
            const result = await complete(project.dir, ['zsh', 'wsc --preset '], { WSC_COMPLETE_DEBUG: '1' });
            assert.equal(result.out, 'values\n');
            assert.match(result.err, /wsc completion: presets/);
        } finally {
            await project.cleanup();
        }
    });
});

describe('completeCommand — bash', () => {
    test('returns escaped, cut items for COMPREPLY, using the word breaks it was given', async () => {
        const project = await tmpIdeaProject();
        try {
            const cut = await complete(project.dir, ['bash', 'wsc api:de', ' \t\n"\'><=;|&(:']);
            assert.equal(cut.out, 'values\ndebug\n');

            const escaped = await complete(project.dir, ['bash', 'wsc api\\ \\>\\ re']);
            assert.ok(escaped.out.includes('api\\ \\>\\ repro:stale-job:debug\n'), escaped.out);
        } finally {
            await project.cleanup();
        }
    });
});

test('the catalogue is read from .idea/, not the current directory', async () => {
    // A config named after a directory that exists beside the project must still be a name.
    const project = await tmpIdeaProject();
    try {
        await fs.mkdir(path.join(project.dir, 'web'));
        const { lines } = await complete(project.dir, ['zsh', 'wsc w']);
        assert.ok(lines.includes('web'));
    } finally {
        await project.cleanup();
    }
});
