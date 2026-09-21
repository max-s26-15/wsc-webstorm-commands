/**
 * Split the command line the shell handed us — everything up to the cursor — into words.
 *
 * The shells' own splitting (`COMP_WORDS` in bash) breaks at `:`, `=` and `>`, which would
 * cut a name like `api > repro:stale-job:debug` into pieces that are not one token, so the
 * wrapper passes the raw line and this does the splitting the way a shell would: spaces
 * separate words, a backslash keeps the next character, quotes group.
 *
 * Pure: no filesystem, no environment.
 */

/**
 * @typedef {object} Tokenized
 * @property {string[]} words - completed words, decoded, the command name first
 * @property {string} partial - the word under the cursor, decoded; '' after a space
 * @property {boolean[]} unescaped - per character of `partial`: typed bare, i.e. outside
 *   quotes and without a backslash — the only characters a shell treats as word breaks
 * @property {'"' | "'" | null} quote - the quote the partial word is still inside, if any
 */

/**
 * @param {string} line
 * @returns {Tokenized}
 */
export function tokenize(line) {
    /** @type {string[]} */
    const words = [];
    let text = '';
    /** @type {boolean[]} */
    let bare = [];
    let inWord = false;
    /** @type {'"' | "'" | null} */
    let quote = null;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];

        if (quote === "'") {
            if (ch === "'") {
                quote = null;
            } else {
                text += ch;
                bare.push(false);
            }
            continue;
        }

        if (quote === '"') {
            if (ch === '"') {
                quote = null;
            } else if (ch === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
                i += 1;
                text += line[i];
                bare.push(false);
            } else {
                text += ch;
                bare.push(false);
            }
            continue;
        }

        if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
            continue;
        }

        if (ch === '\\') {
            inWord = true;
            // A backslash as the very last character escapes nothing yet.
            if (i + 1 < line.length) {
                i += 1;
                text += line[i];
                bare.push(false);
            }
            continue;
        }

        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (inWord) {
                words.push(text);
                text = '';
                bare = [];
                inWord = false;
            }
            continue;
        }

        inWord = true;
        text += ch;
        bare.push(true);
    }

    return { words, partial: inWord ? text : '', unescaped: inWord ? bare : [], quote };
}
