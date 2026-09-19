import http from 'node:http';
import net from 'node:net';

/**
 * Start a throwaway HTTP server on an ephemeral port.
 *
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startServer(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port assigned');

    return {
        port: address.port,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** Server that behaves like a live MCP Server: 200 + text/event-stream that stays open. */
export function startMcpLikeServer() {
    return startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': ping\n\n');
        // Deliberately never ended — the probe must not wait for the stream to finish.
    });
}

/** Server that answers on the port but is not MCP (e.g. the IDE built-in web server). */
export function startPlainServer() {
    return startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
    });
}

/** Server that accepts the connection but never answers — exercises the probe timeout. */
export function startSilentServer() {
    return startServer(() => {
        // no response, ever
    });
}

/**
 * Occupy a real TCP port, the way a debugger already attached to 9229 would.
 *
 * A real listener rather than a stub: the inspector-port check asks the operating system
 * whether a bind succeeds, and only the OS decides what counts as "already in use".
 *
 * @param {string} [host]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function occupyPort(host = '127.0.0.1') {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host, port: 0 }, resolve));

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port assigned');

    return {
        port: address.port,
        close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
    };
}
