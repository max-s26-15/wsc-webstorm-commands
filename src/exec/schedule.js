/**
 * Preset boundaries in a launch plan: what they are, and how they read in a printed plan.
 *
 * A launch is one global list with no gaps in it. A pause is not an element of that list but
 * a barrier beside it, so that a counter of configurations, the inspector ports and every
 * other per-entry stage carry on not knowing about pauses.
 */

/**
 * `after` is how many unique launches come before this barrier. `members` are absolute
 * indexes into the final plan of everything the preset contains, those launched by an earlier
 * preset included: their result is what decides whether the launch may go on.
 *
 * @typedef {{ after: number, presetName: string, waitAfterSeconds: number, members: number[] }} PresetBarrier
 */

/**
 * A preset name as it is printed: JSON, so a newline cannot forge a line of the plan, plus the
 * few characters JSON leaves raw that a terminal would still act on (DEL and C1, of which
 * \u009b starts an escape sequence).
 *
 * @param {string} name
 * @returns {string}
 */
export function quotePresetName(name) {
    return JSON.stringify(name).replace(
        /[\u007f-\u009f]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

/**
 * Put the pauses between the rows of a printed plan.
 *
 * `rows` has one element per plan entry, however many lines each holds: the indexes in a
 * barrier count entries, so splitting a multi-line row first would put the pause inside one.
 *
 * @param {string[]} rows
 * @param {PresetBarrier[]} barriers
 * @returns {string[]}
 */
export function insertWaitRows(rows, barriers) {
    return rows.flatMap((row, index) => [
        ...barriers
            .filter((barrier) => barrier.after === index)
            .map((barrier) => `→ wait ${barrier.waitAfterSeconds}s after preset ${quotePresetName(barrier.presetName)}`),
        row,
    ]);
}
