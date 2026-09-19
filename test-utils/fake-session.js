/**
 * Test double for an MCP session (the object @modelcontextprotocol/sdk's Client exposes).
 *
 * createMcpClient() only needs callTool/close/listTools, so the whole client can be
 * exercised without a running IDE.
 */

/** @param {string} text @param {boolean} [isError] */
export function textResult(text, isError = false) {
    return { content: [{ type: 'text', text }], isError };
}

/** @param {unknown} value */
export function jsonResult(value) {
    return textResult(JSON.stringify(value));
}

/**
 * @param {(req: { name: string, arguments: object }) => any} [handler]
 *   defaults to echoing the request back as JSON
 */
export function fakeSession(handler) {
    const calls = [];
    let closed = false;

    return {
        calls,
        get closed() {
            return closed;
        },
        async callTool(req, _schema, opts) {
            calls.push({ ...req, opts });
            const respond = handler ?? ((r) => jsonResult({ echo: r.arguments }));
            return respond(req);
        },
        async listTools() {
            return { tools: [{ name: 'get_run_configurations' }, { name: 'execute_run_configuration' }] };
        },
        async close() {
            closed = true;
        },
    };
}
