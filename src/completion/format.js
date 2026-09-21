/**
 * Turn what to offer into the text a shell wrapper reads.
 *
 * zsh gets the candidates as they are: `compadd` quotes them for whatever the user has
 * already typed. bash gets them ready for COMPREPLY, because readline inserts them
 * verbatim — so the escaping, and the cut at the last word break, happen here, in
 * JavaScript, where they are unit-tested, instead of in the shell.
 */
import { CONTROL_CHARACTERS } from '../presets/store.js';

/** What an interactive bash starts with: `printf %q "$COMP_WORDBREAKS"`. */
export const DEFAULT_WORDBREAKS = ' \t\n"\'><=;|&(:';

/** Characters bash needs no backslash for. `:` and `=` are in it: they are word breaks, not syntax. */
const SAFE = /^(?:[A-Za-z0-9_@%+=:,./-]|[^\x00-\x7f])$/u;

/**
 * @param {string} text
 * @returns {string} `text` with a backslash before every character bash would split or expand
 */
export function escapeForBash(text) {
    let out = '';
    for (const ch of text) out += SAFE.test(ch) ? ch : `\\${ch}`;
    return out;
}

/**
 * @param {string} candidate
 * @param {import('./tokenize.js').Tokenized} typed
 * @param {string} wordBreaks
 * @returns {string}
 */
function bashItem(candidate, { partial, unescaped, quote }, wordBreaks) {
    // readline strips the opening quote itself and closes it for a single match.
    if (quote !== null) return candidate;

    // readline replaces only the text after the last word break the user typed *bare*; a
    // backslashed one is part of the word. A candidate always begins with the decoded
    // partial word, so the same offset cuts it: that holds because candidates.js only ever
    // offers strict prefix matches, and this cut is wrong for any source that does not.
    let cut = 0;
    for (let i = 0; i < partial.length; i += 1) {
        if (unescaped[i] && wordBreaks.includes(partial[i])) cut = i + 1;
    }
    const rest = candidate.slice(cut);
    return rest === '' ? '' : escapeForBash(rest);
}

/**
 * @param {import('./candidates.js').Completion} completion
 * @param {import('./shells.js').CompletionShell} shell
 * @param {import('./tokenize.js').Tokenized} typed
 * @param {string} [wordBreaks] - bash's COMP_WORDBREAKS
 * @returns {string} the directive on the first line, then one candidate per line
 */
export function formatCompletion(completion, shell, typed, wordBreaks = DEFAULT_WORDBREAKS) {
    // One candidate per line is the whole protocol; a name with a line break in it cannot be
    // sent, and offering half of it would be worse than not offering it. The same goes for
    // any other control character (an ESC would reach the terminal raw in readline's listing):
    // the definition is the preset store's, so a name it refuses is one this drops.
    const safe = completion.values.filter((value) => !CONTROL_CHARACTERS.test(value));
    const items = shell === 'bash' ? safe.map((value) => bashItem(value, typed, wordBreaks)) : safe;
    return [completion.directive, ...items.filter((item) => item !== '')].join('\n') + '\n';
}
