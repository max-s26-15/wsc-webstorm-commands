#!/usr/bin/env node
/**
 * Manual diagnostic — deliberately NOT part of the CLI.
 *
 * When `wsc` misbehaves, the first question is always "is it my code or is it the
 * setup?". This script answers that by walking the same path the CLI takes —
 * discover port → connect → list tools → read run configurations — and reporting
 * each step separately, so a disabled MCP Server looks nothing like a broken client.
 *
 * Keep it after phase 2: MCP tool signatures change between IDE versions, and this
 * is the fastest way to see what a new WebStorm actually returns.
 *
 * Installed from npm this is the `wsc-mcp-probe` command; in a clone, `npm run mcp:probe --`.
 *
 * Usage:
 *   wsc-mcp-probe                        # probe the current project
 *   wsc-mcp-probe /path/to/project       # probe another open project
 *   wsc-mcp-probe --raw > configs.json   # machine-readable payload
 *   wsc-mcp-probe --save-fixture         # refresh the test fixture (a clone only)
 *   WSC_MCP_PORT=64542 wsc-mcp-probe --verbose
 *
 * Progress goes to stderr, the payload to stdout, so `--raw` can be redirected.
 */
import { parseArgs } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPort } from '../src/mcp/discovery.js';
import { AmbiguousProjectError, McpToolError, connectMcp } from '../src/mcp/client.js';
import { createLogger } from '../src/log.js';

const HELP = `wsc-mcp-probe — check that WebStorm's MCP Server is reachable

Usage:
  wsc-mcp-probe [options] [projectPath]

Options:
      --mcp-port <n>  MCP port (default: WSC_MCP_PORT, then a best-effort scan)
      --raw           print the raw get_run_configurations payload to stdout
      --save-fixture  overwrite test/fixtures/run-configurations.json (in a clone only)
  -v, --verbose       show every MCP call
  -h, --help          show this help
`;

const FIXTURE_PATH = fileURLToPath(new URL('../test/fixtures/run-configurations.json', import.meta.url));

const { values, positionals } = parseArgs({
    options: {
        'mcp-port': { type: 'string' },
        raw: { type: 'boolean' },
        'save-fixture': { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
});

if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
}

const log = createLogger({ level: values.verbose ? 'debug' : 'info' });

/** Marks a completed step. Progress lines go to stderr so --raw stays pipeable. */
const step = (ok, text) => log.info(`${ok ? '✓' : '✗'} ${text}`);

// The fixture lives in test/, which an npm install does not ship: say so before contacting anything.
if (values['save-fixture'] && !existsSync(path.dirname(FIXTURE_PATH))) {
    process.stderr.write('wsc-mcp-probe: --save-fixture refreshes the test fixture, which only a clone of the repository has\n');
    process.exit(2);
}

/**
 * The project the IDE should act on. Defaults to cwd, exactly like the CLI will, and is the
 * real path for the same reason: the IDE knows a project by its real path only (a symlinked
 * one reads as "not an open project"), so the probe and wsc must send the same one.
 */
const typedPath = path.resolve(positionals[0] ?? process.cwd());
const projectPath = await realpath(typedPath).catch(() => typedPath);

// ── 1. Port ──────────────────────────────────────────────────────────────────
const port = await discoverPort({ explicitPort: values['mcp-port'], log }).catch((err) => {
    log.error(err.message);
    process.exit(2);
});

if (port === null) {
    step(false, 'no MCP Server found');
    log.info('');
    log.info('Check, in order:');
    log.info('  1. WebStorm is running');
    log.info('  2. Settings → Tools → MCP Server → Enable MCP Server is on');
    log.info('  3. Brave Mode is on (otherwise every call waits for a UI confirmation)');
    log.info('  4. WSC_MCP_PORT matches -Didea.mcp.server.force.port from Custom VM Options');
    process.exit(1);
}
step(true, `MCP Server on port ${port}`);

// ── 2. Connect ───────────────────────────────────────────────────────────────
let client;
try {
    client = await connectMcp(port, { projectPath, log });
} catch (err) {
    step(false, `handshake failed: ${err.message}`);
    process.exit(1);
}
step(true, `handshake complete (project: ${projectPath})`);

try {
    // ── 3. Tools ─────────────────────────────────────────────────────────────
    const tools = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    step(true, `${tools.length} tools available`);

    // The three tools the whole CLI rests on — a missing one explains everything else.
    for (const required of ['get_run_configurations', 'execute_run_configuration', 'execute_terminal_command']) {
        step(names.has(required), required);
    }

    // Not required: both come from the optional wsc Companion plugin (ide-plugin/). The first lets
    // `:debug` open a real Debug tab, the second makes every Terminal tab a real terminal. A ✗
    // here only means the plugin is not installed (or is an older build, for the second).
    step(names.has('debug_run_configuration'), 'debug_run_configuration (optional, from the wsc Companion plugin)');
    step(names.has('open_terminal_tab'), 'open_terminal_tab (optional, from the wsc Companion plugin)');

    // ── 4. Run configurations ────────────────────────────────────────────────
    const payload = await client.callTool('get_run_configurations');
    const configurations = payload?.configurations ?? [];
    step(true, `${configurations.length} run configurations`);

    if (values.raw) {
        log.out(JSON.stringify(payload, null, 2));
    } else {
        const width = Math.max(0, ...configurations.map((c) => c.name.length));
        for (const config of configurations) {
            log.out(`  ${config.name.padEnd(width)}  ${config.description ?? ''}`);
        }
    }

    if (values['save-fixture']) {
        writeFileSync(FIXTURE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
        step(true, `fixture written to ${FIXTURE_PATH}`);
    }
} catch (err) {
    if (err instanceof AmbiguousProjectError) {
        // The IDE reports both cases identically, so tell them apart by the path we sent.
        step(
            false,
            err.projects.includes(projectPath)
                ? 'the IDE could not pick a project'
                : `not an open project: ${projectPath}`,
        );
        log.info('Re-run with one of:');
        for (const project of err.projects) log.info(`  wsc-mcp-probe ${project}`);
        process.exit(1);
    }
    if (err instanceof McpToolError) {
        step(false, err.message);
        process.exit(1);
    }
    throw err;
} finally {
    await client.close();
}
