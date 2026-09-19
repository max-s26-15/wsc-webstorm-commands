/**
 * The "Project node" interpreter — what WebStorm runs a configuration with when the
 * configuration does not pin one.
 *
 * A Node.js configuration usually pins nothing (`path-to-node` is absent), and an npm one
 * often stores the literal `project`. The IDE then resolves the project's interpreter,
 * which for an nvm project is whatever `.nvmrc` names ("Project node (.nvmrc →
 * ~/.nvm/versions/node/v14.21.3/bin/node)" in the run configuration dialog). A terminal
 * tab knows nothing about that: it gets the shell's default node, which on the machine
 * this was found on was v20 for a project pinned to v14 — the app was then debugged under a
 * runtime it is not built for. Reading `.nvmrc` ourselves puts the same node first on PATH
 * that the IDE would have used.
 *
 * Deliberately small: only a literal version is resolved. `lts/*`, `node` and named
 * aliases live in nvm's own alias files and registry, and guessing at them would pin a
 * version nobody asked for — an unresolvable answer is `undefined`, which leaves the tab on
 * the shell's PATH exactly as before.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A version as nvm writes it: 14, 14.21, 14.21.3, each with an optional leading `v`. */
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * @param {string} text - the contents of a .nvmrc
 * @returns {number[] | undefined} `[major]`, `[major, minor]` or `[major, minor, patch]`;
 *   undefined for anything that is not a plain version
 */
export function parseNvmrc(text) {
    const match = VERSION.exec(text.trim());
    if (match === null) return undefined;
    return match.slice(1).filter((part) => part !== undefined).map(Number);
}

/**
 * Whether an installed `v14.21.3` satisfies a (possibly partial) requested version.
 *
 * @param {number[]} installed - always three numbers
 * @param {number[]} wanted
 */
const satisfies = (installed, wanted) => wanted.every((part, index) => installed[index] === part);

/** @param {number[]} a @param {number[]} b */
const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Resolve the node the IDE would call "Project node" for this project.
 *
 * @param {string} projectRoot
 * @param {object} [opts]
 * @param {string} [opts.homeDir] - injected in tests
 * @param {string} [opts.nvmDir] - default: `$NVM_DIR`, then `<home>/.nvm`
 * @param {NodeJS.ProcessEnv} [opts.env] - where `$NVM_DIR` is read from; injected in tests so
 *   the developer's own nvm cannot leak in
 * @returns {Promise<string | undefined>} absolute path to an existing `bin/node`
 */
export async function resolveProjectNode(projectRoot, opts = {}) {
    const text = await fs.readFile(path.join(projectRoot, '.nvmrc'), 'utf8').catch(() => null);
    if (text === null) return undefined;

    const wanted = parseNvmrc(text);
    if (wanted === undefined) return undefined;

    const env = opts.env ?? process.env;
    const nvmDir = opts.nvmDir ?? env.NVM_DIR ?? path.join(opts.homeDir ?? os.homedir(), '.nvm');
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    const names = await fs.readdir(versionsDir).catch(() => /** @type {string[]} */ ([]));

    const candidates = names
        .map((name) => ({ name, version: parseNvmrc(name) }))
        .filter(
            /** @returns {entry is { name: string, version: number[] }} */
            (entry) => entry.version?.length === 3 && satisfies(entry.version, wanted),
        )
        // Numeric, not lexical: `v14.9.0` sorts after `v14.21.3` as a string.
        .sort((a, b) => compareVersions(b.version, a.version));

    for (const { name } of candidates) {
        const node = path.join(versionsDir, name, 'bin', 'node');
        // A half-removed install leaves the directory behind; offering it would put a
        // PATH entry in front of the shell's node that has no node in it.
        if (await fs.access(node).then(() => true, () => false)) return node;
    }
    return undefined;
}
