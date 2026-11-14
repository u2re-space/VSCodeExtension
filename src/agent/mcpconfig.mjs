/**
 * @file src/agent/mcpconfig.mjs
 * @module agent/mcpconfig
 * @purpose The configuration of a client of MCP that takes the tools of the editor.
 *
 *   The editor ships a program of its own: the stdio server of MCP. The path of the
 *   program goes into the configuration of a client of MCP, and the client starts the
 *   program and speaks the protocol with it.
 *
 *   The program is a script of Node.js, so the configuration must name a binary that
 *   runs it as Node.js. The extension host of VSCode is an Electron process, not a
 *   Node.js one: the same binary runs a script as Node.js when the environment says so
 *   with `ELECTRON_RUN_AS_NODE`.
 *
 * @depends none
 * @usedBy agent/index
 * @exports mcpServerConfiguration
 * @ai.tags mcp, config, server
 */

/**
 * The configuration of the client of MCP.
 *
 * @param {{ execPath?: string, serverPath?: string, env?: object }} [options]
 * @returns {{ mcpServers: { vscode: { command: string, args: string[], env: object } } }}
 */
export function mcpServerConfiguration({ execPath = '', serverPath = '', env = {} } = {}) {
    const binary = String(execPath ?? '').trim();
    const name = binary.replace(/\\/g, '/').split('/').pop() ?? '';
    const isNode = /^node(\.exe)?$/i.test(name);

    const vars = {};
    if (binary && !isNode) {
        // The extension host of VSCode is Electron: the flag makes it a Node.js process.
        vars.ELECTRON_RUN_AS_NODE = '1';
    }
    for (const key of ['AI_SERVE_HOME', 'AI_AGENT_HOME']) {
        const value = env?.[key];
        if (typeof value === 'string' && value.trim()) {
            vars[key] = value;
        }
    }

    return {
        mcpServers: {
            vscode: {
                command: binary || 'node',
                args: [String(serverPath ?? '')],
                env: vars,
            },
        },
    };
}
