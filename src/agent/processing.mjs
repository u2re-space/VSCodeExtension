import { PROCESSABLE } from './protocol.mjs';

const READ_LIMIT = 256 * 1024;
const WRITE_LIMIT = 4 * 1024 * 1024;
const SEARCH_FILE_LIMIT = 1024 * 1024;
const LIST_LIMIT = 400;
const SEARCH_LIMIT = 60;
const OUTPUT_LIMIT = 64 * 1024;
const COMMAND_TIMEOUT = 180_000;
const SHELL_WAIT = 15_000;
const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

const PROTECTED_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const FORBIDDEN_DIRS = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;
const NOISY_DIRS = /^(?:\.git|node_modules|\.hg|\.svn|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__|target|\.ai-agent|\.backup)$/i;
const READ_ONLY_DIRS = /^(?:\.git|node_modules)$/i;
const SEARCH_SKIP = /^\.env|\.(pem|key|p12|pfx)$/i;
const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'];
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const terminals = new Map();

function abortError() {
    const error = new Error('Отменено.');
    error.name = 'AbortError';
    return error;
}

function ensure(signal) {
    if (signal?.aborted) {
        throw abortError();
    }
}

function byteLength(text) {
    return encoder.encode(text).length;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return '—';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function windowsPath(value) {
    return value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function splitNative(value) {
    return String(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
}

function canonical(value) {
    const text = splitNative(value).join('/');
    return windowsPath(String(value)) ? text.toLowerCase() : text;
}

function nativeJoin(parts, windows) {
    const joined = parts.join(windows ? '\\' : '/');
    if (windows && /^[A-Za-z]:$/.test(joined)) {
        return `${joined}\\`;
    }
    return joined;
}

function resolvePath(root, relative) {
    const rel = String(relative).replace(/\\/g, '/');
    const absolute = rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
    const windows = windowsPath(root) || windowsPath(rel);
    const parts = absolute ? [] : splitNative(root);
    for (const segment of rel.split('/')) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (parts.length > 1) {
                parts.pop();
            }
            continue;
        }
        parts.push(segment);
    }
    return nativeJoin(parts, windows);
}

function relativePosix(root, abs) {
    const from = splitNative(root);
    const to = splitNative(abs);
    const windows = windowsPath(root);
    const same = (left, right) => (windows ? left.toLowerCase() === right.toLowerCase() : left === right);
    let index = 0;
    while (index < from.length && index < to.length && same(from[index], to[index])) {
        index += 1;
    }
    if (index !== from.length) {
        return to.join('/');
    }
    return to.slice(from.length).join('/') || '.';
}

function isInside(root, candidate) {
    const from = canonical(root);
    const to = canonical(candidate);
    return to === from || to.startsWith(`${from}/`);
}

function dirname(value) {
    const parts = splitNative(value);
    if (parts.length <= 1) {
        return value;
    }
    parts.pop();
    return nativeJoin(parts, windowsPath(value));
}

function basename(value) {
    const parts = splitNative(value);
    return parts[parts.length - 1] || value;
}

function extname(value) {
    const name = basename(value);
    const index = name.lastIndexOf('.');
    if (index <= 0) {
        return '';
    }
    return name.slice(index).toLowerCase();
}

function joinPath(parent, name) {
    const windows = windowsPath(parent);
    const sep = windows ? '\\' : '/';
    return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function samePath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }
    return canonical(left) === canonical(right);
}

async function resolveInside(io, relative, { forWrite = false, allowRoot = true } = {}) {
    if (typeof relative !== 'string') {
        throw new Error('Путь должен быть строкой.');
    }
    if (relative.includes('\0')) {
        throw new Error('Путь содержит NUL.');
    }
    const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
    const abs = resolvePath(io.root, cleaned);
    if (!isInside(io.root, abs)) {
        throw new Error(`Путь вне рабочего каталога: ${relative}`);
    }
    const rel = relativePosix(io.root, abs);
    if (rel === '.' && !allowRoot) {
        throw new Error('Нужен путь к файлу, а не к корню.');
    }
    const segments = rel === '.' ? [] : rel.split('/');
    for (const [index, segment] of segments.entries()) {
        if (FORBIDDEN_DIRS.test(segment)) {
            throw new Error(`Доступ запрещён: ${rel}`);
        }
        if (index === segments.length - 1 && PROTECTED_FILES.test(segment)) {
            throw new Error(`Файл с секретами недоступен: ${rel}`);
        }
        if (forWrite && READ_ONLY_DIRS.test(segment)) {
            throw new Error(`Запись в ${segment} запрещена: ${rel}`);
        }
    }
    if (forWrite && (rel === '.backup' || rel.startsWith('.backup/'))) {
        throw new Error(`Запись в .backup запрещена: ${rel}`);
    }
    let probe = abs;
    for (;;) {
        const stat = await io.stat(probe);
        if (stat?.isSymbolicLink) {
            throw new Error(`Путь через символическую ссылку выходит за рабочий каталог: ${rel}`);
        }
        if (stat) {
            break;
        }
        const parent = dirname(probe);
        if (parent === probe) {
            break;
        }
        probe = parent;
    }
    return { abs, rel };
}

function findDocument(vscode, abs) {
    const docs = vscode?.workspace?.textDocuments;
    if (!Array.isArray(docs)) {
        return null;
    }
    for (const doc of docs) {
        if (!doc?.uri || (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote' && doc.uri.scheme !== 'vscode-vfs')) {
            continue;
        }
        if (samePath(doc.uri.fsPath, abs)) {
            return doc;
        }
    }
    return null;
}

function folderUri(vscode, root) {
    const folders = vscode.workspace?.workspaceFolders;
    if (!Array.isArray(folders)) {
        return null;
    }
    for (const folder of folders) {
        if (samePath(folder?.uri?.fsPath, root)) {
            return folder.uri;
        }
    }
    return null;
}

function locate(vscode, root, abs) {
    const base = folderUri(vscode, root) ?? vscode.Uri.file(root);
    if (base.scheme === 'file' || typeof vscode.Uri.joinPath !== 'function') {
        return vscode.Uri.file(abs);
    }
    const rel = relativePosix(root, abs);
    if (rel === '.') {
        return base;
    }
    return vscode.Uri.joinPath(base, ...rel.split('/'));
}

function missingFile(error) {
    return error?.code === 'FileNotFound' || error?.code === 'EntryNotFound' || error?.name === 'EntryNotFound';
}

function describeType(type) {
    const symlink = (type & SYMLINK) === SYMLINK;
    return {
        isFile: (type & FILE) === FILE && !symlink,
        isDirectory: (type & DIRECTORY) === DIRECTORY && !symlink,
        isSymbolicLink: symlink,
    };
}

function chosenShell(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (!SHELLS.includes(value)) {
        throw new Error(`shell: ${SHELLS.join(' | ')}`);
    }
    return value;
}

function commandTimeout(args) {
    const seconds = Number.isInteger(args?.timeout_seconds) ? args.timeout_seconds : Math.round(COMMAND_TIMEOUT / 1000);
    return Math.min(900, Math.max(1, seconds)) * 1000;
}

function quotePwsh(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteCmd(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteSh(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function commandLine(command, shell) {
    switch (shell) {
        case 'powershell':
        case 'pwsh':
            return `${shell} -NoProfile -NonInteractive -Command ${quotePwsh(command)}`;
        case 'cmd':
            return `cmd /d /s /c ${quoteCmd(command)}`;
        case 'bash':
        case 'sh':
        case 'zsh':
            return `${shell} -lc ${quoteSh(command)}`;
        default:
            return command;
    }
}

function scriptLine(absPath, shell, args) {
    const ext = extname(absPath);
    const chosen = shell || (ext === '.ps1' ? 'powershell' : ext === '.cmd' || ext === '.bat' ? 'cmd' : ext === '.sh' || ext === '.bash' ? 'bash' : null);
    if (!SHELLS.includes(chosen)) {
        throw new Error('Укажите shell: powershell, pwsh, cmd, bash, sh или zsh.');
    }
    const extra = args.map((item) => String(item));
    if (chosen === 'powershell' || chosen === 'pwsh') {
        return `${chosen} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quotePwsh(absPath)}${extra.length ? ` ${extra.map(quotePwsh).join(' ')}` : ''}`;
    }
    if (chosen === 'cmd') {
        return `cmd /d /c ${[quoteCmd(absPath), ...extra.map(quoteCmd)].join(' ')}`;
    }
    return [chosen, quoteSh(absPath), ...extra.map(quoteSh)].join(' ');
}

function commandReport(result, timeoutMs) {
    const status = result.cancelled
        ? 'отменена'
        : result.timedOut
            ? `таймаут ${timeoutMs / 1000} с`
            : result.error
                ? `ошибка запуска: ${result.error}`
                : `exit code ${result.exitCode}`;
    const body = [`status: ${status}`, `duration_ms: ${result.durationMs}`];
    if (result.stdout) {
        body.push(`--- stdout ---\n${result.stdout}`);
    }
    if (result.stderr) {
        body.push(`--- stderr ---\n${result.stderr}`);
    }
    if (result.truncated) {
        body.push('(вывод усечён)');
    }
    return { output: body.join('\n'), summary: status };
}

function cleanOutput(text) {
    return text
        .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replaceAll(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function waitForShell(vscode, terminal, signal) {
    if (terminal.shellIntegration) {
        return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise((resolve, reject) => {
        let subscription = { dispose() {} };
        const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error('Интеграция терминала не включилась.'));
        }, SHELL_WAIT);
        const finish = (error, integration) => {
            clearTimeout(timer);
            subscription.dispose();
            signal?.removeEventListener('abort', onAbort);
            if (error) {
                reject(error);
                return;
            }
            resolve(integration);
        };
        const onAbort = () => finish(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (typeof vscode.window?.onDidChangeTerminalShellIntegration !== 'function') {
            finish(new Error('Интеграция терминала недоступна.'));
            return;
        }
        subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
            if (event?.terminal !== terminal || !event.shellIntegration) {
                return;
            }
            finish(null, event.shellIntegration);
        });
        if (signal?.aborted) {
            onAbort();
        }
    });
}

function waitForExit(vscode, execution, timeoutMs, signal) {
    return new Promise((resolve) => {
        let subscription = { dispose() {} };
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            subscription.dispose();
            signal?.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const timer = setTimeout(() => finish({ exitCode: null, timedOut: true, cancelled: false }), timeoutMs);
        const onAbort = () => finish({ exitCode: null, timedOut: false, cancelled: true });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (typeof vscode.window?.onDidEndTerminalShellExecution === 'function') {
            subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
                if (event?.execution !== execution) {
                    return;
                }
                finish({ exitCode: event.exitCode ?? null, timedOut: false, cancelled: false });
            });
        }
        if (signal?.aborted) {
            onAbort();
        }
    });
}

async function collectOutput(stream) {
    let stdout = '';
    let truncated = false;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        return { stdout, truncated };
    }
    for await (const chunk of stream) {
        const text = cleanOutput(String(chunk ?? ''));
        if (!text) {
            continue;
        }
        if (stdout.length >= OUTPUT_LIMIT) {
            truncated = true;
            continue;
        }
        const room = OUTPUT_LIMIT - stdout.length;
        stdout += text.slice(0, room);
        if (text.length > room) {
            truncated = true;
        }
    }
    return { stdout, truncated };
}

async function runInTerminal(vscode, commandText, { cwd, timeoutMs, signal }) {
    const started = Date.now();
    const empty = { exitCode: null, timedOut: false, cancelled: false, durationMs: 0, truncated: false, stdout: '', stderr: '', error: null };
    if (signal?.aborted) {
        return { ...empty, cancelled: true };
    }
    if (typeof vscode.window?.createTerminal !== 'function') {
        return { ...empty, durationMs: Date.now() - started, error: 'Терминал редактора недоступен.' };
    }
    const key = canonical(cwd);
    let terminal = terminals.get(key);
    if (terminal?.exitStatus) {
        terminals.delete(key);
        terminal = null;
    }
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: 'U2RE Agent', cwd: locate(vscode, cwd, cwd), hideFromUser: true });
        terminals.set(key, terminal);
    }
    let integration;
    try {
        integration = await waitForShell(vscode, terminal, signal);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw error;
        }
        terminal.dispose?.();
        terminals.delete(key);
        return { ...empty, durationMs: Date.now() - started, error: error?.message || String(error) };
    }
    const execution = integration.executeCommand(commandText);
    const ending = waitForExit(vscode, execution, timeoutMs, signal);
    const output = await collectOutput(execution.read());
    const end = await ending;
    if (end.timedOut || end.cancelled) {
        terminal.dispose?.();
        terminals.delete(key);
    }
    return {
        exitCode: end.exitCode,
        timedOut: end.timedOut,
        cancelled: end.cancelled,
        durationMs: Date.now() - started,
        truncated: output.truncated,
        stdout: output.stdout,
        stderr: '',
        error: null,
    };
}

export function createWorkspaceIo(vscode, root) {
    return {
        root,
        async readFile(abs) {
            const doc = findDocument(vscode, abs);
            if (doc) {
                return encoder.encode(doc.getText());
            }
            try {
                return await vscode.workspace.fs.readFile(locate(vscode, root, abs));
            } catch (error) {
                if (missingFile(error)) {
                    return null;
                }
                throw error;
            }
        },
        async writeFile(abs, text) {
            const doc = findDocument(vscode, abs);
            if (doc) {
                const edit = new vscode.WorkspaceEdit();
                const end = doc.positionAt(doc.getText().length);
                edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    throw new Error(`Не удалось применить правку: ${basename(abs)}`);
                }
                const saved = await doc.save();
                if (saved === false) {
                    throw new Error(`Не удалось сохранить ${basename(abs)}.`);
                }
                return;
            }
            const uri = locate(vscode, root, abs);
            await vscode.workspace.fs.createDirectory(locate(vscode, root, dirname(abs)));
            await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
        },
        async deleteFile(abs) {
            await vscode.workspace.fs.delete(locate(vscode, root, abs));
        },
        async stat(abs) {
            try {
                const info = await vscode.workspace.fs.stat(locate(vscode, root, abs));
                return { ...describeType(info.type), size: info.size };
            } catch (error) {
                if (!missingFile(error)) {
                    throw error;
                }
                const doc = findDocument(vscode, abs);
                if (!doc) {
                    return null;
                }
                return { isFile: true, isDirectory: false, isSymbolicLink: false, size: byteLength(doc.getText()) };
            }
        },
        async readdir(abs) {
            const entries = await vscode.workspace.fs.readDirectory(locate(vscode, root, abs));
            return entries.map(([name, type]) => ({ name, ...describeType(type) }));
        },
        spawn(spec, options = {}) {
            return runInTerminal(vscode, spec.commandLine, options);
        },
    };
}

async function loadText(io, abs, rel, fileArg, maxBytes) {
    const info = await io.stat(abs);
    if (!info) {
        throw new Error(`Файл не найден: ${fileArg}`);
    }
    if (info.isSymbolicLink) {
        throw new Error(`Путь через символическую ссылку выходит за рабочий каталог: ${rel}`);
    }
    if (!info.isFile) {
        throw new Error(`Не файл: ${fileArg}`);
    }
    if (info.size > maxBytes) {
        throw new Error(`Файл больше лимита ${formatBytes(maxBytes)}.`);
    }
    const buffer = await io.readFile(abs);
    if (!buffer) {
        throw new Error(`Файл не найден: ${fileArg}`);
    }
    if (buffer.subarray(0, 8192).includes(0)) {
        throw new Error(`Бинарный файл (${formatBytes(info.size)}); для изображений используйте view_image.`);
    }
    try {
        return utf8.decode(buffer);
    } catch {
        throw new Error(`Файл ${rel} не в UTF-8.`);
    }
}

async function listFiles(args, io, signal) {
    const dir = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const depth = Math.min(6, Math.max(1, Number.isInteger(args.depth) ? args.depth : 2));
    const includeHidden = Boolean(args.include_hidden);
    const { abs, rel } = await resolveInside(io, dir);
    const info = await io.stat(abs);
    if (!info) {
        throw new Error(`Каталог не найден: ${dir}`);
    }
    if (!info.isDirectory) {
        throw new Error(`Не каталог: ${dir}`);
    }
    const lines = [];
    let truncated = false;
    const walk = async (current, prefix, level) => {
        if (truncated) {
            return;
        }
        ensure(signal);
        let entries;
        try {
            entries = await io.readdir(current);
        } catch {
            return;
        }
        entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
        for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.github') {
                continue;
            }
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (lines.length >= LIST_LIMIT) {
                truncated = true;
                return;
            }
            if (entry.isDirectory) {
                const skip = NOISY_DIRS.test(entry.name);
                lines.push(`${relative}/${skip ? '  (пропущено)' : ''}`);
                if (!skip && level < depth) {
                    await walk(joinPath(current, entry.name), relative, level + 1);
                }
            } else if (entry.isFile) {
                const fileInfo = await io.stat(joinPath(current, entry.name));
                lines.push(`${relative}  (${formatBytes(fileInfo?.size ?? 0)})`);
            } else if (entry.isSymbolicLink) {
                lines.push(`${relative}  (symlink)`);
            }
        }
    };
    await walk(abs, rel === '.' ? '' : rel, 1);
    const text = `${lines.join('\n') || '(пусто)'}${truncated ? `\n…список усечён (${LIST_LIMIT} записей)` : ''}`;
    return { output: text, summary: `${lines.length} записей` };
}

async function readFileTool(args, io) {
    const file = args.path;
    const { abs, rel } = await resolveInside(io, file, { allowRoot: false });
    const info = await io.stat(abs);
    if (!info) {
        throw new Error(`Файл не найден: ${file}`);
    }
    if (info.isSymbolicLink) {
        throw new Error(`Путь через символическую ссылку выходит за рабочий каталог: ${rel}`);
    }
    if (!info.isFile) {
        throw new Error(`Не файл: ${file}`);
    }
    if (info.size > WRITE_LIMIT) {
        throw new Error(`Файл больше лимита ${formatBytes(WRITE_LIMIT)}.`);
    }
    const buffer = await io.readFile(abs);
    if (!buffer) {
        throw new Error(`Файл не найден: ${file}`);
    }
    if (buffer.subarray(0, 8192).includes(0)) {
        throw new Error(`Бинарный файл (${formatBytes(info.size)}); для изображений используйте view_image.`);
    }
    let text;
    try {
        text = utf8.decode(buffer);
    } catch {
        throw new Error(`Файл ${rel} не в UTF-8.`);
    }
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const from = Math.max(1, Number.isInteger(args.start_line) ? args.start_line : 1);
    let to = Math.min(total, Number.isInteger(args.end_line) ? args.end_line : total);
    if (from > total) {
        throw new Error(`start_line ${from} больше числа строк (${total}).`);
    }
    let selected = lines.slice(from - 1, to);
    let bytes = byteLength(selected.join('\n'));
    let truncated = false;
    while (bytes > READ_LIMIT && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * (READ_LIMIT / bytes) * 0.9)));
        bytes = byteLength(selected.join('\n'));
        truncated = true;
        to = from + selected.length - 1;
    }
    const width = String(to).length;
    const numbered = selected.map((line, index) => `${String(from + index).padStart(width)}| ${line}`).join('\n');
    const header = `# ${rel} — строки ${from}-${to} из ${total}${truncated ? ' (усечено по размеру; запросите диапазон)' : ''}`;
    return { output: `${header}\n${numbered}`, summary: `${file}: строки ${from}-${to}/${total}` };
}

async function searchFiles(args, io, signal) {
    const scope = args.scope ?? 'all';
    if (!['path', 'symbol', 'content', 'all'].includes(scope)) {
        throw new Error('scope: path, symbol, content или all.');
    }
    if (typeof args.query !== 'string' || !args.query) {
        throw new Error('Пустой запрос поиска.');
    }
    const dir = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const regex = Boolean(args.regex);
    let matcher;
    if (regex) {
        try {
            matcher = new RegExp(args.query, 'i');
        } catch (error) {
            throw new Error(`Некорректное регулярное выражение: ${error.message}`);
        }
    }
    const { abs, rel } = await resolveInside(io, dir);
    const results = [];
    let scanned = 0;
    let truncated = false;
    const walk = async (current, prefix) => {
        if (truncated) {
            return;
        }
        ensure(signal);
        let entries;
        try {
            entries = await io.readdir(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (truncated) {
                return;
            }
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory) {
                if (NOISY_DIRS.test(entry.name) || FORBIDDEN_DIRS.test(entry.name)) {
                    continue;
                }
                await walk(joinPath(current, entry.name), relative);
                continue;
            }
            if (!entry.isFile || SEARCH_SKIP.test(entry.name)) {
                continue;
            }
            const full = joinPath(current, entry.name);
            const info = await io.stat(full);
            if (!info?.isFile || info.size > SEARCH_FILE_LIMIT) {
                continue;
            }
            const buffer = await io.readFile(full);
            if (!buffer || buffer.subarray(0, 8192).includes(0)) {
                continue;
            }
            let text;
            try {
                text = utf8.decode(buffer);
            } catch {
                continue;
            }
            scanned += 1;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const hit = regex ? matcher.test(line) : line.toLowerCase().includes(args.query.toLowerCase());
                if (!hit) {
                    continue;
                }
                results.push(`${relative}:${i + 1}: ${line.trim().slice(0, 240)}`);
                if (results.length >= SEARCH_LIMIT) {
                    truncated = true;
                    break;
                }
            }
        }
    };
    await walk(abs, rel === '.' ? '' : rel);
    const body = results.length
        ? `${results.join('\n')}${truncated ? `\n…результаты усечены (${SEARCH_LIMIT})` : ''}`
        : `Совпадений не найдено (просмотрено файлов: ${scanned}).`;
    return { output: `Карта проекта недоступна; поиск по дереву.\n${body}`, summary: `${results.length} совпадений` };
}

async function writeFileTool(args, io) {
    if (typeof args.content !== 'string') {
        throw new Error('content должен быть строкой.');
    }
    if (byteLength(args.content) > WRITE_LIMIT) {
        throw new Error(`Содержимое больше лимита ${formatBytes(WRITE_LIMIT)}.`);
    }
    const { abs, rel } = await resolveInside(io, args.path, { forWrite: true, allowRoot: false });
    const existing = await io.stat(abs);
    if (existing?.isDirectory) {
        throw new Error(`По этому пути находится каталог: ${rel}`);
    }
    if (existing && args.overwrite === false) {
        throw new Error(`Файл уже существует: ${rel} (overwrite=false).`);
    }
    await io.writeFile(abs, args.content);
    const created = !existing;
    return {
        output: `${created ? 'Создан' : 'Перезаписан'} ${rel} (${formatBytes(byteLength(args.content))}).`,
        summary: `${created ? '+' : '~'} ${rel}`,
        changes: [{ op: created ? 'create' : 'overwrite', path: rel }],
    };
}

async function replaceText(args, io) {
    if (typeof args.search !== 'string' || !args.search) {
        throw new Error('search должен быть непустой строкой.');
    }
    if (typeof args.replacement !== 'string') {
        throw new Error('replacement должен быть строкой.');
    }
    const { abs, rel } = await resolveInside(io, args.path, { forWrite: true, allowRoot: false });
    const text = await loadText(io, abs, rel, args.path, WRITE_LIMIT);
    let count = 0;
    for (let index = text.indexOf(args.search); index !== -1; index = text.indexOf(args.search, index + args.search.length)) {
        count += 1;
    }
    if (count === 0) {
        const normalizedCount = text.replaceAll('\r\n', '\n').split(args.search.replaceAll('\r\n', '\n')).length - 1;
        throw new Error(normalizedCount > 0
            ? 'Фрагмент не найден из-за различий переводов строк (CRLF/LF); прочитайте файл заново и используйте точный текст.'
            : 'Фрагмент search не найден в файле; прочитайте файл и укажите точный уникальный текст.');
    }
    if (count > 1 && !args.all) {
        throw new Error(`Фрагмент встречается ${count} раз(а); уточните контекст или укажите all=true.`);
    }
    const updated = args.all ? text.split(args.search).join(args.replacement) : text.replace(args.search, () => args.replacement);
    if (byteLength(updated) > WRITE_LIMIT) {
        throw new Error(`Содержимое больше лимита ${formatBytes(WRITE_LIMIT)}.`);
    }
    await io.writeFile(abs, updated);
    return {
        output: `Изменён ${rel}: замен ${args.all ? count : 1}.`,
        summary: `~ ${rel}`,
        changes: [{ op: 'edit', path: rel }],
    };
}

async function deleteFileTool(args, io) {
    const { abs, rel } = await resolveInside(io, args.path, { forWrite: true, allowRoot: false });
    const info = await io.stat(abs);
    if (!info) {
        throw new Error(`Файл не найден: ${args.path}`);
    }
    if (info.isSymbolicLink) {
        throw new Error(`Путь через символическую ссылку выходит за рабочий каталог: ${rel}`);
    }
    if (!info.isFile) {
        throw new Error('Удалять можно только файлы (не каталоги).');
    }
    await io.deleteFile(abs);
    return { output: `Удалён ${rel}.`, summary: `- ${rel}`, changes: [{ op: 'delete', path: rel }] };
}

async function runCommandTool(args, io, signal) {
    if (typeof args.command !== 'string' || !args.command.trim()) {
        throw new Error('Пустая команда.');
    }
    const cwd = args.cwd ? (await resolveInside(io, args.cwd)).abs : io.root;
    const timeoutMs = commandTimeout(args);
    const result = await io.spawn({ commandLine: commandLine(args.command, chosenShell(args.shell)) }, { cwd, timeoutMs, signal });
    if (signal?.aborted) {
        throw abortError();
    }
    return commandReport(result, timeoutMs);
}

async function runScriptTool(args, io, signal) {
    if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new Error('Укажите путь к скрипту.');
    }
    const { abs } = await resolveInside(io, args.path, { allowRoot: false });
    const info = await io.stat(abs);
    if (!info?.isFile) {
        throw new Error(`Файл не найден: ${args.path}`);
    }
    const cwd = args.cwd ? (await resolveInside(io, args.cwd)).abs : io.root;
    const timeoutMs = commandTimeout(args);
    const result = await io.spawn({
        commandLine: scriptLine(abs, chosenShell(args.shell), Array.isArray(args.args) ? args.args : []),
    }, { cwd, timeoutMs, signal });
    if (signal?.aborted) {
        throw abortError();
    }
    return commandReport(result, timeoutMs);
}

const TOOLS = {
    list_files: listFiles,
    read_file: readFileTool,
    search_files: searchFiles,
    write_file: writeFileTool,
    replace_text: replaceText,
    delete_file: deleteFileTool,
    run_command: runCommandTool,
    run_script: runScriptTool,
};

export async function executeProcessing(frame, io, signal) {
    ensure(signal);
    if (!io?.root || typeof io.root !== 'string' || !io.root.trim()) {
        return { error: 'нет папки workspace' };
    }
    const name = frame?.name;
    if (typeof name !== 'string' || !PROCESSABLE.includes(name)) {
        return { error: `Инструмент недоступен для захвата: ${name}.` };
    }
    const args = frame?.args && typeof frame.args === 'object' && !Array.isArray(frame.args) ? frame.args : {};
    try {
        return await TOOLS[name](args, io, signal);
    } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
            throw error?.name === 'AbortError' ? error : abortError();
        }
        return { error: error?.message || String(error) };
    }
}
