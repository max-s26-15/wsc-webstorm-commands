/**
 * `--list` — print the project's run configurations.
 *
 * Two sources, one output shape
 *   The plan asks for "every configuration from MCP", and that is the primary path. But
 *   phase 8 already reads the same catalogue off `.idea/`, so "what can wsc launch here?"
 *   is answerable with the IDE shut down — and refusing to answer it would be a worse CLI
 *   than one that answers with a caveat. `--list` therefore goes through exactly the same
 *   unreachable-IDE decision a launch does (retry / continue without the IDE / give up),
 *   so `--fallback` means one thing everywhere.
 *
 * The two listings must not be mistakable for one another
 *   A disk listing is the IDE's *saved* state: a configuration created a minute ago and
 *   not yet flushed to workspace.xml is missing from it. That is said out loud, on stderr,
 *   above the listing — never hidden, and never mixed into the data.
 *
 * Output discipline
 *   The listing itself is the one thing that goes to stdout (log.out), because `wsc --list`
 *   is the command src/log.js' stdout/stderr split exists for: piping it into grep or fzf
 *   must not have to filter diagnostics out first. Nothing here is ever coloured — the
 *   logger decides colour from *stderr*'s TTY-ness, so colouring stdout would put escape
 *   sequences into a pipe whenever the two streams differ.
 */
import { DISK_SOURCE, readIdeaRunConfigs } from './fallback/ideaRunConfigs.js';
import { normalizeRunConfigs } from './resolve.js';

/**
 * Label for the "do it without the IDE" option of the phase-7 prompt, in `--list` wording.
 *
 * The default one promises OS terminal tabs, and a listing opens none: whatever the prompt
 * offers has to be what pressing it actually does.
 */
export const LIST_WITHOUT_IDE_LABEL = `List what WebStorm last saved to ${DISK_SOURCE}`;

/**
 * @typedef {{ name: string, description?: string }} ListedConfig
 */

/**
 * One line per configuration: the name, then what kind it is.
 *
 * Aligned into two columns because the name is what the user reads and the description is
 * what tells `npm` apart from `Node.js` — the same two fields the IDE's own dropdown
 * shows. Trailing padding is trimmed so a piped line ends where its content does.
 *
 * @param {ListedConfig[]} configs
 * @returns {string}
 */
export function formatRunConfigs(configs) {
    if (configs.length === 0) return '';

    const width = Math.max(...configs.map((config) => config.name.length));
    return configs
        .map((config) => `${config.name.padEnd(width)}  ${config.description ?? ''}`.trimEnd())
        .join('\n');
}

/**
 * Print what the IDE reports over MCP.
 *
 * @param {import('./mcp/client.js').McpClient} client
 * @param {ReturnType<typeof import('./log.js').createLogger>} log
 * @returns {Promise<number>} exit code
 */
export async function listFromIde(client, log) {
    const configs = normalizeRunConfigs(await client.callTool('get_run_configurations'));
    return print(configs, log, (count) => `${count} run configuration(s) reported by the IDE`);
}

/**
 * Print what the IDE has saved to `.idea/`, for when it cannot be reached.
 *
 * @param {string} projectRoot
 * @param {ReturnType<typeof import('./log.js').createLogger>} log
 * @param {object} [opts]
 * @param {typeof readIdeaRunConfigs} [opts.readConfigs] - injected in tests
 * @returns {Promise<number>} exit code
 */
export async function listFromDisk(projectRoot, log, opts = {}) {
    const configs = await (opts.readConfigs ?? readIdeaRunConfigs)(projectRoot);

    // A warning, not an info line: this listing can be out of date, and that caveat is the
    // whole difference between the two sources.
    log.warn(
        `read from ${DISK_SOURCE} — WebStorm's saved state, so a configuration\n` +
            '  it has not written out yet is missing from this list.',
    );
    return print(configs, log, (count) => `${count} run configuration(s) saved by the IDE`);
}

/**
 * @param {ListedConfig[]} configs
 * @param {ReturnType<typeof import('./log.js').createLogger>} log
 * @param {(count: number) => string} summary
 * @returns {number} exit code
 */
function print(configs, log, summary) {
    // Nothing to list is an answer, not a failure — the same thing `ls` does with an empty
    // directory. It is said on stderr so a pipe still sees exactly zero lines.
    if (configs.length === 0) {
        log.warn('no run configurations found for this project');
        return 0;
    }

    log.info(summary(configs.length));
    log.out(formatRunConfigs(configs));
    return 0;
}
