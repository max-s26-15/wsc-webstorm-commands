/**
 * The launch modes — the one place they are spelled.
 *
 * A mode is a property of one plan entry: `run` starts it in the IDE's Run window,
 * `debug` under a debugger, `terminal` in a new IDE Terminal tab. It is named on the
 * command line (`name:terminal`), stored in presets and asked about by `--configure`, so
 * every one of those has to accept exactly the same list — which is why it lives here and
 * is imported, never retyped.
 *
 * `terminal` is per entry; the global `--target=terminal` is the same launch for the whole
 * run and stays a separate flag.
 *
 * @typedef {'run' | 'debug' | 'terminal'} LaunchMode
 */

/** Launch modes a positional token, a preset entry or a `--configure` answer may carry. */
export const MODES = /** @type {const} */ (['run', 'debug', 'terminal']);

/** Mode used when a configuration is named without a suffix. */
export const DEFAULT_MODE = 'run';

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
