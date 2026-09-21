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
        try {
            stderr.write(
                `wsc completion: ${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
            );
        } catch {
            // A diagnostic that cannot be printed is not worth failing the completion for.
        }
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
        try {
            stdout.write('none\n');
        } catch {
            // The stream itself is what failed; there is nowhere left to say so.
        }
    }
    return 0;
}
