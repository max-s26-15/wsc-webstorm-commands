/**
 * The shells `wsc --completion` can print a script for.
 *
 * Its own tiny module so both src/cli.js (which validates the flag) and the completion
 * code (which offers the values) can import it without importing each other.
 */

export const COMPLETION_SHELLS = /** @type {const} */ (['zsh', 'bash']);

/** @typedef {typeof COMPLETION_SHELLS[number]} CompletionShell */

/**
 * @param {unknown} value
 * @returns {value is CompletionShell}
 */
export function isCompletionShell(value) {
    return typeof value === 'string' && /** @type {readonly string[]} */ (COMPLETION_SHELLS).includes(value);
}
