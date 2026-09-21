import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tmpIdeaProject } from '../test-utils/tmp-dir.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const WSC_BIN = fileURLToPath(new URL('../bin/wsc.js', import.meta.url));

/** A static `import … from '…'`, `export … from '…'` or bare `import '…'` at the start of a line. */
const STATIC_IMPORT = /^(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/**
 * Every file reachable from `entry` through static imports, and every package they name.
 * Dynamic `import()` is deliberately not followed: that is how src/mcp/client.js loads the
 * MCP SDK only when a session is opened.
 *
 * @param {string} entry
 */
async function walk(entry) {
    /** @type {Set<string>} */
    const files = new Set();
    /** @type {Set<string>} */
    const packages = new Set();
    const pending = [entry];

    while (pending.length > 0) {
        const file = /** @type {string} */ (pending.pop());
        if (files.has(file)) continue;
        files.add(file);

        const source = await readFile(file, 'utf8');
        for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
            if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
            else if (!specifier.startsWith('node:')) packages.add(specifier);
        }
    }
    return { files, packages };
}

describe('the completion path stays light', () => {
    test('run.js reaches neither cli.js, nor the prompts, nor any package', async () => {
        const { files, packages } = await walk(path.join(SRC, 'completion', 'run.js'));
        const relative = [...files].map((file) => path.relative(SRC, file));

        // The walk itself works: it found the modules it is supposed to walk through.
        assert.ok(relative.includes(path.join('fallback', 'ideaRunConfigs.js')), relative.join(', '));
        assert.ok(relative.includes(path.join('completion', 'candidates.js')));

        assert.equal(relative.includes('cli.js'), false, 'src/cli.js loads @inquirer/prompts');
        assert.deepEqual(
            relative.filter((file) => file.startsWith(`ui${path.sep}`)),
            [],
            'src/ui/ imports @inquirer/prompts',
        );
        assert.deepEqual([...packages], [], 'a package on the completion path costs every Tab');
    });
});

describe('bin/wsc.js', () => {
    test('has no static import: each branch loads only its own module', async () => {
        // A static `import { runCli } from '../src/cli.js'` would load the prompts on every
        // Tab, and run.js's own walk above would not notice.
        const source = await readFile(WSC_BIN, 'utf8');
        assert.deepEqual([...source.matchAll(STATIC_IMPORT)].map(([, specifier]) => specifier), []);
        assert.match(source, /await import\(['"]\.\.\/src\/cli\.js['"]\)/, 'the CLI is still loaded, dynamically');
    });

    test('__complete answers Tab without going through the CLI', async () => {
        const project = await tmpIdeaProject();
        try {
            const result = spawnSync(process.execPath, [WSC_BIN, '__complete', 'zsh', 'wsc --ta'], {
                cwd: project.dir,
                encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, 'values\n--target\n');
            assert.equal(result.stderr, '');
        } finally {
            await project.cleanup();
        }
    });

    test('anything else still goes to the CLI', () => {
        const result = spawnSync(process.execPath, [WSC_BIN, '--version'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^\d+\.\d+\.\d+/);
    });

    test('__complete is reserved only as the first argument', async () => {
        // Not first: an ordinary name, so the CLI sees it and — there being no such
        // configuration — reports it. `--mcp-port 1` (nothing listens there) plus
        // `--fallback=terminal` keeps the run off any MCP Server, so nothing here depends
        // on whether an IDE happens to be up on the machine running the tests.
        const project = await tmpIdeaProject();
        try {
            const args = [WSC_BIN, '--mcp-port', '1', '--fallback=terminal', '--dry-run', '__complete'];
            const result = spawnSync(process.execPath, args, { cwd: project.dir, encoding: 'utf8' });
            assert.doesNotMatch(result.stdout, /^(values|dirs|none)\n/);
            assert.match(result.stderr, /__complete/);
            assert.notEqual(result.status, 0);
        } finally {
            await project.cleanup();
        }
    });
});
