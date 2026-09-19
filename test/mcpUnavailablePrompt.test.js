import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    FALLBACK_MODES,
    MCP_SETUP_HELP,
    RETRY_ATTEMPTS,
    WITHOUT_IDE_LABEL,
    mcpUnavailableMessage,
    promptFallbackChoice,
    resolveFallbackChoice,
} from '../src/ui/mcpUnavailablePrompt.js';

/**
 * Drive resolveFallbackChoice with scripted answers instead of a terminal.
 *
 * @param {object} opts
 * @param {object} [opts.flags]
 * @param {Array<number | null>} [opts.ports] - what each discoverPort() call returns, in order
 * @param {Array<'retry' | 'terminal' | 'cancel'>} [opts.answers] - what each prompt returns
 * @param {Error} [opts.throws] - make the first prompt throw instead
 * @param {number} [opts.attempts]
 * @param {string} [opts.withoutIdeLabel]
 */
async function resolve(opts = {}) {
    const ports = [...(opts.ports ?? [])];
    const answers = [...(opts.answers ?? [])];
    /** @type {Array<{ terminalAvailable: boolean, withoutIdeLabel?: string }>} */
    const prompted = [];
    /** @type {number[]} */
    const slept = [];
    /** Sleeps and probes in the order they happened, so the two cannot be checked apart. */
    /** @type {string[]} */
    const trace = [];
    let probes = 0;

    const outcome = await resolveFallbackChoice(
        opts.flags ?? {},
        async () => {
            probes++;
            trace.push('probe');
            // Running out of scripted answers means "still nothing", never undefined.
            return ports.length > 0 ? /** @type {number | null} */ (ports.shift() ?? null) : null;
        },
        {
            prompt: async (config) => {
                prompted.push(config);
                if (opts.throws) throw opts.throws;
                const answer = answers.shift();
                assert.ok(answer !== undefined, 'the prompt was drawn more times than the test scripted');
                return answer;
            },
            sleep: async (ms) => { slept.push(ms); trace.push('sleep'); },
            attempts: opts.attempts,
            withoutIdeLabel: opts.withoutIdeLabel,
        },
    );

    return { outcome, probes, prompted, slept, trace };
}

describe('resolveFallbackChoice — --fallback bypasses the prompt', () => {
    test('--fallback=terminal answers the question in advance', async () => {
        const { outcome, probes, prompted } = await resolve({ flags: { fallback: 'terminal' } });
        assert.deepEqual(outcome, { kind: 'terminal' });
        assert.equal(prompted.length, 0);
        assert.equal(probes, 0, 'nothing to re-probe: the user asked to skip the IDE');
    });

    test('--fallback=terminal wins even when there is a terminal to ask in', async () => {
        // The plan's contract is "bypasses the prompt", not "preselects an option on it".
        const { outcome, prompted } = await resolve({ flags: { fallback: 'terminal', interactive: true } });
        assert.deepEqual(outcome, { kind: 'terminal' });
        assert.equal(prompted.length, 0);
    });

    test('--fallback=retry re-probes and connects, without drawing anything', async () => {
        const { outcome, probes, prompted } = await resolve({
            flags: { fallback: 'retry' },
            ports: [null, 64542],
        });
        assert.deepEqual(outcome, { kind: 'connected', port: 64542 });
        assert.equal(probes, 2);
        assert.equal(prompted.length, 0);
    });

    test('--fallback=retry is bounded — a script can never spin forever', async () => {
        const { outcome, probes } = await resolve({ flags: { fallback: 'retry' }, attempts: 3 });
        assert.deepEqual(outcome, { kind: 'unavailable', reason: 'retries-exhausted', attempts: 3 });
        assert.equal(probes, 3, 'gave up exactly at the bound');
    });

    test('--fallback=retry waits before every probe, not after', async () => {
        // An immediate re-probe would just ask the same dead port the same question, so
        // the order matters as much as the count.
        const { slept, probes, trace } = await resolve({ flags: { fallback: 'retry' }, attempts: 2 });
        assert.equal(slept.length, probes);
        assert.ok(slept.every((ms) => ms > 0), `expected a real delay, got ${slept.join(', ')}`);
        assert.deepEqual(trace, ['sleep', 'probe', 'sleep', 'probe']);
    });

    test('--fallback=retry is bounded interactively too, where the flag still means "do not ask me"', async () => {
        const { outcome, prompted } = await resolve({
            flags: { fallback: 'retry', interactive: true },
            attempts: 2,
        });
        assert.equal(outcome.kind, 'unavailable');
        assert.equal(prompted.length, 0);
    });

    test('the real clock is used when none is injected', async () => {
        // The only line the injected sleep hides; delayMs 0 keeps the suite instant.
        let probes = 0;
        const outcome = await resolveFallbackChoice(
            { fallback: 'retry' },
            async () => { probes++; return null; },
            { attempts: 1, delayMs: 0 },
        );
        assert.equal(outcome.kind, 'unavailable');
        assert.equal(probes, 1);
    });

    test('the default bound is the exported one', async () => {
        const { probes } = await resolve({ flags: { fallback: 'retry' } });
        assert.equal(probes, RETRY_ATTEMPTS);
    });
});

describe('resolveFallbackChoice — no terminal to ask in', () => {
    test('a non-interactive run reports rather than asking a question nobody reads', async () => {
        const { outcome, probes, prompted } = await resolve({ flags: {} });
        assert.deepEqual(outcome, { kind: 'unavailable', reason: 'non-interactive' });
        assert.equal(prompted.length, 0);
        assert.equal(probes, 0);
    });

    test('a non-interactive run never falls back to a terminal on its own', async () => {
        // Silently opening OS windows instead of IDE tabs would be a different program
        // than the one that was asked for; the plan is explicit that this must be a choice.
        const { outcome } = await resolve({ flags: { interactive: false } });
        assert.notEqual(outcome.kind, 'terminal');
    });
});

describe('resolveFallbackChoice — the interactive loop', () => {
    test('"try again" re-runs discoverPort in place and connects', async () => {
        const { outcome, probes, prompted } = await resolve({
            flags: { interactive: true },
            answers: ['retry'],
            ports: [64542],
        });
        assert.deepEqual(outcome, { kind: 'connected', port: 64542 });
        assert.equal(probes, 1);
        assert.equal(prompted.length, 1);
    });

    test('a retry that still finds nothing asks again instead of giving up', async () => {
        const { outcome, probes, prompted } = await resolve({
            flags: { interactive: true },
            answers: ['retry', 'retry', 'terminal'],
            ports: [null, null],
        });
        assert.deepEqual(outcome, { kind: 'terminal' });
        assert.equal(probes, 2);
        assert.equal(prompted.length, 3, 'the user is asked again after every failed retry');
    });

    test('the interactive loop never sleeps — the human is the delay', async () => {
        const { slept } = await resolve({
            flags: { interactive: true },
            answers: ['retry', 'terminal'],
            ports: [null],
        });
        assert.deepEqual(slept, []);
    });

    test('"continue without IDE tabs" hands over without probing again', async () => {
        const { outcome, probes } = await resolve({ flags: { interactive: true }, answers: ['terminal'] });
        assert.deepEqual(outcome, { kind: 'terminal' });
        assert.equal(probes, 0);
    });

    test('the prompt is told whether a terminal fallback applies at all', async () => {
        const { prompted } = await resolve({
            flags: { interactive: true, terminalAvailable: false },
            answers: ['cancel'],
        });
        assert.equal(prompted.length, 1);
        assert.equal(prompted[0].terminalAvailable, false);
    });

    test('a caller can rename the without-IDE option for its own screen', async () => {
        const { prompted } = await resolve({
            flags: { interactive: true },
            answers: ['terminal'],
            withoutIdeLabel: 'List what WebStorm saved',
        });
        assert.equal(prompted[0].withoutIdeLabel, 'List what WebStorm saved');
    });

    test('"give up" is a cancel, not a terminal launch', async () => {
        const { outcome } = await resolve({
            flags: { interactive: true, terminalAvailable: false },
            answers: ['cancel'],
        });
        assert.deepEqual(outcome, { kind: 'cancelled' });
    });

    test('terminalAvailable defaults to true', async () => {
        const { prompted } = await resolve({ flags: { interactive: true }, answers: ['terminal'] });
        assert.equal(prompted.length, 1);
        assert.equal(prompted[0].terminalAvailable, true);
    });
});

describe('resolveFallbackChoice — Ctrl-C', () => {
    for (const name of ['ExitPromptError', 'AbortPromptError']) {
        test(`${name} at the prompt is an ordinary cancel`, async () => {
            const err = new Error('cancelled');
            err.name = name;
            const { outcome } = await resolve({ flags: { interactive: true }, throws: err });
            assert.deepEqual(outcome, { kind: 'cancelled' });
        });
    }

    test('any other prompt failure keeps its stack', async () => {
        await assert.rejects(
            () => resolve({ flags: { interactive: true }, throws: new TypeError('boom') }),
            /boom/,
        );
    });
});

describe('promptFallbackChoice', () => {
    /** @param {boolean} [terminalAvailable] @param {string} [withoutIdeLabel] */
    async function ask(terminalAvailable, withoutIdeLabel) {
        /** @type {any[]} */
        const seen = [];
        await promptFallbackChoice({
            terminalAvailable,
            withoutIdeLabel,
            select: async (config) => { seen.push(config); return 'retry'; },
        });
        return seen[0];
    }

    test('offers exactly two options, retry first', async () => {
        const config = await ask();
        assert.equal(config.choices.length, 2);
        assert.equal(config.choices[0].value, 'retry');
        assert.equal(config.choices[1].value, 'terminal');
    });

    test('the without-IDE option says what it actually does for this caller', async () => {
        // --list opens no terminal at all: it reads what the IDE saved to .idea/. An
        // option offering "OS terminal" there would promise something pressing it does
        // not do.
        const config = await ask(undefined, 'List what WebStorm saved');
        assert.equal(config.choices[1].value, 'terminal');
        assert.equal(config.choices[1].name, 'List what WebStorm saved');
    });

    test('the label a launch uses is the default', async () => {
        const config = await ask();
        assert.equal(config.choices[1].name, WITHOUT_IDE_LABEL);
    });

    test('offers a plain give-up when a terminal fallback cannot apply', async () => {
        const config = await ask(false);
        assert.equal(config.choices[1].value, 'cancel');
        assert.doesNotMatch(config.choices[1].name, /terminal/i);
    });
});

describe('mcpUnavailableMessage', () => {
    test('quotes the exact Settings path and the Brave Mode label', async () => {
        assert.match(MCP_SETUP_HELP, /Settings → Tools → MCP Server/);
        assert.match(MCP_SETUP_HELP, /Brave Mode/);
        assert.match(MCP_SETUP_HELP, /idea\.mcp\.server\.force\.port/);
    });

    test('a non-interactive give-up names both escape-hatch flags', () => {
        const message = mcpUnavailableMessage({ reason: 'non-interactive' });
        for (const mode of FALLBACK_MODES) assert.match(message, new RegExp(`--fallback=${mode}`));
    });

    test('with --configure it does not offer a terminal that cannot run anything', () => {
        const message = mcpUnavailableMessage({ reason: 'non-interactive', terminalAvailable: false });
        assert.match(message, /--fallback=retry/);
        assert.doesNotMatch(message, /--fallback=terminal/);
    });

    test('an exhausted retry says how many attempts it made', () => {
        const message = mcpUnavailableMessage({ reason: 'retries-exhausted', attempts: 4 });
        assert.match(message, /gave up after 4 attempts/);
    });

    test('every message still starts with the setup instructions', () => {
        for (const reason of /** @type {const} */ (['non-interactive', 'retries-exhausted'])) {
            assert.ok(mcpUnavailableMessage({ reason }).startsWith(MCP_SETUP_HELP));
        }
    });
});
