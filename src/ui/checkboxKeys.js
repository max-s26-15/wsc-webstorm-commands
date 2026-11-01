/**
 * The keys of the `--configure` list, as a pure function of the list's state.
 *
 * `@inquirer/prompts`' own checkbox has no room for a key of ours, so the list is drawn by
 * editableCheckbox.js instead. Everything it decides lives here, where it is unit-tested;
 * that file only renders and forwards keypresses.
 *
 * The keys are the stock checkbox's (↑↓, space, a, i, 1–9, enter) plus three that leave the
 * list for a moment: `e` edits the custom command under the cursor, `n` adds a new one, `t`
 * sets the pause after the whole preset.
 */

import { isDownKey, isUpKey } from '@inquirer/core';

/**
 * @typedef {{ value: string, name: string, checked: boolean, editable: boolean }} Item
 * @typedef {{ items: Item[], active: number }} ListState
 * @typedef {{ action: 'submit' } | { action: 'edit', value: string } | { action: 'new' } | { action: 'pause' }} Outcome
 * @typedef {{ name?: string, ctrl?: boolean, meta?: boolean }} Key - as readline reports it
 */

/** Between two keys of the key line, as drawn. */
const KEY_SEPARATOR = ' • ';

/**
 * What the key line offers.
 *
 * @param {boolean} editable - whether the row under the cursor can take `e`
 * @returns {[string, string][]} key, and what it does
 */
export function listKeys(editable) {
    return [
        ['↑↓', 'navigate'],
        ['space', 'select'],
        ...(editable ? /** @type {[string, string][]} */ ([['e', 'edit']]) : []),
        ['n', 'new command'],
        ['t', 'pause'],
        ['a', 'all'],
        ['i', 'invert'],
        ['⏎', 'submit'],
    ];
}

/**
 * Break the key line between keys, so the number of lines it takes is known before it is drawn:
 * the list is sized from that, and left to the terminal it wraps wherever the text falls.
 *
 * @param {[string, string][]} keys
 * @param {number | undefined} columns - `stdout.columns`; unknown means one row
 * @returns {[string, string][][]}
 */
export function listKeyRows(keys, columns) {
    if (columns === undefined) return [keys];

    /** @type {[string, string][][]} */
    const rows = [];
    let width = 0;
    for (const key of keys) {
        const needed = `${key[0]} ${key[1]}`.length;
        if (rows.length > 0 && width + KEY_SEPARATOR.length + needed <= columns) {
            rows[rows.length - 1].push(key);
            width += KEY_SEPARATOR.length + needed;
        } else {
            rows.push([key]);
            width = needed;
        }
    }
    return rows;
}

/**
 * Navigation goes through `@inquirer/core`'s own key tests with the theme's keybindings, as in
 * the stock checkbox, so `INQUIRER_KEYBINDINGS=vim` (j/k) and `=emacs` (Ctrl-N/Ctrl-P) work
 * here as they do in every other prompt of the screen. They are checked before the letters
 * below, which is what keeps Ctrl-N "down" under emacs rather than "new".
 *
 * @param {ListState} state
 * @param {Key} key
 * @param {{ keybindings?: ReadonlyArray<'vim' | 'emacs'> }} [opts] - the theme's
 * @returns {{ state: ListState, outcome?: Outcome }} `outcome` only when the key leaves the list
 */
export function pressKey(state, key, { keybindings = [] } = {}) {
    const { items, active } = state;
    const name = key.name ?? '';
    const coreKey = { name, ctrl: Boolean(key.ctrl), shift: false, meta: Boolean(key.meta) };

    if (name === 'return' || name === 'enter') return { state, outcome: { action: 'submit' } };
    if (items.length > 0 && isUpKey(coreKey, [...keybindings])) {
        return { state: { items, active: Math.max(active - 1, 0) } };
    }
    if (items.length > 0 && isDownKey(coreKey, [...keybindings])) {
        return { state: { items, active: Math.min(active + 1, items.length - 1) } };
    }
    // Ctrl-A, Ctrl-E and friends are line-editing habits, not the letters this list uses.
    if (key.ctrl || key.meta) return { state };
    if (name === 'n') return { state, outcome: { action: 'new' } };
    if (name === 't') return { state, outcome: { action: 'pause' } };
    if (items.length === 0) return { state };

    /** @param {(item: Item, index: number) => boolean} pick */
    const toggleWhere = (pick) => items.map((item, index) => (pick(item, index) ? { ...item, checked: !item.checked } : item));

    switch (name) {
        case 'space':
            return { state: { items: toggleWhere((_, index) => index === active), active } };
        case 'a': {
            const checked = items.some((item) => !item.checked);
            return { state: { items: items.map((item) => ({ ...item, checked })), active } };
        }
        case 'i':
            return { state: { items: toggleWhere(() => true), active } };
        case 'e': {
            const item = items[active];
            return item?.editable ? { state, outcome: { action: 'edit', value: item.value } } : { state };
        }
    }

    if (/^[1-9]$/.test(name)) {
        const index = Number(name) - 1;
        if (index >= items.length) return { state };
        return { state: { items: toggleWhere((_, i) => i === index), active: index } };
    }

    return { state };
}
