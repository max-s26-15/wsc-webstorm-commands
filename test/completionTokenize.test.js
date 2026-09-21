import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tokenize } from '../src/completion/tokenize.js';

describe('tokenize', () => {
    test('splits completed words from the one being typed', () => {
        const t = tokenize('wsc web api');
        assert.deepEqual(t.words, ['wsc', 'web']);
        assert.equal(t.partial, 'api');
        assert.equal(t.quote, null);
    });

    test('a trailing space means the next word has not started', () => {
        assert.deepEqual(tokenize('wsc web '), { words: ['wsc', 'web'], partial: '', unescaped: [], quote: null });
        assert.deepEqual(tokenize('wsc '), { words: ['wsc'], partial: '', unescaped: [], quote: null });
    });

    test('a backslash keeps the next character in the word, and marks it as escaped', () => {
        const t = tokenize('wsc api\\ \\>\\ re');
        assert.equal(t.partial, 'api > re');
        assert.deepEqual(t.unescaped, [true, true, true, false, false, false, true, true]);
    });

    test('a single quote runs to the closing quote and escapes nothing inside', () => {
        const t = tokenize("wsc 'api > re");
        assert.equal(t.partial, 'api > re');
        assert.equal(t.quote, "'");
        assert.ok(t.unescaped.every((bare) => bare === false));
        assert.equal(t.unescaped.length, 8);
    });

    test('a double quote honours a backslash only before " \\ $ and backtick', () => {
        assert.equal(tokenize('wsc "a\\"b').partial, 'a"b');
        assert.equal(tokenize('wsc "a\\nb').partial, 'a\\nb');
        assert.equal(tokenize('wsc "a\\"b').quote, '"');
    });

    test('a closed quoted word is a finished word', () => {
        const t = tokenize("wsc 'a b' c");
        assert.deepEqual(t.words, ['wsc', 'a b']);
        assert.equal(t.partial, 'c');
    });

    test('an empty quoted argument is still a word', () => {
        assert.deepEqual(tokenize("wsc '' x").words, ['wsc', '']);
    });

    test('a bare colon or equals sign is marked as typed bare', () => {
        const t = tokenize('wsc --target=de');
        assert.equal(t.partial, '--target=de');
        assert.ok(t.unescaped.every(Boolean));
        const colon = tokenize('wsc a\\:b');
        assert.equal(colon.partial, 'a:b');
        assert.equal(colon.unescaped[1], false);
    });

    test('a dangling backslash at the end is dropped, not kept as text', () => {
        assert.equal(tokenize('wsc a\\').partial, 'a');
    });

    test('a tab or newline separates words like a space', () => {
        assert.deepEqual(tokenize('wsc\tweb\nx').words, ['wsc', 'web']);
    });
});
