/**
 * Dependency bundle for driving runCli() without an IDE or a real terminal.
 *
 * runCli takes its streams, environment, cwd and MCP entry points as injected
 * dependencies precisely so the whole pipeline — args → presets → resolve — can be
 * exercised end to end in a unit test.
 */
import { createRequire } from 'node:module';

import { fakeStream } from './capture.js';

const require = createRequire(import.meta.url);
/** The demo-app payload, so tests resolve against real names. */
export const FIXTURE = require('../test/fixtures/run-configurations.json');

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number | null} [opts.port] - null simulates "MCP Server not reachable"
 * @param {Array<number | null>} [opts.ports] - successive discoverPort() answers, for retries
 * @param {boolean} [opts.tty] - pretend stdin/stdout are a terminal, so prompts are drawn
 * @param {object | Function} [opts.fallbackChoice] - outcome the MCP-unavailable prompt
 *   should return, or a function called with the same arguments the real one gets
 * @param {unknown} [opts.configurations] - payload returned by get_run_configurations
 * @param {string[]} [opts.tools] - names of the tools the fake IDE lists (none by default, so
 *   an optional one like debug_run_configuration is absent unless a test asks for it)
 * @param {(name: string, args: object) => unknown} [opts.callTool] - overrides the payload
 * @param {(projectRoot: string) => Promise<any[]>} [opts.readIdeaRunConfigs] - the `.idea/`
 *   catalogue the MCP path reads to rebuild terminal command lines; installed only when a
 *   test asks, so that every other test exercises the real read
 */
export function fakeCliDeps(opts = {}) {
    const tty = opts.tty ?? false;
    const stdout = fakeStream(tty);
    const stderr = fakeStream(tty);
    const calls = [];
    /** Every plan handed to the execution seam. Empty means nothing was ever launched. */
    const executed = [];
    /** Every context the execution seam was handed (calls, the shared client, connectAs). */
    const executeContexts = [];
    /** Every call to the --configure screen. */
    const configured = [];
    /** Every hand-over to the phase-8 terminal fallback. */
    const fellBack = [];
    /** Flags the MCP-unavailable prompt was asked to decide on. */
    const asked = [];
    /** Options every discoverPort() call was made with, so a retry can be shown to repeat it. */
    const discoveries = [];
    /** Successive discoverPort() answers; the last one repeats once the list runs out. */
    const ports = opts.ports ? [...opts.ports] : null;
    let closed = false;

    const deps = {
        stdout,
        stderr,
        env: { NO_COLOR: '1' },
        cwd: opts.cwd ?? process.cwd(),
        // The plans these tests pin are POSIX command lines; on a Windows runner the real
        // platform would refuse them (src/exec/terminalShell.js). Tests of that refusal set win32.
        platform: 'linux',

        stdin: { isTTY: tty },

        discoverPort: async (discoverOpts) => {
            discoveries.push(discoverOpts ?? {});
            if (ports) return ports.length > 1 ? ports.shift() : ports[0];
            return opts.port === undefined ? 64542 : opts.port;
        },

        runTerminalFallback: async (ctx) => {
            fellBack.push(ctx);
            return 0;
        },

        executePlan: async (plan, ctx) => {
            executed.push(plan);
            executeContexts.push(ctx);
            return 0;
        },

        runConfigure: async (args) => {
            configured.push(args);
            return 0;
        },

        connectMcp: async (port, connectOpts) => {
            calls.push({ type: 'connect', port, projectPath: connectOpts?.projectPath, clientName: connectOpts?.clientName });
            return {
                projectPath: connectOpts?.projectPath,
                callTool: async (name, args) => {
                    calls.push({ type: 'call', name, args });
                    if (opts.callTool) return opts.callTool(name, args);
                    return opts.configurations ?? FIXTURE;
                },
                listTools: async () => (opts.tools ?? []).map((name) => ({ name })),
                close: async () => { closed = true; },
            };
        },
    };

    if (opts.readIdeaRunConfigs) deps.readIdeaRunConfigs = opts.readIdeaRunConfigs;

    // Installed only when a test scripts an answer; otherwise the real decision logic
    // runs, so a test can check the whole unreachable-IDE path end to end.
    if (opts.fallbackChoice) {
        deps.resolveFallbackChoice = async (flags, retryDiscover, choiceOpts) => {
            asked.push(flags);
            return typeof opts.fallbackChoice === 'function'
                ? opts.fallbackChoice(flags, retryDiscover, choiceOpts)
                : opts.fallbackChoice;
        };
    }

    return {
        deps,
        calls,
        executed,
        executeContexts,
        configured,
        fellBack,
        asked,
        discoveries,
        get closed() { return closed; },
        stdout: () => stdout.text(),
        stderr: () => stderr.text(),
        output: () => stdout.text() + stderr.text(),
    };
}
