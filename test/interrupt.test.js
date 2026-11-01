import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createInterruptScope } from '../src/exec/interrupt.js';
import { fakeSignals } from '../test-utils/fake-child.js';

describe('createInterruptScope', () => {
    test('holds one SIGINT handler, and SIGINT aborts its signal', () => {
        const signals = fakeSignals();
        const scope = createInterruptScope(signals);
        assert.equal(signals.handlers.length, 1);
        assert.equal(scope.signal.aborted, false);
        signals.emit('SIGINT');
        assert.equal(scope.signal.aborted, true);
        scope.dispose();
    });

    test('dispose removes the handler, and doing it twice is fine', () => {
        const signals = fakeSignals();
        const scope = createInterruptScope(signals);
        scope.dispose();
        scope.dispose();
        assert.equal(signals.handlers.length, 0);
    });

    test('dispose in a finally cleans up after a body that threw', async () => {
        const signals = fakeSignals();
        const body = async () => {
            const scope = createInterruptScope(signals);
            try {
                throw new Error('boom');
            } finally {
                scope.dispose();
            }
        };
        await assert.rejects(body(), /boom/);
        assert.equal(signals.handlers.length, 0);
    });
});
