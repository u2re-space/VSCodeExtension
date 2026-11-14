/**
 * @file src/agent/mcp.mjs
 * @module agent/mcp
 * @purpose The MCP server of the editor: JSON-RPC 2.0 over a pair of streams.
 *
 *   The editor gives its tools to other AI systems: webdev, measurer, decomposer and
 *   every other MCP client may take the file system and the terminal of the editor.
 *   The server speaks the Model Context Protocol without an SDK: the messages are plain
 *   JSON-RPC 2.0 objects, one message per line.
 *
 *   The server answers `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
 *   `resources/read`, `prompts/list` and `prompts/get`. A message that is not valid JSON
 *   does not kill the session: the server answers with the error of the parser and goes
 *   on.
 *
 *   The tools themselves live in the editor: the editor publishes them on the bus of the
 *   server with the frame `tools.register`, and the server calls them back with the frame
 *   `tool.call`. The stdio server of this module is a proxy of that way: it asks the MCP
 *   server of the package for the list and calls the tool of the editor through it.
 *
 * @depends none
 * @usedBy agent/mcpstdio, agent/index
 * @exports MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOLS, MCP_ERROR, MCP_RESOURCES,
 *          MCP_PROMPTS, CLIENT_TOOL_SEPARATOR, editorToolName, serverToolName,
 *          errorResponse, createMcpServer, startStdioServer
 * @ai.tags mcp, jsonrpc, server
 * @ai.hint io
 */

/** The version of the protocol the server speaks first. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The versions of the protocol the server understands. */
export const MCP_SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** The codes of the errors of JSON-RPC and of MCP. */
export const MCP_ERROR = Object.freeze({
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    timeout: -32001,
    cancelled: -32800,
});

/**
 * The separator between the name of the client and the name of its tool.
 *
 * The server of the package puts the name of the client in front of the name of every
 * tool of it: the tool `read_file` of the editor `vscode` is `vscode__read_file`.
 */
export const CLIENT_TOOL_SEPARATOR = '__';

/** The name of the editor on the bus. */
export const CLIENT_NAME = 'vscode';

/**
 * The name of the tool of the editor in the list of the server.
 *
 * @param {string} name the name of the tool without the prefix
 * @returns {string}
 */
export function serverToolName(name) {
    return `${CLIENT_NAME}${CLIENT_TOOL_SEPARATOR}${String(name ?? '')}`;
}

/**
 * The name of the tool of the editor without the prefix of the client.
 *
 * The name of another client stays as it is: the server of the editor serves the tools
 * of the editor.
 *
 * @param {string} name the name of the tool of the server
 * @returns {string}
 */
export function editorToolName(name) {
    const text = String(name ?? '');
    const prefix = `${CLIENT_NAME}${CLIENT_TOOL_SEPARATOR}`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** The resources the server publishes. */
export const MCP_RESOURCES = Object.freeze([
    Object.freeze({
        uri: 'vscode://tools',
        name: 'Tools of the editor',
        description: 'The catalog of the tools of the editor.',
        mimeType: 'application/json',
    }),
]);

/** The prompts the server publishes. */
export const MCP_PROMPTS = Object.freeze([]);

/**
 * The answer of an error of JSON-RPC.
 *
 * @param {string|number|null} id the id of the message
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {object}
 */
export function errorResponse(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) {error.data = data;}
    return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Create the server of the protocol.
 *
 * The provider of the tools is outside: the server knows the protocol and the shape of
 * the answers, the provider knows the tools.
 *
 * @param {{ name?: string, version?: string, timeoutMs?: number,
 *           listTools?: () => Promise<object[]>,
 *           callTool?: (name: string, args: object) => Promise<{ text?: string, isError?: boolean }> }} [options]
 * @returns {{ handle: (message: unknown) => Promise<object|object[]|null>, listTools: () => Promise<object[]>, close: () => void }}
 */
export function createMcpServer({
    name = 'vext-vscode',
    version = '0.1.0',
    timeoutMs = 120_000,
    listTools = async () => [],
    callTool = async () => ({ text: '', isError: false }),
} = {}) {
    /** The calls that are running now: the id of the request and the abort of it. */
    const pending = new Map();

    /**
     * The catalog of the tools of the editor.
     * @returns {Promise<object[]>}
     */
    const tools = async () => {
        const list = await listTools();
        return Array.isArray(list) ? list.filter((tool) => tool && typeof tool.name === 'string' && tool.name) : [];
    };

    /**
     * The answer of `tools/call`.
     *
     * @param {string|number|null} id
     * @param {object} params
     * @returns {Promise<object|null>}
     */
    const callToolMethod = async (id, params) => {
        const toolName = params?.name;
        if (typeof toolName !== 'string' || !toolName) {
            return errorResponse(id, MCP_ERROR.invalidParams, 'The name of the tool is missing.');
        }
        const known = (await tools()).some((tool) => tool.name === toolName);
        if (!known) {
            return errorResponse(id, MCP_ERROR.invalidParams, `There is no tool named ${toolName}.`);
        }
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const controller = new AbortController();
        const entry = { controller, cancelled: false };
        const key = id === null || id === undefined ? null : String(id);
        if (key !== null) {pending.set(key, entry);}

        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
            timer.unref?.();
        });
        const work = Promise.resolve()
            .then(() => callTool(toolName, args, { signal: controller.signal }))
            .then((value) => ({ value }), (error) => ({ error }));

        try {
            const outcome = await Promise.race([work, timeout]);
            if (outcome.timedOut) {
                controller.abort();
                return errorResponse(id, MCP_ERROR.timeout, `The tool ${toolName} did not finish in ${timeoutMs} ms.`);
            }
            // A cancelled call stays unanswered: the protocol asks for it.
            if (entry.cancelled) {return null;}
            if (outcome.error) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: outcome.error?.message ?? String(outcome.error) }],
                        isError: true,
                    },
                };
            }
            const text = typeof outcome.value?.text === 'string' ? outcome.value.text : '';
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: Boolean(outcome.value?.isError) } };
        } finally {
            if (timer) {clearTimeout(timer);}
            if (key !== null) {pending.delete(key);}
        }
    };

    /**
     * The answer of one message of the protocol.
     *
     * @param {unknown} message
     * @returns {Promise<object|null>}
     */
    const handleMessage = async (message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return errorResponse(null, MCP_ERROR.invalidRequest, 'A message must be a JSON object.');
        }
        const { id, method, params } = message;
        if (typeof method !== 'string' || !method) {
            return errorResponse(id ?? null, MCP_ERROR.invalidRequest, 'The method is missing.');
        }

        if (method === 'notifications/cancelled') {
            const key = params?.requestId === undefined || params?.requestId === null ? null : String(params.requestId);
            const entry = key === null ? null : pending.get(key);
            if (entry) {
                entry.cancelled = true;
                entry.controller.abort();
            }
            return null;
        }
        if (method.startsWith('notifications/')) {return null;}

        if (method === 'initialize') {
            const wanted = params?.protocolVersion;
            const protocolVersion = MCP_SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : MCP_PROTOCOL_VERSION;
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion,
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { subscribe: false, listChanged: false },
                        prompts: { listChanged: false },
                    },
                    serverInfo: { name, version },
                },
            };
        }
        if (method === 'ping') {return { jsonrpc: '2.0', id, result: {} };}
        if (method === 'tools/list') {return { jsonrpc: '2.0', id, result: { tools: await tools() } };}
        if (method === 'tools/call') {return callToolMethod(id, params);}
        if (method === 'resources/list') {
            return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES.map((item) => ({ ...item })) } };
        }
        if (method === 'resources/read') {
            const uri = params?.uri;
            if (typeof uri !== 'string' || !uri) {
                return errorResponse(id, MCP_ERROR.invalidParams, 'The uri of the resource is missing.');
            }
            if (uri !== 'vscode://tools') {
                return errorResponse(id, MCP_ERROR.invalidParams, `There is no resource named ${uri}.`);
            }
            const catalog = await tools();
            return {
                jsonrpc: '2.0',
                id,
                result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(catalog, null, 2) }] },
            };
        }
        if (method === 'prompts/list') {return { jsonrpc: '2.0', id, result: { prompts: [] } };}
        if (method === 'prompts/get') {
            const promptName = params?.name;
            if (typeof promptName !== 'string' || !promptName) {
                return errorResponse(id, MCP_ERROR.invalidParams, 'The name of the prompt is missing.');
            }
            return errorResponse(id, MCP_ERROR.invalidParams, `There is no prompt named ${promptName}.`);
        }
        return errorResponse(id ?? null, MCP_ERROR.methodNotFound, `There is no method named ${method}.`);
    };

    /**
     * The answer of a message or of a batch of messages.
     *
     * @param {unknown} message
     * @returns {Promise<object|object[]|null>}
     */
    const handle = async (message) => {
        if (Array.isArray(message)) {
            const answers = [];
            for (const item of message) {
                const answer = await handleMessage(item);
                if (answer) {answers.push(answer);}
            }
            return answers.length ? answers : null;
        }
        return handleMessage(message);
    };

    return { handle, listTools: tools, close: () => pending.clear() };
}

/**
 * Run the server over a pair of streams: one JSON message per line.
 *
 * @param {{ server: object, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 * @returns {{ close: () => void }}
 */
export function startStdioServer({ server, input = process.stdin, output = process.stdout } = {}) {
    let buffer = '';
    let closed = false;

    /**
     * Write one answer.
     * @param {unknown} payload
     * @returns {void}
     */
    const write = (payload) => {
        if (closed) {return;}
        output.write(`${JSON.stringify(payload)}\n`);
    };

    /**
     * The answer of one line.
     * @param {string} line
     * @returns {Promise<void>}
     */
    const processLine = async (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            write(errorResponse(null, MCP_ERROR.parse, `The message is not valid JSON: ${error.message}`));
            return;
        }
        try {
            const answer = await server.handle(message);
            if (answer) {write(answer);}
        } catch (error) {
            write(errorResponse(message?.id ?? null, MCP_ERROR.internal, error?.message ?? String(error)));
        }
    };

    /**
     * The answer of the data of the stream.
     * @param {Buffer|string} chunk
     * @returns {Promise<void>}
     */
    const onData = async (chunk) => {
        buffer += String(chunk);
        for (;;) {
            const index = buffer.indexOf('\n');
            if (index < 0) {break;}
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) {await processLine(line);}
        }
    };

    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.resume?.();

    return {
        close() {
            if (closed) {return;}
            closed = true;
            input.off?.('data', onData);
            server.close?.();
        },
    };
}
