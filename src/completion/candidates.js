/**
 * What Tab offers after `wsc `, decided from the words already typed.
 *
 * Pure: the catalogue (preset names, configuration names) is handed in, so nothing here
 * reads a file or the environment. Every list of flags and values comes from the module
 * that already owns it — OPTIONS, EXEC_TARGETS, FALLBACK_MODES, MODES — so a new flag or
 * mode shows up in completion without anyone remembering to add it here.
 */
import { OPTIONS } from '../args.js';
import { EXEC_TARGETS } from '../exec/planBuilder.js';
import { FALLBACK_MODES, MODES } from '../modes.js';
import { COMPLETION_SHELLS } from './shells.js';

/**
 * `values`: offer the strings in `values`. `dirs`: offer nothing of ours, let the shell
 * complete directory names. `none`: offer nothing, and no file names either.
 *
 * @typedef {'values' | 'dirs' | 'none'} Directive
 * @typedef {{ directive: Directive, values: string[] }} Completion
 * @typedef {{ presets: string[], configs: string[] }} Catalogue
 */

/** Flags whose value is one of a short fixed list. A Map: the key is text the user typed. */
const FLAG_VALUES = new Map(
    /** @type {[string, string[]][]} */ ([
        ['target', [...EXEC_TARGETS]],
        ['fallback', [...FALLBACK_MODES]],
        ['completion', [...COMPLETION_SHELLS]],
    ]),
);

/** @returns {Completion} */
const none = () => ({ directive: 'none', values: [] });

/**
 * @param {string[]} list
 * @returns {Completion}
 */
const offer = (list) => ({ directive: 'values', values: list });

/**
 * Whether `--name` is one of our flags and wants a value after it. `hasOwn`, because
 * `name` is whatever the user typed: `--constructor` is not a flag.
 *
 * @param {string} name - without the dashes
 * @returns {boolean}
 */
function takesValue(name) {
    return Object.hasOwn(OPTIONS, name) && OPTIONS[name].type === 'string';
}

/**
 * @param {string} word
 * @returns {boolean} whether the word selects an intent that takes no configuration names
 */
function isIntent(word) {
    return (
        word === '-c' ||
        word === '--configure' ||
        word === '-l' ||
        word === '--list' ||
        word === '--completion' ||
        word.startsWith('--completion=') ||
        word === '--delete-preset' ||
        word.startsWith('--delete-preset=')
    );
}

/**
 * @param {string} partial - starts with a dash
 * @returns {string[]}
 */
function flagsMatching(partial) {
    const longs = Object.keys(OPTIONS).map((name) => `--${name}`);
    const shorts = Object.values(OPTIONS).flatMap((option) => ('short' in option ? [`-${option.short}`] : []));
    return (partial.startsWith('--') ? longs : [...longs, ...shorts]).filter((flag) => flag.startsWith(partial));
}

/**
 * What may follow `--flag `.
 *
 * @param {string} flag - without the dashes; must satisfy takesValue()
 * @param {Catalogue} catalogue
 * @returns {Completion}
 */
function valuesOf(flag, catalogue) {
    if (flag === 'project') return { directive: 'dirs', values: [] };
    if (flag === 'preset' || flag === 'delete-preset') return offer([...catalogue.presets]);
    const fixed = FLAG_VALUES.get(flag);
    return fixed === undefined ? none() : offer([...fixed]);
}

/**
 * Whether the next positional may be a preset name.
 *
 * Mirrors splitPresetNames() in src/args.js: the tokens right after `--preset x` are
 * presets only for as long as each one *is* one, and any other flag ends the run.
 *
 * @param {string[]} words - the completed words, up to any `--`
 * @param {string[]} presets
 * @returns {boolean}
 */
function inPresetRun(words, presets) {
    let run = false;
    for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (word === '--preset') {
            run = true;
            i += 1; // its value
        } else if (word.startsWith('--preset=')) {
            run = true;
        } else if (word.startsWith('-')) {
            if (word.startsWith('--') && takesValue(word.slice(2))) i += 1;
            run = false;
        } else if (run && !presets.includes(word)) {
            run = false;
        }
    }
    return run;
}

/**
 * Names beginning with what is typed; the modes only after `<name>:`.
 *
 * `api:` therefore offers `api:run`, `api:debug` and `api:terminal` rather than every name
 * three times over — and, like splitNameMode(), it looks at real names first: a
 * configuration called `api > repro:stale-job:debug` completes as itself.
 *
 * @param {string} partial
 * @param {string[]} presets
 * @param {string[]} configs
 * @returns {string[]}
 */
function names(partial, presets, configs) {
    /** @type {Set<string>} */
    const found = new Set();
    for (const name of presets) if (name.startsWith(partial)) found.add(name);
    for (const name of configs) {
        if (name.startsWith(partial)) found.add(name);
        if (partial.startsWith(`${name}:`)) {
            for (const mode of MODES) {
                const token = `${name}:${mode}`;
                if (token.startsWith(partial)) found.add(token);
            }
        }
    }
    return [...found];
}

/**
 * @param {{ words: string[], partial: string }} input - `words` are the completed words
 *   after the command name; `partial` is the one being typed
 * @param {Catalogue} catalogue
 * @returns {Completion}
 */
export function complete({ words, partial }, catalogue) {
    // After `--` everything is a name, so no flag rule applies to what follows it.
    const literal = words.includes('--');
    const flagWords = literal ? words.slice(0, words.indexOf('--')) : words;

    // `--target=de`: the value is part of the word being typed.
    if (!literal && partial.startsWith('--') && partial.includes('=')) {
        const equals = partial.indexOf('=');
        const flag = partial.slice(2, equals);
        if (!takesValue(flag)) return none();
        const offered = valuesOf(flag, catalogue);
        // `--project=` is left alone: `=` breaks the word in bash, so directories there
        // would work in one shell and not in the other.
        if (offered.directive !== 'values') return none();
        const head = partial.slice(0, equals + 1);
        return offer(offered.values.map((value) => head + value).filter((token) => token.startsWith(partial)));
    }

    if (!literal && partial.startsWith('-')) return offer(flagsMatching(partial));

    // `--target <Tab>`: the previous word is a flag still waiting for its value.
    const previous = words[words.length - 1];
    if (!literal && previous !== undefined && previous.startsWith('--') && takesValue(previous.slice(2))) {
        const offered = valuesOf(previous.slice(2), catalogue);
        if (offered.directive !== 'values') return offered;
        return offer(offered.values.filter((value) => value.startsWith(partial)));
    }

    // wsc refuses names next to these, so suggesting one would offer a command line that
    // is rejected the moment it is run.
    if (flagWords.some(isIntent)) return none();

    // `--` ends a run of presets too: parseCliArgs stops attributing tokens to `--preset`
    // there, so what follows is a configuration name even right after `--preset x --`.
    const presets = !literal && inPresetRun(flagWords, catalogue.presets) ? catalogue.presets : [];
    return offer(names(partial, presets, catalogue.configs));
}

/**
 * The project the command line names, if it names one — the last `--project` wins, as it
 * does in parseArgs.
 *
 * @param {string[]} words - the completed words after the command name
 * @returns {string | undefined}
 */
export function findProjectFlag(words) {
    /** @type {string | undefined} */
    let found;
    for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (word === '--') break;
        if (word === '--project') {
            if (i + 1 < words.length) found = words[i + 1];
        } else if (word.startsWith('--project=')) {
            found = word.slice('--project='.length);
        }
    }
    return found;
}
