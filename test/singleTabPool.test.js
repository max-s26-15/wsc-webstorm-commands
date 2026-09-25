import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../src/log.js';
import { SHELL } from '../src/fallback/terminalTabs.js';
import { lineBuffer, missingShellMessage, runSingleTabPool } from '../src/fallback/singleTabPool.js';
import { fakeSignals, fakeSpawn } from '../test-utils/fake-child.js';
import { fakeStream } from '../test-utils/capture.js';

/** A logger writing into strings, with colour on, so the tagging can be asserted. */
const testLogger = (env = { FORCE_COLOR: '1' }) => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    return { log: createLogger({ stdout, stderr, env }), out: () => stdout.text(), err: () => stderr.text() };
};

const TABS = [
    { name: 'web', command: 'npm run dev' },
    { name: 'api', command: 'cd api && npm run dev' },
];

describe('lineBuffer', () => {
    test('emits whole lines only, holding an unfinished one back', () => {
        // Without this, two children writing at once produce half a line with another
        // configuration's prefix stapled into the middle of it.
        const lines = [];
        const buffer = lineBuffer((line) => lines.push(line));

        buffer.push('one\ntw');
        assert.deepEqual(lines, ['one']);

        buffer.push('o\nthree\n');
        assert.deepEqual(lines, ['one', 'two', 'three']);
    });

    test('flushes the tail when the stream ends', () => {
        const lines = [];
        const buffer = lineBuffer((line) => lines.push(line));

        buffer.push('dying mid-sen');
        buffer.flush();
        assert.deepEqual(lines, ['dying mid-sen']);
    });

    test('a second flush emits nothing', () => {
        const lines = [];
        const buffer = lineBuffer((line) => lines.push(line));

        buffer.push('x');
        buffer.flush();
        buffer.flush();
        assert.deepEqual(lines, ['x']);
    });

    test('strips the carriage return of CRLF output', () => {
        const lines = [];
        const buffer = lineBuffer((line) => lines.push(line));

        buffer.push('windows\r\n');
        assert.deepEqual(lines, ['windows']);
    });
});

describe('runSingleTabPool', () => {
    test('runs every command through the shell, in the project root', async () => {
        const { spawn, calls, children } = fakeSpawn({ pipes: true });
        const { log } = testLogger();

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals() });
        for (const child of children) child.finish(0);
        assert.equal(await run, 0);

        assert.equal(calls.length, 2);
        assert.equal(calls[0].command, SHELL);
        assert.deepEqual(calls[0].args, ['-c', 'npm run dev']);
        assert.equal(calls[0].options.cwd, '/p');
        // stdin is closed: several children reading one terminal would each get a fraction
        // of whatever is typed.
        assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    });

    test('tags every line with the configuration it came from, in its own colour', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true });
        const { log, err } = testLogger();

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals() });
        children[0].say('stdout', 'listening on 3000\n');
        children[1].say('stderr', 'warn: slow\n');
        for (const child of children) child.finish(0);
        await run;

        assert.match(err(), /\[web\][^\n]*listening on 3000/);
        assert.match(err(), /\[api\][^\n]*warn: slow/);
        // The palette from src/log.js, not a second colour system invented here.
        assert.match(err(), /\x1b\[3\d?m\[web\]\x1b\[0m/);
    });

    test('the tagged output stays on stderr, so stdout is still a clean pipe', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true });
        const { log, out } = testLogger();

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals() });
        children[0].say('stdout', 'hello\n');
        for (const child of children) child.finish(0);
        await run;

        assert.equal(out(), '');
    });

    test('a child that exits non-zero makes the whole run fail', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true });
        const { log, err } = testLogger();

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals() });
        children[0].finish(0);
        children[1].finish(1);

        assert.equal(await run, 1);
        assert.match(err(), /\[api\][^\n]*exited with code 1/);
    });

    test('a command that cannot be spawned at all is a failure, not a hang', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true, manual: true });
        const { log, err } = testLogger();

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: fakeSignals() });
        children[0].emit('error', new Error('spawn bash ENOENT'));

        assert.equal(await run, 1);
        assert.match(err(), /web: spawn bash ENOENT/);
    });

    test('a missing bash is one readable line, not a spawn error per tab', async () => {
        // Windows without Git Bash: every tab fails the same way, and ENOENT says nothing useful.
        const enoent = Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' });
        const { spawn } = fakeSpawn({ pipes: true, failWith: enoent });
        const { log, err } = testLogger({ NO_COLOR: '1' });

        const code = await runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals(), platform: 'win32' });

        assert.equal(code, 1);
        const errors = err().split('\n').filter((line) => line.startsWith('error:'));
        assert.deepEqual(errors, [`error: ${missingShellMessage()}`]);
        assert.doesNotMatch(err(), /ENOENT/);
        assert.match(missingShellMessage(), /Git Bash/);
    });

    test('the last words of a crashing process are printed before its status line', async () => {
        // 'close' rather than 'exit' is what guarantees this: the pipes are drained first.
        const { spawn, children } = fakeSpawn({ pipes: true });
        const { log, err } = testLogger({ NO_COLOR: '1' });

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: fakeSignals() });
        children[0].say('stderr', 'Error: boom');
        children[0].finish(1);
        await run;

        const lines = err().trim().split('\n');
        assert.deepEqual(lines.slice(-2), ['[web] Error: boom', '[web] exited with code 1']);
    });

    test('Ctrl-C stops every child and exits 130', async () => {
        // A pool that leaves orphans behind is a real hazard: each child is holding a port.
        const { spawn, children } = fakeSpawn({ pipes: true, manual: true });
        const signals = fakeSignals();
        const { log, err } = testLogger();

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: signals, killGraceMs: 5 });
        signals.emit('SIGINT');

        assert.deepEqual(children.map((child) => child.killed), [['SIGINT'], ['SIGINT']]);
        for (const child of children) child.finish(null, 'SIGINT');

        assert.equal(await run, 130);
        assert.match(err(), /stopping 2 process\(es\)/);
        assert.match(err(), /\[web\][^\n]*stopped by SIGINT/);
    });

    test('Ctrl-C signals the whole process group, not just the shell', async () => {
        // The child is `bash -c "npm run dev"`, which becomes bash → npm → sh → the server.
        // Signalling only the child leaves the server holding the output pipe, so 'close'
        // never fires and the pool hangs with the processes it was asked to stop still
        // running — reproduced live before this existed. A negative pid addresses the whole
        // group, which is what detached:true gave each child.
        const { spawn, calls, children } = fakeSpawn({ pipes: true, manual: true });
        const signals = fakeSignals();
        const { log } = testLogger();

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: signals, platform: 'linux' });
        children[0].pid = 4242;
        assert.equal(calls[0].options.detached, true, 'a group of its own to signal');

        signals.emit('SIGINT');
        assert.deepEqual(signals.signalled, [[-4242, 'SIGINT']]);
        assert.deepEqual(children[0].killed, [], 'the child alone was not enough');

        children[0].finish(null, 'SIGINT');
        assert.equal(await run, 130);
    });

    test('a child that is already gone falls back to killing it directly', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true, manual: true });
        const signals = fakeSignals({ killThrows: Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) });
        const { log } = testLogger();

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: signals, platform: 'linux' });
        children[0].pid = 4242;
        signals.emit('SIGINT');

        assert.deepEqual(children[0].killed, ['SIGINT']);
        children[0].finish(null, 'SIGINT');
        assert.equal(await run, 130);
    });

    test('a second Ctrl-C escalates to SIGKILL', async () => {
        const { spawn, children } = fakeSpawn({ pipes: true, manual: true });
        const signals = fakeSignals();
        const { log } = testLogger();

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: signals, killGraceMs: 60_000 });
        signals.emit('SIGINT');
        signals.emit('SIGINT');

        assert.deepEqual(children[0].killed, ['SIGINT', 'SIGKILL']);
        children[0].finish(null, 'SIGKILL');
        assert.equal(await run, 130);
    });

    test('the SIGINT handler is removed again, whatever happened', async () => {
        // The pool is not the last thing a process does — runCli returns an exit code to
        // bin/wsc.js — so a handler left installed would swallow the next Ctrl-C.
        const { spawn, children } = fakeSpawn({ pipes: true });
        const signals = fakeSignals();
        const { log } = testLogger();

        const run = runSingleTabPool([TABS[0]], { cwd: '/p', log, spawn, process: signals });
        assert.equal(signals.handlers.length, 1);
        children[0].finish(0);
        await run;

        assert.deepEqual(signals.handlers, []);
    });
});
