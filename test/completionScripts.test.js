import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WORDBREAKS } from '../src/completion/format.js';
import { BASH_SCRIPT, ZSH_SCRIPT, completionScript } from '../src/completion/scripts.js';
import { tmpDir, tmpIdeaProject } from '../test-utils/tmp-dir.js';

const WSC_BIN = fileURLToPath(new URL('../bin/wsc.js', import.meta.url));
const has = (shell) => spawnSync(shell, ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * A directory holding a `wsc` that runs this checkout, to put first on PATH: the wrappers
 * call `command wsc`, exactly as they will for a user who ran `npm link`.
 */
async function withShim(body) {
    const shim = await tmpDir('wsc-shim-');
    const file = path.join(shim.dir, 'wsc');
    await fs.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${WSC_BIN}" "$@"\n`);
    await fs.chmod(file, 0o755);
    try {
        return await body(shim.dir);
    } finally {
        await shim.cleanup();
    }
}

describe('completionScript', () => {
    test('picks the script by shell', () => {
        assert.equal(completionScript('zsh'), ZSH_SCRIPT);
        assert.equal(completionScript('bash'), BASH_SCRIPT);
    });

    test('both wrappers send stderr to /dev/null and call the hidden entry', () => {
        for (const script of [ZSH_SCRIPT, BASH_SCRIPT]) {
            assert.match(script, /command wsc __complete /);
            assert.match(script, /2>\/dev\/null/);
        }
    });

    test('each script says how to install it', () => {
        assert.match(ZSH_SCRIPT, /source <\(wsc --completion zsh\)/);
        assert.match(BASH_SCRIPT, /source <\(wsc --completion bash\)/);
    });
});

describe('the bash wrapper, in a real bash', { skip: !has('bash') && 'bash is not installed' }, () => {
    /**
     * @param {string} line - what is on the command line, up to the cursor
     * @param {string} cwd
     * @param {string} shimDir
     * @returns {string[]} COMPREPLY
     */
    const tab = (line, cwd, shimDir) => {
        const script = `${BASH_SCRIPT}
COMP_LINE=$WSC_TEST_LINE
COMP_POINT=\${#COMP_LINE}
COMP_WORDBREAKS=$WSC_TEST_WORDBREAKS
COMP_WORDS=(wsc "")
COMP_CWORD=1
_wsc
printf '%s\\n' "\${COMPREPLY[@]}"
`;
        const result = spawnSync('bash', ['--norc', '--noprofile', '-c', script], {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                WSC_TEST_LINE: line,
                WSC_TEST_WORDBREAKS: DEFAULT_WORDBREAKS,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return result.stdout.split('\n').filter(Boolean);
    };

    test('completes names, escaped for readline', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                const items = tab('wsc a', project.dir, shim);
                for (const item of ['api', 'api\\ \\>\\ repro:stale-job:debug', 'addon-client']) {
                    assert.ok(items.includes(item), `${item} missing from ${JSON.stringify(items)}`);
                }
                assert.equal(items.includes('web'), false);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('completes only the part after a bare colon or equals sign', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc api:de', project.dir, shim), ['debug']);
                assert.deepEqual(tab('wsc --target=t', project.dir, shim), ['terminal']);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('--project completes directory names', async () => {
        const project = await tmpIdeaProject();
        try {
            await fs.mkdir(path.join(project.dir, 'sub'));
            await withShim(async (shim) => {
                assert.ok(tab('wsc --project ', project.dir, shim).includes('sub'));
            });
        } finally {
            await project.cleanup();
        }
    });

    test('offers nothing when nothing applies', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --list ', project.dir, shim), []);
                assert.deepEqual(tab('wsc --mcp-port ', project.dir, shim), []);
            });
        } finally {
            await project.cleanup();
        }
    });
});

describe('the zsh wrapper', { skip: !has('zsh') && 'zsh is not installed' }, () => {
    test('is valid zsh', () => {
        const result = spawnSync('zsh', ['-n', '-c', ZSH_SCRIPT], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    });

    /**
     * Runs the wrapper's function outside ZLE: `compadd` and `_files` are stubs that print
     * what they were given, and `_wsc_line` (the one place the wrapper reads BUFFER and
     * CURSOR, which only exist inside a widget) is replaced by one that reads the test's
     * line. That checks the wrapper's own logic; the real Tab is checked by hand through a pty.
     *
     * @param {string} line
     * @param {string} cwd
     * @param {string} shimDir
     * @returns {string[]} one entry per line the stubs printed
     */
    const tab = (line, cwd, shimDir) => {
        const script = `
compadd() { print -rl -- "$@" }
_files() { print -r -- "_files $*" }
compdef() { : }
eval "$WSC_TEST_SCRIPT"
_wsc_line() { REPLY=$WSC_TEST_LINE }
_wsc
`;
        const result = spawnSync('zsh', ['-f', '-c', script], {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                WSC_TEST_SCRIPT: ZSH_SCRIPT,
                WSC_TEST_LINE: line,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return result.stdout.split('\n').filter(Boolean);
    };

    test('hands raw names to compadd after --, leaving the quoting to zsh', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                const printed = tab('wsc a', project.dir, shim);
                assert.equal(printed[0], '--');
                for (const name of ['api', 'api > repro:stale-job:debug', 'addon-client']) {
                    assert.ok(printed.includes(name), `${name} missing from ${JSON.stringify(printed)}`);
                }
            });
        } finally {
            await project.cleanup();
        }
    });

    test('asks _files for directories after --project', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --project ', project.dir, shim), ['_files -/']);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('adds nothing when nothing applies', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --list ', project.dir, shim), []);
            });
        } finally {
            await project.cleanup();
        }
    });
});
