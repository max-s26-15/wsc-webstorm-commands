import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../src/log.js';
import { SHELL } from '../src/fallback/terminalTabs.js';
import { lineBuffer, missingShellMessage, runSingleTabPool } from '../src/fallback/singleTabPool.js';
import { fakeSignals, fakeSpawn } from '../test-utils/fake-child.js';
import { fakeStream } from '../test-utils/capture.js';
import { createControlledWait } from '../test-utils/controlled-wait.js';

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
        // Node's order for a failed spawn: 'error', then 'close' with a negative code
        // (-2 on POSIX, -4058 on Windows) — neither may add a line per configuration.
        const enoent = () => Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' });
        const { spawn, children } = fakeSpawn({ pipes: true, manual: true });
        const { log, err } = testLogger({ NO_COLOR: '1' });

        const run = runSingleTabPool(TABS, { cwd: '/p', log, spawn, process: fakeSignals(), platform: 'win32' });
        for (const child of children) {
            child.emit('error', enoent());
            child.finish(-4058);
        }

        assert.equal(await run, 1);
        // Let the 'close' events that follow each 'error' be delivered before reading.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const errors = err().split('\n').filter((line) => line.startsWith('error:'));
        assert.deepEqual(errors, [`error: ${missingShellMessage()}`]);
        assert.doesNotMatch(err(), /ENOENT/);
        assert.doesNotMatch(err(), /exited with code/);
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

describe('runSingleTabPool — stages', { timeout: 5000 }, () => {
    const THREE = [...TABS, { name: 'mail', command: 'npm run mail' }];
    const BARRIER = [{ after: 1, presetName: 'infra', waitAfterSeconds: 10, members: [0] }];
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    const setup = (tabs = TABS, barriers = BARRIER) => {
        const fake = fakeSpawn({ pipes: true, manual: true });
        const signals = fakeSignals();
        const clock = createControlledWait();
        const logged = testLogger({ NO_COLOR: '1' });
        const running = runSingleTabPool(tabs, {
            cwd: '/p',
            log: logged.log,
            spawn: fake.spawn,
            process: signals,
            platform: 'linux',
            barriers,
            wait: clock.wait,
        });
        return { ...fake, signals, clock, running, ...logged };
    };

    test('the next stage starts after the pause, with the first child still alive', async () => {
        const h = setup();
        assert.equal(h.children.length, 1);
        h.children[0].emit('spawn');
        const pending = await h.clock.next();
        assert.equal(pending.ms, 10000);
        assert.equal(h.children.length, 1, 'nothing behind the pause has started');

        pending.release();
        await tick();
        assert.equal(h.children.length, 2);
        h.children[1].emit('spawn');
        await tick();

        h.children[0].finish(0);
        h.children[1].finish(0);
        assert.equal(await h.running, 0);
        assert.equal(h.signals.handlers.length, 0);
    });

    test('the timer waits for the launch to be acknowledged', async () => {
        const h = setup();
        await tick();
        assert.deepEqual(h.clock.calls, []);
        h.children[0].emit('spawn');
        (await h.clock.next()).release();
        await tick();
        h.children[1].emit('spawn');
        await tick();
        for (const child of h.children) child.finish(0);
        await h.running;
    });

    test('a spawn error in a member skips what is behind it, and the run fails once its children end', async () => {
        const h = setup(THREE, [{ after: 2, presetName: 'infra', waitAfterSeconds: 10, members: [0, 1] }]);
        h.children[0].emit('error', new Error('nope'));
        h.children[0].emit('close', -2, null);
        h.children[1].emit('spawn');
        await tick();

        assert.equal(h.children.length, 2);
        assert.deepEqual(h.clock.calls, []);
        assert.match(h.err(), /"infra"/);
        assert.match(h.err(), /mail/);

        let settled = false;
        h.running.then(() => { settled = true; });
        await tick();
        assert.equal(settled, false, 'the child that did start is still ours to wait for');

        h.children[1].finish(0);
        assert.equal(await h.running, 1);
        assert.equal(h.children.length, 2);
    });

    test('a failure is counted once, so one spawn error is one failure in the exit code', async () => {
        const h = setup(TABS, []);
        h.children[0].emit('error', new Error('nope'));
        h.children[0].emit('close', -2, null);
        h.children[1].emit('spawn');
        h.children[1].finish(0);
        assert.equal(await h.running, 1);
    });

    test('a nonzero exit after the launch does not hold up the next stage, and still fails the run', async () => {
        const h = setup();
        h.children[0].emit('spawn');
        const pending = await h.clock.next();
        h.children[0].finish(3);
        await tick();

        pending.release();
        await tick();
        assert.equal(h.children.length, 2, 'the timer is not a health check');
        h.children[1].emit('spawn');
        h.children[1].finish(0);
        assert.equal(await h.running, 1);
    });

    test('a child that dies before it was acknowledged still lets the stage end', async () => {
        const h = setup();
        h.children[0].finish(0);
        (await h.clock.next()).release();
        await tick();
        h.children[1].emit('spawn');
        h.children[1].finish(0);
        assert.equal(await h.running, 0);
    });

    test('all children ending during the pause does not end the run', async () => {
        const h = setup();
        h.children[0].emit('spawn');
        const pending = await h.clock.next();

        let settled = false;
        h.running.then(() => { settled = true; });
        h.children[0].finish(0);
        await tick();
        assert.equal(settled, false, 'there is still something planned');

        pending.release();
        await tick();
        assert.equal(h.children.length, 2);
        h.children[1].emit('spawn');
        h.children[1].finish(0);
        assert.equal(await h.running, 0);
    });

    test('Ctrl-C during the pause stops the groups, and a late release spawns nothing', async () => {
        const h = setup();
        h.children[0].pid = 4242;
        h.children[0].emit('spawn');
        const pending = await h.clock.next();

        h.signals.emit();
        assert.deepEqual(h.signals.signalled, [[-4242, 'SIGINT']]);
        pending.release();
        await tick();
        assert.equal(h.children.length, 1);

        h.children[0].finish(null, 'SIGINT');
        assert.equal(await h.running, 130);
        assert.equal(h.signals.handlers.length, 0);
    });

    test('a second Ctrl-C during the pause still escalates', async () => {
        const h = setup();
        h.children[0].pid = 4242;
        h.children[0].emit('spawn');
        await h.clock.next();

        h.signals.emit();
        h.signals.emit();
        assert.deepEqual(h.signals.signalled, [[-4242, 'SIGINT'], [-4242, 'SIGKILL']]);
        h.children[0].finish(null, 'SIGKILL');
        assert.equal(await h.running, 130);
    });

    test('Ctrl-C while a stage is being acknowledged starts no wait', async () => {
        const h = setup();
        h.signals.emit();
        h.children[0].emit('spawn');
        await tick();
        assert.deepEqual(h.clock.calls, []);
        h.children[0].finish(null, 'SIGINT');
        assert.equal(await h.running, 130);
    });

    test('without barriers every child starts at once, as it always has', async () => {
        const h = setup(THREE, []);
        assert.equal(h.children.length, 3);
        for (const child of h.children) child.emit('spawn');
        for (const child of h.children) child.finish(0);
        assert.equal(await h.running, 0);
        assert.deepEqual(h.clock.calls, []);
    });
});
