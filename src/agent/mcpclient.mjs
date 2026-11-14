/**
 * @file src/agent/mcpclient.mjs
 * @module agent/mcpclient
 * @purpose The client of MCP of the editor: it asks the server of the bus over HTTP.
 *
 *   The server of the package keeps an MCP server on the route `/mcp` of the same port
 *   and with the same token as the bus. The editor speaks to it with JSON-RPC 2.0:
 *   `initialize`, `tools/list` and `tools/call`.
 *
 *   The list of the tools of the server holds the tools of the package and the tools of
 *   the clients of the bus: the tools of the editor itself are there too, under the
 *   name with the prefix of the client.
 *
 * @depends none
 * @usedBy agent/index
 * @exports createMcpClient, MCP_PROTOCOL_VERSION
 */

/** The version of the protocol the client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Create the client of the MCP server.
 *
 * The client keeps the address of the server and the token of it. Every call is one
 * POST: the server of the package answers with the answer of the call.
 *
 * @param {{ fetchImpl?: Function|null, onStatus?: Function|null }} [options]
 * @returns {{ connect: (endpoint: { url?: string, token?: string }|null) => void,
 *             close: () => void,
 *             listTools: () => Promise<object[]>,
 *             callTool: (name: string, args?: object) => Promise<{ text: string, isError: boolean, raw: object|null }> }}
 */
export function createMcpClient({ fetchImpl = globalThis.fetch, onStatus = null } = {}) {
    let endpoint = null;
    let seq = 0;

    /**
     * One call of the protocol.
     *
     * @param {string} method
     * @param {object|null} [params]
     * @returns {Promise<object|null>}
     */
    const call = async (method, params = null) => {
        const url = typeof endpoint?.url === 'string' ? endpoint.url : '';
        if (!url || typeof fetchImpl !== 'function') {
            return null;
        }
        const body = { jsonrpc: '2.0', id: ++seq, method };
        if (params && typeof params === 'object') {
            body.params = params;
        }
        try {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${typeof endpoint.token === 'string' ? endpoint.token : ''}`,
                },
                body: JSON.stringify(body),
            });
            if (!response?.ok) {
                onStatus?.(`MCP: ${response?.status ?? 'ошибка'}.`);
                return null;
            }
            const answer = await response.json();
            if (answer?.error) {
                onStatus?.(`MCP: ${answer.error.message ?? 'ошибка'}.`);
                return null;
            }
            return answer?.result && typeof answer.result === 'object' ? answer.result : null;
        } catch (error) {
            onStatus?.(error?.message || String(error));
            return null;
        }
    };

    return {
        connect(next) {
            endpoint = next && typeof next === 'object' ? next : null;
        },
        close() {
            endpoint = null;
        },
        /**
         * The list of the tools of the server.
         *
         * @returns {Promise<object[]>}
         */
        async listTools() {
            const result = await call('tools/list');
            const tools = Array.isArray(result?.tools) ? result.tools : [];
            return tools.filter((tool) => tool && typeof tool.name === 'string' && tool.name);
        },
        /**
         * Call a tool of the server.
         *
         * @param {string} name
         * @param {object} [args]
         * @returns {Promise<{ text: string, isError: boolean, raw: object|null }>}
         */
        async callTool(name, args = {}) {
            const result = await call('tools/call', {
                name: String(name ?? ''),
                arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
            });
            const content = Array.isArray(result?.content) ? result.content : [];
            const text = content
                .map((item) => (typeof item?.text === 'string' ? item.text : ''))
                .filter(Boolean)
                .join('\n')
                .trim();
            return { text, isError: Boolean(result?.isError), raw: result ?? null };
        },
    };
}
