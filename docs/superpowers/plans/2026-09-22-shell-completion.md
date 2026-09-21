# Автодоповнення в оболонці (zsh, bash) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Після `wsc ` і Tab оболонка (zsh або bash) пропонує прапорці, значення прапорців, назви пресетів і назви run-конфігурацій (з суфіксами `:run|:debug|:terminal` після двокрапки), як це робить git.

**Architecture:** Тонка shell-обгортка передає рядок до курсора в приховану точку входу `wsc __complete <shell> <рядок>`. `bin/wsc.js` розпізнає її й динамічно імпортує легкий модуль `src/completion/run.js`, який не тягне `cli.js`, тож Tab не платить за `@inquirer/prompts`. Модуль розбирає рядок токенайзером, читає назви з `.idea/` (не з MCP) і друкує директиву та кандидатів; екранування для bash робиться в JS. Публічна команда встановлення — прапорець `wsc --completion <zsh|bash>`, що друкує скрипт.

**Tech Stack:** Node ≥18, чистий ESM, `node:test`, JSDoc-типи (`npm run typecheck`), shell: bash і zsh.

**Spec:** `docs/superpowers/specs/2026-09-22-shell-completion-design.md`

## Global Constraints

- `engines.node >=18`: без `import ... with { type: 'json' }`, без `import.meta.dirname` (використовувати `new URL(..., import.meta.url)`). У JSDoc-описах не писати `@` усередині тексту (це новий тег).
- Публічна команда — прапорець `--completion <zsh|bash>`, не підкоманда; приховане слово `__complete` діє лише на позиції `argv[0]`.
- Обгортка передає **весь рядок до курсора одним аргументом**: zsh — `${BUFFER[1,CURSOR]}`, bash — `${COMP_LINE:0:COMP_POINT}` (+ `$COMP_WORDBREAKS` третім аргументом).
- Вивід `__complete`: перший рядок — директива `values` | `dirs` | `none`, далі по кандидату на рядок. Кандидат із `\n` або `\r` відкидається.
- Значення прапорців: `--target` → `run-window`, `terminal` (`EXEC_TARGETS`); `--fallback` → `retry`, `terminal` (`FALLBACK_MODES`); `--completion` → `zsh`, `bash`; `--preset` → назви пресетів; `--project` → `dirs`; `--project=…`, `--mcp-port`, `--debug-port` → `none`.
- Назви конфігурацій — лише з `.idea/` (`readIdeaRunConfigs`), **ніколи з MCP**. Власні записи пресету (`commands`) не пропонуються.
- Автодоповнення мовчить: exit 0 і порожній stderr за будь-якого збою; `WSC_COMPLETE_DEBUG=1` друкує причину в stderr. Джерело, яке не вдалося прочитати, вважається порожнім; `none` лише для невідомої оболонки чи неочікуваного винятку.
- `src/completion/*` транзитивно (статичними імпортами) не імпортує `src/cli.js`, будь-що з `src/ui/` і жоден пакет, крім `node:*`. `src/mcp/` дозволений (SDK там імпортується динамічно).
- Пошук за іменем, введеним користувачем (назва прапорця, конфігурації, пресету), — лише `Object.hasOwn`/`Map`/`Set`/масиви, ніколи `obj[name]`: ім'я може бути `constructor`, `toString`, `__proto__`.
- bash-екранування: символ поза `[A-Za-z0-9_@%+=:,./-]` і не-ASCII екранується зворотним слешем; у незакритій лапці кандидат віддається сирим.
- Не використовувати `compopt -o filenames` для назв (крім `dirs`): readline дописує `/` до кандидата, що збігається з каталогом у cwd (`web` — і конфігурація, і каталог у demo-app).
- `test/` і `test-utils/` не входять до `tsc`; код у `src/` і `bin/` мусить проходити `npm run typecheck`.
- Базовий стан: `npm test` — 895 тестів зелені, `npm run typecheck` чистий. Кожен коміт лишає обидва зеленими. Повідомлення комітів закінчуються рядком `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Команди виконуються з кореня worktree. Жодних пушів у `main`.

## Карта файлів

| Файл | Дія | Відповідальність |
|---|---|---|
| `src/modes.js` | змінити | + `FALLBACK_MODES` (переїжджає з `ui/mcpUnavailablePrompt.js`) |
| `src/ui/mcpUnavailablePrompt.js` | змінити | імпортує й реекспортує `FALLBACK_MODES` |
| `src/completion/shells.js` | створити | `COMPLETION_SHELLS`, `isCompletionShell()` |
| `src/completion/tokenize.js` | створити | чиста: рядок → слова, недописане слово, які його символи набрані «голими», відкрита лапка |
| `src/completion/candidates.js` | створити | чиста: що пропонувати; `findProjectFlag()` |
| `src/completion/format.js` | створити | чиста: директива + кандидати → текст для zsh чи bash |
| `src/completion/run.js` | створити | нечиста: `completeCommand()` — корінь проєкту, читання джерел, друк |
| `src/completion/scripts.js` | створити | шаблони обгорток `ZSH_SCRIPT`, `BASH_SCRIPT`, `completionScript()` |
| `bin/wsc.js` | змінити | `argv[0] === '__complete'` → динамічний імпорт `run.js`, інакше `cli.js` |
| `src/args.js` | змінити | `completion` в `OPTIONS` і `CliValues` |
| `src/cli.js` | змінити | інтент `--completion`, рядок у `HELP` |
| `test/modes.test.js` | змінити | тотожність `FALLBACK_MODES` |
| `test/completionShells.test.js` | створити | тести `shells.js` |
| `test/completionTokenize.test.js` | створити | тести токенайзера |
| `test/completionCandidates.test.js` | створити | тести правил кандидатів |
| `test/completionFormat.test.js` | створити | тести форматера |
| `test/completionRun.test.js` | створити | тести `completeCommand()` на справжніх тимчасових проєктах |
| `test/completionScripts.test.js` | створити | справжній bash, zsh із заглушками |
| `test/completionBoundary.test.js` | створити | граф імпортів і процес `bin/wsc.js` |
| `test/cli.integration.test.js` | змінити | рядок таблиці `--completion` |
| `README.md`, `CLAUDE.md` | змінити | документація (Task 9) |

---

### Task 1: Спільні константи — `FALLBACK_MODES` у `modes.js`, `COMPLETION_SHELLS`

**Files:**
- Modify: `src/modes.js`, `src/ui/mcpUnavailablePrompt.js:14-25`
- Create: `src/completion/shells.js`
- Test: `test/modes.test.js`, `test/completionShells.test.js`

**Interfaces:**
- Produces: `FALLBACK_MODES: readonly ['retry','terminal']` з `src/modes.js` (той самий об'єкт реекспортує `ui/mcpUnavailablePrompt.js`); `COMPLETION_SHELLS: readonly ['zsh','bash']`, `isCompletionShell(value: unknown): value is 'zsh'|'bash'`, тип `CompletionShell` з `src/completion/shells.js`.

- [ ] **Step 1: Write the failing tests**

У `test/modes.test.js` змінити імпорти й додати тест у `describe('launch modes', …)`:

```js
import * as prompt from '../src/ui/mcpUnavailablePrompt.js';
import { DEFAULT_MODE, FALLBACK_MODES, MODES } from '../src/modes.js';
```

```js
    it('--fallback values have one spelling too: the prompt re-exports the list from modes.js', () => {
        assert.deepEqual([...FALLBACK_MODES], ['retry', 'terminal']);
        assert.equal(prompt.FALLBACK_MODES, FALLBACK_MODES);
    });
```

Створити `test/completionShells.test.js`:

```js
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { COMPLETION_SHELLS, isCompletionShell } from '../src/completion/shells.js';

describe('completion shells', () => {
    test('are zsh and bash', () => {
        assert.deepEqual([...COMPLETION_SHELLS], ['zsh', 'bash']);
    });

    test('isCompletionShell accepts the listed shells and nothing else', () => {
        assert.equal(isCompletionShell('zsh'), true);
        assert.equal(isCompletionShell('bash'), true);
        assert.equal(isCompletionShell('fish'), false);
        assert.equal(isCompletionShell(''), false);
        assert.equal(isCompletionShell(undefined), false);
        assert.equal(isCompletionShell('constructor'), false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/modes.test.js test/completionShells.test.js`
Expected: FAIL — `FALLBACK_MODES` не експортується з `modes.js`; `src/completion/shells.js` не існує.

- [ ] **Step 3: Write minimal implementation**

Дописати в кінець `src/modes.js`:

```js

/**
 * Values accepted by --fallback.
 *
 * `retry` polls for the IDE, `terminal` skips it entirely. Both exist so a script — or
 * anything else without a terminal to answer in — can state up front what it wants
 * instead of being asked a question nobody is there to read.
 *
 * Here rather than next to the prompt that uses it: Tab completion needs the list, and
 * that prompt module imports @inquirer/prompts, which a completion must never load.
 */
export const FALLBACK_MODES = /** @type {const} */ (['retry', 'terminal']);
```

У `src/ui/mcpUnavailablePrompt.js` замінити блок (рядки 14–25) на:

```js
import { select } from '@inquirer/prompts';

import { FALLBACK_MODES } from '../modes.js';
import { isCancelled } from './promptCancel.js';

// Re-exported so existing importers keep working; the list itself lives in modes.js.
export { FALLBACK_MODES };
```

(тобто прибрати старий коментар і `export const FALLBACK_MODES = …`; решта файлу лишається як була).

Створити `src/completion/shells.js`:

```js
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/modes.test.js test/completionShells.test.js test/mcpUnavailablePrompt.test.js && npm run typecheck`
Expected: PASS, typecheck без помилок.

- [ ] **Step 5: Commit**

```bash
git add src/modes.js src/ui/mcpUnavailablePrompt.js src/completion/shells.js test/modes.test.js test/completionShells.test.js
git commit -m "Move FALLBACK_MODES to modes.js; add COMPLETION_SHELLS

Tab completion needs both lists, and the prompt module that held
FALLBACK_MODES imports @inquirer/prompts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Токенайзер рядка до курсора

**Files:**
- Create: `src/completion/tokenize.js`
- Test: `test/completionTokenize.test.js`

**Interfaces:**
- Produces: `tokenize(line: string): Tokenized` де `Tokenized = { words: string[], partial: string, unescaped: boolean[], quote: '"' | "'" | null }`. `words` — завершені слова, розкодовані (лапки й `\` прибрані), **включно з першим словом-командою**. `partial` — слово під курсором, розкодоване (`''` після пробілу). `unescaped[i]` — `true`, якщо `partial[i]` набрано «голим» (поза лапками, без `\`). `quote` — лапка, всередині якої слово ще не закрите.

- [ ] **Step 1: Write the failing test**

`test/completionTokenize.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionTokenize.test.js`
Expected: FAIL — `Cannot find module '../src/completion/tokenize.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/completion/tokenize.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/completionTokenize.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/completion/tokenize.js test/completionTokenize.test.js
git commit -m "Add the shell-style tokenizer for completion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Правила кандидатів

**Files:**
- Create: `src/completion/candidates.js`
- Test: `test/completionCandidates.test.js`

**Interfaces:**
- Consumes: `OPTIONS` (`src/args.js`), `EXEC_TARGETS` (`src/exec/planBuilder.js`), `FALLBACK_MODES`, `MODES` (`src/modes.js`), `COMPLETION_SHELLS` (`./shells.js`).
- Produces: `complete(input: { words: string[], partial: string }, catalogue: Catalogue): Completion` де `Completion = { directive: 'values'|'dirs'|'none', values: string[] }`, `Catalogue = { presets: string[], configs: string[] }`; `words` — **без** слова-команди. `findProjectFlag(words: string[]): string | undefined`.

- [ ] **Step 1: Write the failing test**

`test/completionCandidates.test.js`:

```js
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { complete, findProjectFlag } from '../src/completion/candidates.js';

const catalogue = {
    presets: ['default', 'backend'],
    configs: ['web', 'api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server', 'toString'],
};

/**
 * `typed` is the words and then the partial word, separated by single spaces — so a
 * trailing space is an empty partial. Names that contain spaces go through complete()
 * directly.
 *
 * @param {string} typed
 */
const at = (typed) => {
    const parts = typed.split(' ');
    return complete({ words: parts.slice(0, -1), partial: parts[parts.length - 1] }, catalogue);
};

describe('complete — configuration names', () => {
    test('a bare Tab offers every configuration and no preset', () => {
        assert.deepEqual(at(''), { directive: 'values', values: catalogue.configs });
    });

    test('filters by prefix', () => {
        assert.deepEqual(at('a').values, ['api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server']);
    });

    test('offers the modes only once the name is followed by a colon', () => {
        assert.deepEqual(at('api:').values, ['api:run', 'api:debug', 'api:terminal']);
        assert.deepEqual(at('api:de').values, ['api:debug']);
        assert.deepEqual(at('api').values.includes('api:run'), false);
    });

    test('a name that itself contains colons completes as a name, and takes modes after it', () => {
        assert.deepEqual(complete({ words: [], partial: 'api > repro:stale-job:' }, catalogue).values, [
            'api > repro:stale-job:debug',
        ]);
        assert.deepEqual(complete({ words: [], partial: 'api > repro:stale-job:debug:' }, catalogue).values, [
            'api > repro:stale-job:debug:run',
            'api > repro:stale-job:debug:debug',
            'api > repro:stale-job:debug:terminal',
        ]);
    });

    test('names that collide with Object.prototype are ordinary names', () => {
        assert.deepEqual(at('to').values, ['toString']);
        assert.deepEqual(at('constr').values, []);
    });
});

describe('complete — flags', () => {
    test('two dashes offer the long flags, taken from OPTIONS', () => {
        const flags = at('--').values;
        for (const flag of ['--preset', '--target', '--dry-run', '--fallback', '--completion', '--configure']) {
            assert.ok(flags.includes(flag), `${flag} missing`);
        }
        assert.equal(flags.includes('-c'), false);
    });

    test('one dash adds the short flags', () => {
        const flags = at('-').values;
        for (const flag of ['-c', '-l', '-h', '-v', '--list']) assert.ok(flags.includes(flag), `${flag} missing`);
    });

    test('filters by prefix', () => {
        assert.deepEqual(at('--ta').values, ['--target']);
    });
});

describe('complete — flag values', () => {
    test('--target, --fallback and --completion offer their fixed values', () => {
        assert.deepEqual(at('--target ').values, ['run-window', 'terminal']);
        assert.deepEqual(at('--target te').values, ['terminal']);
        assert.deepEqual(at('--fallback ').values, ['retry', 'terminal']);
        assert.deepEqual(at('--completion ').values, ['zsh', 'bash']);
    });

    test('the --flag=value form keeps the flag in every candidate', () => {
        assert.deepEqual(at('--target=t').values, ['--target=terminal']);
        assert.deepEqual(at('--preset=b').values, ['--preset=backend']);
    });

    test('--preset offers preset names', () => {
        assert.deepEqual(at('--preset ').values, ['default', 'backend']);
    });

    test('--project hands the decision to the shell, and the = form offers nothing', () => {
        assert.deepEqual(at('--project '), { directive: 'dirs', values: [] });
        assert.deepEqual(at('--project=').directive, 'none');
    });

    test('numeric flags offer nothing, and not file names either', () => {
        assert.deepEqual(at('--mcp-port '), { directive: 'none', values: [] });
        assert.deepEqual(at('--debug-port '), { directive: 'none', values: [] });
    });

    test('a flag that is not one of ours is not looked up on Object.prototype', () => {
        assert.equal(at('--constructor=').directive, 'none');
        assert.equal(at('--toString ').directive, 'values');
    });
});

describe('complete — what may follow', () => {
    test('after --preset a, another preset or a configuration may follow', () => {
        assert.deepEqual(at('--preset backend ').values, ['default', 'backend', ...catalogue.configs]);
    });

    test('a token that is not a preset ends the run of presets', () => {
        assert.deepEqual(at('--preset backend web ').values, catalogue.configs);
    });

    test('a flag in between ends the run of presets', () => {
        assert.deepEqual(at('--preset backend --dry-run ').values, catalogue.configs);
    });

    test('--configure, --list and --completion take no names', () => {
        assert.deepEqual(at('-c '), { directive: 'none', values: [] });
        assert.deepEqual(at('--list '), { directive: 'none', values: [] });
        assert.deepEqual(at('--completion zsh '), { directive: 'none', values: [] });
        assert.deepEqual(at('--completion=zsh '), { directive: 'none', values: [] });
    });

    test('--configure still takes --preset, so its value is completed', () => {
        assert.deepEqual(at('-c --preset ').values, ['default', 'backend']);
    });

    test('after -- everything is a name, even something that looks like a flag', () => {
        assert.deepEqual(at('-- ').values, catalogue.configs);
        assert.deepEqual(at('-- -').values, []);
    });

    test('a -c before -- still refuses names that come after it', () => {
        assert.deepEqual(at('-c -- '), { directive: 'none', values: [] });
    });
});

describe('findProjectFlag', () => {
    test('reads both spellings, and the last one wins', () => {
        assert.equal(findProjectFlag(['--project', '/a']), '/a');
        assert.equal(findProjectFlag(['--project=/b']), '/b');
        assert.equal(findProjectFlag(['--project', '/a', '--project=/b']), '/b');
    });

    test('is undefined when absent, or when the flag has no value yet, or after --', () => {
        assert.equal(findProjectFlag(['web']), undefined);
        assert.equal(findProjectFlag(['--project']), undefined);
        assert.equal(findProjectFlag(['--', '--project', '/a']), undefined);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionCandidates.test.js`
Expected: FAIL — `Cannot find module '../src/completion/candidates.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/completion/candidates.js`:

```js
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
        word.startsWith('--completion=')
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
    if (flag === 'preset') return offer([...catalogue.presets]);
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

    const presets = inPresetRun(flagWords, catalogue.presets) ? catalogue.presets : [];
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
```

- [ ] **Step 4: Run test and typecheck**

Run: `node --test test/completionCandidates.test.js && npm run typecheck`
Expected: PASS. Якщо `tsc` скаржиться на `OPTIONS[name]` (індексація рядком) — додати перед рядком `// @ts-expect-error` **не треба**: `strict: false` це дозволяє; якщо все ж скаржиться, замінити на `/** @type {Record<string, { type: string }>} */ (OPTIONS)[name].type`.

- [ ] **Step 5: Commit**

```bash
git add src/completion/candidates.js test/completionCandidates.test.js
git commit -m "Add the rules that decide what Tab offers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Форматер для zsh і bash

**Files:**
- Create: `src/completion/format.js`
- Test: `test/completionFormat.test.js`

**Interfaces:**
- Consumes: `Completion` (`./candidates.js`), `Tokenized` (`./tokenize.js`), `CompletionShell` (`./shells.js`).
- Produces: `formatCompletion(completion, shell, tokenized, wordBreaks?): string` (директива, потім кандидати, кожен рядок закінчується `\n`); `escapeForBash(text: string): string`; `DEFAULT_WORDBREAKS: string`.

- [ ] **Step 1: Write the failing test**

`test/completionFormat.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionFormat.test.js`
Expected: FAIL — `Cannot find module '../src/completion/format.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/completion/format.js`:

```js
/**
 * Turn what to offer into the text a shell wrapper reads.
 *
 * zsh gets the candidates as they are: `compadd` quotes them for whatever the user has
 * already typed. bash gets them ready for COMPREPLY, because readline inserts them
 * verbatim — so the escaping, and the cut at the last word break, happen here, in
 * JavaScript, where they are unit-tested, instead of in the shell.
 */

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
    // partial word, so the same offset cuts it.
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
    // sent, and offering half of it would be worse than not offering it.
    const safe = completion.values.filter((value) => !/[\r\n]/.test(value));
    const items = shell === 'bash' ? safe.map((value) => bashItem(value, typed, wordBreaks)) : safe;
    return [completion.directive, ...items.filter((item) => item !== '')].join('\n') + '\n';
}
```

- [ ] **Step 4: Run test and typecheck**

Run: `node --test test/completionFormat.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/completion/format.js test/completionFormat.test.js
git commit -m "Add the completion formatter (raw for zsh, escaped and cut for bash)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `completeCommand()` — читання джерел і друк

**Files:**
- Create: `src/completion/run.js`
- Test: `test/completionRun.test.js`

**Interfaces:**
- Consumes: `tokenize`, `complete`, `findProjectFlag`, `formatCompletion`, `isCompletionShell`; `findProjectRoot`, `readPresets`, `listPresets`, `CONFIG_DIR` (`src/presets/store.js`); `readIdeaRunConfigs` (`src/fallback/ideaRunConfigs.js`).
- Produces: `completeCommand(args: string[], deps?: { cwd?: string, env?: NodeJS.ProcessEnv, stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }): Promise<0>`, де `args = [shell, line, wordBreaks?]`. Завжди повертає `0`.

- [ ] **Step 1: Write the failing test**

`test/completionRun.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { completeCommand } from '../src/completion/run.js';
import { tmpDir, tmpIdeaProject } from '../test-utils/tmp-dir.js';

const PRESETS = JSON.stringify({ presets: { default: [{ name: 'web' }], backend: [{ name: 'api' }] } });

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
async function complete(cwd, args, env = {}) {
    let out = '';
    let err = '';
    const code = await completeCommand(args, {
        cwd,
        env,
        stdout: { write: (text) => (out += text) },
        stderr: { write: (text) => (err += text) },
    });
    return { code, out, err, lines: out.split('\n').filter(Boolean) };
}

describe('completeCommand — sources', () => {
    test('offers configuration names from .idea/, filtered by the typed prefix', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        try {
            const { code, lines, err } = await complete(project.dir, ['zsh', 'wsc a']);
            assert.equal(code, 0);
            assert.equal(err, '');
            assert.equal(lines[0], 'values');
            for (const name of ['api', 'api > repro:stale-job:debug', 'addon-client', 'addon-server']) {
                assert.ok(lines.includes(name), `${name} missing`);
            }
            assert.equal(lines.includes('web'), false);
        } finally {
            await project.cleanup();
        }
    });

    test('offers preset names after --preset', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        try {
            const { out } = await complete(project.dir, ['zsh', 'wsc --preset ']);
            assert.equal(out, 'values\ndefault\nbackend\n');
        } finally {
            await project.cleanup();
        }
    });

    test('a --project earlier in the line decides which project is read', async () => {
        const project = await tmpIdeaProject({ presets: PRESETS });
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            const { out } = await complete(elsewhere.dir, ['zsh', `wsc --project ${project.dir} --preset `]);
            assert.equal(out, 'values\ndefault\nbackend\n');
        } finally {
            await elsewhere.cleanup();
            await project.cleanup();
        }
    });

    test('a --project that is not a WebStorm project offers no names, but flags still work', async () => {
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            assert.equal((await complete(elsewhere.dir, ['zsh', `wsc --project ${elsewhere.dir} a`])).out, 'values\n');
            assert.equal((await complete(elsewhere.dir, ['zsh', 'wsc --ta'])).out, 'values\n--target\n');
        } finally {
            await elsewhere.cleanup();
        }
    });

    test('--project completes directories by asking the shell to', async () => {
        const project = await tmpIdeaProject();
        try {
            assert.equal((await complete(project.dir, ['zsh', 'wsc --project '])).out, 'dirs\n');
        } finally {
            await project.cleanup();
        }
    });
});

describe('completeCommand — failures are silent', () => {
    test('a broken preset file means no presets, but the configurations are still offered', async () => {
        const project = await tmpIdeaProject({ presets: '{ not json' });
        try {
            const presets = await complete(project.dir, ['zsh', 'wsc --preset ']);
            assert.deepEqual([presets.code, presets.out, presets.err], [0, 'values\n', '']);

            const names = await complete(project.dir, ['zsh', 'wsc api:de']);
            assert.equal(names.out, 'values\napi:debug\n');
            assert.equal(names.err, '');
        } finally {
            await project.cleanup();
        }
    });

    test('outside any project there are no names, and still no noise', async () => {
        const elsewhere = await tmpDir('wsc-elsewhere-');
        try {
            const result = await complete(elsewhere.dir, ['zsh', 'wsc a']);
            assert.deepEqual([result.code, result.out, result.err], [0, 'values\n', '']);
        } finally {
            await elsewhere.cleanup();
        }
    });

    test('a project with no saved run configurations offers no names', async () => {
        const project = await tmpIdeaProject({ workspace: false, shared: false });
        try {
            assert.equal((await complete(project.dir, ['zsh', 'wsc a'])).out, 'values\n');
        } finally {
            await project.cleanup();
        }
    });

    test('an unknown shell is answered with none, not an error', async () => {
        const project = await tmpIdeaProject();
        try {
            const result = await complete(project.dir, ['fish', 'wsc a']);
            assert.deepEqual([result.code, result.out, result.err], [0, 'none\n', '']);
            assert.deepEqual(await complete(project.dir, []), { code: 0, out: 'none\n', err: '', lines: ['none'] });
        } finally {
            await project.cleanup();
        }
    });

    test('WSC_COMPLETE_DEBUG=1 says why a source was skipped', async () => {
        const project = await tmpIdeaProject({ presets: '{ not json' });
        try {
            const result = await complete(project.dir, ['zsh', 'wsc --preset '], { WSC_COMPLETE_DEBUG: '1' });
            assert.equal(result.out, 'values\n');
            assert.match(result.err, /wsc completion: presets/);
        } finally {
            await project.cleanup();
        }
    });
});

describe('completeCommand — bash', () => {
    test('returns escaped, cut items for COMPREPLY, using the word breaks it was given', async () => {
        const project = await tmpIdeaProject();
        try {
            const cut = await complete(project.dir, ['bash', 'wsc api:de', ' \t\n"\'><=;|&(:']);
            assert.equal(cut.out, 'values\ndebug\n');

            const escaped = await complete(project.dir, ['bash', 'wsc api\\ \\>\\ re']);
            assert.ok(escaped.out.includes('api\\ \\>\\ repro:stale-job:debug\n'), escaped.out);
        } finally {
            await project.cleanup();
        }
    });
});

test('the catalogue is read from .idea/, not the current directory', async () => {
    // A config named after a directory that exists beside the project must still be a name.
    const project = await tmpIdeaProject();
    try {
        await fs.mkdir(path.join(project.dir, 'web'));
        const { lines } = await complete(project.dir, ['zsh', 'wsc w']);
        assert.ok(lines.includes('web'));
    } finally {
        await project.cleanup();
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionRun.test.js`
Expected: FAIL — `Cannot find module '../src/completion/run.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/completion/run.js`:

```js
/**
 * `wsc __complete <shell> <line> [wordbreaks]` — what the shell's Tab handler calls.
 *
 * This runs on every keypress, so two rules: it must stay fast (it never touches the MCP
 * Server, and nothing it imports may pull in src/cli.js or the prompt library — see
 * test/completionBoundary.test.js), and it must stay quiet. A stack trace in the middle of
 * a prompt is worse than no suggestions, so every failure here means "offer less", never
 * "print something". WSC_COMPLETE_DEBUG=1 is the way to find out why it offered less.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { readIdeaRunConfigs } from '../fallback/ideaRunConfigs.js';
import { CONFIG_DIR, findProjectRoot, listPresets, readPresets } from '../presets/store.js';
import { complete, findProjectFlag } from './candidates.js';
import { formatCompletion } from './format.js';
import { isCompletionShell } from './shells.js';
import { tokenize } from './tokenize.js';

/**
 * @typedef {object} CompleteDeps
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {{ write: (text: string) => unknown }} [stdout]
 * @property {{ write: (text: string) => unknown }} [stderr]
 */

/**
 * The project Tab is completing for: the one `--project` names, if the line has one and
 * it really is a WebStorm project, otherwise the nearest one above the working directory.
 *
 * `resolveProjectRoot()` in src/cli.js does the same and cannot be imported here: it lives
 * in the module this entry point exists to avoid loading.
 *
 * @param {string[]} words
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function projectRootFor(words, cwd) {
    const explicit = findProjectFlag(words);
    if (explicit === undefined) return await findProjectRoot(cwd);

    const root = path.resolve(cwd, explicit);
    const stats = await fs.stat(path.join(root, CONFIG_DIR)).catch(() => null);
    return stats?.isDirectory() ? root : null;
}

/**
 * The two sources are independent: a preset file that does not parse costs the preset names
 * and nothing else.
 *
 * @param {string | null} root
 * @param {(what: string, err: unknown) => void} report
 * @returns {Promise<import('./candidates.js').Catalogue>}
 */
async function readCatalogue(root, report) {
    if (root === null) return { presets: [], configs: [] };

    /** @type {string[]} */
    const presets = await readPresets(root)
        .then(listPresets)
        .catch((err) => {
            report('presets', err);
            return [];
        });
    /** @type {string[]} */
    const configs = await readIdeaRunConfigs(root)
        .then((all) => all.map(({ name }) => name))
        .catch((err) => {
            report('run configurations', err);
            return [];
        });

    return { presets, configs };
}

/**
 * @param {string[]} args - `[shell, line, wordBreaks?]`
 * @param {CompleteDeps} [deps]
 * @returns {Promise<0>} always 0: a completion that fails is an empty completion
 */
export async function completeCommand(args, deps = {}) {
    const cwd = deps.cwd ?? process.cwd();
    const env = deps.env ?? process.env;
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;

    /**
     * @param {string} what
     * @param {unknown} err
     */
    const report = (what, err) => {
        if (env.WSC_COMPLETE_DEBUG !== '1') return;
        stderr.write(`wsc completion: ${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    };

    try {
        const [shell, line = '', wordBreaks] = args;
        if (!isCompletionShell(shell)) {
            report('shell', `unknown shell ${JSON.stringify(shell)}`);
            stdout.write('none\n');
            return 0;
        }

        const typed = tokenize(line);
        const words = typed.words.slice(1); // the first word is the command itself
        const root = await projectRootFor(words, cwd);
        const catalogue = await readCatalogue(root, report);
        const completion = complete({ words, partial: typed.partial }, catalogue);

        stdout.write(formatCompletion(completion, shell, typed, wordBreaks || undefined));
    } catch (err) {
        report('unexpected', err);
        stdout.write('none\n');
    }
    return 0;
}
```

- [ ] **Step 4: Run test and typecheck**

Run: `node --test test/completionRun.test.js && npm run typecheck`
Expected: PASS. (Якщо `tmpIdeaProject({ workspace: false, shared: false })` у фікстурі все ж лишає імена, тест «no saved run configurations» показує це — тоді перевірити `test-utils/tmp-dir.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/completion/run.js test/completionRun.test.js
git commit -m "Add completeCommand: read .idea/ and presets, answer Tab quietly

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Вхід `__complete` у `bin/wsc.js`, межа імпортів, замір

**Files:**
- Modify: `bin/wsc.js`
- Test: `test/completionBoundary.test.js`

**Interfaces:**
- Consumes: `completeCommand` (`src/completion/run.js`), `runCli` (`src/cli.js`).
- Produces: `wsc __complete <shell> <line> [wordbreaks]` як процес; `bin/wsc.js` імпортує `cli.js` **лише** у звичайній гілці.

- [ ] **Step 1: Write the failing test**

`test/completionBoundary.test.js`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tmpIdeaProject } from '../test-utils/tmp-dir.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const WSC_BIN = fileURLToPath(new URL('../bin/wsc.js', import.meta.url));

/** A static `import … from '…'`, `export … from '…'` or bare `import '…'` at the start of a line. */
const STATIC_IMPORT = /^(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/**
 * Every file reachable from `entry` through static imports, and every package they name.
 * Dynamic `import()` is deliberately not followed: that is how src/mcp/client.js loads the
 * MCP SDK only when a session is opened.
 *
 * @param {string} entry
 */
async function walk(entry) {
    /** @type {Set<string>} */
    const files = new Set();
    /** @type {Set<string>} */
    const packages = new Set();
    const pending = [entry];

    while (pending.length > 0) {
        const file = /** @type {string} */ (pending.pop());
        if (files.has(file)) continue;
        files.add(file);

        const source = await readFile(file, 'utf8');
        for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
            if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
            else if (!specifier.startsWith('node:')) packages.add(specifier);
        }
    }
    return { files, packages };
}

describe('the completion path stays light', () => {
    test('run.js reaches neither cli.js, nor the prompts, nor any package', async () => {
        const { files, packages } = await walk(path.join(SRC, 'completion', 'run.js'));
        const relative = [...files].map((file) => path.relative(SRC, file));

        // The walk itself works: it found the modules it is supposed to walk through.
        assert.ok(relative.includes(path.join('fallback', 'ideaRunConfigs.js')), relative.join(', '));
        assert.ok(relative.includes(path.join('completion', 'candidates.js')));

        assert.equal(relative.includes('cli.js'), false, 'src/cli.js loads @inquirer/prompts');
        assert.deepEqual(
            relative.filter((file) => file.startsWith(`ui${path.sep}`)),
            [],
            'src/ui/ imports @inquirer/prompts',
        );
        assert.deepEqual([...packages], [], 'a package on the completion path costs every Tab');
    });
});

describe('bin/wsc.js', () => {
    test('__complete answers Tab without going through the CLI', async () => {
        const project = await tmpIdeaProject();
        try {
            const result = spawnSync(process.execPath, [WSC_BIN, '__complete', 'zsh', 'wsc --ta'], {
                cwd: project.dir,
                encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, 'values\n--target\n');
            assert.equal(result.stderr, '');
        } finally {
            await project.cleanup();
        }
    });

    test('anything else still goes to the CLI', () => {
        const result = spawnSync(process.execPath, [WSC_BIN, '--version'], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^\d+\.\d+\.\d+/);
    });

    test('__complete is reserved only as the first argument', async () => {
        // Not first: an ordinary name, so the CLI sees it and — there being no such
        // configuration — reports it. `--fallback=terminal` keeps the run off the MCP
        // Server, so nothing here depends on an IDE being up.
        const project = await tmpIdeaProject();
        try {
            const result = spawnSync(process.execPath, [WSC_BIN, '--fallback=terminal', '--dry-run', '__complete'], {
                cwd: project.dir,
                encoding: 'utf8',
            });
            assert.doesNotMatch(result.stdout, /^(values|dirs|none)\n/);
            assert.match(result.stderr, /__complete/);
            assert.notEqual(result.status, 0);
        } finally {
            await project.cleanup();
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionBoundary.test.js`
Expected: FAIL — граф імпортів проходить (файли вже є), але `__complete answers Tab…` падає: `bin/wsc.js` віддає `cli.js` слово `__complete`, і stdout не `values\n--target\n`.

- [ ] **Step 3: Write minimal implementation**

`bin/wsc.js` (весь файл):

```js
#!/usr/bin/env node
// `wsc __complete …` is what the shell's Tab handler runs, on every keypress. It gets its
// own entry so it never loads src/cli.js, which pulls in the interactive prompts and costs
// several times what a completion can afford (test/completionBoundary.test.js pins this).
// Everything else is `runCli`, as before; both are imported only on the branch that needs them.
const argv = process.argv.slice(2);

const code =
    argv[0] === '__complete'
        ? await (await import('../src/completion/run.js')).completeCommand(argv.slice(1))
        : await (await import('../src/cli.js')).runCli(argv);

process.exit(code);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/completionBoundary.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Measure Tab latency against the budget (≲120 ms)**

Створити проєкт із фікстур і виміряти медіану з десяти запусків:

```bash
P=$(mktemp -d) && mkdir -p "$P/.idea/runConfigurations" \
  && cp test/fixtures/idea-workspace.xml "$P/.idea/workspace.xml" \
  && cp test/fixtures/idea-shared-node.xml "$P/.idea/runConfigurations/Repro.xml" \
  && (cd "$P" && for i in 1 2 3 4 5 6 7 8 9 10; do /usr/bin/time -f '%e' node "$OLDPWD/bin/wsc.js" __complete zsh 'wsc a' >/dev/null; done 2>&1 | sort -n | sed -n 5,6p)
```

Порівняти з `time node bin/wsc.js --version` (≈0,21 с). Записати обидва числа в повідомлення коміту.

- **Якщо обидва числа з рядків 5–6 ≤ 0,12 с** — нічого більше не робити; перейти до Step 6.
- **Якщо більше** — причина, ймовірно, `resolveProjectNode()` у `readIdeaRunConfigs()` (читає `.nvmrc`); автодоповненню інтерпретатор не потрібен. Тоді додати опцію:
  1. У `test/ideaRunConfigs.test.js` після тесту «without a resolvable .nvmrc…» (рядок ~236) додати:

     ```js
     test('resolveNode: false skips the .nvmrc lookup, which a caller that only needs names does not want', async () => {
         const project = await tmpIdeaProject();
         const home = await tmpDir('wsc-home-');
         try {
             const bin = path.join(home.dir, '.nvm', 'versions', 'node', 'v20.20.0', 'bin');
             await fs.mkdir(bin, { recursive: true });
             await fs.writeFile(path.join(bin, 'node'), '');
             await fs.writeFile(path.join(project.dir, '.nvmrc'), '20\n');

             const configs = await readIdeaRunConfigs(project.dir, { homeDir: home.dir, env: {}, resolveNode: false });

             assert.equal(byName('client > bundle:build', configs).interpreter, undefined);
         } finally {
             await home.cleanup();
             await project.cleanup();
         }
     });
     ```

     Run: `node --test --test-name-pattern='resolveNode' test/ideaRunConfigs.test.js` → FAIL (опція ігнорується, `interpreter` заповнений).
  2. У `src/fallback/ideaRunConfigs.js`, у JSDoc `readIdeaRunConfigs` додати після рядка `@param {NodeJS.ProcessEnv} [opts.env] …`:

     ```js
      * @param {boolean} [opts.resolveNode] - `false` skips resolving "Project node" from `.nvmrc`
      *   (default: resolve). For callers that only need names — Tab completion.
     ```

     і перед `const projectNode = await resolveProjectNode(…)` вставити:

     ```js
         if (opts.resolveNode === false) return unique;
     ```
  3. У `src/completion/run.js` змінити виклик на `readIdeaRunConfigs(root, { resolveNode: false })`.
  4. Повторити вимір; тест `node --test test/ideaRunConfigs.test.js test/completionRun.test.js` має пройти.

- [ ] **Step 6: Commit**

```bash
git add bin/wsc.js test/completionBoundary.test.js
# (і src/fallback/ideaRunConfigs.js, src/completion/run.js, test/ideaRunConfigs.test.js, лише якщо застосовано опцію з Step 5)
git commit -m "Route wsc __complete to the light completion module

wsc --version: <N> s; wsc __complete: <M> s (median of 10, demo-app fixtures).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(У повідомленні підставити виміряні числа замість `<N>` і `<M>`.)

---

### Task 7: Обгортки для zsh і bash

**Files:**
- Create: `src/completion/scripts.js`
- Test: `test/completionScripts.test.js`

**Interfaces:**
- Consumes: `CompletionShell` (`./shells.js`); `DEFAULT_WORDBREAKS` (`./format.js`) — лише в тесті.
- Produces: `ZSH_SCRIPT: string`, `BASH_SCRIPT: string`, `completionScript(shell: CompletionShell): string`.

Обгортки не викликають нічого, крім `command wsc __complete <shell> <рядок> [<wordbreaks>]`. bash-обгортку перевірено вручну в тимчасовій теці з фальшивим `wsc` (варіанти `values`, `none`, порожній список, `dirs`, відсутній `wsc` у `PATH`); zsh-обгортку на етапі планування виконати не вдалося — її вперше проганяє цей Task.

- [ ] **Step 1: Write the failing test**

`test/completionScripts.test.js`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WORDBREAKS } from '../src/completion/format.js';
import { BASH_SCRIPT, ZSH_SCRIPT, completionScript } from '../src/completion/scripts.js';
import { tmpDir, tmpIdeaProject } from '../test-utils/tmp-dir.js';

const WSC_BIN = fileURLToPath(new URL('../bin/wsc.js', import.meta.url));
const has = (shell) => spawnSync(shell, ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * A directory holding a `wsc` that runs this checkout, to put first on PATH: the wrappers
 * call `command wsc`, exactly as they will for a user who ran `npm link`.
 */
async function withShim(body) {
    const shim = await tmpDir('wsc-shim-');
    const file = path.join(shim.dir, 'wsc');
    await fs.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${WSC_BIN}" "$@"\n`);
    await fs.chmod(file, 0o755);
    try {
        return await body(shim.dir);
    } finally {
        await shim.cleanup();
    }
}

describe('completionScript', () => {
    test('picks the script by shell', () => {
        assert.equal(completionScript('zsh'), ZSH_SCRIPT);
        assert.equal(completionScript('bash'), BASH_SCRIPT);
    });

    test('both wrappers send stderr to /dev/null and call the hidden entry', () => {
        for (const script of [ZSH_SCRIPT, BASH_SCRIPT]) {
            assert.match(script, /command wsc __complete /);
            assert.match(script, /2>\/dev\/null/);
        }
    });

    test('each script says how to install it', () => {
        assert.match(ZSH_SCRIPT, /source <\(wsc --completion zsh\)/);
        assert.match(BASH_SCRIPT, /source <\(wsc --completion bash\)/);
    });
});

describe('the bash wrapper, in a real bash', { skip: !has('bash') && 'bash is not installed' }, () => {
    /**
     * @param {string} line - what is on the command line, up to the cursor
     * @param {string} cwd
     * @param {string} shimDir
     * @returns {string[]} COMPREPLY
     */
    const tab = (line, cwd, shimDir) => {
        const script = `${BASH_SCRIPT}
COMP_LINE=$WSC_TEST_LINE
COMP_POINT=\${#COMP_LINE}
COMP_WORDBREAKS=$WSC_TEST_WORDBREAKS
COMP_WORDS=(wsc "")
COMP_CWORD=1
_wsc
printf '%s\\n' "\${COMPREPLY[@]}"
`;
        const result = spawnSync('bash', ['--norc', '--noprofile', '-c', script], {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                WSC_TEST_LINE: line,
                WSC_TEST_WORDBREAKS: DEFAULT_WORDBREAKS,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return result.stdout.split('\n').filter(Boolean);
    };

    test('completes names, escaped for readline', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                const items = tab('wsc a', project.dir, shim);
                for (const item of ['api', 'api\\ \\>\\ repro:stale-job:debug', 'addon-client']) {
                    assert.ok(items.includes(item), `${item} missing from ${JSON.stringify(items)}`);
                }
                assert.equal(items.includes('web'), false);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('completes only the part after a bare colon or equals sign', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc api:de', project.dir, shim), ['debug']);
                assert.deepEqual(tab('wsc --target=t', project.dir, shim), ['terminal']);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('--project completes directory names', async () => {
        const project = await tmpIdeaProject();
        try {
            await fs.mkdir(path.join(project.dir, 'sub'));
            await withShim(async (shim) => {
                assert.ok(tab('wsc --project ', project.dir, shim).includes('sub'));
            });
        } finally {
            await project.cleanup();
        }
    });

    test('offers nothing when nothing applies', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --list ', project.dir, shim), []);
                assert.deepEqual(tab('wsc --mcp-port ', project.dir, shim), []);
            });
        } finally {
            await project.cleanup();
        }
    });
});

describe('the zsh wrapper', { skip: !has('zsh') && 'zsh is not installed' }, () => {
    test('is valid zsh', () => {
        const result = spawnSync('zsh', ['-n', '-c', ZSH_SCRIPT], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    });

    /**
     * Runs the wrapper's function outside ZLE: `compadd` and `_files` are stubs that print
     * what they were given, and `_wsc_line` (the one place the wrapper reads BUFFER and
     * CURSOR, which only exist inside a widget) is replaced by one that reads the test's
     * line. That checks the wrapper's own logic; the real Tab is checked by hand through a pty.
     *
     * @param {string} line
     * @param {string} cwd
     * @param {string} shimDir
     * @returns {string[]} one entry per line the stubs printed
     */
    const tab = (line, cwd, shimDir) => {
        const script = `
compadd() { print -rl -- "$@" }
_files() { print -r -- "_files $*" }
compdef() { : }
eval "$WSC_TEST_SCRIPT"
_wsc_line() { REPLY=$WSC_TEST_LINE }
_wsc
`;
        const result = spawnSync('zsh', ['-f', '-c', script], {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${shimDir}:${process.env.PATH}`,
                WSC_TEST_SCRIPT: ZSH_SCRIPT,
                WSC_TEST_LINE: line,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        return result.stdout.split('\n').filter(Boolean);
    };

    test('hands raw names to compadd after --, leaving the quoting to zsh', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                const printed = tab('wsc a', project.dir, shim);
                assert.equal(printed[0], '--');
                for (const name of ['api', 'api > repro:stale-job:debug', 'addon-client']) {
                    assert.ok(printed.includes(name), `${name} missing from ${JSON.stringify(printed)}`);
                }
            });
        } finally {
            await project.cleanup();
        }
    });

    test('asks _files for directories after --project', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --project ', project.dir, shim), ['_files -/']);
            });
        } finally {
            await project.cleanup();
        }
    });

    test('adds nothing when nothing applies', async () => {
        const project = await tmpIdeaProject();
        try {
            await withShim(async (shim) => {
                assert.deepEqual(tab('wsc --list ', project.dir, shim), []);
            });
        } finally {
            await project.cleanup();
        }
    });
});
```

Тести викликають `bin/wsc.js __complete` із Task 6 через `wsc`-заглушку в `PATH`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/completionScripts.test.js`
Expected: FAIL — `Cannot find module '../src/completion/scripts.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/completion/scripts.js`:

```js
/**
 * The two shell wrappers `wsc --completion <shell>` prints.
 *
 * They are deliberately thin: hand the line up to the cursor to `wsc __complete`, read the
 * directive it answers with, and give the candidates to the shell. Every decision — what
 * to offer, how to escape it for bash — is made in JavaScript, where it is tested.
 *
 * Both silence stderr and swallow a failing `wsc`: a Tab press must never print anything.
 */

/** @typedef {import('./shells.js').CompletionShell} CompletionShell */

// `\${` below is a literal `${` in the emitted script: in a template literal it would
// otherwise start an interpolation.
export const ZSH_SCRIPT = `#compdef wsc
# Tab completion for wsc. Add this to ~/.zshrc:
#   source <(wsc --completion zsh)

# The one place that reads ZLE's BUFFER and CURSOR, kept apart so the tests can replace it.
_wsc_line() { REPLY=\${BUFFER[1,CURSOR]} }

_wsc() {
  local -a reply_lines
  _wsc_line
  reply_lines=("\${(@f)$(command wsc __complete zsh "$REPLY" 2>/dev/null)}")
  local directive=\${reply_lines[1]}
  shift reply_lines
  case $directive in
    values) (( \${#reply_lines} )) && compadd -- "\${reply_lines[@]}" ;;
    dirs) _files -/ ;;
  esac
  return 0
}

if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi
compdef _wsc wsc
`;

export const BASH_SCRIPT = `# Tab completion for wsc. Add this to ~/.bashrc:
#   source <(wsc --completion bash)

_wsc() {
  local out directive line rest
  COMPREPLY=()
  out=$(command wsc __complete bash "\${COMP_LINE:0:COMP_POINT}" "$COMP_WORDBREAKS" 2>/dev/null) || return 0
  directive=\${out%%$'\\n'*}
  case $directive in
    values)
      [[ $out == *$'\\n'* ]] || return 0
      rest=\${out#*$'\\n'}
      while IFS= read -r line; do
        [[ -n $line ]] && COMPREPLY+=("$line")
      done <<< "$rest"
      ;;
    dirs)
      compopt -o filenames 2>/dev/null
      while IFS= read -r line; do
        COMPREPLY+=("$line")
      done < <(compgen -d -- "\${COMP_WORDS[COMP_CWORD]}")
      ;;
  esac
  return 0
}

complete -F _wsc wsc
`;

/**
 * @param {CompletionShell} shell
 * @returns {string}
 */
export function completionScript(shell) {
    return shell === 'zsh' ? ZSH_SCRIPT : BASH_SCRIPT;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/completionScripts.test.js && npm run typecheck`
Expected: PASS — зокрема тести «real bash» і «the zsh wrapper». Якщо `zsh` не проходить через `BUFFER`/`CURSOR` чи `$+functions[compdef]`, помилка в `ZSH_SCRIPT`: виправити обгортку, а не послаблювати тест.

- [ ] **Step 5: Commit**

```bash
git add src/completion/scripts.js test/completionScripts.test.js
git commit -m "Add the zsh and bash wrappers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Прапорець `--completion`

**Files:**
- Modify: `src/args.js` (OPTIONS, `CliValues`), `src/cli.js` (імпорти, `HELP`, `run()`)
- Test: `test/cli.integration.test.js`

**Interfaces:**
- Consumes: `COMPLETION_SHELLS`, `isCompletionShell` (`src/completion/shells.js`); `completionScript` (`src/completion/scripts.js`).
- Produces: `wsc --completion <zsh|bash>` друкує скрипт у stdout (exit 0); вживання з позиційними або іншими прапорцями, чи невідома оболонка — `UsageError` (exit 2).

- [ ] **Step 1: Write the failing tests**

У `test/cli.integration.test.js`: додати імпорт

```js
import { BASH_SCRIPT, ZSH_SCRIPT } from '../src/completion/scripts.js';
```

і `describe` перед `// ── -l, --list` (тобто після блоку `flag table — -c/--configure`):

```js
// ── --completion ─────────────────────────────────────────────────────────────
describe('flag table — --completion', () => {
    test('prints the zsh script to stdout, and contacts nothing', async () => {
        const result = await wsc(['--completion', 'zsh']);

        assert.equal(result.code, 0);
        assert.equal(result.stdout, ZSH_SCRIPT);
        assert.equal(result.stderr, '');
        assert.deepEqual(result.calls, []);
        assert.deepEqual(result.executed, []);
    });

    test('prints the bash script for bash', async () => {
        const result = await wsc(['--completion=bash']);

        assert.equal(result.code, 0);
        assert.equal(result.stdout, BASH_SCRIPT);
    });

    test('a shell it has no script for is a usage error that names the ones it has', async () => {
        const result = await wsc(['--completion', 'fish']);

        assert.equal(result.code, 2);
        assert.match(result.output, /--completion: expected one of zsh, bash, got "fish"/);
    });

    test('a missing value is a usage error', async () => {
        assert.equal((await wsc(['--completion'])).code, 2);
    });

    test('takes no configuration names and no other flag', async () => {
        for (const argv of [
            ['--completion', 'zsh', 'web'],
            ['--completion', 'zsh', '--dry-run'],
            ['--completion', 'zsh', '--list'],
            ['--completion', 'zsh', '--preset', 'a'],
            ['-c', '--completion', 'zsh'],
        ]) {
            const result = await wsc(argv);
            assert.equal(result.code, 2, argv.join(' '));
            assert.match(result.output, /--completion prints a script and takes nothing else/);
            assert.equal(result.stdout, '');
        }
    });

    test('--help still wins, and lists the flag', async () => {
        const result = await wsc(['--completion', 'zsh', '--help']);

        assert.equal(result.code, 0);
        assert.match(result.stdout, /--completion <sh>/);
        assert.doesNotMatch(result.stdout, /#compdef wsc/);
    });
});
```

Перший тест уже покриває «працює поза налаштованим проєктом»: `wsc()` без `idea` створює порожній `.idea/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern='flag table — --completion' test/cli.integration.test.js`
Expected: FAIL — `--completion` невідомий (`ERR_PARSE_ARGS_UNKNOWN_OPTION` → exit 2 там, де очікується 0).

- [ ] **Step 3: Write minimal implementation**

`src/args.js`: у `OPTIONS` після `fallback: { type: 'string' },` додати

```js
    completion: { type: 'string' },
```

і в typedef `CliValues` після `fallback?: string,` додати

```js
 *   completion?: string,
```

`src/cli.js`:

1. Імпорти — додати перед `import { announceCustomCommands } from './exec/customCommands.js';`:

```js
import { completionScript } from './completion/scripts.js';
import { COMPLETION_SHELLS, isCompletionShell } from './completion/shells.js';
```

2. У `HELP`, у секції `Options:` після рядка `-c, --configure …` не чіпати, а **після рядка `--fallback <how> …` і його продовження** (перед `-h, --help`) додати:

```
      --completion <sh> print a Tab-completion script (zsh or bash), and stop
```

(`<sh>`, а не `<shell>`: колонка описів у `HELP` починається на 24-му символі, і `--completion <sh>` — найдовший підпис, що в неї вміщається.)

а в секцію `Examples:` після рядка `wsc --fallback=terminal web …` додати:

```
  source <(wsc --completion zsh)      in ~/.zshrc: Tab completes flags, presets and configurations
```

3. У `run()` одразу після блоку `if (values.version) { … return 0; }` додати:

```js

    // --completion is a fourth intent, and the only one that touches nothing: it prints a
    // script and stops, so it is decided before the project, the presets or the IDE come
    // into it. Every other intent refuses a command line that means two things at once, and
    // so does this one — a `wsc --completion zsh web` that printed the script and dropped
    // `web` would look like it had worked.
    if (Object.hasOwn(values, 'completion')) {
        const others = Object.keys(values).filter((flag) => flag !== 'completion');
        if (typed.length > 0 || others.length > 0) {
            throw new UsageError(
                '--completion prints a script and takes nothing else: no configuration names, no other flags',
            );
        }
        const shell = values.completion;
        if (!isCompletionShell(shell)) {
            throw new UsageError(`--completion: expected one of ${COMPLETION_SHELLS.join(', ')}, got "${shell}"`);
        }
        stdout.write(completionScript(shell));
        return 0;
    }
```

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Наявні тести, що закріплюють `HELP` або «кожен прапорець читається» (`test/cli.test.js:409`), мають пройти: `values.completion` читається в `cli.js`. Якщо якийсь тест закріплює точний текст довідки — оновити його очікування тим самим рядком, що додано в `HELP`, і більше нічого.

- [ ] **Step 5: Commit**

```bash
git add src/args.js src/cli.js test/cli.integration.test.js
git commit -m "Add --completion: print the zsh or bash completion script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Документація, ручна приймальна перевірка, підсумок

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:** нічого нового; документує Tasks 1–8.

- [ ] **Step 1: README — рядок таблиці й розділ**

У таблицю «The flag table» (`README.md`, після рядка `--fallback=…`, ~рядок 174) додати:

```
| `--completion <zsh\|bash>` | print a Tab-completion script for that shell (see [Tab completion](#tab-completion)) |
```

Розділ `## Tab completion` додати перед `## The flag table`. Його зміст — лише захоплений вивід і команди. Зібрати його так:

1. Виконати `node bin/wsc.js --completion zsh | head -8` і вставити вивід **дослівно** у блок коду, підписаний «`wsc --completion zsh | head -8`».
2. Виконати в проєкті з `.idea/` (скопіювати `.idea/workspace.xml` цього репозиторію у тимчасову теку, як описано в `CLAUDE.md`) `node <шлях>/bin/wsc.js __complete zsh 'wsc --ta'` і `node <шлях>/bin/wsc.js __complete zsh 'wsc test:'` і вставити обидва виводи дослівно.
3. Текст навколо — не довший за дві фрази на блок: що додати в `~/.zshrc` (`source <(wsc --completion zsh)`) і в `~/.bashrc` (`source <(wsc --completion bash)`); що назви беруться з `.idea/` і тому щойно створена в IDE конфігурація з'явиться, коли IDE її запише; що `wsc` має бути в `PATH` (`npm link`).

- [ ] **Step 2: CLAUDE.md — чотири точкові правки**

Використати `Edit` із такими парами (кожен `old_string` — один рядок, що існує рівно раз):

1. `What is left is user-triggered: \`/code-review\` over the whole diff before the first version tag.` →
   `Since then: Tab completion for zsh and bash (\`wsc --completion <shell>\`, \`src/completion/\`).\nWhat is left is user-triggered: \`/code-review\` over the whole diff before the first version tag.`
2. `- \`bin/wsc.js\` — shebang entrypoint. Calls \`runCli(process.argv.slice(2))\` and does \`process.exit(code)\`.` →
   `- \`bin/wsc.js\` — shebang entrypoint. Calls \`runCli(process.argv.slice(2))\` and does \`process.exit(code)\` — except that\n  \`argv[0] === '__complete'\` goes to \`src/completion/run.js\` instead, each imported only on its own branch (see the\n  completion paragraph below).`
3. `  every flag plugs into. Three intents live in it, and each one refuses the other two's flags rather than` →
   `  every flag plugs into. Four intents live in it, and each one refuses the others' flags rather than`
4. `  half-honouring a command line: a launch, \`--configure\`, and \`--list\`.` →
   `  half-honouring a command line: a launch, \`--configure\`, \`--list\`, and \`--completion\`.`

Потім, перед рядком `- \`scripts/mcp-probe.js\` — manual diagnostic script …`, вставити абзац (`Edit`: `old_string` = початок цього рядка, `new_string` = абзац + початок цього рядка):

```
- **`src/completion/` — Tab completion (zsh, bash), and why it has its own entry point.** The shell wrapper
  (`wsc --completion <shell>` prints it) hands the line up to the cursor to `wsc __complete <shell> <line>`;
  `bin/wsc.js` routes that to `src/completion/run.js` **without loading `src/cli.js`**, because `cli.js`
  statically imports `@inquirer/prompts` and `wsc --version` costs 0.21 s against 0.05 s for bare `node` —
  a cost paid on every keypress. Pinned by `test/completionBoundary.test.js`, which walks the *static* import
  graph from `run.js` and forbids `cli.js`, `src/ui/` and any package (`src/mcp/` is allowed: its SDK import
  is dynamic). That is why `FALLBACK_MODES` moved into `src/modes.js`. Names come from `.idea/`
  (`readIdeaRunConfigs`), **never MCP**: a Tab cannot wait for a connection, and a configuration the IDE has
  not saved yet is simply absent. Answer protocol: first line `values` | `dirs` | `none`, then one candidate
  per line. **Escaping is done in JS (`format.js`), not in the shell**: zsh gets raw names and `compadd`
  quotes them; bash gets ready `COMPREPLY` items, cut after the last *bare* `COMP_WORDBREAKS` character
  (`:`, `=`, `>` are word breaks in bash, and `api > repro:stale-job:debug` has all of them) and
  backslash-escaped. The wrapper passes the raw line, not `COMP_WORDS`, for the same reason. Never
  `compopt -o filenames` for names: readline appends `/` to a candidate that matches a directory in the
  working directory, and demo-app has both a configuration and a directory called `web`. Every failure means
  "offer less": exit 0, empty stderr, `WSC_COMPLETE_DEBUG=1` prints why. `__complete` is a reserved word only
  as `argv[0]`. The zsh wrapper is tested with stubbed `compadd`/`_files`/`_wsc_line` (BUFFER and CURSOR
  exist only inside ZLE); the real Tab is checked by hand through a pty.
```

- [ ] **Step 3: Ручна приймальна перевірка через pty**

Це те, що юніт-тести не бачать: справжній Tab. Виконати й записати результат у повідомлення фінального коміту або в звіт:

1. `npm link` (або `PATH="$PWD/bin:$PATH"` з символічним посиланням `wsc` → `bin/wsc.js`).
2. У тимчасовому проєкті з `.idea/` із фікстур:
   `script -qec "bash --norc -i" /dev/null` з підготовленим вводом: `source <(wsc --completion bash)`, потім `wsc a` + Tab Tab. Очікується: список із `addon-client`, `api`, … . Потім `wsc api:` + Tab Tab → `api:run api:debug api:terminal` (у bash — після відрізання: `run debug terminal`). Потім `wsc api\ \>\ ` + Tab → підставляється `repro:stale-job:debug` без зламаних екранувань.
3. Те саме для zsh: `script -qec "zsh -f -i" /dev/null` з `autoload -Uz compinit && compinit`, `source <(wsc --completion zsh)`, `wsc a` + Tab. Очікується меню з тими самими іменами; вибір `api > repro:stale-job:debug` вставляється як `api\ \>\ repro:stale-job:debug`.
4. `wsc --ta` + Tab → `--target`; `wsc --target ` + Tab → `run-window terminal`; `wsc --project ` + Tab → каталоги; `wsc --list ` + Tab → нічого.
5. Поза проєктом (`cd /tmp`): `wsc --` + Tab → прапорці; `wsc a` + Tab → нічого, і жодного тексту помилки в терміналі.

Якщо щось із цього розходиться з юніт-тестами — це знахідка: додати тест, що її відтворює, перш ніж виправляти.

- [ ] **Step 4: Повна перевірка**

Run: `npm test && npm run typecheck`
Expected: усе зелене; кількість тестів > 895.

Run: `git status --short`
Expected: порожньо, крім файлів цього Task.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document Tab completion: README section and the CLAUDE.md paragraph

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Після цього залишається користувацький крок із `CLAUDE.md`: `/code-review` над усім диффом перед першим тегом версії.
