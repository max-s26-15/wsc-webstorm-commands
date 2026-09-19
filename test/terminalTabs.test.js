import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    ADAPTERS,
    SHELL,
    appleScriptQuote,
    createPathLookup,
    findTerminal,
    gnomeTerminal,
    hasDisplay,
    keepOpen,
    konsole,
    macTerminal,
    openTerminalTabs,
    windowsTerminal,
} from '../src/fallback/terminalTabs.js';
import { fakeSpawn } from '../test-utils/fake-child.js';
import { tmpDir } from '../test-utils/tmp-dir.js';

/**
 * A PATH resolver that knows exactly what a test says it does — the plan's requirement
 * for this file. Nothing here depends on what is installed on the machine running it.
 *
 * @param {string[]} installed
 */
const lookup = (installed) => {
    const probed = /** @type {string[]} */ ([]);
    const lookupPath = async (/** @type {string} */ binary) => {
        probed.push(binary);
        return installed.includes(binary) ? `/usr/bin/${binary}` : null;
    };
    return { lookupPath, probed };
};

const LINUX = { platform: 'linux', env: { DISPLAY: ':0' } };

/** @param {{ name?: string, command?: string }} [tab] */
const tab = (tab = {}) => ({ name: tab.name ?? 'web', command: tab.command ?? 'cd web && npm run dev' });

describe('findTerminal — detection order', () => {
    test('gnome-terminal wins when both Linux emulators are installed', async () => {
        const { lookupPath } = lookup(['gnome-terminal', 'konsole', SHELL]);
        const found = await findTerminal({ ...LINUX, lookupPath });

        assert.equal(found?.adapter.id, 'gnome-terminal');
        assert.equal(found?.bin['gnome-terminal'], '/usr/bin/gnome-terminal');
    });

    test('konsole is next when gnome-terminal is not there', async () => {
        const { lookupPath } = lookup(['konsole', SHELL]);
        assert.equal((await findTerminal({ ...LINUX, lookupPath }))?.adapter.id, 'konsole');
    });

    test('nothing installed means nothing found — the pool is the caller\'s problem', async () => {
        const { lookupPath } = lookup([SHELL]);
        assert.equal(await findTerminal({ ...LINUX, lookupPath }), null);
    });

    test('an emulator without the shell it drives is not usable', async () => {
        // A tab opened without bash would die on the first `&&` of the command, in a window
        // that then closes. Falling through to the pool is the better answer.
        const { lookupPath } = lookup(['gnome-terminal', 'konsole']);
        assert.equal(await findTerminal({ ...LINUX, lookupPath }), null);
    });

    test('macOS reaches Terminal.app, and needs no shell on PATH', async () => {
        // `do script` runs the command in the user's own login shell.
        const { lookupPath } = lookup(['osascript']);
        const found = await findTerminal({ platform: 'darwin', env: {}, lookupPath });

        assert.equal(found?.adapter.id, 'Terminal.app');
        assert.equal(found?.adapter.opens, 'window');
    });

    test('Windows reaches wt', async () => {
        const { lookupPath } = lookup(['wt', SHELL]);
        assert.equal((await findTerminal({ platform: 'win32', env: {}, lookupPath }))?.adapter.id, 'wt');
    });
});

describe('findTerminal — what is never even probed', () => {
    test('osascript and wt are not looked for on Linux', async () => {
        // `osascript` on a Linux box would be somebody else's program entirely, and a `wt`
        // there is not Windows Terminal. Platform gating comes before the PATH lookup.
        const { lookupPath, probed } = lookup([]);
        await findTerminal({ ...LINUX, lookupPath });

        assert.deepEqual(probed, ['gnome-terminal', 'konsole']);
    });

    test('the Linux emulators are not looked for on macOS', async () => {
        const { lookupPath, probed } = lookup([]);
        await findTerminal({ platform: 'darwin', env: {}, lookupPath });

        assert.deepEqual(probed, ['osascript']);
    });

    test('a headless session skips the X11 emulators entirely', async () => {
        // Over SSH gnome-terminal is on PATH and can only fail. The pool works there.
        const { lookupPath, probed } = lookup(['gnome-terminal', 'konsole', SHELL]);
        const found = await findTerminal({ platform: 'linux', env: {}, lookupPath });

        assert.equal(found, null);
        assert.deepEqual(probed, [], 'not even probed — the display is missing, not the binary');
    });

    test('a Wayland session counts as a display', () => {
        assert.equal(hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' }), true);
        assert.equal(hasDisplay({ DISPLAY: ':1' }), true);
        assert.equal(hasDisplay({}), false);
        assert.equal(hasDisplay({ DISPLAY: '' }), false);
    });

    test('the second binary of an adapter is not probed once the first one is missing', async () => {
        const { lookupPath, probed } = lookup(['konsole', SHELL]);
        await findTerminal({ ...LINUX, lookupPath });

        assert.deepEqual(probed, ['gnome-terminal', 'konsole', SHELL]);
    });
});

describe('createPathLookup', () => {
    test('finds an executable file on PATH and returns its absolute path', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const binary = path.join(dir, 'gnome-terminal');
            await fs.writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });

            const lookupPath = createPathLookup({ env: { PATH: `/nowhere${path.delimiter}${dir}` }, platform: 'linux' });
            assert.equal(await lookupPath('gnome-terminal'), binary);
            assert.equal(await lookupPath('konsole'), null);
        } finally {
            await cleanup();
        }
    });

    test('a directory with the right name is not an executable', async () => {
        // fs.access(X_OK) succeeds on directories on every POSIX system, so without the
        // isFile() check a `konsole/` directory anywhere on PATH would be "found" and then
        // spawned as EACCES.
        const { dir, cleanup } = await tmpDir();
        try {
            await fs.mkdir(path.join(dir, 'konsole'));
            const lookupPath = createPathLookup({ env: { PATH: dir }, platform: 'linux' });
            assert.equal(await lookupPath('konsole'), null);
        } finally {
            await cleanup();
        }
    });

    test('a file without the executable bit is not found', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            await fs.writeFile(path.join(dir, 'wt'), 'text', { mode: 0o644 });
            const lookupPath = createPathLookup({ env: { PATH: dir }, platform: 'linux' });
            assert.equal(await lookupPath('wt'), null);
        } finally {
            await cleanup();
        }
    });

    test('on Windows the extension is what makes a file runnable', async () => {
        const { dir, cleanup } = await tmpDir();
        try {
            const binary = path.join(dir, 'wt.EXE');
            await fs.writeFile(binary, 'MZ', { mode: 0o644 });

            const lookupPath = createPathLookup({ env: { PATH: dir, PATHEXT: '.COM;.EXE' }, platform: 'win32' });
            assert.equal(await lookupPath('wt'), binary);
        } finally {
            await cleanup();
        }
    });

    test('an empty PATH finds nothing instead of throwing', async () => {
        assert.equal(await createPathLookup({ env: {}, platform: 'linux' })('gnome-terminal'), null);
    });
});

describe('keepOpen', () => {
    test('keeps the tab alive and prints the exit status', () => {
        // The tab has to survive a crash — that is the one moment the output matters — and
        // `exec bash` alone says nothing about why the process is gone.
        const command = keepOpen(tab());

        assert.match(command, /^cd web && npm run dev; /);
        assert.match(command, /"\$\?"/);
        assert.match(command, new RegExp(`exec ${SHELL}$`));
    });

    test('a configuration name is quoted before it reaches printf', () => {
        assert.match(keepOpen(tab({ name: "it's mine" })), /'it'\\''s mine'/);
    });
});

describe('command construction — gnome-terminal', () => {
    const bin = { 'gnome-terminal': '/usr/bin/gnome-terminal', [SHELL]: `/usr/bin/${SHELL}` };

    test('one invocation carries every tab, so they share one window', () => {
        const invocations = gnomeTerminal.invocations([tab(), tab({ name: 'api' })], { cwd: '/p', bin });

        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].command, '/usr/bin/gnome-terminal');
        assert.deepEqual(invocations[0].args.filter((arg) => arg === '--tab').length, 2);
    });

    test('each tab is a --tab / --title / -e group', () => {
        const [{ args }] = gnomeTerminal.invocations([tab()], { cwd: '/p', bin });

        assert.deepEqual(args.slice(0, 3), ['--tab', '--title=web', '-e']);
        assert.equal(args.length, 4);
    });

    test('the -e payload is shell-quoted, because gnome-terminal re-parses it', () => {
        // -e is the only repeatable form (`--` swallows the rest of the argv, so a second
        // --tab group never runs — verified on 3.52). It is parsed with POSIX quoting
        // rules, which is what shellQuote produces.
        const [{ args }] = gnomeTerminal.invocations([tab({ command: "echo 'hi there'" })], { cwd: '/p', bin });
        const payload = args[3];

        assert.match(payload, new RegExp(`^${SHELL} -c '`));
        assert.match(payload, /'\\''hi there'\\''/, 'the inner quotes are escaped, not terminating');
        assert.equal(payload.endsWith("'"), true);
    });

    test('a name full of shell metacharacters is one argv element and cannot break out', () => {
        const name = 'api > repro:stale-job:debug';
        const [{ args }] = gnomeTerminal.invocations([tab({ name })], { cwd: '/p', bin });

        assert.equal(args[1], `--title=${name}`);
        assert.equal(args.filter((arg) => arg === '--tab').length, 1, 'nothing was re-split');
    });
});

describe('command construction — konsole, Terminal.app, wt', () => {
    test('konsole gets one invocation per tab, each with the working directory', () => {
        const bin = { konsole: '/usr/bin/konsole', [SHELL]: `/usr/bin/${SHELL}` };
        const invocations = konsole.invocations([tab(), tab({ name: 'api' })], { cwd: '/p', bin });

        assert.equal(invocations.length, 2, '-e is greedy here too, so one spawn per tab');
        assert.deepEqual(invocations[0].args.slice(0, 6), [
            '--new-tab', '--workdir', '/p', '-p', 'tabtitle=web', '-e',
        ]);
        // The command is a plain argv element: no quoting, and nothing to escape out of.
        assert.equal(invocations[0].args.at(-1), keepOpen(tab()));
    });

    test('Terminal.app is driven with one AppleScript per window, cd-ing first', () => {
        const invocations = macTerminal.invocations([tab()], { cwd: '/p', bin: { osascript: '/usr/bin/osascript' } });

        assert.equal(invocations.length, 1);
        assert.deepEqual(invocations[0].args.slice(0, 1), ['-e']);
        assert.match(invocations[0].args[1], /do script "cd \/p && cd web && npm run dev; printf /);
        assert.match(invocations[0].args[1], /set custom title of front window to "web"/);
    });

    test('a quote in a command is escaped for AppleScript, not left to close the string', () => {
        const invocations = macTerminal.invocations(
            [tab({ command: 'echo "hi"' })],
            { cwd: '/p', bin: { osascript: '/usr/bin/osascript' } },
        );
        assert.match(invocations[0].args[1], /do script "cd \/p && echo \\"hi\\"; printf /);
    });

    test('appleScriptQuote escapes backslashes before quotes', () => {
        assert.equal(appleScriptQuote('a\\b"c'), '"a\\\\b\\"c"');
    });

    test('wt puts every tab in one invocation, separated by a literal ;', () => {
        const bin = { wt: 'C:\\wt.exe', [SHELL]: 'C:\\bash.exe' };
        const [{ args }] = windowsTerminal.invocations([tab(), tab({ name: 'api' })], { cwd: 'C:\\p', bin });

        assert.equal(args.filter((arg) => arg === ';').length, 1, 'a separator between tabs, not before the first');
        assert.deepEqual(args.slice(0, 6), ['new-tab', '--title', 'web', '-d', 'C:\\p', SHELL]);
    });

    test('every adapter reports the exit status, macOS included', () => {
        // Terminal.app is the one adapter that does not need keepOpen() — `do script`
        // already leaves an interactive shell behind — and it silently skipped the exit
        // line with it, so a crash looked different there than on every other platform.
        const bin = {
            [SHELL]: `/usr/bin/${SHELL}`,
            'gnome-terminal': '/usr/bin/gnome-terminal',
            konsole: '/usr/bin/konsole',
            osascript: '/usr/bin/osascript',
            wt: '/usr/bin/wt',
        };

        for (const adapter of ADAPTERS) {
            const invocations = adapter.invocations([tab()], { cwd: '/p', bin });
            const line = invocations.flatMap(({ args }) => args).join(' ');
            assert.match(line, /\[wsc\] %s exited with status %s/, adapter.id);
        }
    });

    test('every adapter declares the shell it drives, except the one that needs none', () => {
        for (const adapter of ADAPTERS) {
            const needsShell = adapter.id !== 'Terminal.app';
            assert.equal(adapter.binaries.includes(SHELL), needsShell, adapter.id);
            assert.equal(adapter.binaries[0], { 'Terminal.app': 'osascript' }[adapter.id] ?? adapter.id);
        }
    });
});

describe('openTerminalTabs', () => {
    const terminal = { adapter: gnomeTerminal, bin: { 'gnome-terminal': '/usr/bin/gnome-terminal', [SHELL]: '/bin/bash' } };
    const log = { debug: () => {} };

    test('spawns detached, with no stdio, in the project root', async () => {
        // Detached is what lets the tabs outlive wsc; stdio:'ignore' is what keeps
        // gnome-terminal's own deprecation warning off the user's screen.
        const { spawn, calls } = fakeSpawn();
        await openTerminalTabs([tab()], { terminal, cwd: '/p', log, spawn, settleMs: 0 });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, '/usr/bin/gnome-terminal');
        assert.equal(calls[0].options.cwd, '/p');
        assert.equal(calls[0].options.detached, true);
        assert.equal(calls[0].options.stdio, 'ignore');
    });

    test('lets go of the children, so the CLI can exit while the tabs run', async () => {
        const { spawn, children } = fakeSpawn();
        await openTerminalTabs([tab()], { terminal, cwd: '/p', log, spawn, settleMs: 0 });

        assert.equal(children[0].unrefs, 1);
    });

    test('an emulator that cannot be started at all is reported, not swallowed', async () => {
        const { spawn } = fakeSpawn({ failWith: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) });

        await assert.rejects(
            () => openTerminalTabs([tab()], { terminal, cwd: '/p', log, spawn, settleMs: 0 }),
            (err) => err.name === 'FallbackError' && /could not start gnome-terminal: spawn EACCES/.test(err.message),
        );
    });

    test('an emulator that rejects its arguments and exits is reported too', async () => {
        // gnome-terminal is a client that hands the request to a server and exits 0 at
        // once, so "spawned" is not "opened". A non-zero status within the settle window is
        // the only signal that the tabs never appeared.
        const { spawn, children } = fakeSpawn();
        const opening = openTerminalTabs([tab()], { terminal, cwd: '/p', log, spawn, settleMs: 5 });
        setImmediate(() => children[0].emit('exit', 1));

        await assert.rejects(opening, (err) => err.name === 'FallbackError' && /exited with status 1/.test(err.message));
    });

    test('the usual exit-0-immediately is not mistaken for a failure', async () => {
        const { spawn, children } = fakeSpawn();
        const opening = openTerminalTabs([tab()], { terminal, cwd: '/p', log, spawn, settleMs: 5 });
        setImmediate(() => children[0].emit('exit', 0));

        await opening;
    });
});
