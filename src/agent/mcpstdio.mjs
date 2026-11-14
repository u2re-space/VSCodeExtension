/**
 * @file src/agent/mcpstdio.mjs
 * @module agent/mcpstdio
 * @purpose The entry point of the stdio server of MCP of the editor.
 *
 *   The process speaks the Model Context Protocol over stdio: one JSON-RPC message per
 *   line in, one answer per line out. Any MCP client may take it: another AI system, a
 *   script, another editor.
 *
 *   The tools of the editor live in the editor: the editor publishes them on the bus of
 *   the agent server, and the server calls them back. The server of this process is a
 *   proxy of that way: it asks the MCP server of the agent for the tools of the editor
 *   and calls them through it.
 *
 *   The address of the agent server comes from the record `serve.json` of the homes of
 *   the server: `AI_SERVE_HOME`/`~/.ai-serve` first, `AI_AGENT_HOME`/`~/.ai-agent` after.
 *
 * @depends agent/mcp, agent/mcpclient, agent/mcpproxy, agent/endpoint
 * @usedBy none
 * @exports runStdioServer
 * @ai.tags mcp, stdio, server
 * @ai.hint io
 */

import { createMcpClient } from './mcpclient.mjs';
import { createMcpServer, startStdioServer } from './mcp.mjs';
import { createEditorToolProvider } from './mcpproxy.mjs';
import { homeDirectories, resolveEndpoint } from './endpoint.mjs';
import { readFirstServeRecordFile } from './servefile.mjs';

/**
 * Run the server of MCP of the editor over stdio.
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 *           env?: object, fetchImpl?: Function|null, onStatus?: Function|null }} [options]
 * @returns {Promise<{ close: () => void, endpoint: object|null }>}
 */
export async function runStdioServer({
    input = process.stdin,
    output = process.stdout,
    env = process.env,
    fetchImpl = globalThis.fetch,
    onStatus = null,
} = {}) {
    const record = await readFirstServeRecordFile(homeDirectories(env));
    const endpoint = record
        ? resolveEndpoint({ record, settings: { port: 0, token: '' }, ownPid: null, alive: true })
        : null;

    const client = createMcpClient({ fetchImpl, onStatus });
    if (endpoint?.mcp) {
        client.connect({ url: endpoint.mcp, token: endpoint.token });
    }

    const provider = createEditorToolProvider({ client });
    const server = createMcpServer({
        name: 'vext-vscode',
        version: '0.1.0',
        listTools: provider.listTools,
        callTool: provider.callTool,
    });

    const stdio = startStdioServer({ server, input, output });
    return {
        endpoint,
        close() {
            client.close();
            stdio.close();
        },
    };
}
