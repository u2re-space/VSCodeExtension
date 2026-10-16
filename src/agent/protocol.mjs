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
    const start = { type: 'start', command, prompt, cwd, approve };
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
    return null;
}

export const __agentTest = {
    FULL_BYTES,
    JSON_BYTES,
    nextDelay,
    submissionFrame,
    approveFrame,
    answerFrame,
    completionHeader,
    completionRequest,
    acceptCompletion,
    panelMessageFromEvent,
    panelMessageFromHub,
};
