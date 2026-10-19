import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { editableCheckbox } from '../src/ui/editableCheckbox.js';

// What @inquirer/core's ScreenManager writes when a prompt settles: the last render is
// either erased (clearPromptOnDone) or left behind with a newline, then the cursor reset.
const ERASE_LINE = '\u001b[2K';
const SETTLED = '\u001b[G\u001b[?25h';

const ITEMS = [
    { value: 'web', name: 'web', checked: true, editable: false },
    { value: 'api', name: 'api', checked: false, editable: false },
    { value: 'c:0', name: '⌘ seed — npm i', checked: false, editable: true },
];

/**
 * Drive the real prompt through fake streams: keys go in one at a time, as a terminal sends them.
 *
 * @param {string[]} keys
 * @param {object} [config]
 */
async function press(keys, config = {}) {
    const input = new PassThrough();
    let out = '';
    const output = new Writable({
        write(chunk, _encoding, callback) {
            out += chunk.toString();
            callback();
        },
    });

    const answer = editableCheckbox({ message: 'Pick', choices: ITEMS, ...config }, { input, output });
    for (const key of keys) {
        await new Promise((resolve) => setImmediate(resolve));
        input.write(key);
    }
    const result = await answer;
    return { result, out };
}

describe('editableCheckbox — the real prompt, through fake streams', () => {
    test('Enter submits what is checked and leaves the answer line behind', async () => {
        const { result, out } = await press(['\u001b[B', ' ', '\r']);

        assert.deepEqual(result, { action: 'submit', checked: ['web', 'api'], active: 1 });
        assert.ok(out.endsWith(`\n${SETTLED}`), 'not erased');
        assert.match(out.slice(out.lastIndexOf('Pick')), /^Pick.*web, api/);
    });

    test('e on a custom entry leaves the list with its state, and erases it', async () => {
        const { result, out } = await press(['e'], { active: 2 });

        assert.deepEqual(result, { action: 'edit', value: 'c:0', checked: ['web'], active: 2 });
        assert.ok(out.endsWith(`${ERASE_LINE}\u001b[G${SETTLED}`), 'erased');
    });

    test('n leaves the list and erases it too', async () => {
        const { result, out } = await press([' ', 'n']);

        assert.deepEqual(result, { action: 'new', checked: [], active: 0 });
        assert.ok(out.endsWith(`${ERASE_LINE}\u001b[G${SETTLED}`), 'erased');
    });

    test('the key line offers e only on a custom entry', async () => {
        const { out } = await press(['\u001b[B', '\u001b[B', '\r']);
        const renders = out.split('Pick').slice(1, -1);

        assert.doesNotMatch(renders[0], /e\S* edit/);
        assert.match(renders.at(-1), /e\S* edit/);
    });

    test('the theme\'s keybindings reach the keys: INQUIRER_KEYBINDINGS=vim moves with j', async () => {
        const saved = process.env.INQUIRER_KEYBINDINGS;
        process.env.INQUIRER_KEYBINDINGS = 'vim';
        try {
            const { result } = await press(['j', 'j', '\r']);
            assert.equal(result.active, 2);
        } finally {
            if (saved === undefined) delete process.env.INQUIRER_KEYBINDINGS;
            else process.env.INQUIRER_KEYBINDINGS = saved;
        }
    });

    test('an empty list says how to add an entry, and n still works', async () => {
        const { result, out } = await press(['n'], { choices: [] });

        assert.deepEqual(result, { action: 'new', checked: [], active: 0 });
        assert.match(out, /press n to add a custom command/);
    });
});
