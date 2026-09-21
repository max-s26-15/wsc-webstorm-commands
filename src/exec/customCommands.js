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
