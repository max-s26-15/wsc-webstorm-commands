/**
 * The one error class of the no-IDE path.
 *
 * Shared by every module under src/fallback/ rather than defined per file, because from
 * the user's side they are one situation: "wsc tried to launch this without WebStorm and
 * could not". Its name is listed in KNOWN_ERRORS (src/cli.js), so the message is printed
 * as a plain line and the run exits 1 — the same treatment WscError and
 * UnsupportedLaunchError get on the main path.
 */

/** A condition on the terminal-fallback path, reported without a stack trace. */
export class FallbackError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'FallbackError';
    }
}
