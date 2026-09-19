import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Create a throwaway directory and return it together with a cleanup function.
 *
 * Real directories rather than a mocked fs: the whole point of the store is its
 * interaction with the filesystem (rename semantics, permissions, ENOENT), and a
 * mock would test the mock.
 *
 * @param {string} [prefix]
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function tmpDir(prefix = 'wsc-test-') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return {
        dir,
        cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
}

/**
 * Create a tmp directory that already looks like a WebStorm project.
 *
 * @param {string} [contents] - written to .idea/webstorm-commands.json when given
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function tmpProject(contents) {
    const { dir, cleanup } = await tmpDir('wsc-project-');
    await fs.mkdir(path.join(dir, '.idea'), { recursive: true });
    if (contents !== undefined) {
        await fs.writeFile(path.join(dir, '.idea', 'webstorm-commands.json'), contents);
    }
    return { dir, cleanup };
}

/**
 * List leftover atomic-write temp files in a directory.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function tmpArtifacts(dir) {
    const entries = await fs.readdir(dir).catch(() => []);
    return entries.filter((name) => name.endsWith('.tmp'));
}

/**
 * Create a tmp project that also has run configurations saved in `.idea/`, the way the
 * terminal fallback reads them.
 *
 * The XML comes from the demo-app fixtures (anonymised from a real project, not
 * invented per test), so a test
 * of the no-IDE path resolves against exactly the 13 names `get_run_configurations`
 * reports for the same project.
 *
 * @param {object} [opts]
 * @param {string} [opts.presets] - contents of .idea/webstorm-commands.json
 * @param {boolean} [opts.workspace] - write .idea/workspace.xml (default: true)
 * @param {boolean} [opts.shared] - write .idea/runConfigurations/ (default: true)
 * @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>}
 */
export async function tmpIdeaProject(opts = {}) {
    // new URL(...) rather than import.meta.dirname: that one needs Node >=20.11, and the
    // repo's floor is >=18.
    const fixtures = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
    const project = await tmpProject(opts.presets);

    if (opts.workspace !== false) {
        await fs.copyFile(
            path.join(fixtures, 'idea-workspace.xml'),
            path.join(project.dir, '.idea', 'workspace.xml'),
        );
    }
    if (opts.shared !== false) {
        const dir = path.join(project.dir, '.idea', 'runConfigurations');
        await fs.mkdir(dir, { recursive: true });
        await fs.copyFile(path.join(fixtures, 'idea-shared-node.xml'), path.join(dir, 'Repro.xml'));
    }

    return project;
}
