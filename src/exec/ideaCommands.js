/**
 * Terminal command lines for the *MCP* path, read off disk instead of guessed.
 *
 * The gap this closes (the phase-6 caveat)
 *   `get_run_configurations` reports only `{name, description}`, so buildTerminalCommand()
 *   in src/exec/planBuilder.js has no choice but to rebuild a command from the shape of the
 *   name: `web` → `npm run web`, `client > bundle:build` → `cd client && npm run
 *   bundle:build`. Measured against the anonymised demo-app `.idea/` fixtures, of its 13 configurations
 *   the guess gets 2 right, gets 10 *wrong* and cannot express the last one at all —
 *   `web` is really `cd web && npm run dev` (there is no root `web` script) and
 *   `client > bundle:build` really lives in `gateway/addon/client`. So
 *   `--target=terminal` and every `:debug` — which always goes through a terminal, since
 *   the IDE's MCP API has no debug parameter — could open a tab that immediately dies with
 *   "Missing script".
 *
 * The fix, and why it is small
 *   MCP stays the catalogue: it is the IDE's live list of names, and resolution, ambiguity
 *   and the preset all keep working against it exactly as before. Only the *command* is
 *   looked up, in the same `.idea/` files the no-IDE path already reads, through the same
 *   buildFallbackCommand(). Nothing about the run-window path changes — there
 *   `execute_run_configuration` takes the name and the IDE owns everything else.
 *
 * When `.idea/` has no entry for a name
 *   That happens for a configuration created moments ago: workspace.xml is the IDE's saved
 *   state, written on its own schedule. wsc then falls back to the old name-shaped guess
 *   and *says so*, naming the configurations involved (see guessedCommandNote). Refusing
 *   was the alternative and was rejected: `:debug` has no other route, so refusing would
 *   make a brand-new configuration undebuggable, and the guess is exactly the behaviour
 *   that shipped in phases 6-9 — it is not made worse by being labelled. A wrong guess
 *   fails loudly in the tab (`npm ERR! Missing script`), and `--dry-run` shows the exact
 *   command line before anything starts.
 */
import { buildFallbackCommand, DISK_SOURCE } from '../fallback/ideaRunConfigs.js';
import { buildTerminalCommand, terminalEscapeHint } from './planBuilder.js';

/**
 * @typedef {import('../fallback/ideaRunConfigs.js').IdeaRunConfig} IdeaRunConfig
 * @typedef {import('./planBuilder.js').CommandFor} CommandFor
 */

/**
 * Build the command resolver buildExecutionPlan() takes.
 *
 * Pure: the `.idea/` read happens in src/cli.js and its result is handed in, so this file
 * (like planBuilder next door) touches no filesystem and needs no IDE to test.
 *
 * @param {IdeaRunConfig[]} diskConfigs - from readIdeaRunConfigs()
 * @param {string} projectRoot - commands are emitted relative to it: the IDE opens every
 *   Terminal tab there
 * @returns {CommandFor}
 */
export function ideaCommandResolver(diskConfigs, projectRoot) {
    // A Map rather than an object, per the house rule: a run configuration may legally be
    // called `constructor` or `__proto__`, and both a plain read and a plain write on an
    // object keyed by one of those do something other than what they look like.
    const byName = new Map(diskConfigs.map((config) => [config.name, config]));

    return (entry, opts = {}) => {
        const saved = byName.get(entry.name);

        // The name the IDE reported, not the token the user typed: resolveName() has
        // already turned a prefix or a different casing into the canonical name, and that
        // is the one WebStorm wrote into workspace.xml.
        if (saved === undefined) {
            return { command: buildTerminalCommand(entry.config, entry.mode, opts), source: 'name' };
        }

        return {
            command: buildFallbackCommand(saved, entry.mode, {
                projectRoot,
                debugPort: opts.debugPort,
                // The no-IDE default ("start the MCP Server") would name the one thing that
                // is already true here, so a refusal points at the flag instead.
                advice: terminalEscapeHint(entry.mode),
            }),
            source: 'idea',
        };
    };
}

/**
 * The warning for entries whose command line had to be guessed after all.
 *
 * One line per run rather than per entry, and it names the configurations, because "some
 * command was guessed" is not something the user can act on and "web, api were
 * guessed" is. It is a warning rather than an error for the reason in this file's header:
 * the guess is what wsc did unconditionally until now.
 *
 * @param {string[]} names - from guessedCommands(), in plan order; at least one
 * @returns {string}
 */
export function guessedCommandNote(names) {
    const [subject, whose] = names.length === 1
        ? [`${names[0]} is not in`, 'Its']
        : [`${names.join(', ')} are not in`, 'Their'];

    return `${subject} ${DISK_SOURCE} — WebStorm writes run\n` +
        '  configurations there on its own schedule, so a new one may not be saved yet.\n' +
        `  ${whose} command line was rebuilt from the configuration name instead, which is a\n` +
        '  guess: check it with --dry-run if the tab dies.';
}
