import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseNvmrc, resolveProjectNode } from '../src/fallback/projectNode.js';
import { tmpDir } from '../test-utils/tmp-dir.js';

/**
 * A throwaway home with the given nvm versions installed, and a project with the given
 * .nvmrc. Real directories: the code under test lists and stats them.
 *
 * @param {{ nvmrc?: string, installed: string[], nvmDir?: string }} opts
 */
async function withNvm({ nvmrc, installed, nvmDir }, body) {
    const home = await tmpDir('wsc-home-');
    const project = await tmpDir('wsc-nvmproj-');
    try {
        const root = nvmDir ?? path.join(home.dir, '.nvm');
        for (const version of installed) {
            await fs.mkdir(path.join(root, 'versions', 'node', version, 'bin'), { recursive: true });
            await fs.writeFile(path.join(root, 'versions', 'node', version, 'bin', 'node'), '');
        }
        if (nvmrc !== undefined) await fs.writeFile(path.join(project.dir, '.nvmrc'), nvmrc);
        await body({ home: home.dir, project: project.dir, root });
    } finally {
        await home.cleanup();
        await project.cleanup();
    }
}

const nodeAt = (root, version) => path.join(root, 'versions', 'node', version, 'bin', 'node');

describe('parseNvmrc', () => {
    test('accepts a bare version, a v-prefixed one, and surrounding whitespace', () => {
        assert.deepEqual(parseNvmrc('14.21.3'), [14, 21, 3]);
        assert.deepEqual(parseNvmrc('v14.21.3\n'), [14, 21, 3]);
        assert.deepEqual(parseNvmrc('  v16.20.2  \r\n'), [16, 20, 2]);
    });

    test('accepts a partial version, which nvm treats as "the newest installed match"', () => {
        assert.deepEqual(parseNvmrc('14'), [14]);
        assert.deepEqual(parseNvmrc('v20.1'), [20, 1]);
    });

    test('refuses aliases it cannot resolve without nvm itself', () => {
        // `lts/*`, `node`, `stable` and named aliases live in nvm's own alias files and
        // registry; guessing at them would pin a version nobody asked for.
        for (const alias of ['lts/*', 'lts/hydrogen', 'node', 'stable', 'system', '', '14.x', '14.21.3.1']) {
            assert.equal(parseNvmrc(alias), undefined, JSON.stringify(alias));
        }
    });
});

describe('resolveProjectNode', () => {
    test('finds the installed node the .nvmrc names', async () => {
        await withNvm({ nvmrc: '14.21.3\n', installed: ['v14.21.3', 'v20.20.0'] }, async ({ home, project, root }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), nodeAt(root, 'v14.21.3'));
        });
    });

    test('a v-prefixed .nvmrc names the same directory', async () => {
        await withNvm({ nvmrc: 'v16.20.2', installed: ['v16.20.2'] }, async ({ home, project, root }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), nodeAt(root, 'v16.20.2'));
        });
    });

    test('a partial version picks the highest installed match, compared as numbers', async () => {
        // v14.9.0 sorts after v14.21.3 as a string. Comparing lexically would hand back the
        // older node whenever a minor crosses a digit boundary.
        await withNvm(
            { nvmrc: '14', installed: ['v14.9.0', 'v14.21.3', 'v14.2.0', 'v16.20.2'] },
            async ({ home, project, root }) => {
                assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), nodeAt(root, 'v14.21.3'));
            },
        );
    });

    test('a partial version does not match a different major that merely starts the same', async () => {
        await withNvm({ nvmrc: '1', installed: ['v14.21.3'] }, async ({ home, project }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
    });

    test('a version that is not installed resolves to nothing, so the tab falls back to PATH', async () => {
        await withNvm({ nvmrc: '12.22.0', installed: ['v14.21.3'] }, async ({ home, project }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
    });

    test('no .nvmrc, an alias, or no nvm at all resolve to nothing', async () => {
        await withNvm({ installed: ['v14.21.3'] }, async ({ home, project }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
        await withNvm({ nvmrc: 'lts/*', installed: ['v14.21.3'] }, async ({ home, project }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
        await withNvm({ nvmrc: '14.21.3', installed: [] }, async ({ home, project }) => {
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
    });

    test('an installed version with no bin/node in it is not offered', async () => {
        await withNvm({ nvmrc: '14.21.3', installed: [] }, async ({ home, project, root }) => {
            await fs.mkdir(path.join(root, 'versions', 'node', 'v14.21.3'), { recursive: true });
            assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
        });
    });

    test('an explicit nvmDir wins over the one under the home directory', async () => {
        const elsewhere = await tmpDir('wsc-nvmdir-');
        try {
            await withNvm(
                { nvmrc: '14.21.3', installed: ['v14.21.3'], nvmDir: elsewhere.dir },
                async ({ home, project, root }) => {
                    assert.equal(
                        await resolveProjectNode(project, { homeDir: home, env: {}, nvmDir: elsewhere.dir }),
                        nodeAt(root, 'v14.21.3'),
                    );
                    // …and the default location, which is empty here, is not consulted.
                    assert.equal(await resolveProjectNode(project, { homeDir: home, env: {} }), undefined);
                },
            );
        } finally {
            await elsewhere.cleanup();
        }
    });
});
