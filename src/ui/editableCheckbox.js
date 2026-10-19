/**
 * The `--configure` list: `@inquirer/prompts`' checkbox, plus `e` (edit the custom command
 * under the cursor) and `n` (add one).
 *
 * The stock checkbox takes no key of ours, so this draws the list itself on
 * `@inquirer/core`, the library that checkbox is built on, and looks the same. Every
 * decision a key makes is in checkboxKeys.js, which is unit-tested; what is left here is
 * rendering, verified by hand through a pty like the other prompts.
 *
 * `e` and `n` *leave* the list: the prompt settles with what it was holding, the caller
 * runs its menu and draws the list again from that state. Leaving erases the list from the
 * terminal (and the caller's menus erase themselves), so the user sees one list changing
 * in place; only the final Enter leaves the usual `✔ question answer` line behind.
 */
import { createPrompt, makeTheme, useKeypress, usePagination, usePrefix, useState } from '@inquirer/core';
import figures from '@inquirer/figures';
import { styleText } from 'node:util';

import { pressKey } from './checkboxKeys.js';

const CURSOR_HIDE = '\u001b[?25l';

/**
 * @typedef {import('./checkboxKeys.js').Item} Item
 * @typedef {{
 *   action: 'submit' | 'edit' | 'new',
 *   value?: string,
 *   checked: string[],
 *   active: number,
 * }} ListResult - `checked` and `active` are the list as it was left, to draw it again from
 * @typedef {{
 *   message: string,
 *   choices: Item[],
 *   active?: number,
 *   pageSize?: number,
 * }} ListConfig
 */

/** @param {[string, string][]} keys */
const helpLine = (keys) =>
    keys.map(([key, action]) => `${styleText('bold', key)} ${styleText('dim', action)}`).join(styleText('dim', ' • '));

const view = createPrompt(
    /**
     * @param {ListConfig & { leaving: () => void }} config
     * @param {(result: ListResult) => void} done
     */
    (config, done) => {
        const theme = makeTheme({});
        const [status, setStatus] = useState(/** @type {'idle' | 'done' | 'away'} */ ('idle'));
        const prefix = usePrefix({ status: status === 'idle' ? 'idle' : 'done', theme });
        const [state, setState] = useState(() => ({
            items: config.choices,
            active: Math.max(0, Math.min(config.active ?? 0, config.choices.length - 1)),
        }));

        useKeypress((key) => {
            const { state: next, outcome } = pressKey(state, key);
            if (!outcome) {
                setState(next);
                return;
            }
            if (outcome.action !== 'submit') config.leaving();
            setStatus(outcome.action === 'submit' ? 'done' : 'away');
            done({
                ...outcome,
                checked: next.items.filter((item) => item.checked).map((item) => item.value),
                active: next.active,
            });
        });

        const message = theme.style.message(config.message, status === 'idle' ? 'idle' : 'done');
        const page = usePagination({
            items: state.items,
            active: state.active,
            renderItem: ({ item, isActive }) => {
                const cursor = isActive ? figures.pointer : ' ';
                const box = item.checked ? styleText('green', figures.circleFilled) : figures.circle;
                const line = `${cursor}${box} ${item.name}`;
                return isActive ? theme.style.highlight(line) : line;
            },
            pageSize: config.pageSize ?? 7,
            loop: false,
        });

        if (status === 'away') return '';
        if (status === 'done') {
            const answer = state.items.filter((item) => item.checked).map((item) => item.name).join(', ');
            return [prefix, message, theme.style.answer(answer)].filter(Boolean).join(' ');
        }

        /** @type {[string, string][]} */
        const keys = [['↑↓', 'navigate'], ['space', 'select']];
        if (state.items[state.active]?.editable) keys.push(['e', 'edit']);
        keys.push(['n', 'new command'], ['a', 'all'], ['i', 'invert'], ['⏎', 'submit']);

        const body = state.items.length > 0 ? page : styleText('dim', '  (empty — press n to add a custom command)');
        return `${[`${prefix} ${message}`, body, ' ', helpLine(keys)].join('\n')}${CURSOR_HIDE}`;
    },
);

/**
 * Draw the list until Enter, `e` or `n`.
 *
 * `@inquirer/core` reads `clearPromptOnDone` off the context only once the prompt has
 * settled, so the context is created here and flipped by the view when it leaves through
 * `e` or `n` — the one moment that knows whether the list should stay on screen.
 *
 * @param {ListConfig} config
 * @param {Parameters<typeof view>[1]} [context]
 * @returns {Promise<ListResult>}
 */
export function editableCheckbox(config, context = {}) {
    const ctx = { ...context };
    return view({ ...config, leaving: () => { ctx.clearPromptOnDone = true; } }, ctx);
}
