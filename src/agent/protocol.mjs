export const FULL_BYTES = 262144;
export const JSON_BYTES = 900000;

const RADII = [[200, 50], [100, 25], [50, 12], [25, 6], [12, 3], [6, 1], [0, 0]];

export function nextDelay(previous) {
    const current = Number(previous) || 0;
    if (current <= 0) {
        return 2000;
    }
    return Math.min(current * 2, 30000);
}

export function approveFrame(requestId, decision) {
    return { type: 'approve', requestId, decision };
}

export function answerFrame(requestId, text) {
    return { type: 'answer', requestId, text: String(text ?? '') };
}

export const PROCESSABLE = ['delete_file', 'list_files', 'read_file', 'replace_text', 'run_command', 'run_script', 'search_files', 'write_file'];

/**
 * The name of the editor on the bus.
 *
 * The server puts the name of the client in front of the name of every tool of it, so
 * two clients may have a tool with the same name: the tool `read_file` of the editor
 * `vscode` is `vscode__read_file`.
 */
export const CLIENT_NAME = 'vscode';

/**
 * The tools the editor publishes to the bus.
 *
 * The list is the catalog of the editor: the file system of the workspace and the
 * terminal of the editor. The server shows the list in the MCP server, so another
 * system may use the editor as the source of its own tools.
 *
 * The names are the names of the tools of the editor itself: the server adds the name
 * of the client, and the server asks the editor to run a tool with the name it
 * published.
 */
export const CLIENT_TOOLS = Object.freeze([
    {
        name: 'list_files',
        description: 'The files and the directories of a path of the workspace of the editor.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
                depth: { type: 'integer', description: 'How deep the listing goes, from 1 to 6.' },
                include_hidden: { type: 'boolean', description: 'The hidden files are in the list too.' },
            },
        },
    },
    {
        name: 'read_file',
        description: 'A text file of the workspace of the editor, with the numbered lines.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
                start_line: { type: 'integer', description: 'The first line of the range.' },
                end_line: { type: 'integer', description: 'The last line of the range.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'search_files',
        description: 'The files of the workspace of the editor that hold a string or a regular expression.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The text or the regular expression to find.' },
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
                regex: { type: 'boolean', description: 'The query is a regular expression.' },
                scope: { type: 'string', description: 'One of path, symbol, content, all.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'write_file',
        description: 'Create or overwrite a file of the workspace of the editor.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
                content: { type: 'string', description: 'The text of the file.' },
                overwrite: { type: 'boolean', description: 'The file may be overwritten.' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'replace_text',
        description: 'Replace a fragment of a file of the workspace of the editor.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
                search: { type: 'string', description: 'The text to replace.' },
                replacement: { type: 'string', description: 'The text to put instead.' },
                all: { type: 'boolean', description: 'Every occurrence is replaced, not the first one.' },
            },
            required: ['path', 'search', 'replacement'],
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file of the workspace of the editor.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path, relative to the root of the workspace.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'run_command',
        description: 'Run a command in the terminal of the editor.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The line of the command.' },
                cwd: { type: 'string', description: 'The working directory, relative to the root of the workspace.' },
                timeout_seconds: { type: 'number', description: 'How long the command may run.' },
            },
            required: ['command'],
        },
    },
    {
        name: 'run_script',
        description: 'Run a script of the workspace of the editor in the terminal of the editor.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The path of the script, relative to the root of the workspace.' },
                args: { type: 'array', items: { type: 'string' }, description: 'The arguments of the script.' },
                cwd: { type: 'string', description: 'The working directory, relative to the root of the workspace.' },
                timeout_seconds: { type: 'number', description: 'How long the script may run.' },
            },
            required: ['path'],
        },
    },
]);

/**
 * The frame that opens the talk with the server.
 *
 * The name of the client is in the frame: the server puts it in front of the names of
 * the tools of the client.
 *
 * @param {string} token
 * @returns {object}
 */
export function helloFrame(token) {
    return { type: 'hello', role: 'client', token: String(token ?? ''), name: CLIENT_NAME };
}

/**
 * The frame that publishes the tools of the editor.
 *
 * The list replaces the list the server had: a client that changes its catalog
 * publishes it again.
 *
 * @param {Array<{ name: string, description?: string, parameters?: object }>} [tools]
 * @returns {object}
 */
export function toolsRegisterFrame(tools = CLIENT_TOOLS) {
    const list = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
        const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
        if (!name) {
            continue;
        }
        list.push({
            name,
            description: typeof tool.description === 'string' ? tool.description : '',
            parameters: tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
                ? tool.parameters
                : { type: 'object', properties: {} },
        });
    }
    return { type: 'tools.register', tools: list };
}

/**
 * The request of the server to run a tool of the editor.
 *
 * The server sends it when another system calls a tool of the editor through the MCP
 * server of the package. The editor answers with `tool.result`.
 *
 * @param {object} frame
 * @returns {{ requestId: string, name: string, args: object }|null}
 */
export function toolCallRequest(frame) {
    if (!frame || frame.type !== 'tool.call') {
        return null;
    }
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
    const name = typeof frame.name === 'string' ? frame.name.trim() : '';
    if (!requestId || !name) {
        return null;
    }
    const args = frame.arguments && typeof frame.arguments === 'object' && !Array.isArray(frame.arguments)
        ? frame.arguments
        : {};
    return { requestId, name, args };
}

/**
 * The title of a run: the server builds it from the command and the prompt.
 *
 * @param {string} command
 * @param {string} prompt
 * @returns {string}
 */
export function runTitle(command, prompt) {
    return `${command} ${prompt}`.trim().slice(0, 200);
}

/**
 * Is the run the one this client has started?
 *
 * A run of another client belongs to another client: the tools of it stay with it. The
 * title and the folder tell the runs apart.
 *
 * @param {object} run
 * @param {{ command: string, prompt: string, cwd: string }|null} submitted
 * @returns {boolean}
 */
export function isOwnRun(run, submitted) {
    if (!run || !submitted) {
        return false;
    }
    if (typeof run.title === 'string' && run.title !== runTitle(submitted.command, submitted.prompt)) {
        return false;
    }
    if (typeof run.cwd === 'string' && run.cwd !== submitted.cwd) {
        return false;
    }
    return true;
}

const CHANGE_OPS = new Set(['create', 'overwrite', 'edit', 'delete']);

export function claimFrames(runs) {
    if (!Array.isArray(runs)) {
        return [];
    }
    const frames = [];
    for (const run of runs) {
        if (!run || run.source !== 'client' || run.status !== 'running' || typeof run.id !== 'string' || run.id === '') {
            continue;
        }
        frames.push({ type: 'processing.claim', runId: run.id, tools: PROCESSABLE.slice() });
    }
    return frames;
}

export function toolResultFrame(requestId, result) {
    const error = result && typeof result.error === 'string' ? result.error.trim() : '';
    if (!result || error) {
        return { type: 'tool.result', requestId, error: error || 'Ошибка инструмента.' };
    }
    const frame = {
        type: 'tool.result',
        requestId,
        output: typeof result.output === 'string' ? result.output : '',
        summary: typeof result.summary === 'string' ? result.summary : '',
    };
    if (Array.isArray(result.changes)) {
        const changes = [];
        for (const item of result.changes) {
            if (!item || typeof item.path !== 'string' || !CHANGE_OPS.has(item.op)) {
                continue;
            }
            changes.push({ op: item.op, path: item.path });
            if (changes.length >= 100) {
                break;
            }
        }
        if (changes.length) {
            frame.changes = changes;
        }
    }
    return frame;
}

export function submissionFrame({ command, prompt, cwd, approve, phase }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
        return { error: 'empty' };
    }
    if (phase === 'starting') {
        return { error: 'pending' };
    }
    const running = phase !== null && typeof phase === 'object';
    if (command === 'chat' && running && phase.command === 'chat' && phase.runId) {
        return { frames: [{ type: 'input', runId: phase.runId, text: prompt }] };
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') {
        return { error: 'no-workspace' };
    }
    const start = { type: 'start', command, prompt, cwd, approve, processing: PROCESSABLE.slice() };
    if (running && phase.runId) {
        return { frames: [{ type: 'cancel', runId: phase.runId }, start] };
    }
    return { frames: [start] };
}

function copyList(value, limit) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    return value.slice(0, limit);
}

const HEADER_LINE = /^\s*(?:import\s|import\(|export\s+(?:type\s+|interface\s+|\{|\*)|export\s+[\w$]+\s+from\s|const\s+\w+\s*=\s*require\s*\(|[A-Za-z_$][\w$.]*\s*=\s*require\s*\(|using\s|#include\s|package\s|namespace\s|from\s+\S+\s+import\s)/;
const HEADER_NOTE = /^\s*(?:\/\/|\/\*|\*(?:\/|\s|$)|#(?!include\s)\s|--)/;
const HEADER_DIRECTIVE = /^\s*['"]use [\w.]+['"];?\s*$/;

/**
 * Import block above the cursor. Empty when the file does not open with imports.
 * @param {string} text
 * @param {number} cursorLine
 * @returns {string|undefined}
 */
export function completionHeader(text, cursorLine) {
    const lines = String(text ?? '').split('\n');
    const stop = Math.min(Math.max(cursorLine ?? 0, 0), lines.length);
    const header = [];
    let started = false;
    for (let i = 0; i < stop && header.length < 24; i++) {
        const line = lines[i];
        if (HEADER_LINE.test(line)) {
            started = true;
            header.push(line);
            continue;
        }
        const blank = line.trim() === '';
        const note = HEADER_NOTE.test(line) || HEADER_DIRECTIVE.test(line) || line.startsWith('#!');
        if (!started) {
            if (blank) {
                continue;
            }
            if (note) {
                header.push(line);
                continue;
            }
            return undefined;
        }
        if (blank || note) {
            header.push(line);
            continue;
        }
        break;
    }
    if (!started) {
        return undefined;
    }
    while (header.length > 0 && header[header.length - 1].trim() === '') {
        header.pop();
    }
    const joined = header.join('\n').trim();
    if (!joined) {
        return undefined;
    }
    return joined.length > 4000 ? joined.slice(0, 4000) : joined;
}

function copyReferences(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const content = typeof item.content === 'string' ? item.content.replace(/\r\n/g, '\n').trim() : '';
        if (!content) {
            continue;
        }
        const row = { content: content.slice(0, 2000) };
        if (typeof item.path === 'string' && item.path.trim()) {
            row.path = item.path.trim().slice(0, 300);
        }
        if (typeof item.language === 'string' && item.language.trim()) {
            row.language = item.language.trim().slice(0, 40);
        }
        out.push(row);
        if (out.length >= 4) {
            break;
        }
    }
    return out.length ? out : undefined;
}

function buildBody({ id, language, path: filePath, content, cursor, model, problems, validation, files, header, references }) {
    const body = {
        type: 'complete',
        id,
        language,
        content,
        cursor: { line: cursor.line, character: cursor.character },
    };
    if (filePath) {
        body.path = filePath;
    }
    if (typeof model === 'string' && model.trim()) {
        body.model = model.trim();
    }
    if (typeof header === 'string' && header.trim()) {
        body.header = header.trim();
    }
    const problemList = copyList(problems, 24);
    const validationList = copyList(validation, 24);
    const fileList = copyList(files, 200);
    const referenceList = copyReferences(references);
    if (problemList) {
        body.problems = problemList;
    }
    if (validationList) {
        body.validation = validationList;
    }
    if (fileList) {
        body.files = fileList;
    }
    if (referenceList) {
        body.references = referenceList;
    }
    return body;
}

export function completionRequest({ id, language, path: filePath, text, cursor, model, problems, validation, files, references }) {
    const full = String(text ?? '');
    const context = {
        model,
        problems,
        validation,
        files,
        references,
        header: completionHeader(full, cursor?.line ?? 0),
    };
    if (Buffer.byteLength(full, 'utf8') <= FULL_BYTES) {
        return buildBody({ id, language, path: filePath, content: full, cursor, ...context });
    }
    const lines = full.split('\n');
    for (const [before, after] of RADII) {
        const start = Math.max(0, cursor.line - before);
        const end = Math.min(lines.length - 1, cursor.line + after);
        const content = lines.slice(start, end + 1).join('\n');
        const body = buildBody({
            id,
            language,
            path: filePath,
            content,
            cursor: { line: cursor.line - start, character: cursor.character },
            ...context,
        });
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= JSON_BYTES) {
            return body;
        }
    }
    return null;
}

export function acceptCompletion(expectedId, message) {
    if (!message || message.type !== 'completion') {
        return null;
    }
    if (message.id !== expectedId) {
        return null;
    }
    if (typeof message.text !== 'string' || message.text === '') {
        return null;
    }
    return message.text;
}

export function panelMessageFromEvent(event) {
    if (!event || typeof event.type !== 'string') {
        return null;
    }
    if (event.type === 'text.delta') {
        return { type: 'text', text: String(event.text ?? '') };
    }
    if (event.type === 'tool.exec.start') {
        return { type: 'log', level: 'action', text: String(event.name ?? 'tool') };
    }
    if (event.type === 'tool.exec.done') {
        const summary = event.summary || (event.ok ? 'готово' : 'ошибка');
        return { type: 'log', level: event.ok ? 'ok' : 'fail', text: `${event.name} · ${summary}` };
    }
    if (event.type === 'warning') {
        return { type: 'log', level: 'warn', text: String(event.message ?? '') };
    }
    if (event.type === 'error') {
        return { type: 'log', level: 'fail', text: String(event.message ?? '') };
    }
    if (event.type === 'image.saved') {
        return { type: 'log', level: 'info', text: `Изображение сохранено: ${event.path}` };
    }
    if (event.type === 'response.done') {
        const usage = event.usage;
        const parts = [];
        if (usage && Number.isFinite(usage.input)) {
            parts.push(`↑ ${usage.input}`);
        }
        if (usage && Number.isFinite(usage.output)) {
            parts.push(`↓ ${usage.output}`);
        }
        if (Number.isFinite(event.costUsd)) {
            parts.push(`${event.costUsd} USD`);
        }
        if (parts.length === 0) {
            return null;
        }
        return { type: 'log', level: 'info', text: parts.join(' · ') };
    }
    if (event.type === 'reasoning.delta' || event.type === 'reasoning.start') {
        return { type: 'status', state: 'ready', detail: 'думает…' };
    }
    if (event.type === 'image.progress') {
        return { type: 'status', state: 'ready', detail: 'генерирует изображение…' };
    }
    if (event.type === 'processing.held') {
        const tools = Array.isArray(event.tools) ? event.tools.filter((name) => typeof name === 'string') : [];
        const text = tools.length ? `редактор выполняет: ${tools.join(', ')}` : 'инструменты выполняет агент';
        return { type: 'log', level: 'info', text };
    }
    return null;
}

export function panelMessageFromHub(frame) {
    if (!frame || typeof frame.type !== 'string') {
        return null;
    }
    if (frame.type === 'ready') {
        return { type: 'status', state: 'ready', detail: '' };
    }
    if (frame.type === 'error' && frame.code === 'unauthorized') {
        return { type: 'status', state: 'unauthorized', detail: String(frame.message ?? 'Неверный токен.') };
    }
    if (frame.type === 'error') {
        return { type: 'status', state: 'error', detail: String(frame.message ?? '') };
    }
    if (frame.type === 'run.started' && frame.run) {
        return { type: 'run', runId: frame.run.id, command: frame.run.command, status: 'started' };
    }
    if (frame.type === 'run.ended') {
        return { type: 'run', runId: frame.runId, status: 'ended', exitCode: frame.exitCode };
    }
    if (frame.type === 'run.event') {
        const inner = panelMessageFromEvent(frame.event);
        if (!inner) {
            return null;
        }
        return { ...inner, runId: frame.runId };
    }
    if (frame.type === 'approval.request') {
        return {
            type: 'approval',
            runId: frame.runId,
            requestId: frame.requestId,
            name: frame.name ?? '',
            category: frame.category ?? '',
            preview: frame.preview ?? '',
        };
    }
    if (frame.type === 'question.request') {
        return { type: 'question', runId: frame.runId, requestId: frame.requestId, question: String(frame.question ?? '') };
    }
    if (frame.type === 'processing.released') {
        const tools = Array.isArray(frame.tools) ? frame.tools.filter((name) => typeof name === 'string') : [];
        const text = tools.length ? `редактор отпустил: ${tools.join(', ')}` : 'редактор отпустил инструменты';
        return { type: 'log', level: 'warn', text };
    }
    return null;
}

export const __agentTest = {
    FULL_BYTES,
    JSON_BYTES,
    nextDelay,
    PROCESSABLE,
    CLIENT_NAME,
    CLIENT_TOOLS,
    claimFrames,
    toolResultFrame,
    submissionFrame,
    approveFrame,
    answerFrame,
    helloFrame,
    toolsRegisterFrame,
    toolCallRequest,
    runTitle,
    isOwnRun,
    completionHeader,
    completionRequest,
    acceptCompletion,
    panelMessageFromEvent,
    panelMessageFromHub,
};
