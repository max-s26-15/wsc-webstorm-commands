/**
 * What Ctrl-C means at an interactive prompt.
 *
 * Shared by every screen that draws one (--configure, the MCP-unavailable prompt):
 * backing out of a question is an ordinary way to use the CLI, not a crash, so it must
 * look identical wherever it happens. Kept in its own module rather than copied because
 * the second copy is exactly where the two would drift apart.
 */

/**
 * Exit code for "the user aborted at a prompt".
 *
 * 130 is the shell convention for a process terminated by SIGINT (128 + 2), which is
 * what Ctrl-C means everywhere else on the command line — and it is distinct from 1, so
 * a script can tell "the user changed their mind" from "the run failed".
 */
export const CANCELLED_EXIT_CODE = 130;

/**
 * @param {unknown} err
 * @returns {boolean} true when the user pressed Ctrl-C at a prompt
 */
export function isCancelled(err) {
    // @inquirer/prompts raises ExitPromptError for Ctrl-C and AbortPromptError when the
    // caller's AbortSignal fires. Matched by name rather than by class so this file does
    // not have to import the prompt library at all — it is used on paths (and in tests)
    // where no prompt is ever drawn.
    return err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError');
}
