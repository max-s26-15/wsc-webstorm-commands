import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const root = fileURLToPath(new URL('..', import.meta.url));

/** What `npm publish` would upload, as paths relative to the package root. */
function packedFiles() {
    // shell on Windows so npm.cmd is found; every argument is a constant.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    return JSON.parse(out)[0].files.map((/** @type {{ path: string }} */ file) => file.path);
}

describe('the published package', () => {
    test('is publishable and says what it is', () => {
        assert.equal(pkg.name, 'webstorm-commands');
        assert.equal(pkg.private, undefined);
        assert.equal(pkg.license, 'MIT');
        assert.equal(pkg.engines.node, '>=22');
        assert.ok(pkg.description.length > 0);
        assert.equal(pkg.repository.url, 'git+https://github.com/max-s26-15/wsc-webstorm-commands.git');
    });

    test('installs both commands', () => {
        assert.deepEqual(pkg.bin, { wsc: './bin/wsc.js', 'wsc-mcp-probe': './scripts/mcp-probe.js' });
    });

    test('ships the code and nothing of the repository around it', () => {
        const files = packedFiles();
        for (const wanted of ['bin/wsc.js', 'scripts/mcp-probe.js', 'src/cli.js', 'README.md', 'LICENSE', 'package.json']) {
            assert.ok(files.includes(wanted), `missing ${wanted}`);
        }
        const leaked = files.filter((file) => /^(test|test-utils|ide-plugin|\.claude|\.docs|\.idea|\.github)\//.test(file));
        assert.deepEqual(leaked, []);
    });
});
