import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { COMPLETION_SHELLS, isCompletionShell } from '../src/completion/shells.js';

describe('completion shells', () => {
    test('are zsh and bash', () => {
        assert.deepEqual([...COMPLETION_SHELLS], ['zsh', 'bash']);
    });

    test('isCompletionShell accepts the listed shells and nothing else', () => {
        assert.equal(isCompletionShell('zsh'), true);
        assert.equal(isCompletionShell('bash'), true);
        assert.equal(isCompletionShell('fish'), false);
        assert.equal(isCompletionShell(''), false);
        assert.equal(isCompletionShell(undefined), false);
        assert.equal(isCompletionShell('constructor'), false);
    });
});
