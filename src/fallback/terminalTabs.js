/**
 * OS terminal tabs — one per configuration, when the IDE cannot provide them.
 *
 * Structure: every emulator is a small data object (a TerminalAdapter) that says what it
 * needs on PATH, which platforms it exists on, and how to turn a list of tabs into
 * argv arrays. Detection walks the list in order and picks the first one that is actually
 * there. Nothing here decides *what* to launch — that is src/fallback/terminalFallback.js
 * — and nothing here talks to the IDE.
 *
 * The adapters are interchangeable on purpose: the plan has the gnome-terminal one as the
 * author's own work and konsole/macOS/Windows as agent work behind the same interface, so
 * the interface is the contract, and adding a fifth emulator means adding one object to
 * ADAPTERS and one unit test — no branching anywhere else.
 *
 * Quoting is the sharp edge here, and the reason none of this uses a shell. Every
 * invocation is an argv array handed straight to spawn(), so a configuration named
 * `api > repro:stale-job:debug`, or one whose command contains a quote, is a single
 * array element and cannot break out of anything. The only place a string is re-parsed is
 * gnome-terminal's `-e`, which is why that one payload goes through shellQuote().
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { shellQuote } from '../exec/planBuilder.js';
import { FallbackError } from './errors.js';

/**
 * Shell every adapter drives.
 *
 * bash rather than the user's login shell, and on every platform: the commands wsc builds
 * are POSIX shell (`cd x && NODE_OPTIONS="…" npm run y`) — the same ones the IDE's own
 * terminal runs — so the tab has to be a shell that understands them. On Windows that
 * means the bash shipped with Git for Windows, which is also what WebStorm's terminal
 * defaults to there; detection requires it, so a machine without one falls through to the
 * next adapter rather than opening a tab that dies on the first `&&`.
 */
export const SHELL = 'bash';

/**
 * How long the CLI waits before deciding the emulator started successfully.
 *
 * A terminal emulator is fire-and-forget — gnome-terminal in particular is a thin client
 * that hands the request to gnome-terminal-server and exits 0 immediately — so "the
 * process spawned" is not the same as "the tabs opened". A rejected argument list shows up
 * as a non-zero exit a few milliseconds later, and without this window the CLI would have
 * already printed "launched" and gone. Paid once per run, not once per tab.
 */
export const SETTLE_MS = 300;

/**
 * @typedef {{ name: string, command: string }} TabSpec
 * @typedef {{ command: string, args: string[] }} Invocation
 *
 * @typedef {object} TerminalAdapter
 * @property {string} id - the emulator's name, as shown to the user
 * @property {string[]} binaries - every executable that must be on PATH; the first one is
 *   what gets spawned
 * @property {string[]} platforms - process.platform values this adapter may be probed on
 * @property {boolean} [needsDisplay] - skip it when there is no X11/Wayland display
 * @property {'tab' | 'window'} opens - what one entry actually gets, so the CLI can say so
 * @property {(tabs: TabSpec[], ctx: { cwd: string, bin: Record<string, string> }) => Invocation[]}
 *   invocations - one entry per spawn, in order
 */

/**
 * Run the command and say how it ended.
 *
 * Every adapter appends this, including the one that does not need keepOpen(): a crashed
 * dev server has to look the same on every platform, or the difference reads as a bug in
 * whichever one the user happens to be on. `$?` is expanded before printf runs, so it is
 * still the command's own status.
 *
 * @param {TabSpec} tab
 * @returns {string}
 */
export function reportExit(tab) {
    const report = `printf '\\n[wsc] %s exited with status %s\\n' ${shellQuote(tab.name)} "$?"`;
    return `${tab.command}; ${report}`;
}

/**
 * Keep a tab alive after its command finishes.
 *
 * Without it the tab closes the instant a dev server crashes, taking the stack trace with
 * it — the one moment the output matters most.
 *
 * @param {TabSpec} tab
 * @returns {string}
 */
export function keepOpen(tab) {
    return `${reportExit(tab)}; exec ${SHELL}`;
}

/**
 * Quote a string for an AppleScript string literal.
 *
 * @param {string} value
 * @returns {string}
 */
export function appleScriptQuote(value) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * GNOME Terminal — the emulator this was developed against (3.52, verified).
 *
 * One invocation for the whole run, which is what puts every configuration in *one*
 * window as separate tabs. Two things about the command line are not obvious:
 *
 *   1. `--tab … -- bash -c …` cannot be repeated. `--` means "everything after this is
 *      the command", greedily, to the end of the argv — so a second `--tab` group is
 *      swallowed as ignored arguments to the first `bash -c`. Verified on 3.52: of two
 *      tabs written that way, only the first one ever ran.
 *   2. `-e` takes the command as a *single string*, which is the only form that can be
 *      repeated, so it is the only way to open several tabs in one window. It is
 *      deprecated (it prints a warning on stderr, which stdio:'ignore' swallows) but
 *      still works; the string is parsed with POSIX shell quoting rules, which is exactly
 *      what shellQuote() produces.
 *
 * @type {TerminalAdapter}
 */
export const gnomeTerminal = {
    id: 'gnome-terminal',
    binaries: ['gnome-terminal', SHELL],
    platforms: ['linux', 'freebsd', 'openbsd'],
    needsDisplay: true,
    opens: 'tab',
    invocations: (tabs, { bin }) => [
        {
            command: bin['gnome-terminal'],
            args: tabs.flatMap((tab) => [
                '--tab',
                `--title=${tab.name}`,
                '-e',
                `${SHELL} -c ${shellQuote(keepOpen(tab))}`,
            ]),
        },
    ],
};

/**
 * Konsole (KDE).
 *
 * One invocation per tab, because `-e` here has the same greedy meaning `--` has for
 * gnome-terminal. That is not a downgrade: `--new-tab` attaches to the existing Konsole
 * window, so N invocations still produce N tabs of one window.
 *
 * @type {TerminalAdapter}
 */
export const konsole = {
    id: 'konsole',
    binaries: ['konsole', SHELL],
    platforms: ['linux', 'freebsd', 'openbsd'],
    needsDisplay: true,
    opens: 'tab',
    invocations: (tabs, { cwd, bin }) =>
        tabs.map((tab) => ({
            command: bin.konsole,
            args: ['--new-tab', '--workdir', cwd, '-p', `tabtitle=${tab.name}`, '-e', SHELL, '-c', keepOpen(tab)],
        })),
};

/**
 * macOS Terminal.app, driven through osascript.
 *
 * `do script` opens a *window*, not a tab — tabs would need System Events keystrokes,
 * i.e. Accessibility permission the user has to grant in System Settings, which is a
 * worse trade than one window per configuration. The adapter says `opens: 'window'` so
 * the CLI reports what actually happens rather than promising tabs.
 *
 * There is no `exec bash` tail here: `do script` runs the command *in* a new interactive
 * shell, which stays alive afterwards, so the output is already kept on screen. The exit
 * line is still printed — that half of keepOpen() is not about staying open, and leaving
 * it out was the one thing that made a crash on macOS look different from a crash
 * everywhere else.
 *
 * @type {TerminalAdapter}
 */
export const macTerminal = {
    id: 'Terminal.app',
    binaries: ['osascript'],
    platforms: ['darwin'],
    opens: 'window',
    invocations: (tabs, { cwd, bin }) =>
        tabs.map((tab) => ({
            command: bin.osascript,
            args: [
                '-e',
                [
                    'tell application "Terminal"',
                    `  do script ${appleScriptQuote(`cd ${shellQuote(cwd)} && ${reportExit(tab)}`)}`,
                    `  set custom title of front window to ${appleScriptQuote(tab.name)}`,
                    '  activate',
                    'end tell',
                ].join('\n'),
            ],
        })),
};

/**
 * Windows Terminal.
 *
 * One invocation for the whole run: `wt` takes several `new-tab` commands separated by a
 * literal `;` argument, which is a plain argv element here — no shell is involved, so it
 * needs no escaping.
 *
 * @type {TerminalAdapter}
 */
export const windowsTerminal = {
    id: 'wt',
    binaries: ['wt', SHELL],
    platforms: ['win32'],
    opens: 'tab',
    invocations: (tabs, { cwd, bin }) => [
        {
            command: bin.wt,
            args: tabs.flatMap((tab, index) => [
                ...(index === 0 ? [] : [';']),
                'new-tab',
                '--title',
                tab.name,
                '-d',
                cwd,
                SHELL,
                '-c',
                keepOpen(tab),
            ]),
        },
    ],
};

/** Detection order, straight from the plan. Platform gating keeps it from mattering. */
export const ADAPTERS = [gnomeTerminal, konsole, macTerminal, windowsTerminal];

/**
 * Whether a graphical session exists to open a window in.
 *
 * Without this check, `wsc` over SSH would find gnome-terminal on PATH, pick it, and
 * spawn something that can only fail — instead of falling through to the single-tab pool,
 * which works perfectly well on a headless machine.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function hasDisplay(env) {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Look an executable up on PATH.
 *
 * Injected wholesale in tests (the plan asks for exactly that), so no unit test depends on
 * what happens to be installed on the machine running it. Doing the lookup directly rather
 * than shelling out to `which`/`where` also keeps a spawn out of the decision about
 * whether to spawn.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.platform]
 * @returns {(binary: string) => Promise<string | null>} absolute path, or null
 */
export function createPathLookup(opts = {}) {
    const env = opts.env ?? process.env;
    const platform = opts.platform ?? process.platform;

    const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '');
    // On Windows the executable bit does not exist and the extension is what makes a file
    // runnable, so the candidate list is per-extension instead.
    const extensions = platform === 'win32'
        ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
        : [''];

    return async (binary) => {
        for (const dir of dirs) {
            for (const extension of extensions) {
                const candidate = path.join(dir, binary + extension);
                if (await isExecutableFile(candidate, platform)) return candidate;
            }
        }
        return null;
    };
}

/**
 * "Found" means: it exists, it is a file, and it may be executed.
 *
 * The isFile() check is not pedantry — fs.access(X_OK) succeeds on a *directory* on every
 * POSIX system, so a directory called `konsole` somewhere on PATH would otherwise be
 * detected as an emulator and spawned as EACCES.
 *
 * @param {string} candidate
 * @param {string} platform
 * @returns {Promise<boolean>}
 */
async function isExecutableFile(candidate, platform) {
    const stats = await fs.stat(candidate).catch(() => null);
    if (!stats?.isFile()) return false;
    if (platform === 'win32') return true;

    return await fs.access(candidate, constants.X_OK).then(() => true, () => false);
}

/**
 * @typedef {{ adapter: TerminalAdapter, bin: Record<string, string> }} DetectedTerminal
 */

/**
 * Find the first terminal emulator that is actually usable here.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {TerminalAdapter[]} [opts.adapters]
 * @param {(binary: string) => Promise<string | null>} [opts.lookupPath] - injected in tests
 * @returns {Promise<DetectedTerminal | null>} null when the pool is the only option left
 */
export async function findTerminal(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    const lookupPath = opts.lookupPath ?? createPathLookup({ env, platform });

    for (const adapter of opts.adapters ?? ADAPTERS) {
        // Platform first, so `osascript` is never probed on Linux and `wt` never on macOS:
        // a name that happens to exist on the wrong platform is not the program we mean.
        if (!adapter.platforms.includes(platform)) continue;
        if (adapter.needsDisplay && !hasDisplay(env)) continue;

        /** @type {Record<string, string>} */
        const bin = Object.create(null);
        for (const binary of adapter.binaries) {
            const found = await lookupPath(binary);
            if (found === null) break;
            bin[binary] = found;
        }

        // Every binary the adapter declared, or it is not usable — an emulator without the
        // shell it drives would open a tab that dies immediately.
        if (adapter.binaries.every((binary) => Object.hasOwn(bin, binary))) return { adapter, bin };
    }

    return null;
}

/**
 * Open the tabs.
 *
 * Detached and with stdio ignored, because the terminal has to outlive `wsc`: the CLI
 * prints what it started and exits, while the tabs keep running. That also means Ctrl-C on
 * `wsc` afterwards cannot reach them, which is the point — they are separate windows now,
 * exactly like the IDE's tabs would have been.
 *
 * @param {TabSpec[]} tabs
 * @param {object} opts
 * @param {DetectedTerminal} opts.terminal
 * @param {string} opts.cwd - every command is written relative to the project root
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ debug: (...a: any[]) => void }} opts.log
 * @param {typeof nodeSpawn} [opts.spawn] - injected in tests; nothing real is ever started
 * @param {number} [opts.settleMs] - 0 in tests, so none of them waits
 * @returns {Promise<void>}
 * @throws {FallbackError} when the emulator refuses to start, or exits non-zero at once
 */
export async function openTerminalTabs(tabs, opts) {
    const { terminal, cwd, log } = opts;
    const spawn = opts.spawn ?? nodeSpawn;
    const invocations = terminal.adapter.invocations(tabs, { cwd, bin: terminal.bin });

    /** @type {{ invocation: Invocation, code: number | null }[]} */
    const exited = [];
    /** @type {import('node:child_process').ChildProcess[]} */
    const children = [];

    for (const invocation of invocations) {
        log.debug(`${invocation.command} ${invocation.args.join(' ')}`);

        const child = spawn(invocation.command, invocation.args, {
            cwd,
            env: opts.env ?? process.env,
            detached: true,
            stdio: 'ignore',
        });

        // Recorded before the wait below, so an emulator that rejects its arguments is
        // still noticed after every invocation has been issued.
        child.on('exit', (code) => exited.push({ invocation, code }));
        children.push(child);

        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', (err) => reject(new FallbackError(
                `could not start ${terminal.adapter.id}: ${err.message}\n` +
                    '  It was on PATH a moment ago, so this is a permissions or environment problem.',
            )));
        });
    }

    await settle(opts.settleMs ?? SETTLE_MS);
    for (const child of children) child.unref();

    const failed = exited.filter(({ code }) => code !== 0 && code !== null);
    if (failed.length > 0) {
        throw new FallbackError(
            `${terminal.adapter.id} exited with status ${failed.map(({ code }) => code).join(', ')} — ` +
                `${failed.length === invocations.length ? 'no' : 'not every'} ${terminal.adapter.opens} opened.\n` +
                '  Re-run with WSC_LOG_LEVEL=debug to see the exact command line it was given.',
        );
    }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function settle(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
