/**
 * @file src/agent/mcpproxy.mjs
 * @module agent/mcpproxy
 * @purpose The provider of the tools of the editor for the stdio server of MCP.
 *
 *   The editor publishes its tools on the bus of the server with the frame
 *   `tools.register`, and the server shows them in its own MCP server under the name
 *   with the prefix of the client: `vscode__read_file`.
 *
 *   The stdio server of the editor is a proxy of that way: it asks the MCP server of the
 *   package for the list of the tools and calls the tool of the editor through it. The
 *   names lose the prefix on the way out and get it back on the way in: the client of
 *   MCP sees the tools of the editor under the names the editor knows them by.
 *
 * @depends agent/mcp
 * @usedBy agent/mcpstdio
 * @exports createEditorToolProvider
 * @ai.tags mcp, proxy, server
 * @ai.hint io
 */

import { editorToolName, serverToolName } from './mcp.mjs';

/**
 * Create the provider of the tools of the editor.
 *
 * The provider asks the MCP server of the agent through the client of MCP. The client
 * answers with the tools of the package and the tools of the clients of the bus; the
 * provider keeps the tools of the editor and drops the rest.
 *
 * @param {{ client: { listTools: () => Promise<object[]>, callTool: (name: string, args?: object) => Promise<{ text: string, isError: boolean }> } }} options
 * @returns {{ listTools: () => Promise<object[]>, callTool: (name: string, args?: object) => Promise<{ text: string, isError: boolean }> }}
 */
export function createEditorToolProvider({ client }) {
    if (!client || typeof client.listTools !== 'function' || typeof client.callTool !== 'function') {
        throw new Error('The provider needs a client of MCP.');
    }

    /**
     * The tools of the editor in the shape of MCP.
     *
     * @returns {Promise<object[]>}
     */
    const listTools = async () => {
        const list = await client.listTools();
        const out = [];
        for (const tool of Array.isArray(list) ? list : []) {
            const name = typeof tool?.name === 'string' ? tool.name : '';
            if (!name.startsWith('vscode__')) {
                continue;
            }
            out.push({
                name: editorToolName(name),
                description: typeof tool.description === 'string' ? tool.description : '',
                inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
                    ? tool.inputSchema
                    : { type: 'object', properties: {} },
            });
        }
        return out;
    };

    /**
     * Call a tool of the editor through the server of the package.
     *
     * @param {string} name the name of the tool without the prefix of the client
     * @param {object} [args]
     * @returns {Promise<{ text: string, isError: boolean }>}
     */
    const callTool = async (name, args = {}) => {
        const answer = await client.callTool(serverToolName(name), args);
        return {
            text: typeof answer?.text === 'string' ? answer.text : '',
            isError: Boolean(answer?.isError),
        };
    };

    return { listTools, callTool };
}
