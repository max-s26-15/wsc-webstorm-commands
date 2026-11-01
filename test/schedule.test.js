import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { insertWaitRows, quotePresetName } from '../src/exec/schedule.js';
import { formatPlan } from '../src/resolve.js';

const barrier = (after, presetName, waitAfterSeconds) => ({ after, presetName, waitAfterSeconds, members: [] });

describe('insertWaitRows', () => {
    test('puts each pause between the rows it separates', () => {
        const barriers = [barrier(1, 'infra', 10), barrier(2, 'api', 5)];
        assert.deepEqual(insertWaitRows(['db', 'api', 'web'], barriers), [
            'db',
            '→ wait 10s after preset "infra"',
            'api',
            '→ wait 5s after preset "api"',
            'web',
        ]);
    });

    test('pauses at one position keep their order', () => {
        const barriers = [barrier(1, 'b', 2), barrier(1, 'a', 3)];
        assert.deepEqual(insertWaitRows(['x', 'y'], barriers), [
            'x',
            '→ wait 2s after preset "b"',
            '→ wait 3s after preset "a"',
            'y',
        ]);
    });

    test('a row holding a newline stays one row', () => {
        assert.deepEqual(insertWaitRows(['a\n  cmd', 'b\n  cmd'], [barrier(1, 'p', 1)]), [
            'a\n  cmd',
            '→ wait 1s after preset "p"',
            'b\n  cmd',
        ]);
    });

    test('no barriers leaves the rows alone', () => {
        assert.deepEqual(insertWaitRows(['a', 'b'], []), ['a', 'b']);
    });

    test('a control character in a preset name cannot forge a row', () => {
        const [, row] = insertWaitRows(['a', 'b'], [barrier(1, 'x\n→ wait 0s\u001b[2J\u009b2J', 1)]);
        assert.equal(row.includes('\n'), false);
        assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(row), false, row);
    });
});

describe('quotePresetName', () => {
    test('is plain JSON for an ordinary name', () => {
        assert.equal(quotePresetName('infra "x"'), '"infra \\"x\\""');
    });

    test('escapes what JSON leaves raw and a terminal would act on', () => {
        assert.equal(quotePresetName('a\u009bb\u007f'), '"a\\u009bb\\u007f"');
    });
});

describe('formatPlan with barriers', () => {
    const config = (name) => ({ name, mode: 'run', config: { name }, source: 'preset' });

    test('shows the pause between entries', () => {
        assert.equal(
            formatPlan([config('db'), config('api')], [barrier(1, 'infra', 10)]),
            'db   run    (preset)\n→ wait 10s after preset "infra"\napi  run    (preset)',
        );
    });

    test('without barriers the text is what it always was', () => {
        assert.equal(formatPlan([config('db'), config('api')]), 'db   run    (preset)\napi  run    (preset)');
        assert.equal(formatPlan([]), 'nothing to launch');
    });
});
