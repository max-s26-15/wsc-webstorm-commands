import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    AmbiguousProjectError,
    DEFAULT_CALL_TIMEOUT_MS,
    MCP_PATH,
    McpConnectError,
    McpToolError,
    connectMcp,
    createMcpClient,
    parseOpenProjects,
    unwrapToolResult,
} from '../src/mcp/client.js';
import { fakeSession, jsonResult, textResult } from '../test-utils/fake-session.js';
import { startServer, startSilentServer } from '../test-utils/fake-server.js';

/** The exact message WebStorm returns when several projects are open. */
const AMBIGUOUS_TEXT =
    'Unable to determine the target project for the current MCP tool call.\n' +
    ' You may specify the project path via `projectPath` parameter when calling a tool. \n' +
    'Currently open projects: {"projects":[{"path":"/home/me/a"},{"path":"/home/me/b"}]}';

describe('parseOpenProjects', () => {
    test('extracts the project paths from a real ambiguity message', () => {
        assert.deepEqual(parseOpenProjects(AMBIGUOUS_TEXT), ['/home/me/a', '/home/me/b']);
    });

    test('returns an empty list when there is no project blob', () => {
        assert.deepEqual(parseOpenProjects('some unrelated failure'), []);
    });

    test('returns an empty list on malformed JSON instead of throwing', () => {
        assert.deepEqual(parseOpenProjects('{"projects":[{"path":]}'), []);
    });
});

describe('unwrapToolResult', () => {
    test('parses a JSON text payload', () => {
        const value = unwrapToolResult('get_run_configurations', jsonResult({ configurations: [] }));
        assert.deepEqual(value, { configurations: [] });
    });

    test('returns plain text unchanged when it is not JSON', () => {
        assert.equal(unwrapToolResult('execute_terminal_command', textResult('npm run dev\n> ready')), 'npm run dev\n> ready');
    });

    test('joins multiple text parts', () => {
        const result = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false };
        assert.equal(unwrapToolResult('x', result), 'a\nb');
    });

    test('ignores non-text content parts', () => {
        const result = { content: [{ type: 'image', data: '...' }, { type: 'text', text: 'ok' }] };
        assert.equal(unwrapToolResult('x', result), 'ok');
    });

    test('prefers structuredContent when the server provides it', () => {
        const result = { content: [{ type: 'text', text: 'ignored' }], structuredContent: { a: 1 } };
        assert.deepEqual(unwrapToolResult('x', result), { a: 1 });
    });

    test('returns null for an empty result', () => {
        assert.equal(unwrapToolResult('x', { content: [] }), null);
    });

    test('throws McpToolError when isError is set — a failure must not look like data', () => {
        assert.throws(
            () => unwrapToolResult('execute_run_configuration', textResult('no such configuration', true)),
            (err) => {
                assert.ok(err instanceof McpToolError);
                assert.equal(err.tool, 'execute_run_configuration');
                assert.equal(err.detail, 'no such configuration');
                assert.match(err.message, /execute_run_configuration.*no such configuration/);
                return true;
            },
        );
    });

    test('throws AmbiguousProjectError with the open projects attached', () => {
        assert.throws(
            () => unwrapToolResult('get_run_configurations', textResult(AMBIGUOUS_TEXT, true)),
            (err) => {
                assert.ok(err instanceof AmbiguousProjectError);
                assert.ok(err instanceof McpToolError, 'must stay catchable as a tool error');
                assert.deepEqual(err.projects, ['/home/me/a', '/home/me/b']);
                return true;
            },
        );
    });

    test('reports a usable message when an error carries no text', () => {
        assert.throws(
            () => unwrapToolResult('x', { content: [], isError: true }),
            /no details returned/,
        );
    });
});

describe('createMcpClient', () => {
    test('injects projectPath into every call', async () => {
        const session = fakeSession();
        const client = createMcpClient(session, { projectPath: '/home/me/a' });

        await client.callTool('get_run_configurations');
        await client.callTool('execute_run_configuration', { configurationName: 'api' });

        assert.deepEqual(session.calls[0].arguments, { projectPath: '/home/me/a' });
        assert.deepEqual(session.calls[1].arguments, {
            configurationName: 'api',
            projectPath: '/home/me/a',
        });
    });

    test('an explicit projectPath in args wins over the session default', async () => {
        const session = fakeSession();
        const client = createMcpClient(session, { projectPath: '/home/me/a' });

        await client.callTool('get_run_configurations', { projectPath: '/home/me/b' });
        assert.equal(session.calls[0].arguments.projectPath, '/home/me/b');
    });

    test('does not add projectPath when the client has none', async () => {
        const session = fakeSession();
        const client = createMcpClient(session);

        await client.callTool('get_run_configurations');
        assert.deepEqual(session.calls[0].arguments, {});
    });

    test('does not mutate the caller’s args object', async () => {
        const session = fakeSession();
        const client = createMcpClient(session, { projectPath: '/home/me/a' });
        const args = { configurationName: 'api' };

        await client.callTool('execute_run_configuration', args);
        assert.deepEqual(args, { configurationName: 'api' });
    });

    test('passes a call timeout to the session', async () => {
        const session = fakeSession();
        await createMcpClient(session).callTool('x');
        assert.equal(session.calls[0].opts.timeout, DEFAULT_CALL_TIMEOUT_MS);

        await createMcpClient(session, { timeoutMs: 1234 }).callTool('x');
        assert.equal(session.calls[1].opts.timeout, 1234);
    });

    test('unwraps the payload instead of returning the raw envelope', async () => {
        const fixture = JSON.parse(readFileSync(new URL('./fixtures/run-configurations.json', import.meta.url), 'utf8'));
        const session = fakeSession(() => jsonResult(fixture));
        const client = createMcpClient(session, { projectPath: '/home/me/a' });

        const result = await client.callTool('get_run_configurations');
        assert.equal(result.configurations.length, 13);
        assert.ok(result.configurations.some((c) => c.name === 'api'));
    });

    test('propagates tool errors as exceptions', async () => {
        const session = fakeSession(() => textResult('Run configuration not found', true));
        const client = createMcpClient(session);

        await assert.rejects(() => client.callTool('execute_run_configuration'), McpToolError);
    });

    test('logs each call at debug level', async () => {
        const lines = [];
        const client = createMcpClient(fakeSession(), { log: { debug: (line) => lines.push(line) } });

        await client.callTool('get_run_configurations', { projectPath: '/x' });
        assert.equal(lines.length, 1);
        assert.match(lines[0], /get_run_configurations/);
    });

    test('exposes the tool list for diagnostics', async () => {
        const tools = await createMcpClient(fakeSession()).listTools();
        assert.deepEqual(tools.map((t) => t.name), ['get_run_configurations', 'execute_run_configuration']);
    });

    test('listTools returns an empty list when the session does not support it', async () => {
        const session = fakeSession();
        delete session.listTools;
        assert.deepEqual(await createMcpClient(session).listTools(), []);
    });

    test('close closes the underlying session', async () => {
        const session = fakeSession();
        const client = createMcpClient(session);

        assert.equal(session.closed, false);
        await client.close();
        assert.equal(session.closed, true);
    });

    test('exposes the project it is bound to', () => {
        assert.equal(createMcpClient(fakeSession(), { projectPath: '/home/me/a' }).projectPath, '/home/me/a');
    });
});

describe('protocol constants', () => {
    test('the streamable HTTP endpoint is /stream', () => {
        // Verified against WebStorm 2026.2; /sse is the legacy transport.
        assert.equal(MCP_PATH, '/stream');
    });
});

describe('run-configurations fixture', () => {
    test('matches the 13 configurations shown in the IDE dropdown', () => {
        const fixture = JSON.parse(readFileSync(new URL('./fixtures/run-configurations.json', import.meta.url), 'utf8'));
        assert.equal(fixture.configurations.length, 13);
        for (const config of fixture.configurations) {
            assert.equal(typeof config.name, 'string');
            assert.ok(config.name.length > 0);
        }
    });
});

describe('connectMcp — the handshake, against a real socket', () => {
    /**
     * Phase 10 finding. discoverPort() only checks that *something* answers /sse with
     * text/event-stream; the session is opened afterwards, over a second request. Between
     * the two the IDE can quit, and the best-effort range scan can hand back a port that
     * belongs to some other program entirely. Both land here — and the SDK's own
     * StreamableHTTPError has `name === 'Error'`, so before McpConnectError existed this
     * escaped runCli()'s KNOWN_ERRORS check and printed a V8 stack trace through
     * node_modules at the user. Reproduced exactly this way.
     */
    test('a port that passes the probe but is not an MCP Server is a message, not a crash', async () => {
        const server = await startServer((req, res) => {
            if (String(req.url).startsWith('/sse')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(': hi\n\n');
                return;
            }
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not here');
        });

        try {
            await assert.rejects(
                () => connectMcp(server.port, { connectTimeoutMs: 3_000 }),
                (err) => {
                    assert.ok(err instanceof McpConnectError);
                    // The name is what KNOWN_ERRORS matches on; the SDK's class has none.
                    assert.equal(err.name, 'McpConnectError');
                    assert.match(err.message, new RegExp(`could not open an MCP session on 127.0.0.1:${server.port}`));
                    // The IDE's own words are kept, so the cause is still diagnosable.
                    assert.match(err.message, /not here/);
                    assert.match(err.message, /--mcp-port/);
                    return true;
                },
            );
        } finally {
            await server.close();
        }
    });

    test('introduces itself as "wsc" unless told a name, and as that name when told', async () => {
        // The IDE titles a Terminal tab after this name, so it is behaviour, not decoration.
        const introduced = [];
        const server = await startServer((req, res) => {
            if (String(req.url).startsWith('/sse')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(': hi\n\n');
                return;
            }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                try {
                    introduced.push(JSON.parse(body).params?.clientInfo?.name);
                } catch {
                    introduced.push(undefined);
                }
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('not here');
            });
        });

        try {
            await assert.rejects(() => connectMcp(server.port, { connectTimeoutMs: 3_000 }));
            await assert.rejects(() => connectMcp(server.port, { connectTimeoutMs: 3_000, clientName: 'api > repro:stale-job' }));
            assert.deepEqual(introduced, ['wsc', 'api > repro:stale-job']);
        } finally {
            await server.close();
        }
    });

    test('a socket that accepts and never answers times out instead of hanging forever', async () => {
        const server = await startSilentServer();
        const started = Date.now();

        try {
            await assert.rejects(
                () => connectMcp(server.port, { connectTimeoutMs: 300 }),
                (err) => {
                    assert.equal(err.name, 'McpConnectError');
                    assert.match(err.message, /handshake timed out after 300ms/);
                    return true;
                },
            );
            // The guard is the point: without it the CLI sits on a half-open socket with
            // no output at all.
            assert.ok(Date.now() - started < 5_000, 'the connect must not outlive its own bound');
        } finally {
            await server.close();
        }
    });

    test('the failed session is closed, so nothing is left holding the socket', async () => {
        const server = await startSilentServer();
        try {
            await assert.rejects(() => connectMcp(server.port, { connectTimeoutMs: 200 }));
            // close() on the transport is what lets the process exit; if it were skipped
            // the pending request would keep the event loop alive and this test would hang.
            await server.close();
        } catch (err) {
            await server.close();
            throw err;
        }
    });
});
