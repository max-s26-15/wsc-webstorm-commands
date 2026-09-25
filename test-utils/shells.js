/**
 * Which shells this machine has, for tests that run a built command line through a real one.
 *
 * Those tests are the only authority on "does the shell read this the way we meant", so they
 * are skipped — with the reason in the test log — rather than faked where the shell is
 * missing. On Windows that is /bin/sh; the product refuses the POSIX terminal routes there
 * (src/exec/terminalShell.js), so nothing they would test is reachable.
 */
import { spawnSync } from 'node:child_process';

export const POSIX_SH = '/bin/sh';

/** @param {string} command */
export function hasShell(command) {
    return spawnSync(command, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
}

/** For `test(..., { skip })`: false, or why the test cannot run here. */
export const skipWithoutPosixSh = hasShell(POSIX_SH) ? false : `${POSIX_SH} is not available on this machine`;
