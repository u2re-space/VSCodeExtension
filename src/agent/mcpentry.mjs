/**
 * @file src/agent/mcpentry.mjs
 * @module agent/mcpentry
 * @purpose The program of the stdio server of MCP of the editor.
 *
 *   The program is the server itself: it reads the messages of the client of MCP from
 *   the standard input and writes the answers to the standard output. Nothing else goes
 *   to the standard output: a note about a failure goes to the standard error, so the
 *   channel of the protocol stays clean.
 *
 *   The program is the way for another AI system to take the tools of the editor: the
 *   path of the program goes into the configuration of the client of MCP.
 *
 * @depends agent/mcpstdio
 * @usedBy none
 * @exports main
 * @ai.tags mcp, stdio, server
 * @ai.hint io
 */

import { runStdioServer } from './mcpstdio.mjs';

/**
 * Run the program.
 *
 * @returns {Promise<void>}
 */
export async function main() {
    const note = (text) => {
        process.stderr.write(`${text}\n`);
    };
    let server = null;
    try {
        server = await runStdioServer({ onStatus: note });
    } catch (error) {
        note(`The server of MCP of the editor did not start: ${error?.message ?? String(error)}`);
        return;
    }
    if (!server.endpoint) {
        note('The agent server is not running: the tools of the editor are not there yet.');
    }
    const stop = () => {
        server.close();
        process.exit(0);
    };
    process.stdin.on('end', stop);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
