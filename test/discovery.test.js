import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_FALLBACK_RANGE,
    InvalidPortError,
    discoverPort,
    parsePort,
    probePort,
} from '../src/mcp/discovery.js';
import { startMcpLikeServer, startPlainServer, startSilentServer } from '../test-utils/fake-server.js';

/** Swallows debug output so tests stay quiet. */
const quietLog = { debug: () => {} };

describe('parsePort', () => {
    test('accepts a numeric string', () => {
        assert.equal(parsePort('64542'), 64542);
    });

    test('accepts a number', () => {
        assert.equal(parsePort(64542), 64542);
    });

    test('rejects non-numeric input', () => {
        assert.equal(parsePort('abc'), null);
    });

    test('rejects empty and missing values', () => {
        assert.equal(parsePort(''), null);
        assert.equal(parsePort(undefined), null);
        assert.equal(parsePort(null), null);
    });

    test('rejects ports outside the TCP range', () => {
        assert.equal(parsePort(0), null);
        assert.equal(parsePort(70000), null);
        assert.equal(parsePort(-1), null);
    });

    test('rejects fractional ports', () => {
        assert.equal(parsePort('64542.5'), null);
    });
});

describe('probePort', () => {
    test('returns true for a server answering text/event-stream', async () => {
        const server = await startMcpLikeServer();
        try {
            assert.equal(await probePort(server.port), true);
        } finally {
            await server.close();
        }
    });

    test('returns false for a server that is not MCP', async () => {
        const server = await startPlainServer();
        try {
            assert.equal(await probePort(server.port), false);
        } finally {
            await server.close();
        }
    });

    test('returns false when nothing is listening', async () => {
        // Take a port, then release it, so we know it is free.
        const server = await startMcpLikeServer();
        const port = server.port;
        await server.close();

        assert.equal(await probePort(port), false);
    });

    test('returns false instead of hanging when the server never answers', async () => {
        const server = await startSilentServer();
        try {
            assert.equal(await probePort(server.port, { timeoutMs: 100 }), false);
        } finally {
            await server.close();
        }
    });

    test('returns false on a non-2xx response', async () => {
        const server = await startPlainServer();
        try {
            const fakeFetch = async () =>
                new Response('nope', { status: 503, headers: { 'content-type': 'text/event-stream' } });
            assert.equal(await probePort(server.port, { fetch: fakeFetch }), false);
        } finally {
            await server.close();
        }
    });
});

describe('discoverPort — explicit port', () => {
    test('returns the port passed as explicitPort when it is live', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({ explicitPort: server.port, env: {}, log: quietLog });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });

    test('reads the port from WSC_MCP_PORT', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                env: { WSC_MCP_PORT: String(server.port) },
                log: quietLog,
            });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });

    test('explicitPort wins over WSC_MCP_PORT', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                explicitPort: server.port,
                env: { WSC_MCP_PORT: '1' },
                log: quietLog,
            });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });

    test('returns null when the explicit port is dead — no silent fallback to a scan', async () => {
        const server = await startMcpLikeServer();
        const deadPort = server.port;
        await server.close();

        const live = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                explicitPort: deadPort,
                env: {},
                fallbackRange: [live.port, live.port],
                log: quietLog,
            });
            assert.equal(port, null, 'a pinned port that is down must not resolve to another port');
        } finally {
            await live.close();
        }
    });

    test('returns null when the explicit port answers but is not MCP', async () => {
        const server = await startPlainServer();
        try {
            const port = await discoverPort({ explicitPort: server.port, env: {}, log: quietLog });
            assert.equal(port, null);
        } finally {
            await server.close();
        }
    });

    test('throws a named error for an invalid --mcp-port', async () => {
        await assert.rejects(
            () => discoverPort({ explicitPort: 'abc', env: {}, log: quietLog }),
            (err) => {
                // Typed so the CLI can report it as a usage error instead of a stack trace.
                assert.ok(err instanceof InvalidPortError);
                assert.equal(err.source, '--mcp-port');
                assert.equal(err.value, 'abc');
                assert.match(err.message, /--mcp-port: "abc" is not a valid port/);
                return true;
            },
        );
    });

    test('throws a named error for an invalid WSC_MCP_PORT', async () => {
        await assert.rejects(
            () => discoverPort({ env: { WSC_MCP_PORT: '99999' }, log: quietLog }),
            (err) => {
                assert.ok(err instanceof InvalidPortError);
                assert.equal(err.source, 'WSC_MCP_PORT');
                return true;
            },
        );
    });

    test('ignores an empty WSC_MCP_PORT and falls through to the scan', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                env: { WSC_MCP_PORT: '' },
                fallbackRange: [server.port, server.port],
                log: quietLog,
            });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });
});

describe('discoverPort — fallback scan', () => {
    test('finds a live server inside the range', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                env: {},
                fallbackRange: [server.port - 2, server.port + 2],
                log: quietLog,
            });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });

    test('returns null when nothing in the range answers', async () => {
        const server = await startMcpLikeServer();
        const port = server.port;
        await server.close();

        const found = await discoverPort({
            env: {},
            fallbackRange: [port, port],
            log: quietLog,
        });
        assert.equal(found, null);
    });

    test('returns null immediately when the scan is disabled', async () => {
        const probed = [];
        const fakeFetch = async (url) => {
            probed.push(url);
            throw new Error('should not be called');
        };

        const port = await discoverPort({
            env: {},
            fallbackRange: null,
            fetch: fakeFetch,
            log: quietLog,
        });

        assert.equal(port, null);
        assert.deepEqual(probed, [], 'no port should be probed when the scan is disabled');
    });

    test('probes every port of the range across batch boundaries', async () => {
        const range = /** @type {[number, number]} */ ([20000, 20099]);
        const probed = [];
        const fakeFetch = async (url) => {
            probed.push(Number(new URL(url).port));
            return new Response(null, { status: 404 });
        };

        const port = await discoverPort({ env: {}, fallbackRange: range, fetch: fakeFetch, log: quietLog });

        assert.equal(port, null);
        assert.equal(probed.length, 100);
        assert.equal(Math.min(...probed), 20000);
        assert.equal(Math.max(...probed), 20099);
    });

    test('stops scanning once a port answers', async () => {
        const target = 20005;
        const probed = [];
        const fakeFetch = async (url) => {
            const port = Number(new URL(url).port);
            probed.push(port);
            return port === target
                ? new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })
                : new Response(null, { status: 404 });
        };

        const port = await discoverPort({
            env: {},
            fallbackRange: [20000, 20999],
            fetch: fakeFetch,
            log: quietLog,
        });

        assert.equal(port, target);
        assert.ok(probed.length < 100, `scan should stop early, probed ${probed.length} ports`);
    });

    test('probes the /sse path on localhost', async () => {
        const urls = [];
        const fakeFetch = async (url) => {
            urls.push(url);
            return new Response(null, { status: 404 });
        };

        await discoverPort({ env: {}, fallbackRange: [20000, 20000], fetch: fakeFetch, log: quietLog });
        assert.deepEqual(urls, ['http://127.0.0.1:20000/sse']);
    });

    test('the default range is a narrow, deliberate window', () => {
        const [start, end] = DEFAULT_FALLBACK_RANGE;
        assert.ok(start < end);
        assert.ok(end - start <= 500, 'a wide default scan would be slow and still unreliable');
    });
});

describe('discoverPort — defaults', () => {
    test('falls back to process.env when no env is injected', async () => {
        const server = await startMcpLikeServer();
        const previous = process.env.WSC_MCP_PORT;
        process.env.WSC_MCP_PORT = String(server.port);
        try {
            assert.equal(await discoverPort({ log: quietLog }), server.port);
        } finally {
            if (previous === undefined) delete process.env.WSC_MCP_PORT;
            else process.env.WSC_MCP_PORT = previous;
            await server.close();
        }
    });

    test('works without an injected logger', async () => {
        const server = await startMcpLikeServer();
        try {
            assert.equal(await discoverPort({ explicitPort: server.port, env: {} }), server.port);
        } finally {
            await server.close();
        }
    });

    test('treats an explicitPort of null as "not provided"', async () => {
        const server = await startMcpLikeServer();
        try {
            const port = await discoverPort({
                explicitPort: null,
                env: {},
                fallbackRange: [server.port, server.port],
                log: quietLog,
            });
            assert.equal(port, server.port);
        } finally {
            await server.close();
        }
    });

    test('scans DEFAULT_FALLBACK_RANGE when no range is given', async () => {
        const probed = [];
        const fakeFetch = async (url) => {
            probed.push(Number(new URL(url).port));
            return new Response(null, { status: 404 });
        };

        const port = await discoverPort({ env: {}, fetch: fakeFetch, log: quietLog });

        assert.equal(port, null);
        assert.equal(Math.min(...probed), DEFAULT_FALLBACK_RANGE[0]);
        assert.equal(Math.max(...probed), DEFAULT_FALLBACK_RANGE[1]);
    });
});

describe('probePort — content-type handling', () => {
    test('returns false when a 200 response carries no content-type', async () => {
        const fakeFetch = async () => new Response(null, { status: 200 });
        assert.equal(await probePort(20000, { fetch: fakeFetch }), false);
    });

    test('accepts text/event-stream with parameters', async () => {
        const fakeFetch = async () =>
            new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream;charset=UTF-8' } });
        assert.equal(await probePort(20000, { fetch: fakeFetch }), true);
    });

    test('releases the response body so the SSE connection does not leak', async () => {
        let cancelled = false;
        const fakeFetch = async () => ({
            ok: true,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: { cancel: async () => { cancelled = true; } },
        });

        assert.equal(await probePort(20000, { fetch: fakeFetch }), true);
        assert.equal(cancelled, true, '/sse never ends — the body must be cancelled');
    });

    test('survives a body that refuses to be cancelled', async () => {
        const fakeFetch = async () => ({
            ok: true,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: { cancel: async () => { throw new Error('already released'); } },
        });

        // A failed cleanup must not turn a live server into "no MCP here".
        assert.equal(await probePort(20000, { fetch: fakeFetch }), true);
    });
});
