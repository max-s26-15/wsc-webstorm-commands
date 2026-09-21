# Власні CLI-команди у пресеті — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запис пресету з масивом `commands` запускає shell-команди (одну або послідовність через `&&`) у Terminal-вкладці IDE з назвою запису, без run-конфігурацій WebStorm; такі записи додаються в `wsc --configure`.

**Architecture:** Запис пресету з `commands` — окремий вид запису (`isCustomEntry`). `buildLaunchPlan()` перетворює його на `CustomPlanEntry` без `config` і без звернення до каталогу IDE. `buildExecutionPlan()` робить із нього один виклик `execute_terminal_command` з `tabName = name`, а no-IDE шлях (`terminalFallback.js`) — вкладку ОС-терміналу з тією самою назвою. Екран `--configure` показує наявні власні записи в чекбоксі й додає цикл створення нових.

**Tech Stack:** Node ≥18, чистий ESM, `node:test`, `@inquirer/prompts` ^7 (`input`, `confirm`), JSDoc-типи, що перевіряє `tsc` (`npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-09-21-custom-commands-design.md`

## Global Constraints

- Запис пресету: `{ "name": "seed db", "mode": "terminal", "commands": ["npm i", "npm run seed"] }`. Власний запис — той, що має масив `commands`.
- `mode` власного запису — завжди `terminal`. Якщо `mode` є і не `terminal`, це `PresetConfigError`. Значення `MODES` у `src/modes.js` не змінюється. Версія схеми лишається `1` (`SCHEMA_VERSION`).
- `commands` — непорожній масив непорожніх (після `trim`) однорядкових рядків (без `\n` і `\r`).
- Послідовність з'єднується рівно `' && '`, без quoting: це shell-текст користувача (як `config.args`). Зупинка на першій помилці.
- Без `cwd`, без `onError`, без виклику з CLI за іменем, без окремого каталогу команд, без підтвердження перед запуском.
- Назва вкладки = `name` запису (`McpCall.tabName`); виклик такого запису ніколи не читає `.idea/` і не отримує inspector-порт.
- Перед запуском команди завжди друкуються: `log.info` (stderr), заголовок `custom commands from the preset:`, далі рядки `  <name>: <commands joined>`.
- Власна назва в `--configure` відхиляється, якщо вона порожня, дублює ім'я власного запису пресету (навіть щойно знятого) або збігається з ім'ям IDE-конфігурації.
- Ключі `Map` для плану — `JSON.stringify([kind, name])`; пошук за ім'ям — `Object.hasOwn`/`Map`/`Set`, ніколи `obj[name]` (ім'я може бути `constructor`, `__proto__`, `toString`).
- `engines.node >=18`: без синтаксису, що потребує новішого Node. У JSDoc-описах не писати `@` усередині тексту (це новий тег).
- `test/` і `test-utils/` не входять до `tsc`; код у `src/` мусить проходити `npm run typecheck`.
- Базовий стан гілки: `npm test` — 805 тестів зелені, `npm run typecheck` чистий. Кожен коміт лишає обидва зеленими.

## Карта файлів

| Файл | Дія | Відповідальність |
|---|---|---|
| `src/presets/store.js` | змінити | `commands` у `parseEntry`/`serializeConfig`, `isCustomEntry` |
| `src/resolve.js` | змінити | `ConfigPlanEntry`/`CustomPlanEntry`, `isCustomPlanEntry`, `buildLaunchPlan` для власних записів |
| `src/exec/customCommands.js` | створити | `customCommandLine`, `customCommandLines`, `announceCustomCommands` |
| `src/exec/planBuilder.js` | змінити | виклик Terminal для власного запису, `needsTerminalCommands` |
| `src/fallback/terminalFallback.js` | змінити | вкладка з власного запису, правило каталогу, оголошення |
| `src/cli.js` | змінити | `announceCustomCommands` перед запуском |
| `src/ui/configureLogic.js` | змінити | вибір, `applyAnswersToPreset`, `diffPreset`, `validateCustomName` |
| `src/ui/configure.js` | змінити | цикл додавання, порожній каталог IDE |
| `test/*.test.js`, `test-utils/` | змінити/створити | див. задачі |
| `README.md`, `CLAUDE.md` | змінити | розділ і абзац про власні записи |

---

### Task 1: Схема пресету — `commands` у записі

**Files:**
- Modify: `src/presets/store.js` (typedef `PresetEntry`, `parseEntry`, `serializeConfig`; новий експорт `isCustomEntry`)
- Test: `test/presets.test.js`

**Interfaces:**
- Produces: `isCustomEntry(entry: PresetEntry): entry is PresetEntry & { commands: string[] }`; `PresetEntry` отримує `commands?: string[]`. Розібраний власний запис: `{ ...extra, name, mode: 'terminal', commands }`.

- [ ] **Step 1: Write the failing tests**

У `test/presets.test.js` додати `isCustomEntry` до імпорту з `../src/presets/store.js` (в алфавітному порядку, після `hasPreset`), а в кінець файлу дописати:

```js
describe('custom command entries', () => {
    const custom = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const parse = (entries) => parseConfig(JSON.stringify({ version: 1, presets: { default: entries } }));

    test('an entry with commands parses as a custom entry', () => {
        const [entry] = parse([custom]).presets.default;
        assert.deepEqual(entry, custom);
        assert.equal(isCustomEntry(entry), true);
    });

    test('mode may be left out: a custom entry is always a terminal one', () => {
        const [entry] = parse([{ name: 'seed db', commands: ['npm i'] }]).presets.default;
        assert.equal(entry.mode, 'terminal');
    });

    test('a run-configuration entry is not a custom one', () => {
        assert.equal(isCustomEntry({ name: 'web', mode: 'run' }), false);
    });

    for (const mode of ['run', 'debug']) {
        test(`mode "${mode}" contradicts commands and is refused`, () => {
            assert.throws(
                () => parse([{ ...custom, mode }]),
                (err) => err instanceof PresetConfigError && /mode must be "terminal"/.test(err.detail),
            );
        });
    }

    for (const [label, commands] of [
        ['an empty list', []],
        ['a string', 'npm i'],
        ['an empty command', ['']],
        ['a blank command', ['  ']],
        ['a non-string', [1]],
        ['a command with a newline', ['npm i\nnpm run seed']],
        ['a command with a carriage return', ['a\rb']],
    ]) {
        test(`commands that are ${label} are refused, naming the entry`, () => {
            assert.throws(
                () => parse([{ name: 'ok', mode: 'run' }, { name: 'seed db', commands }]),
                (err) => err instanceof PresetConfigError
                    && /preset "default" entry 1/.test(err.detail)
                    && /"commands" must be a non-empty list/.test(err.detail),
            );
        });
    }

    test('serializes commands right after mode, keeps unknown keys, and rewriting is a no-op', () => {
        const text = serializeConfig(parse([{ zeta: 1, commands: ['npm i'], name: 'seed db', mode: 'terminal' }]));
        const written = JSON.parse(text).presets.default[0];

        assert.deepEqual(Object.keys(written), ['name', 'mode', 'commands', 'zeta']);
        assert.equal(serializeConfig(parseConfig(text)), text);
    });

    test('a custom entry may be called like a member of Object.prototype', () => {
        for (const name of ['constructor', '__proto__', 'toString']) {
            const [entry] = parse([{ name, commands: ['echo hi'] }]).presets.default;
            assert.equal(entry.name, name);
            assert.deepEqual(entry.commands, ['echo hi']);
        }
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern='custom command entries' test/presets.test.js`
Expected: FAIL (`isCustomEntry` is not a function / not exported).

- [ ] **Step 3: Implement**

У `src/presets/store.js`:

1. Замінити typedef `PresetEntry`:

```js
/**
 * @typedef {{
 *   name: string,
 *   mode: import('../modes.js').LaunchMode,
 *   commands?: string[],
 *   [extra: string]: unknown,
 * }} PresetEntry
 * @typedef {{
 *   version: number,
 *   defaultPreset: string,
 *   presets: Record<string, PresetEntry[]>,
 *   [extra: string]: unknown,
 * }} PresetConfig
 */
```

2. Одразу після класу `PresetConfigError` додати:

```js
/**
 * An entry that runs shell commands of its own instead of naming a run configuration.
 *
 * The one place that decides it: everything downstream (resolving, the launch plan, the
 * `--configure` screen) asks this instead of looking for `commands` itself.
 *
 * @param {PresetEntry} entry
 * @returns {entry is PresetEntry & { commands: string[] }}
 */
export function isCustomEntry(entry) {
    return Array.isArray(entry.commands);
}
```

3. У `parseEntry` замінити рядок деструктурування й додати гілку для власного запису (після перевірки `name`, до перевірки `mode`):

```js
    const { name, mode, commands, ...extra } = /** @type {Record<string, unknown>} */ (entry);

    if (typeof name !== 'string' || name === '') {
        throw new PresetConfigError(filePath, `${where} is missing a non-empty "name"`);
    }
    if (commands !== undefined) return parseCustomEntry(name, mode, commands, extra, where, filePath);
```

(Наявна перевірка `mode !== undefined && !MODES.includes(...)` і фінальний `return` лишаються нижче без змін.)

4. Одразу після `parseEntry` додати:

```js
/**
 * @param {string} name
 * @param {unknown} mode
 * @param {unknown} commands
 * @param {Record<string, unknown>} extra
 * @param {string} where
 * @param {string} filePath
 * @returns {PresetEntry}
 */
function parseCustomEntry(name, mode, commands, extra, where, filePath) {
    if (mode !== undefined && mode !== 'terminal') {
        throw new PresetConfigError(
            filePath,
            `${where} has "commands", so its mode must be "terminal", got ${JSON.stringify(mode)}`,
        );
    }

    // One line each: the list is joined with `&&` into a single command line, and a newline
    // inside an item would start a second command that `&&` no longer guards.
    const valid = Array.isArray(commands)
        && commands.length > 0
        && commands.every((command) => typeof command === 'string' && command.trim() !== '' && !/[\r\n]/.test(command));
    if (!valid) {
        throw new PresetConfigError(
            filePath,
            `${where} "commands" must be a non-empty list of non-empty single-line strings`,
        );
    }

    return { ...extra, name, mode: 'terminal', commands: [.../** @type {string[]} */ (commands)] };
}
```

5. У `serializeConfig` замінити `entries.map(...)`:

```js
                entries.map(({ name: entryName, mode, commands, ...extra }) => ({
                    name: entryName,
                    mode,
                    ...(commands === undefined ? {} : { commands }),
                    ...sortKeys(extra),
                })),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/presets.test.js && npm run typecheck`
Expected: усі тести файлу PASS; typecheck без помилок.

- [ ] **Step 5: Commit**

```bash
git add src/presets/store.js test/presets.test.js
git commit -m "feat(presets): custom command entries with a commands list

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Власний запис у плані, виклику Terminal і вкладці fallback

Один комміт, бо зміна типу `PlanEntry` торкається всіх споживачів одразу (інакше `typecheck` не зелений).

**Files:**
- Modify: `src/resolve.js` (typedef, `isCustomPlanEntry`, `buildLaunchPlan`)
- Create: `src/exec/customCommands.js`
- Modify: `src/exec/planBuilder.js` (typedef, `needsTerminalCommands`, `buildExecutionPlan`)
- Modify: `src/fallback/terminalFallback.js` (`buildTabs`)
- Test: `test/resolve.test.js`, `test/planBuilder.test.js`, `test/terminalFallback.test.js`, `test/customCommands.test.js` (новий)

**Interfaces:**
- Consumes (Task 1): `PresetEntry.commands?: string[]`.
- Produces:
  - `ConfigPlanEntry = { name, mode, config: RunConfigInfo, source }`, `CustomPlanEntry = { name, mode: 'terminal', commands: string[], source }`, `PlanEntry = ConfigPlanEntry | CustomPlanEntry` (у `src/resolve.js`)
  - `isCustomPlanEntry(entry: PlanEntry): entry is CustomPlanEntry` (`src/resolve.js`)
  - `customCommandLine(commands: string[]): string` = `commands.join(' && ')`; `customCommandLines(plan: PlanEntry[]): string[]` (рядки `"<name>: <line>"`); `announceCustomCommands(plan, log): void` (`src/exec/customCommands.js`)
  - `CommandSource` тепер `'idea' | 'name' | 'custom'`; `CommandFor` приймає `ConfigPlanEntry`.

- [ ] **Step 1: Write the failing tests**

**`test/customCommands.test.js`** (новий файл):

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { announceCustomCommands, customCommandLine, customCommandLines } from '../src/exec/customCommands.js';
import { createLogger } from '../src/log.js';
import { buildLaunchPlan } from '../src/resolve.js';
import { fakeStream } from '../test-utils/capture.js';

const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
const plan = buildLaunchPlan({ configs: [{ name: 'web' }], preset: [{ name: 'web', mode: 'run' }, seed] });

describe('customCommandLine', () => {
    test('joins the commands with && and quotes nothing', () => {
        assert.equal(customCommandLine(['npm i', 'echo "a b" | tr a-z A-Z']), 'npm i && echo "a b" | tr a-z A-Z');
    });

    test('a failing command stops the chain — run through a real /bin/sh', () => {
        const chained = spawnSync('/bin/sh', ['-c', customCommandLine(['false', 'echo second'])], { encoding: 'utf8' });
        assert.equal(chained.status, 1, 'the chain ends with the failure of its first command');
        assert.equal(chained.stdout, '', 'the second command must not run');

        // The control: the same two commands joined with ';' do run the second one, so the
        // assertion above is the && and not an accident of the shell.
        const loose = spawnSync('/bin/sh', ['-c', ['false', 'echo second'].join('; ')], { encoding: 'utf8' });
        assert.equal(loose.stdout, 'second\n');
    });

    test('a succeeding chain runs every command, in order', () => {
        const chained = spawnSync('/bin/sh', ['-c', customCommandLine(['echo one', 'echo two'])], { encoding: 'utf8' });
        assert.equal(chained.status, 0);
        assert.equal(chained.stdout, 'one\ntwo\n');
    });
});

describe('customCommandLines', () => {
    test('names only the custom entries, as "name: command line"', () => {
        assert.deepEqual(customCommandLines(plan), ['seed db: npm i && npm run seed']);
    });
});

describe('announceCustomCommands', () => {
    const logTo = (stderr) => createLogger({ stdout: fakeStream(), stderr, env: { NO_COLOR: '1' } });

    test('prints a header and one indented line per custom entry, on stderr', () => {
        const stderr = fakeStream();
        announceCustomCommands(plan, logTo(stderr));
        assert.match(stderr.text(), /custom commands from the preset:\n {2}seed db: npm i && npm run seed\n/);
    });

    test('says nothing for a plan without custom entries', () => {
        const stderr = fakeStream();
        announceCustomCommands(buildLaunchPlan({ configs: [{ name: 'web' }], preset: [{ name: 'web', mode: 'run' }] }), logTo(stderr));
        assert.equal(stderr.text(), '');
    });
});
```

**`test/resolve.test.js`:** додати `isCustomPlanEntry` до імпорту з `../src/resolve.js` і в кінець файлу дописати:

```js
describe('buildLaunchPlan — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a custom entry resolves without any run configuration', () => {
        const plan = buildLaunchPlan({ configs: [], preset: [seed] });
        assert.deepEqual(plan, [{ name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'], source: 'preset' }]);
        assert.equal(isCustomPlanEntry(plan[0]), true);
    });

    test('it keeps its place between run configurations', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }, seed, { name: 'api', mode: 'run' }],
        });
        assert.deepEqual(plan.map((entry) => entry.name), ['web', 'seed db', 'api']);
        assert.deepEqual(plan.map(isCustomPlanEntry), [false, true, false]);
    });

    test('a custom entry and a run configuration of the same name are two entries', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [{ name: 'web', mode: 'run' }, { ...seed, name: 'web' }],
        });
        assert.equal(plan.length, 2);
        assert.deepEqual(plan.map(isCustomPlanEntry), [false, true]);
    });

    test('a run configuration called like a key of the custom kind does not swallow it', () => {
        const plan = buildLaunchPlan({
            configs: [{ name: '["custom","seed db"]' }],
            preset: [{ name: '["custom","seed db"]', mode: 'run' }, seed],
        });
        assert.equal(plan.length, 2);
    });

    test('two custom entries of one name merge: first position, last commands', () => {
        const plan = buildLaunchPlan({
            configs: CONFIGS,
            preset: [seed, { name: 'web', mode: 'run' }, { ...seed, commands: ['echo later'] }],
        });
        assert.deepEqual(plan.map((entry) => entry.name), ['seed db', 'web']);
        assert.deepEqual(plan[0].commands, ['echo later']);
    });

    test('the command line cannot name a custom entry: it only resolves against the IDE', () => {
        assert.throws(
            () => buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests: [{ name: 'seed db', mode: 'run' }] }),
            UnknownConfigurationError,
        );
    });

    test('formatPlan shows it as an ordinary terminal entry of the preset', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed] });
        assert.equal(formatPlan(plan), 'seed db  terminal  (preset)');
    });
});
```

**`test/planBuilder.test.js`:** додати `guessedCommands` до імпорту з `../src/exec/planBuilder.js` і в кінець файлу дописати:

```js
describe('buildExecutionPlan — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const customPlan = (requests = []) => buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests });

    test('is one Terminal call: the commands joined with &&, in a tab named after the entry', () => {
        const [call] = buildExecutionPlan({ plan: customPlan() });

        assert.equal(call.tool, TERMINAL_TOOL);
        assert.equal(call.arguments.command, 'npm i && npm run seed');
        assert.equal(call.arguments.reuseExistingTerminalWindow, false);
        assert.equal(call.tabName, 'seed db');
        assert.equal(call.mode, 'terminal');
        assert.equal(call.commandSource, 'custom');
    });

    test('is a Terminal call under either target, with no inspector port and no note', () => {
        for (const target of EXEC_TARGETS) {
            const [call] = buildExecutionPlan({ plan: customPlan(), target });
            assert.equal(call.tool, TERMINAL_TOOL);
            assert.equal(call.debugPort, undefined);
            assert.equal(call.note, undefined);
        }
    });

    test('never asks commandFor: there is no .idea/ definition to look up', () => {
        const commandFor = () => assert.fail('a custom entry has no run configuration');
        assert.doesNotThrow(() => buildExecutionPlan({ plan: customPlan(), commandFor }));
    });

    test('does not shift the inspector ports of the :debug entries around it', () => {
        const calls = buildExecutionPlan({ plan: customPlan([{ name: 'web', mode: 'debug' }]) });
        assert.deepEqual(calls.map((call) => call.debugPort), [undefined, DEBUG_PORT_BASE]);
    });

    test('is not reported as a guessed command line', () => {
        assert.deepEqual(guessedCommands(buildExecutionPlan({ plan: customPlan() })), []);
    });
});

describe('needsTerminalCommands — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i'] };

    test('a plan of only custom entries needs no .idea/ read, whatever the target', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed] });
        assert.equal(needsTerminalCommands(plan, 'run-window'), false);
        assert.equal(needsTerminalCommands(plan, 'terminal'), false);
    });

    test('a :terminal configuration next to one still does', () => {
        const plan = buildLaunchPlan({ configs: CONFIGS, preset: [seed], requests: [{ name: 'web', mode: 'terminal' }] });
        assert.equal(needsTerminalCommands(plan, 'run-window'), true);
    });
});
```

**`test/terminalFallback.test.js`:** в кінець файлу дописати:

```js
describe('runTerminalFallback — custom command entries', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a custom entry becomes a tab titled after it, running the joined commands', async () => {
        const { code, opened } = await run({ presetEntries: [{ name: 'web', mode: 'run' }, seed] });

        assert.equal(code, 0);
        assert.deepEqual(opened[0].tabs.map((tab) => tab.name), ['web', 'seed db']);
        assert.equal(opened[0].tabs[1].command, 'npm i && npm run seed');
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/customCommands.test.js test/resolve.test.js test/planBuilder.test.js test/terminalFallback.test.js`
Expected: FAIL (модуль `customCommands.js` не існує; `isCustomPlanEntry` не експортовано; власні записи йдуть у `resolveName` і кидають `UnknownConfigurationError`).

- [ ] **Step 3: Implement `src/resolve.js`**

1. Замінити блок typedef на початку файлу (рядки з `PlanEntry`) на:

```js
/**
 * @typedef {{ name: string, description?: string, supportsDynamicLaunchOverrides?: boolean }} RunConfigInfo
 * @typedef {{ name: string, mode: import('./modes.js').LaunchMode }} RunRequest
 * @typedef {'preset' | 'cli'} PlanSource
 * @typedef {{ name: string, mode: import('./modes.js').LaunchMode, config: RunConfigInfo, source: PlanSource }} ConfigPlanEntry
 * @typedef {{ name: string, mode: 'terminal', commands: string[], source: PlanSource }} CustomPlanEntry
 * @typedef {ConfigPlanEntry | CustomPlanEntry} PlanEntry
 */
```

2. Перед `buildLaunchPlan` додати:

```js
/**
 * A plan entry that runs the commands its preset wrote down, not a run configuration.
 *
 * @param {PlanEntry} entry
 * @returns {entry is CustomPlanEntry}
 */
export function isCustomPlanEntry(entry) {
    return 'commands' in entry;
}

/**
 * The key an entry has in the plan's Map.
 *
 * JSON rather than a prefix: a run configuration may be called anything, `custom:x` included,
 * and a plain concatenation would let it swallow a custom entry of that name.
 *
 * @param {'config' | 'custom'} kind
 * @param {string} name
 * @returns {string}
 */
function planKey(kind, name) {
    return JSON.stringify([kind, name]);
}
```

3. Замінити `buildLaunchPlan` (JSDoc-параметр `preset` і тіло):

```js
 * @param {Array<RunRequest & { commands?: string[] }>} [args.preset] - entries of the active
 *   preset; one that carries `commands` is a custom entry and never touches `configs`
```

```js
export function buildLaunchPlan({ configs, preset = [], requests = [] }) {
    /** @type {Map<string, PlanEntry>} */
    const plan = new Map();

    for (const entry of preset) {
        if (entry.commands !== undefined) {
            // Nothing to resolve: the commands are the definition. Two of one name (from two
            // presets launched together) follow the rule below — first position, last wins.
            plan.set(planKey('custom', entry.name), {
                name: entry.name,
                mode: 'terminal',
                commands: entry.commands,
                source: 'preset',
            });
            continue;
        }

        const config = resolveName(entry.name, configs, { source: 'preset' });
        plan.set(planKey('config', config.name), { name: config.name, mode: entry.mode, config, source: 'preset' });
    }

    for (const request of requests) {
        const config = resolveName(request.name, configs, { source: 'cli' });
        // Overriding keeps the preset's position; a genuinely new entry lands at the end.
        plan.set(planKey('config', config.name), { name: config.name, mode: request.mode, config, source: 'cli' });
    }

    return [...plan.values()];
}
```

`formatPlan` не змінюється.

- [ ] **Step 4: Implement `src/exec/customCommands.js`** (новий)

```js
/**
 * Custom commands — the shell text a preset entry carries instead of a run configuration.
 *
 * Both launch paths (the IDE's Terminal tabs and the OS-terminal fallback) turn the same
 * list into the same command line and say the same thing about it before starting, so the
 * two live here once rather than being retyped on each side.
 */
import { isCustomPlanEntry } from '../resolve.js';

/** Between two commands: the second runs only if the first succeeded. */
const JOINER = ' && ';

/**
 * The one command line a custom entry stands for.
 *
 * Not quoted, on purpose: every item is shell text the user typed (a pipe, a redirect, an
 * env assignment), and quoting it would turn `npm run a | tee log` into one word. `&&` is
 * what makes the series stop at the first failure.
 *
 * @param {string[]} commands
 * @returns {string}
 */
export function customCommandLine(commands) {
    return commands.join(JOINER);
}

/**
 * @param {import('../resolve.js').PlanEntry[]} plan
 * @returns {string[]} `name: command line`, one per custom entry, in plan order
 */
export function customCommandLines(plan) {
    return plan.filter(isCustomPlanEntry).map((entry) => `${entry.name}: ${customCommandLine(entry.commands)}`);
}

/**
 * Say what is about to run, before it does.
 *
 * `webstorm-commands.json` lives in `.idea/` and is usually committed, so a cloned project
 * can put shell text in front of `wsc`. Running it silently would be the surprise; printing
 * the exact line, every time and not only under --dry-run, is the whole mitigation.
 *
 * @param {import('../resolve.js').PlanEntry[]} plan
 * @param {ReturnType<typeof import('../log.js').createLogger>} log
 */
export function announceCustomCommands(plan, log) {
    const lines = customCommandLines(plan);
    if (lines.length === 0) return;

    log.info('custom commands from the preset:');
    for (const line of lines) log.info(`  ${line}`);
}
```

- [ ] **Step 5: Implement `src/exec/planBuilder.js`**

1. Імпорти вгорі (після існуючого імпорту з `../mcp/execute.js`):

```js
import { isCustomPlanEntry } from '../resolve.js';
import { customCommandLine } from './customCommands.js';
```

2. У typedef-блоці: додати рядок `@typedef {import('../resolve.js').ConfigPlanEntry} ConfigPlanEntry` після `PlanEntry`; замінити `@typedef {'idea' | 'name'} CommandSource` на `@typedef {'idea' | 'name' | 'custom'} CommandSource`, доповнивши коментар над ним рядком `'custom' — a preset entry's own commands, joined; nothing was looked up.`; у `CommandFor` замінити `(entry: PlanEntry, opts:` на `(entry: ConfigPlanEntry, opts:`.

3. Замінити `needsTerminalCommands`:

```js
export function needsTerminalCommands(plan, target, opts = {}) {
    // A custom entry carries its own command line: there is nothing in `.idea/` to read for it.
    return plan.some((entry) => !isCustomPlanEntry(entry) && usesTerminal(entry, target, opts));
}
```

4. У `buildExecutionPlan` на початок колбека `plan.map((entry) => {` додати (перед `const viaTerminal`):

```js
        if (isCustomPlanEntry(entry)) {
            // Always a Terminal tab, whatever the target: the entry asked for a command line.
            // No commandFor (nothing to look up), no inspector port (nothing is debugged), no
            // note (nothing was rerouted), and a tab named after the entry like every other.
            /** @type {McpCall} */
            const custom = {
                name: entry.name,
                mode: entry.mode,
                ...terminalCommandCall(customCommandLine(entry.commands)),
                commandSource: 'custom',
                tabName: entry.name,
            };
            return custom;
        }

```

- [ ] **Step 6: Implement `src/fallback/terminalFallback.js`**

1. Імпорт: `import { customCommandLine } from '../exec/customCommands.js';` (перед імпортом `../exec/inspectorPorts.js`) та змінити `import { buildLaunchPlan, formatPlan } from '../resolve.js';` на `import { buildLaunchPlan, formatPlan, isCustomPlanEntry } from '../resolve.js';`.

2. У `buildTabs` на початок колбека `plan.map((entry) => {` додати:

```js
        // The preset's own shell text: there is no run configuration to rebuild a command
        // from, and no inspector port to hand out.
        if (isCustomPlanEntry(entry)) {
            return { name: entry.name, mode: entry.mode, command: customCommandLine(entry.commands) };
        }

```

- [ ] **Step 7: Run to verify everything passes**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS (805 + нові); typecheck без помилок. Якщо `tsc` скаржиться на `entry.config` у `src/`, це місце, де `PlanEntry` не звужено `isCustomPlanEntry` — додати звуження, не приведення типу.

- [ ] **Step 8: Commit**

```bash
git add src/resolve.js src/exec/customCommands.js src/exec/planBuilder.js src/fallback/terminalFallback.js \
  test/customCommands.test.js test/resolve.test.js test/planBuilder.test.js test/terminalFallback.test.js
git commit -m "feat(plan): custom entries resolve to a named Terminal tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Запуск наскрізь — оголошення команд і no-IDE без каталогу

**Files:**
- Modify: `src/cli.js` (імпорт і один виклик)
- Modify: `src/fallback/terminalFallback.js` (правило каталогу, оголошення)
- Test: `test/cli.integration.test.js`, `test/terminalFallback.test.js`

**Interfaces:**
- Consumes (Task 2): `announceCustomCommands(plan, log)`, `isCustomPlanEntry`; (Task 1): `isCustomEntry`.
- Produces: користувацька поведінка з розділів 4–5 spec — рядки команд у stderr перед запуском; пресет лише з власних команд працює в no-IDE шляху без збережених run-конфігурацій.

- [ ] **Step 1: Write the failing tests**

**`test/cli.integration.test.js`** — в кінець файлу:

```js
// ── custom commands in a preset ──────────────────────────────────────────────
describe('custom commands in a preset', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const config = withPresets({ default: [seed] });

    test('--dry-run shows the joined command line and never reads .idea/', async () => {
        const result = await wsc(['--dry-run'], {
            config,
            deps: { readIdeaRunConfigs: async () => assert.fail('a custom entry has nothing in .idea/') },
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.executed, [], '--dry-run launches nothing');
        assert.match(result.stdout, /^seed db {2}terminal {2}\(preset\)$/m);
        assert.match(result.stdout, /^→ execute_terminal_command {2}npm i && npm run seed$/m);
    });

    test('a real launch hands the runner one Terminal call, titled after the entry', async () => {
        const result = await wsc([], { config });

        assert.equal(result.code, 0);
        const [call] = result.contexts[0].calls;
        assert.equal(call.tool, 'execute_terminal_command');
        assert.equal(call.tabName, 'seed db');
        assert.equal(call.arguments.command, 'npm i && npm run seed');
    });

    test('the command line is announced on stderr, ahead of the launch', async () => {
        const result = await wsc(['--dry-run'], { config });
        assert.match(result.stderr, /custom commands from the preset:\n {2}seed db: npm i && npm run seed\n/);
    });

    test('next to a run configuration the header says so, and each entry gets its own tool', async () => {
        const result = await wsc([], { config: withPresets({ default: [{ name: 'shared' }, seed] }) });

        assert.equal(result.code, 0);
        assert.match(result.stderr, /via run-window \+ terminal:$/m);
        assert.deepEqual(
            result.contexts[0].calls.map((call) => call.tool),
            ['execute_run_configuration', 'execute_terminal_command'],
        );
    });

    test('--target does not change where it goes', async () => {
        for (const target of ['run-window', 'terminal']) {
            const result = await wsc(['--dry-run', `--target=${target}`], { config });
            assert.match(result.stdout, /^→ execute_terminal_command {2}npm i && npm run seed$/m);
        }
    });

    test('a malformed commands list stops the run with a message naming the file', async () => {
        const result = await wsc([], { config: withPresets({ default: [{ name: 'x', commands: [] }] }) });

        assert.equal(result.code, 1);
        assert.deepEqual(result.executed, []);
        assert.match(result.output, /webstorm-commands\.json/);
        assert.match(result.output, /"commands" must be a non-empty list/);
    });

    test('the no-IDE hand-over carries the entry with its commands', async () => {
        const result = await wsc([], { config, deps: { port: null, fallbackChoice: { kind: 'terminal' } } });

        assert.equal(result.code, 0);
        assert.deepEqual(result.fellBack[0].presetEntries, [seed]);
    });
});
```

**`test/terminalFallback.test.js`** — у describe `runTerminalFallback — custom command entries` (доданий у Task 2) дописати тести:

```js
    test('a preset of only custom commands needs no run configuration saved at all', async () => {
        const { code, opened } = await run({ configs: [], presetEntries: [seed] });

        assert.equal(code, 0);
        assert.deepEqual(opened[0].tabs, [{ name: 'seed db', mode: 'terminal', command: 'npm i && npm run seed' }]);
    });

    test('naming a run configuration still needs the catalogue, custom entries or not', async () => {
        await assert.rejects(
            () => run({ configs: [], presetEntries: [seed], positionals: ['web'] }),
            (err) => err.name === 'FallbackError' && /saved no run configurations/.test(err.message),
        );
    });

    test('a preset with a run configuration in it still needs the catalogue', async () => {
        await assert.rejects(
            () => run({ configs: [], presetEntries: [seed, { name: 'web', mode: 'run' }] }),
            (err) => err.name === 'FallbackError' && /saved no run configurations/.test(err.message),
        );
    });

    test('the commands are announced before the tabs open', async () => {
        const { err } = await run({ presetEntries: [seed] });
        assert.match(err, /custom commands from the preset:\n {2}seed db: npm i && npm run seed\n/);
    });

    test('--dry-run prints the command and opens nothing', async () => {
        const { code, opened, out } = await run({ presetEntries: [seed], dryRun: true });

        assert.equal(code, 0);
        assert.equal(opened.length, 0);
        assert.match(out, /^→ seed db {2}npm i && npm run seed$/m);
    });

    test('with no terminal emulator the single-window pool gets the same tab', async () => {
        const { pooled } = await run({ presetEntries: [seed], terminal: false });
        assert.equal(pooled[0][0].command, 'npm i && npm run seed');
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/cli.integration.test.js test/terminalFallback.test.js`
Expected: FAIL — немає рядка `custom commands from the preset:` у stderr; тест `configs: []` падає з "saved no run configurations".

- [ ] **Step 3: Implement `src/cli.js`**

Додати імпорт перед `import { guessedCommandNote, ideaCommandResolver } from './exec/ideaCommands.js';`:

```js
import { announceCustomCommands } from './exec/customCommands.js';
```

У `run()`, одразу після рядка `log.out(formatPlan(plan));` (перед `const notes = executionNotes(calls);`) додати:

```js
        // Ahead of every note and of the launch itself: the preset file is usually committed,
        // so what it is about to run should be visible, not merely obeyed.
        announceCustomCommands(plan, log);
```

- [ ] **Step 4: Implement `src/fallback/terminalFallback.js`**

1. Імпорти: додати `announceCustomCommands` до імпорту з `../exec/customCommands.js` (`import { announceCustomCommands, customCommandLine } from '../exec/customCommands.js';`) і новий рядок `import { isCustomEntry } from '../presets/store.js';` (після імпорту `../exec/planBuilder.js`).

2. У `runTerminalFallback` замінити блок `if (configs.length === 0) { throw ... }`:

```js
    // Only a launch that names run configurations needs the catalogue. A preset of nothing
    // but custom commands has no use for it, so a project WebStorm saved nothing for can
    // still run one — which is the whole point of a command that is not a run configuration.
    const needsCatalogue = ctx.positionals.length > 0 || ctx.presetEntries.some((entry) => !isCustomEntry(entry));
    if (configs.length === 0 && needsCatalogue) {
        throw new FallbackError(
            `WebStorm has saved no run configurations for this project (looked in ${DISK_SOURCE}).\n` +
                '  Without the MCP Server that file is the only list wsc has, so there is nothing\n' +
                '  it can launch. Start the MCP Server and re-run.',
        );
    }
```

3. Одразу після `log.out(formatPlan(plan));` додати `announceCustomCommands(plan, log);` (перед `for (const note of debugNotes(tabs)) log.warn(note);`).

- [ ] **Step 5: Run to verify everything passes**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS; typecheck чистий. Наявний `cli.test.js` "the real seam refuses loudly when the IDE has saved nothing to disk" лишається зеленим (там є позиційний `web`).

- [ ] **Step 6: Commit**

```bash
git add src/cli.js src/fallback/terminalFallback.js test/cli.integration.test.js test/terminalFallback.test.js
git commit -m "feat(launch): announce custom commands; no-IDE path needs no catalogue for them

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Чиста логіка `--configure` — вибір, збереження, diff, валідація

**Files:**
- Modify: `src/ui/configureLogic.js`
- Test: `test/configureLogic.test.js`

**Interfaces:**
- Consumes (Task 1): `isCustomEntry`; (Task 2): `customCommandLine`.
- Produces:
  - `customChoiceValue(name: string): string` — значення пункту чекбокса для власного запису (`'\u0000custom\u0000' + name`, щоб не збігатися з іменем IDE-конфігурації)
  - `buildInitialSelection(runConfigs, preset)` — тепер додає власні записи в кінець `choices` (checked) і не рахує їх у `stale`
  - `pendingModeQuestions(selection, preset)` — ігнорує пункти власних записів
  - `applyAnswersToPreset(selection, modes, preset, added = [])` — `added: PresetEntry[]` (нові власні) додаються в кінець
  - `diffPreset(before, after)` — розрізняє власний запис і конфігурацію з тим самим іменем
  - `validateCustomName(name: string, opts?: { taken?: string[], ideNames?: string[] }): string | null`

- [ ] **Step 1: Write the failing tests**

У `test/configureLogic.test.js` розширити імпорт:

```js
import {
    DEFAULT_MODE,
    applyAnswersToPreset,
    buildInitialSelection,
    customChoiceValue,
    diffPreset,
    pendingModeQuestions,
    validateCustomName,
} from '../src/ui/configureLogic.js';
```

і дописати в кінець файлу:

```js
describe('custom command entries — the checkbox and what it saves', () => {
    const custom = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };

    test('a saved custom entry is offered checked, after the IDE list, labelled with its commands', () => {
        const { choices } = buildInitialSelection(CONFIGS, [custom]);

        assert.equal(choices.length, 14);
        assert.deepEqual(choices[13], {
            name: '⌘ seed db — npm i && npm run seed',
            value: customChoiceValue('seed db'),
            checked: true,
            mode: 'terminal',
        });
    });

    test('it is not reported as stale: it refers to nothing in the IDE', () => {
        assert.deepEqual(buildInitialSelection(CONFIGS, [custom]).stale, []);
    });

    test('a custom entry called like an IDE configuration does not check that configuration', () => {
        const { choices } = buildInitialSelection(CONFIGS, [{ ...custom, name: 'web' }]);
        assert.equal(choices.find((c) => c.value === 'web').checked, false);
    });

    test('pendingModeQuestions never asks about a custom choice, nor mistakes its name for a known configuration', () => {
        const preset = [{ ...custom, name: 'web' }];
        assert.deepEqual(pendingModeQuestions([customChoiceValue('web'), 'web'], preset), ['web']);
    });

    test('a checked custom entry keeps its place and its commands', () => {
        const preset = [{ name: 'web', mode: 'run' }, custom, { name: 'api', mode: 'run' }];
        const after = applyAnswersToPreset(['web', customChoiceValue('seed db'), 'api'], {}, preset);
        assert.deepEqual(after, preset);
    });

    test('unchecking it removes it', () => {
        const preset = [{ name: 'web', mode: 'run' }, custom];
        assert.deepEqual(applyAnswersToPreset(['web'], {}, preset), [{ name: 'web', mode: 'run' }]);
    });

    test('new custom entries are appended after the configurations, in the order given', () => {
        const added = [
            { name: 'a', mode: 'terminal', commands: ['echo a'] },
            { name: 'b', mode: 'terminal', commands: ['echo b'] },
        ];
        const after = applyAnswersToPreset(['web'], { web: 'run' }, [], added);
        assert.deepEqual(after.map((entry) => entry.name), ['web', 'a', 'b']);
    });

    test('diffPreset names a custom entry, and tells it from a configuration of the same name', () => {
        const before = [{ name: 'web', mode: 'run' }];
        const after = [{ name: 'web', mode: 'run' }, { name: 'web', mode: 'terminal', commands: ['x'] }];
        const diff = diffPreset(before, after);

        assert.deepEqual(diff.added, ['web']);
        assert.deepEqual(diff.removed, []);
        assert.equal(diff.unchanged, false);
    });

    test('diffPreset of an untouched custom entry is unchanged', () => {
        assert.equal(diffPreset([custom], [{ ...custom }]).unchanged, true);
    });
});

describe('validateCustomName', () => {
    const opts = { taken: ['seed db'], ideNames: ['web', 'api'] };

    test('accepts a fresh name', () => {
        assert.equal(validateCustomName('lint all', opts), null);
    });

    test('refuses an empty or blank name', () => {
        assert.equal(validateCustomName('', opts), 'a name is required');
        assert.equal(validateCustomName('   ', opts), 'a name is required');
    });

    test('refuses a name a custom entry of the preset already has', () => {
        assert.equal(validateCustomName('seed db', opts), '"seed db" is already a custom command in this preset');
    });

    test('refuses the name of a run configuration', () => {
        assert.equal(
            validateCustomName('web', opts),
            '"web" is the name of a run configuration; pick a different name',
        );
    });

    test('a prototype member is an ordinary name', () => {
        assert.equal(validateCustomName('constructor', opts), null);
        assert.equal(validateCustomName('__proto__', opts), null);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/configureLogic.test.js`
Expected: FAIL (`customChoiceValue`/`validateCustomName` не експортовано).

- [ ] **Step 3: Implement `src/ui/configureLogic.js`**

1. Імпорти вгорі (після `import { DEFAULT_MODE } from '../modes.js';`):

```js
import { customCommandLine } from '../exec/customCommands.js';
import { isCustomEntry } from '../presets/store.js';
```

2. Після рядка `export { DEFAULT_MODE };` додати:

```js
/**
 * A custom entry's value in the checkbox.
 *
 * Distinct from any configuration name — those are the raw names the IDE reported — so a
 * custom entry and a run configuration of the same name (a hand-edited file can have both)
 * are two different choices and cannot answer for one another.
 *
 * @param {string} name
 * @returns {string}
 */
export function customChoiceValue(name) {
    return `${CUSTOM_PREFIX}${name}`;
}

const CUSTOM_PREFIX = '\u0000custom\u0000';

/** @param {string} value */
const isCustomChoiceValue = (value) => value.startsWith(CUSTOM_PREFIX);

/**
 * Identity of an entry across two versions of a preset. Kind first, so a custom entry and a
 * configuration of one name are not the same entry.
 *
 * @param {PresetEntry} entry
 */
const entryKey = (entry) => JSON.stringify([isCustomEntry(entry) ? 'custom' : 'config', entry.name]);
```

3. Замінити `buildInitialSelection`:

```js
export function buildInitialSelection(runConfigs, preset = []) {
    // Custom entries refer to nothing in the IDE, so they take no part in the by-name
    // matching: a hand-edited custom "web" must not tick the run configuration "web".
    const references = preset.filter((entry) => !isCustomEntry(entry));
    const modes = new Map(references.map((entry) => [entry.name, entry.mode]));

    const ideChoices = runConfigs.map((config) => ({
        name: config.description ? `${config.name}  (${config.description})` : config.name,
        value: config.name,
        checked: modes.has(config.name),
        mode: modes.get(config.name) ?? null,
    }));

    const known = new Set(runConfigs.map((config) => config.name));
    const stale = references.filter((entry) => !known.has(entry.name));

    // After the IDE's list, in the order the preset has them; always checked, because
    // unchecking is how one is deleted.
    const customChoices = preset.filter(isCustomEntry).map((entry) => ({
        name: `⌘ ${entry.name} — ${customCommandLine(entry.commands)}`,
        value: customChoiceValue(entry.name),
        checked: true,
        mode: entry.mode,
    }));

    return { choices: [...ideChoices, ...customChoices], stale };
}
```

4. Замінити `pendingModeQuestions`:

```js
export function pendingModeQuestions(selection, preset = []) {
    const known = new Set(preset.filter((entry) => !isCustomEntry(entry)).map((entry) => entry.name));
    return selection.filter((value) => !isCustomChoiceValue(value) && !known.has(value));
}
```

5. Замінити `applyAnswersToPreset` (JSDoc — додати `@param {PresetEntry[]} [added] - custom entries created on this screen`):

```js
export function applyAnswersToPreset(selection, modes = {}, preset = [], added = []) {
    const selectedNames = new Set(selection.filter((value) => !isCustomChoiceValue(value)));
    const keptCustom = new Set(selection.filter(isCustomChoiceValue));

    const kept = preset
        .filter((entry) =>
            isCustomEntry(entry) ? keptCustom.has(customChoiceValue(entry.name)) : selectedNames.has(entry.name))
        .map((entry) =>
            isCustomEntry(entry) ? entry : { ...entry, mode: answered(modes, entry.name) ?? entry.mode });

    const keptNames = new Set(kept.filter((entry) => !isCustomEntry(entry)).map((entry) => entry.name));
    const appended = selection
        .filter((value) => !isCustomChoiceValue(value) && !keptNames.has(value))
        .map((name) => ({ name, mode: answered(modes, name) ?? DEFAULT_MODE }));

    return [...kept, ...appended, ...added];
}
```

6. Замінити `diffPreset`:

```js
export function diffPreset(before, after) {
    const beforeModes = new Map(before.map((entry) => [entryKey(entry), entry.mode]));
    const afterModes = new Map(after.map((entry) => [entryKey(entry), entry.mode]));

    const added = after.filter((entry) => !beforeModes.has(entryKey(entry))).map((entry) => entry.name);
    const removed = before.filter((entry) => !afterModes.has(entryKey(entry))).map((entry) => entry.name);
    const changed = after
        .filter((entry) => beforeModes.has(entryKey(entry)) && beforeModes.get(entryKey(entry)) !== entry.mode)
        .map((entry) => `${entry.name} → ${entry.mode}`);

    return {
        added,
        removed,
        changed,
        unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
    };
}
```

7. В кінець файлу:

```js
/**
 * Why a name cannot be used for a new custom command, or `null` when it can.
 *
 * `taken` is every custom name the preset had when the screen opened, plus what was added
 * since — including one just unchecked: re-adding it in the same run would look, to the
 * diff, like nothing changed and the new commands would never be saved.
 *
 * @param {string} name - already trimmed
 * @param {{ taken?: string[], ideNames?: string[] }} [opts]
 * @returns {string | null}
 */
export function validateCustomName(name, { taken = [], ideNames = [] } = {}) {
    if (name.trim() === '') return 'a name is required';
    if (taken.includes(name)) return `"${name}" is already a custom command in this preset`;
    if (ideNames.includes(name)) return `"${name}" is the name of a run configuration; pick a different name`;
    return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS (включно з наявними `configureLogic.test.js`); typecheck чистий.

- [ ] **Step 5: Commit**

```bash
git add src/ui/configureLogic.js test/configureLogic.test.js
git commit -m "feat(configure): selection, saving and validation logic for custom commands

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Екран `--configure` — цикл додавання

**Files:**
- Modify: `src/ui/configure.js`
- Test: `test/configure.test.js`

**Interfaces:**
- Consumes (Task 4): `customChoiceValue`, `validateCustomName`, `applyAnswersToPreset(selection, modes, preset, added)`; (Task 1): `isCustomEntry`.
- Produces: `Prompts` тепер `{ checkbox, select, confirm, input }`; `runConfigure` повертає 0/1/130 як раніше.

- [ ] **Step 1: Update the test helper and the tests it breaks**

У `test/configure.test.js`:

1. Розширити імпорт з `../src/ui/configure.js`-сусідів: додати `import { customChoiceValue } from '../src/ui/configureLogic.js';`.

2. Замінити хелпер `configure(opts)` (JSDoc — додати `@param {boolean[]} [opts.confirms]`, `@param {string[]} [opts.inputs]`, `@param {object[]} [opts.configs]`, `@param {Error} [opts.throwsOnConfirm]`):

```js
async function configure(opts) {
    const stdout = fakeStream(opts.tty ?? true);
    const stderr = fakeStream(opts.tty ?? true);
    const stdin = { isTTY: opts.tty ?? true };
    const asked = [];
    // The custom-command prompts are recorded apart from `asked`, so the many tests that
    // read `asked` as "the checkbox, then one select per new entry" keep meaning that.
    const customAsked = [];
    const rejected = [];
    const remaining = [...(opts.modes ?? [])];
    const confirms = [...(opts.confirms ?? [])];
    const inputs = [...(opts.inputs ?? [])];

    const prompts = {
        checkbox: async (config) => {
            asked.push({ type: 'checkbox', choices: config.choices, message: config.message });
            if (opts.throws) throw opts.throws;
            return opts.checked ?? [];
        },
        select: async (config) => {
            asked.push({ type: 'select', message: config.message, choices: config.choices, default: config.default });
            if (opts.throws) throw opts.throws;
            if (opts.throwsOnSelect) throw opts.throwsOnSelect;
            return remaining.shift() ?? 'run';
        },
        confirm: async (config) => {
            customAsked.push(config.message);
            if (opts.throwsOnConfirm) throw opts.throwsOnConfirm;
            return confirms.shift() ?? false;
        },
        // Like the real prompt: a validate() that answers with a string rejects the line and
        // asks again, so a scripted refusal is followed by the next scripted answer.
        input: async (config) => {
            for (;;) {
                const answer = inputs.shift();
                assert.notEqual(answer, undefined, `no scripted answer left for "${config.message}"`);
                customAsked.push(config.message);
                const verdict = config.validate ? config.validate(answer) : true;
                if (verdict === true) return answer;
                rejected.push(verdict);
            }
        },
    };

    const code = await runConfigure({
        configs: opts.configs ?? CONFIGS,
        config: opts.config ?? emptyConfig(),
        presetName: 'default',
        projectRoot: opts.dir,
        log: createLogger({ stdout, stderr, env: { NO_COLOR: '1' } }),
        prompts,
        stdin: /** @type {any} */ (stdin),
        stdout: /** @type {any} */ (stdout),
    });

    return { code, asked, customAsked, rejected, output: stdout.text() + stderr.text() };
}
```

3. У двох інлайн-викликах `runConfigure`, що доходять до циклу додавання — тести `'the mode answered for "__proto__" is actually saved'` і `'a preset named "constructor" is read as its own entry, not a function'` — додати в літерал `prompts` поля `confirm: async () => false, input: async () => assert.fail('no custom command was asked for'),`. В інших інлайн-викликах нічого не міняти: `'Ctrl-C during the mode question also saves nothing'` кидає ще на `select`, а `'an empty IDE list still reports stale preset entries'` виходить з кодом 1 до будь-якого промпта.

4. Знайти тест `'exits 1 when the IDE reports no configurations at all'` (останній у файлі, після `'an empty IDE list still reports stale preset entries'`) і **видалити** його: порожній каталог без stale-записів тепер не помилка, і це перевіряє новий тест `'an IDE with no run configurations skips the checkbox…'` нижче. Тест із stale-записом лишається без змін.

- [ ] **Step 2: Write the failing tests**

Дописати в кінець `test/configure.test.js`:

```js
describe('runConfigure — custom commands', () => {
    const seed = { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] };
    const withSeed = () => ({ ...emptyConfig(), presets: { default: [seed] } });

    test('asks whether to add one, and declining changes nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, customAsked, output } = await configure({ dir });
            assert.equal(code, 0);
            assert.deepEqual(customAsked, ['Add a custom command?']);
            assert.match(output, /unchanged/);
        } finally {
            await cleanup();
        }
    });

    test('saves a named command list after the configurations', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, customAsked, output } = await configure({
                dir,
                checked: ['web'],
                modes: ['run'],
                confirms: [true],
                inputs: ['seed db', 'npm i', 'npm run seed', ''],
            });

            assert.equal(code, 0);
            assert.deepEqual(customAsked, [
                'Add a custom command?',
                'Name (it titles the terminal tab)',
                'Command',
                'Command 2 (empty to finish)',
                'Command 3 (empty to finish)',
                'Add another custom command?',
            ]);
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'web', mode: 'run' },
                { name: 'seed db', mode: 'terminal', commands: ['npm i', 'npm run seed'] },
            ]);
            assert.match(output, /\+ seed db/);
        } finally {
            await cleanup();
        }
    });

    test('can add several in one run', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({
                dir,
                confirms: [true, true],
                inputs: ['a', 'echo a', '', 'b', 'echo b', ''],
            });
            const saved = (await readPresets(dir)).presets.default;
            assert.deepEqual(saved.map((entry) => entry.name), ['a', 'b']);
        } finally {
            await cleanup();
        }
    });

    test('an empty name and the name of a run configuration are refused and asked again', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                confirms: [true],
                inputs: ['', 'web', 'seed db', 'npm i', ''],
            });

            assert.deepEqual(rejected, [
                'a name is required',
                '"web" is the name of a run configuration; pick a different name',
            ]);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });

    test('the first command is required; later ones end the list when left empty', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({ dir, confirms: [true], inputs: ['seed', '', 'npm i', ''] });
            assert.deepEqual(rejected, ['the first command is required']);
            assert.deepEqual((await readPresets(dir)).presets.default[0].commands, ['npm i']);
        } finally {
            await cleanup();
        }
    });

    test('surrounding spaces are trimmed from the name and from each command', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            await configure({ dir, confirms: [true], inputs: ['  seed db ', '  npm i  ', ''] });
            assert.deepEqual((await readPresets(dir)).presets.default, [
                { name: 'seed db', mode: 'terminal', commands: ['npm i'] },
            ]);
        } finally {
            await cleanup();
        }
    });

    test('a saved custom entry comes back checked in the same list', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { asked, output } = await configure({
                dir,
                config: withSeed(),
                checked: [customChoiceValue('seed db')],
            });

            const custom = asked[0].choices.filter((c) => c.checked);
            assert.deepEqual(custom.map((c) => c.name), ['⌘ seed db — npm i && npm run seed']);
            assert.match(output, /unchanged/, 'an untouched custom entry is not rewritten');
        } finally {
            await cleanup();
        }
    });

    test('unchecking it removes it, and is reported', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { output } = await configure({ dir, config: withSeed(), checked: [] });

            assert.deepEqual((await readPresets(dir)).presets.default, []);
            assert.match(output, /- seed db/);
        } finally {
            await cleanup();
        }
    });

    test('a name the preset already has is refused, even when it was just unchecked', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { rejected } = await configure({
                dir,
                config: withSeed(),
                checked: [],
                confirms: [true],
                inputs: ['seed db', 'other', 'echo hi', ''],
            });

            assert.deepEqual(rejected, ['"seed db" is already a custom command in this preset']);
            assert.deepEqual((await readPresets(dir)).presets.default.map((entry) => entry.name), ['other']);
        } finally {
            await cleanup();
        }
    });

    test('Ctrl-C while answering cancels and saves nothing', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const err = new Error('User force closed the prompt');
            err.name = 'ExitPromptError';

            const { code, output } = await configure({ dir, checked: ['web'], modes: ['run'], throwsOnConfirm: err });

            assert.equal(code, 130);
            assert.match(output, /cancelled; nothing was saved/);
            assert.deepEqual((await readPresets(dir)).presets, {});
        } finally {
            await cleanup();
        }
    });

    test('an IDE with no run configurations skips the checkbox and still offers custom commands', async () => {
        const { dir, cleanup } = await tmpProject();
        try {
            const { code, asked, output } = await configure({
                dir,
                configs: [],
                confirms: [true],
                inputs: ['seed db', 'npm i', ''],
            });

            assert.equal(code, 0);
            assert.equal(asked.filter((a) => a.type === 'checkbox').length, 0);
            assert.match(output, /no run configurations/);
            assert.equal((await readPresets(dir)).presets.default[0].name, 'seed db');
        } finally {
            await cleanup();
        }
    });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/configure.test.js`
Expected: FAIL — `prompts.confirm` не викликається (тести на `customAsked` падають), тест порожнього IDE отримує код 1.

- [ ] **Step 4: Implement `src/ui/configure.js`**

1. Імпорти:

```js
import { checkbox, confirm, input, select } from '@inquirer/prompts';

import { DEFAULT_MODE, MODES } from '../modes.js';
import { hasPreset, isCustomEntry, setPreset, writePresets } from '../presets/store.js';
import {
    applyAnswersToPreset,
    buildInitialSelection,
    diffPreset,
    pendingModeQuestions,
    validateCustomName,
} from './configureLogic.js';
import { CANCELLED_EXIT_CODE, isCancelled } from './promptCancel.js';
```

2. Typedef `Prompts` замінити на:

```js
 * @typedef {{
 *   checkbox: (config: any) => Promise<string[]>,
 *   select: (config: any) => Promise<import('../modes.js').LaunchMode>,
 *   confirm: (config: any) => Promise<boolean>,
 *   input: (config: any) => Promise<string>,
 * }} Prompts
```

3. У `runConfigure`: `const prompts = opts.prompts ?? { checkbox, select, confirm, input };`

4. Замінити фрагмент від `if (choices.length === 0) {` до кінця обчислення `after` (два `try/catch` об'єднуються в один) на:

```js
    // An IDE that reports nothing cannot vouch for the entries the preset already names, and
    // rewriting the preset from an empty list would drop them all. Refusing is the old
    // behaviour, kept for exactly that case — a preset with nothing to lose is different.
    if (configs.length === 0 && stale.length > 0) {
        log.error('the IDE reported no run configurations, so the preset\'s entries cannot be checked; nothing was changed');
        return 1;
    }
    if (configs.length === 0) {
        log.warn('the IDE reported no run configurations — custom commands can still be added');
    }

    /** @type {string[]} */
    let selection = [];
    // Null prototype: a configuration named "__proto__" would otherwise hit the
    // prototype setter here and lose its answer silently.
    /** @type {Record<string, import('../modes.js').LaunchMode>} */
    const modes = Object.create(null);
    /** @type {import('../presets/store.js').PresetEntry[]} */
    let added = [];

    try {
        if (choices.length > 0) {
            selection = await prompts.checkbox({
                message: `Configurations to launch by default (preset "${presetName}")`,
                choices,
                pageSize: PAGE_SIZE,
                loop: false,
            });
        }

        for (const name of pendingModeQuestions(selection, before)) {
            modes[name] = await prompts.select({
                message: `Mode for "${name}"`,
                // Built from MODES so a mode added there cannot be missing from this screen.
                choices: MODES.map((mode) => ({ name: mode, value: mode })),
                default: DEFAULT_MODE,
            });
        }

        added = await askCustomCommands({
            prompts,
            // Every custom name the preset had, unchecked or not: see validateCustomName().
            taken: before.filter(isCustomEntry).map((entry) => entry.name),
            ideNames: configs.map((config) => config.name),
        });
    } catch (err) {
        // Ctrl-C inside a prompt is an ordinary way to back out, not a crash.
        if (isCancelled(err)) {
            log.info('cancelled; nothing was saved');
            return CANCELLED_EXIT_CODE;
        }
        throw err;
    }

    const after = applyAnswersToPreset(selection, modes, before, added);
```

(Наступні рядки — `const diff = diffPreset(before, after);` і далі — без змін.)

5. Після `runConfigure` додати:

```js
/**
 * The "add a custom command" loop: a name, then commands one line at a time.
 *
 * The prompts' own `validate` does the refusing, so a bad name is explained and asked
 * again in place instead of aborting the screen.
 *
 * @param {object} opts
 * @param {Prompts} opts.prompts
 * @param {string[]} opts.taken - custom names the preset already has
 * @param {string[]} opts.ideNames - names of the IDE's run configurations
 * @returns {Promise<import('../presets/store.js').PresetEntry[]>}
 */
async function askCustomCommands({ prompts, taken, ideNames }) {
    /** @type {import('../presets/store.js').PresetEntry[]} */
    const added = [];
    let message = 'Add a custom command?';

    while (await prompts.confirm({ message, default: false })) {
        const name = (
            await prompts.input({
                message: 'Name (it titles the terminal tab)',
                validate: (/** @type {string} */ value) =>
                    validateCustomName(value.trim(), { taken: [...taken, ...added.map((entry) => entry.name)], ideNames }) ?? true,
            })
        ).trim();

        /** @type {string[]} */
        const commands = [];
        for (;;) {
            const line = (
                await prompts.input({
                    message: commands.length === 0 ? 'Command' : `Command ${commands.length + 1} (empty to finish)`,
                    validate: (/** @type {string} */ value) =>
                        commands.length === 0 && value.trim() === '' ? 'the first command is required' : true,
                })
            ).trim();
            if (line === '') break;
            commands.push(line);
        }

        added.push({ name, mode: 'terminal', commands });
        message = 'Add another custom command?';
    }

    return added;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS; typecheck чистий. Тест "an empty IDE list still reports stale preset entries" лишається зеленим без змін (stale + порожній список → код 1 до будь-якого промпта).

- [ ] **Step 6: Manual pty check (not part of `npm test`)**

Потрібен запущений WebStorm з відкритим проєктом. У каталозі проєкту:

```bash
script -qec 'node <repo>/bin/wsc.js --configure' /dev/null
```

Пройти: відмітити нічого → `Add a custom command?` → `y` → назва `hello` → команди `echo one`, `echo two`, порожній рядок → `n`. Очікується: `saved preset "default"` і `+ hello`. Перевірити `.idea/webstorm-commands.json`: запис `{ "name": "hello", "mode": "terminal", "commands": ["echo one", "echo two"] }`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/configure.js test/configure.test.js
git commit -m "feat(configure): add custom commands from the --configure screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Документація і фінальна перевірка

**Files:**
- Modify: `README.md` (новий розділ після `## A Terminal tab for one entry (\`:terminal\`)`)
- Modify: `CLAUDE.md` (абзац "Currently implemented" і bullet в Architecture)

**Interfaces:**
- Consumes: усе з Tasks 1–5.

- [ ] **Step 1: Capture the real output for README**

`README.md` містить лише захоплений вивід, тож блоки не пишуться вручну. Створити scratch-проєкт і зняти вивід:

```bash
SCRATCH=$(mktemp -d) && mkdir "$SCRATCH/.idea"
cp .idea/workspace.xml "$SCRATCH/.idea/" 2>/dev/null || true
cat > "$SCRATCH/.idea/webstorm-commands.json" <<'EOF'
{
  "version": 1,
  "presets": {
    "default": [
      { "name": "test", "mode": "run" },
      { "name": "seed db", "mode": "terminal", "commands": ["npm i", "npm run seed"] }
    ]
  }
}
EOF
cd "$SCRATCH" && node <repo>/bin/wsc.js --dry-run            # IDE запущений
cd "$SCRATCH" && node <repo>/bin/wsc.js --mcp-port 65001 --fallback=terminal --dry-run   # без IDE
```

Скопіювати обидва виводи дослівно (stdout і stderr разом, як їх бачить користувач) у README.

- [ ] **Step 2: Write the README section**

Після розділу `:terminal` (перед `## \`--target=terminal\``) вставити розділ `## Your own commands (no run configuration)` зі змістом:

- Що це: запис пресету з `commands` запускає shell-команди в новій Terminal-вкладці, названій так само, як запис; run-конфігурація WebStorm не потрібна.
- JSON-приклад запису (той самий, що у Step 1) і пояснення: `mode` завжди `terminal` (можна опустити), команди з'єднуються `&&` — серія зупиняється на першій помилці, вкладка лишається відкритою.
- `wsc -c`: `Add a custom command?` → назва → команди по одній (порожній рядок завершує); наявні власні записи показані в чекбоксі як `⌘ name — commands`, зняття позначки видаляє запис. Назва не може збігатися з іменем run-конфігурації чи іншого власного запису.
- Захоплені блоки зі Step 1, з двома рядками про те, що бачить користувач: `custom commands from the preset:` завжди друкується перед запуском (файл лежить у `.idea/` і зазвичай комітиться, тож видно, що стартує).
- Обмеження: команду не можна викликати за іменем з командного рядка (`wsc "seed db"` — це `unknown run configuration`); `--target` і `:debug` на неї не діють; без IDE (`--fallback=terminal`) це вкладка ОС-терміналу з тим самим заголовком, і пресет лише з власних команд працює навіть коли WebStorm нічого не зберіг у `.idea/`; `wsc`, зібраний до цієї можливості, не прочитає такий запис і зупиниться з помилкою, що називає файл.

- [ ] **Step 3: Update `CLAUDE.md`**

1. У розділі "Project state" до переліку реалізованого додати речення: власні CLI-команди в пресеті (`commands`) — запис без run-конфігурації, іменована Terminal-вкладка.
2. У розділі Architecture після bullet про `:terminal` додати bullet **«Custom command entries»** (стисло, у стилі сусідніх): запис із `commands` — окремий вид (`isCustomEntry` у `store.js`, `isCustomPlanEntry` у `resolve.js`), mode завжди `terminal`, `MODES` і версія схеми не змінені; `buildLaunchPlan` ключує `Map` через `JSON.stringify([kind, name])`, щоб конфігурація з ім'ям `custom:x` не поглинала власний запис; `customCommandLine` з'єднує `&&` без quoting (shell-текст користувача); власний виклик не читає `.idea/`, не має inspector-порту й не ходить у `commandFor`; `announceCustomCommands` друкує рядки завжди, бо файл у `.idea/` зазвичай комітиться; no-IDE шлях не вимагає каталогу для пресету лише з власних команд; у `--configure` значення пункту власного запису `customChoiceValue(name)` відмінне від імені конфігурації, порожній список IDE без stale-записів більше не помилка, а зі stale — як раніше (код 1).

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS (805 + нові), typecheck чистий.

Run: `git diff main --stat -- src && git grep -n "TODO\|TBD" -- src`
Expected: змінені лише файли з карти файлів; жодного нового `TODO`/`TBD` у `src/`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: custom commands in a preset

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Human acceptance (потрібен живий WebStorm; не автоматизується)**

1. `wsc -c` → додати `hello` з двох команд → перевірити `.idea/webstorm-commands.json`.
2. `wsc --dry-run` → у stdout рядок `→ execute_terminal_command  echo one && echo two`, у stderr — `custom commands from the preset:`.
3. `wsc` у живому IDE → нова Terminal-вкладка з назвою `hello`. Це також закриває нез'ясоване питання з `CLAUDE.md`: чи вкладка лишається з назвою після `close()` сесії.
4. `wsc --fallback=terminal` → вкладка ОС-терміналу з заголовком `hello`.
5. Команда, що падає першою (`false`, `echo never`) → друга не виконується, вкладка відкрита.
6. Результат пунктів 3 і 5 записати в `CLAUDE.md` (речення про вкладку після `close()`) і в PR.

---

## Self-review проти spec

| Розділ spec | Де реалізовано |
|---|---|
| 1. Модель даних | Task 1 |
| 2. Резолвінг (`PlanEntry`, ключі `Map`, CLI не змінює власний) | Task 2 (`resolve.test.js`) |
| 3. План запуску (`&&`, `tabName`, без `.idea/`, без порту) | Task 2 (`planBuilder.test.js`, `customCommands.test.js`) |
| 4. Прозорість | Task 2 (`announceCustomCommands`), Task 3 (виклик, `cli.integration.test.js`) |
| 5. No-IDE шлях (без каталогу, вкладка, оголошення) | Task 2 (вкладка), Task 3 (каталог, оголошення, dry-run, pool) |
| 6. Екран `--configure` (чекбокс, цикл, валідація, порожній IDE, Ctrl-C) | Tasks 4–5 |
| 7. Обробка помилок | Task 1 (валідація), Task 3 (інтеграційний тест `PresetConfigError`), наявний `launchFailureReason()` (без змін) |
| 8. Тести | у кожній задачі |
| 9. Ручна перевірка | Task 6, Step 6 |

Відхилення від spec, свідомі: (а) значення пункту чекбокса для власного запису — `customChoiceValue(name)`, а не голе ім'я, бо hand-edited файл може мати власний запис і конфігурацію з однаковою назвою; (б) порожній список IDE без stale-записів більше не помилка, а зі stale — лишається помилка (код 1), бо переписати пресет з порожнього списку означало б стерти записи, яких IDE тимчасово не показало; (в) два `try/catch` у `runConfigure` об'єднані в один, щоб обробка Ctrl-C не мала третьої копії.
