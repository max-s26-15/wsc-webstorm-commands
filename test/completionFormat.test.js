import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_WORDBREAKS, escapeForBash, formatCompletion } from '../src/completion/format.js';
import { tokenize } from '../src/completion/tokenize.js';

const values = (list) => ({ directive: /** @type {const} */ ('values'), values: list });

describe('formatCompletion — zsh', () => {
    test('prints the directive, then each candidate as it is', () => {
        assert.equal(formatCompletion(values(['a', 'b c']), 'zsh', tokenize('wsc ')), 'values\na\nb c\n');
    });

    test('prints a bare directive for dirs and none', () => {
        assert.equal(formatCompletion({ directive: 'dirs', values: [] }, 'zsh', tokenize('wsc ')), 'dirs\n');
        assert.equal(formatCompletion({ directive: 'none', values: [] }, 'zsh', tokenize('wsc ')), 'none\n');
    });

    test('drops a candidate that would break the one-per-line protocol', () => {
        assert.equal(formatCompletion(values(['a\nb', 'c\rd', 'ok']), 'zsh', tokenize('wsc ')), 'values\nok\n');
    });

    test('drops a candidate with any other control character, which a terminal would act on', () => {
        const list = ['esc\u001b[2J', 'del\u007f', 'c1\u009b', 'nul\u0000', 'ok'];
        assert.equal(formatCompletion(values(list), 'zsh', tokenize('wsc ')), 'values\nok\n');
        assert.equal(formatCompletion(values(list), 'bash', tokenize('wsc ')), 'values\nok\n');
    });

    test('keeps a tab, which the preset store allows in a name, and bash escapes it', () => {
        assert.equal(formatCompletion(values(['a\tb']), 'zsh', tokenize('wsc ')), 'values\na\tb\n');
        assert.equal(formatCompletion(values(['a\tb']), 'bash', tokenize('wsc ')), 'values\na\\\tb\n');
    });
});

describe('escapeForBash', () => {
    test('escapes what a shell would split or expand, and nothing else', () => {
        assert.equal(escapeForBash('api > repro:stale-job:debug'), 'api\\ \\>\\ repro:stale-job:debug');
        assert.equal(escapeForBash('a$b`c"d\'e(f)g*h~i'), 'a\\$b\\`c\\"d\\\'e\\(f\\)g\\*h\\~i');
    });

    test('keeps the characters bash does not need escaped, including colon and equals', () => {
        assert.equal(escapeForBash('--target=a_b@c%d+e,f.g/h-i:j'), '--target=a_b@c%d+e,f.g/h-i:j');
    });

    test('leaves non-ASCII letters alone', () => {
        assert.equal(escapeForBash('сервер'), 'сервер');
    });
});

describe('formatCompletion — bash', () => {
    test('escapes each candidate', () => {
        const typed = tokenize('wsc api\\ \\>\\ re');
        assert.equal(
            formatCompletion(values(['api > repro:stale-job:debug']), 'bash', typed),
            'values\napi\\ \\>\\ repro:stale-job:debug\n',
        );
    });

    test('cuts at the last bare word break, because bash replaces only the word after it', () => {
        const typed = tokenize('wsc api\\ \\>\\ repro:');
        assert.equal(typed.partial, 'api > repro:');
        assert.equal(
            formatCompletion(values(['api > repro:stale-job:debug']), 'bash', typed),
            'values\nstale-job:debug\n',
        );
    });

    test('cuts after the = of --flag=value', () => {
        const typed = tokenize('wsc --target=t');
        assert.equal(formatCompletion(values(['--target=terminal']), 'bash', typed), 'values\nterminal\n');
    });

    test('an escaped colon is not a word break', () => {
        const typed = tokenize('wsc a\\:b');
        assert.equal(formatCompletion(values(['a:bc']), 'bash', typed), 'values\na:bc\n');
    });

    test('inside an open quote the candidate is returned raw, uncut', () => {
        const typed = tokenize("wsc 'api > re");
        assert.equal(
            formatCompletion(values(['api > repro:stale-job:debug']), 'bash', typed),
            'values\napi > repro:stale-job:debug\n',
        );
    });

    test('uses the word breaks the wrapper passed, not the default', () => {
        const typed = tokenize('wsc a:b');
        assert.equal(formatCompletion(values(['a:bc']), 'bash', typed, '='), 'values\na:bc\n');
        assert.equal(formatCompletion(values(['a:bc']), 'bash', typed, ':'), 'values\nbc\n');
    });

    test('drops a candidate that is empty once cut', () => {
        const typed = tokenize('wsc a:');
        assert.equal(formatCompletion(values(['a:']), 'bash', typed), 'values\n');
    });

    test('DEFAULT_WORDBREAKS is what an interactive bash starts with', () => {
        assert.equal(DEFAULT_WORDBREAKS, ' \t\n"\'><=;|&(:');
    });
});
