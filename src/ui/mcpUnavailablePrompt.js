/**
 * What happens when the IDE's MCP Server cannot be reached.
 *
 * The UX the plan fixes for this case is a message with two options, never a silent
 * fallback: the whole point of the product is native Run/Debug tabs, so quietly opening
 * OS terminal windows instead would be a different program than the one that was asked
 * for. The user is told why, and chooses.
 *
 * Split the same way --configure is (configureLogic.js / configure.js): every decision —
 * the flag bypass, the retry loop, the mapping from an answer to an outcome — lives in
 * resolveFallbackChoice() and is unit-tested with an injected prompt, while the only
 * part that needs a terminal is the single select() call in promptFallbackChoice().
 */
import { select } from '@inquirer/prompts';

import { FALLBACK_MODES } from '../modes.js';
import { isCancelled } from './promptCancel.js';

// Re-exported so existing importers keep working; the list itself lives in modes.js.
export { FALLBACK_MODES };

/**
 * How many times `--fallback=retry` re-probes before giving up, and how long it waits
 * between attempts.
 *
 * Bounded, unlike the interactive loop, and that asymmetry is the point. Interactively,
 * every extra attempt costs a deliberate keypress, so "keep trying" can be unbounded —
 * the user is the bound. Non-interactively there is nobody to stop, and an unbounded
 * poll inside a CI job or a shell script is a hang that looks like a working command.
 * Five attempts a second apart covers the case the flag is actually for (WebStorm is
 * starting up, or the MCP Server was just switched on) without ever becoming one.
 */
export const RETRY_ATTEMPTS = 5;
export const RETRY_DELAY_MS = 1000;

/**
 * @typedef {'retry' | 'terminal'} FallbackMode
 * @typedef {'retry' | 'terminal' | 'cancel'} FallbackAnswer
 *
 * Why the CLI stopped asking. Carried out rather than turned into a message here so the
 * caller keeps ownership of exit codes, exactly as resolveName() leaves that to cli.js.
 * @typedef {'non-interactive' | 'retries-exhausted'} UnavailableReason
 *
 * @typedef {{ kind: 'connected', port: number }
 *   | { kind: 'terminal' }
 *   | { kind: 'cancelled' }
 *   | { kind: 'unavailable', reason: UnavailableReason, attempts?: number }} FallbackOutcome
 */

/**
 * The exact Settings path, from phase 0 of the plan.
 *
 * Kept as one string used by both the prompt header and the give-up error: the point of
 * the message is that it can be followed without guessing, so the two must not drift.
 * Brave Mode is named in full because that is the label in the IDE, and without it every
 * launch stops for a confirmation click — which looks like wsc hanging.
 *
 * The port is part of the instructions for a reason: the IDE publishes it *only* on that
 * screen (mcpServer.xml stores enableMcpServer/enableBraveMode and nothing else), so
 * there is no file wsc could read instead, and the scan it falls back to is a lottery.
 */
export const MCP_SETUP_HELP =
    "cannot reach WebStorm's MCP Server.\n" +
    '  Turn it on in Settings → Tools → MCP Server ("Enable MCP Server"), and enable\n' +
    '  "Run shell commands or run configurations without confirmation (Brave Mode)"\n' +
    '  there too — otherwise every launch waits for a click in the IDE.\n' +
    '  The same screen shows the port, as http://127.0.0.1:<port>/sse. The IDE writes it\n' +
    '  nowhere on disk, so pass it with --mcp-port or WSC_MCP_PORT; Help → Edit Custom VM\n' +
    '  Options → -Didea.mcp.server.force.port=<port> pins it across restarts.';

/**
 * The full text for "the CLI gave up".
 *
 * @param {{ reason: UnavailableReason, attempts?: number, terminalAvailable?: boolean }} outcome
 * @returns {string}
 */
export function mcpUnavailableMessage(outcome) {
    const tail = outcome.reason === 'retries-exhausted'
        ? `  --fallback=retry gave up after ${outcome.attempts ?? RETRY_ATTEMPTS} attempts.`
        // No TTY means the two-option prompt would be a question asked into a pipe, which
        // is indistinguishable from a hang — so the flags are named instead of drawn.
        : '  Not a terminal, so there is nobody to ask: re-run with --fallback=retry to\n' +
          '  poll for the IDE' +
          (outcome.terminalAvailable === false ? '.' : ', or --fallback=terminal to launch without it.');

    return `${MCP_SETUP_HELP}\n${tail}`;
}

/**
 * What the second option promises when there *is* a way to proceed without the IDE.
 *
 * A launch is the default one; `--list` overrides it, because that path opens no terminal
 * at all — it reads the catalogue WebStorm saved to disk. An option has to name what
 * pressing it does, and the two do different things.
 */
export const WITHOUT_IDE_LABEL = 'Continue without IDE tabs (OS terminal)';

/**
 * Ask which way out the user wants.
 *
 * The thin half: one select() call and nothing else, so there is no logic in here that a
 * test would have wanted to reach. Checked by hand against the plan's phase-7 checklist.
 *
 * @param {object} opts
 * @param {boolean} [opts.terminalAvailable] - false when there is nothing a terminal could run
 * @param {string} [opts.withoutIdeLabel] - overrides WITHOUT_IDE_LABEL
 * @param {(config: any) => Promise<FallbackAnswer>} [opts.select] - injected in tests
 * @returns {Promise<FallbackAnswer>}
 */
export async function promptFallbackChoice(opts = {}) {
    const ask = opts.select ?? select;

    // With --configure there is no launch to move anywhere, so the second option is
    // "give up" rather than a terminal fallback that would have nothing to open.
    const second = opts.terminalAvailable === false
        ? { name: 'Give up (nothing to configure without the IDE)', value: 'cancel' }
        : { name: opts.withoutIdeLabel ?? WITHOUT_IDE_LABEL, value: 'terminal' };

    return ask({
        message: 'WebStorm is not answering. What now?',
        choices: [{ name: 'Try again — the MCP Server is on now', value: 'retry' }, second],
    });
}

/**
 * Decide what to do about an unreachable MCP Server.
 *
 * Called only after discoverPort() has already returned null once, and re-runs it in
 * place: "try again" must not mean "start wsc over", because the project, the preset and
 * the resolved flags are all already worked out by this point.
 *
 * discoverPort is passed as a zero-argument thunk rather than the module function, so
 * every retry repeats the *same* lookup the first attempt made — same --mcp-port, same
 * WSC_MCP_PORT, same scan window. discoverPort() itself holds no state between calls, so
 * it needed nothing new to support this.
 *
 * @param {object} flags
 * @param {FallbackMode} [flags.fallback] - from --fallback; bypasses the prompt entirely
 * @param {boolean} [flags.interactive] - stdin and stdout are both a TTY
 * @param {boolean} [flags.terminalAvailable] - false when a terminal fallback cannot apply
 *   (--configure). Callers must reject `fallback: 'terminal'` in that case themselves,
 *   up front, so the user hears about it before the IDE is ever contacted.
 * @param {() => Promise<number | null>} discoverPort - one more attempt at finding the port
 * @param {object} [opts]
 * @param {{ info: Function, warn: Function }} [opts.log]
 * @param {string} [opts.withoutIdeLabel] - what the without-IDE option promises, when the
 *   caller's is not a launch. Sits with `prompt` rather than in `flags` because it shapes
 *   the screen, not the decision.
 * @param {(o: { terminalAvailable: boolean, withoutIdeLabel?: string }) => Promise<FallbackAnswer>}
 *   [opts.prompt] - injected in tests
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injected in tests, so no test waits a second
 * @param {number} [opts.attempts] - bound for --fallback=retry
 * @param {number} [opts.delayMs]
 * @returns {Promise<FallbackOutcome>}
 */
export async function resolveFallbackChoice(flags, discoverPort, opts = {}) {
    const log = opts.log ?? { info: () => {}, warn: () => {} };
    const prompt = opts.prompt ?? promptFallbackChoice;
    const sleep = opts.sleep ?? defaultSleep;
    const attempts = opts.attempts ?? RETRY_ATTEMPTS;
    const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
    const terminalAvailable = flags.terminalAvailable !== false;

    // A flag is the user having answered the question in advance, so it wins over the
    // prompt in both directions — including interactively, where the plan's contract is
    // that --fallback bypasses the screen rather than pre-selecting an option on it.
    if (flags.fallback === 'terminal') return { kind: 'terminal' };

    if (flags.fallback === 'retry') {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            // Waiting *before* the probe, not after: discoverPort() failed a moment ago,
            // so an immediate re-probe only asks the same dead port the same question.
            await sleep(delayMs);
            log.info(`looking for the MCP Server again (${attempt}/${attempts})`);

            const port = await discoverPort();
            if (port !== null) return { kind: 'connected', port };
        }
        return { kind: 'unavailable', reason: 'retries-exhausted', attempts };
    }

    // Without a terminal there is nothing to draw the prompt on and nobody to answer it.
    // Unlike --configure this is not the end of the road, though: the caller turns it into
    // a message naming the two flags, so a script has a documented way to say what it wants.
    if (!flags.interactive) return { kind: 'unavailable', reason: 'non-interactive' };

    // Unbounded on purpose — see RETRY_ATTEMPTS. Every iteration blocks on a human
    // choosing "try again", so the loop cannot spin on its own.
    for (;;) {
        /** @type {FallbackAnswer} */
        let answer;
        try {
            answer = await prompt({ terminalAvailable, withoutIdeLabel: opts.withoutIdeLabel });
        } catch (err) {
            // Ctrl-C at the prompt is an ordinary way to back out, exactly as in --configure.
            if (isCancelled(err)) return { kind: 'cancelled' };
            throw err;
        }

        if (answer === 'terminal') return { kind: 'terminal' };
        if (answer === 'cancel') return { kind: 'cancelled' };

        const port = await discoverPort();
        if (port !== null) return { kind: 'connected', port };

        log.warn('still nothing on that port — the MCP Server may not be enabled yet');
    }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
