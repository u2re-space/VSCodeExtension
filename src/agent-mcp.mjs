/**
 * @file src/agent-mcp.mjs
 * @module agent-mcp
 * @purpose The program of the stdio server of MCP of the editor.
 *
 *   The file is the entry point of the bundle `dist/agent-mcp.mjs`: the path of it goes
 *   into the configuration of a client of MCP, and the client speaks the protocol with
 *   the editor through it.
 *
 * @depends agent/mcpentry
 * @usedBy none
 * @exports none
 * @ai.tags mcp, stdio, entry
 */

import { main } from './agent/mcpentry.mjs';

void main();
