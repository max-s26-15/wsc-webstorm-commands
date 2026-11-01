import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listKeys, listKeyRows, pressKey } from '../src/ui/checkboxKeys.js';

/** @param {string} name @param {object} [extra] */
const key = (name, extra = {}) => ({ name, ctrl: false, shift: false, meta: false, ...extra });

const items = () => [
    { value: 'web', name: 'web', checked: true, editable: false },
    { value: 'api', name: 'api', checked: false, editable: false },
    { value: 'c:seed', name: '⌘ seed', checked: true, editable: true },
];

describe('pressKey — the list itself', () => {
    test('up and down move the cursor and stop at either end', () => {
        let state = { items: items(), active: 0 };
        state = pressKey(state, key('down')).state;
        assert.equal(state.active, 1);
        state = pressKey(state, key('down')).state;
        state = pressKey(state, key('down')).state;
        assert.equal(state.active, 2);
        state = pressKey(state, key('up')).state;
        assert.equal(state.active, 1);
        assert.equal(pressKey({ items: items(), active: 0 }, key('up')).state.active, 0);
    });

    test('space toggles the item under the cursor and nothing else', () => {
        const { state } = pressKey({ items: items(), active: 1 }, key('space'));
        assert.deepEqual(state.items.map((item) => item.checked), [true, true, true]);
    });

    test('a checks everything, or unchecks everything when all are checked already', () => {
        const all = pressKey({ items: items(), active: 0 }, key('a')).state;
        assert.deepEqual(all.items.map((item) => item.checked), [true, true, true]);
        const none = pressKey(all, key('a')).state;
        assert.deepEqual(none.items.map((item) => item.checked), [false, false, false]);
    });

    test('i inverts every item', () => {
        const { state } = pressKey({ items: items(), active: 0 }, key('i'));
        assert.deepEqual(state.items.map((item) => item.checked), [false, true, false]);
    });

    test('a digit toggles that item and moves the cursor to it', () => {
        const { state } = pressKey({ items: items(), active: 0 }, key('2'));
        assert.equal(state.active, 1);
        assert.equal(state.items[1].checked, true);
        assert.equal(pressKey({ items: items(), active: 0 }, key('9')).state.items.length, 3, 'past the end: nothing');
    });

    test('does not mutate the state it was given', () => {
        const state = { items: items(), active: 1 };
        pressKey(state, key('space'));
        pressKey(state, key('i'));
        assert.deepEqual(state, { items: items(), active: 1 });
    });

    test('a key the list does not use changes nothing and decides nothing', () => {
        const state = { items: items(), active: 0 };
        assert.deepEqual(pressKey(state, key('x')), { state });
    });
});

describe('pressKey — INQUIRER_KEYBINDINGS, as the stock checkbox honours them', () => {
    const at = (active) => ({ items: items(), active });

    test('vim: j and k move the cursor', () => {
        assert.equal(pressKey(at(0), key('j'), { keybindings: ['vim'] }).state.active, 1);
        assert.equal(pressKey(at(1), key('k'), { keybindings: ['vim'] }).state.active, 0);
    });

    test('emacs: ctrl-n and ctrl-p move the cursor, and ctrl-n is not n', () => {
        const down = pressKey(at(0), key('n', { ctrl: true }), { keybindings: ['emacs'] });
        assert.equal(down.state.active, 1);
        assert.equal(down.outcome, undefined);
        assert.equal(pressKey(at(1), key('p', { ctrl: true }), { keybindings: ['emacs'] }).state.active, 0);
    });

    test('without them, j does nothing and ctrl-n neither moves nor adds', () => {
        const state = at(0);
        assert.deepEqual(pressKey(state, key('j')), { state });
        assert.deepEqual(pressKey(state, key('n', { ctrl: true })), { state });
    });
});

describe('pressKey — leaving the list', () => {
    test('enter submits', () => {
        assert.deepEqual(pressKey({ items: items(), active: 0 }, key('return')).outcome, { action: 'submit' });
        assert.deepEqual(pressKey({ items: items(), active: 0 }, key('enter')).outcome, { action: 'submit' });
    });

    test('e on an editable item asks to edit it', () => {
        assert.deepEqual(pressKey({ items: items(), active: 2 }, key('e')).outcome, { action: 'edit', value: 'c:seed' });
    });

    test('e on a run configuration does nothing', () => {
        assert.equal(pressKey({ items: items(), active: 0 }, key('e')).outcome, undefined);
    });

    test('n asks for a new custom command, wherever the cursor is', () => {
        assert.deepEqual(pressKey({ items: items(), active: 0 }, key('n')).outcome, { action: 'new' });
    });

    test('a letter with ctrl is not that letter: ctrl-a, ctrl-e and ctrl-n do nothing', () => {
        const state = { items: items(), active: 2 };
        for (const name of ['a', 'e', 'n', 'i']) {
            assert.deepEqual(pressKey(state, key(name, { ctrl: true })), { state }, name);
        }
    });

    test('an empty list can still be submitted or given a new entry, and ignores the rest', () => {
        const empty = { items: [], active: 0 };
        assert.deepEqual(pressKey(empty, key('return')).outcome, { action: 'submit' });
        assert.deepEqual(pressKey(empty, key('n')).outcome, { action: 'new' });
        for (const name of ['space', 'down', 'up', 'e', '1', 'a', 'i']) {
            assert.deepEqual(pressKey(empty, key(name)), { state: empty }, name);
        }
    });
});

describe('pressKey — t, the pause of the whole preset', () => {
    test('leaves the list, on any row', () => {
        assert.deepEqual(pressKey({ items: items(), active: 1 }, key('t')).outcome, { action: 'pause' });
    });

    test('works in an empty list', () => {
        assert.deepEqual(pressKey({ items: [], active: 0 }, key('t')).outcome, { action: 'pause' });
    });

    test('Ctrl-T and Meta-T do not open it', () => {
        assert.equal(pressKey({ items: items(), active: 0 }, key('t', { ctrl: true })).outcome, undefined);
        assert.equal(pressKey({ items: items(), active: 0 }, key('t', { meta: true })).outcome, undefined);
    });
});

describe('listKeyRows — the key line, wrapped by us', () => {
    const width = (row) => row.map(([k, action]) => `${k} ${action}`).join(' • ').length;

    test('offers t pause, and e only when the row is editable', () => {
        assert.ok(listKeys(false).some(([k, action]) => k === 't' && action === 'pause'));
        assert.equal(listKeys(false).some(([k]) => k === 'e'), false);
        assert.ok(listKeys(true).some(([k]) => k === 'e'));
    });

    test('an unknown width is one row', () => {
        assert.equal(listKeyRows(listKeys(true), undefined).length, 1);
    });

    test('no row is wider than the terminal, and no key is lost or split', () => {
        const rows = listKeyRows(listKeys(true), 40);
        assert.ok(rows.length > 1);
        for (const row of rows) assert.ok(width(row) <= 40, JSON.stringify(row));
        assert.deepEqual(rows.flat(), listKeys(true));
    });

    test('a width narrower than a key still gives every key a row', () => {
        assert.deepEqual(listKeyRows(listKeys(false), 1).flat(), listKeys(false));
    });
});
