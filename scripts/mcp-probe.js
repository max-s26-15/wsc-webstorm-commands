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
 * Usage:
 *   node scripts/mcp-probe.js                        # probe the current project
 *   node scripts/mcp-probe.js /path/to/project       # probe another open project
 *   node scripts/mcp-probe.js --raw > configs.json   # machine-readable payload
 *   node scripts/mcp-probe.js --save-fixture         # refresh the test fixture
 *   WSC_MCP_PORT=64542 node scripts/mcp-probe.js --verbose
 *
 * Progress goes to stderr, the payload to stdout, so `--raw` can be redirected.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { discoverPort } from '../src/mcp/discovery.js';
import { AmbiguousProjectError, McpToolError, connectMcp } from '../src/mcp/client.js';
import { createLogger } from '../src/log.js';

const HELP = `mcp-probe — check that WebStorm's MCP Server is reachable

Usage:
  node scripts/mcp-probe.js [options] [projectPath]

Options:
      --mcp-port <n>  MCP port (default: WSC_MCP_PORT, then a best-effort scan)
      --raw           print the raw get_run_configurations payload to stdout
      --save-fixture  overwrite test/fixtures/run-configurations.json
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

/** The project the IDE should act on. Defaults to cwd, exactly like the CLI will. */
const projectPath = positionals[0] ?? process.cwd();

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

    // Not required: it comes from the optional wsc IDE plugin (ide-plugin/), and is what would
    // let `:debug` open a real Debug tab. A ✗ here only means the plugin is not installed.
    step(names.has('debug_run_configuration'), 'debug_run_configuration (optional, from the wsc IDE plugin)');

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
        for (const project of err.projects) log.info(`  node scripts/mcp-probe.js ${project}`);
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
