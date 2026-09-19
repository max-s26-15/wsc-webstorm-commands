import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { findBusyPorts, isPortFree } from '../src/exec/inspectorPorts.js';
import { occupyPort } from '../test-utils/fake-server.js';

describe('isPortFree', () => {
    test('a port nothing is listening on is free', async () => {
        // Ask the OS for a port and hand it straight back, so it is known-unused.
        const { port, close } = await occupyPort();
        await close();
        assert.equal(await isPortFree(port), true);
    });

    test('a port with a listener on it is not', async () => {
        const { port, close } = await occupyPort();
        try {
            assert.equal(await isPortFree(port), false);
        } finally {
            await close();
        }
    });

    test('a listener on every interface also blocks the loopback port', async () => {
        // What a container-facing dev server looks like: bound to 0.0.0.0, but Node's
        // inspector still cannot take 127.0.0.1:<port> afterwards.
        const { port, close } = await occupyPort('0.0.0.0');
        try {
            assert.equal(await isPortFree(port, { host: '127.0.0.1' }), false);
        } finally {
            await close();
        }
    });

    test('the port is released again — the check may not become the squatter', async () => {
        const { port, close } = await occupyPort();
        await close();

        assert.equal(await isPortFree(port), true);
        assert.equal(await isPortFree(port), true, 'the first check must not have kept it');
    });

    test('an answer that never arrives counts as usable rather than holding up a launch', async () => {
        // 0 always binds (the OS picks a port), so this only exercises the timeout path
        // being harmless; the check is best-effort by design.
        assert.equal(await isPortFree(0, { timeoutMs: 1 }), true);
    });
});

describe('findBusyPorts', () => {
    test('reports only the taken ones, in the order given', async () => {
        const taken = await occupyPort();
        const free = await occupyPort();
        await free.close();

        try {
            assert.deepEqual(await findBusyPorts([free.port, taken.port]), [taken.port]);
        } finally {
            await taken.close();
        }
    });

    test('an empty list asks the OS nothing', async () => {
        assert.deepEqual(await findBusyPorts([]), []);
    });
});
