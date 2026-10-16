import { acceptCompletion, completionRequest } from './protocol.mjs';

function wait(ms, token) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        const cancel = () => {
            clearTimeout(timer);
            resolve(true);
        };
        if (token?.isCancellationRequested) {
            cancel();
            return;
        }
        token?.onCancellationRequested?.(cancel);
    });
}

export function createCompleteClient({ WebSocketImpl, onStatus }) {
    let socket = null;
    let endpoint = null;
    let generation = 0;
    let resolveOpened = () => {};
    let opened = Promise.resolve();
    const waiters = new Map();

    const failAll = () => {
        for (const [id, waiter] of waiters) {
            waiter(null);
            waiters.delete(id);
        }
    };

    const settleOpened = () => {
        resolveOpened();
    };

    const open = () => {
        if (!endpoint?.completeWs) {
            return;
        }
        const gen = ++generation;
        const ws = new WebSocketImpl(endpoint.completeWs);
        socket = ws;
        let resolveThis = () => {};
        opened = new Promise((resolve) => {
            resolveThis = resolve;
            resolveOpened = resolve;
        });
        ws.onopen = () => {
            if (gen !== generation) {
                return;
            }
            resolveThis();
        };
        ws.onmessage = (event) => {
            if (gen !== generation) {
                return;
            }
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            if (message?.type === 'error') {
                onStatus?.(String(message.message ?? 'Ошибка дополнения.'));
                const waiter = waiters.get(message.id);
                if (waiter) {
                    waiter(null);
                    waiters.delete(message.id);
                }
                return;
            }
            const waiter = waiters.get(message?.id);
            if (!waiter) {
                return;
            }
            waiter(acceptCompletion(message.id, message));
            waiters.delete(message.id);
        };
        ws.onclose = () => {
            if (gen !== generation) {
                return;
            }
            socket = null;
            settleOpened();
            failAll();
        };
    };

    const dropSocket = () => {
        generation += 1;
        const current = socket;
        socket = null;
        settleOpened();
        failAll();
        try {
            current?.close(1000);
        } catch { /* already closed */ }
    };

    return {
        connect(next) {
            dropSocket();
            endpoint = next;
            open();
        },
        close() {
            dropSocket();
        },
        request(body, signal) {
            const gen = generation;
            const sendNow = () => new Promise((resolve) => {
                if (gen !== generation || !socket || socket.readyState !== 1) {
                    resolve(null);
                    return;
                }
                const finish = (value) => resolve(value);
                waiters.set(body.id, finish);
                const cancel = () => {
                    if (waiters.get(body.id) !== finish) {
                        return;
                    }
                    waiters.delete(body.id);
                    finish(null);
                };
                if (signal?.isCancellationRequested) {
                    cancel();
                    return;
                }
                signal?.onCancellationRequested?.(cancel);
                socket.send(JSON.stringify(body));
            });
            if (socket && socket.readyState === 1) {
                return sendNow();
            }
            if (signal?.isCancellationRequested) {
                return Promise.resolve(null);
            }
            return opened.then(sendNow);
        },
        isOpen() {
            return Boolean(socket && socket.readyState === 1);
        },
    };
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];

function editorDiagnostics(vscode, document) {
    if (typeof vscode.languages?.getDiagnostics !== 'function') {
        return [];
    }
    const list = vscode.languages.getDiagnostics(document.uri) ?? [];
    return list.slice(0, 24).map((item) => ({
        line: item.range?.start?.line ?? 0,
        character: item.range?.start?.character ?? 0,
        severity: SEVERITY[item.severity] ?? 'info',
        source: typeof item.source === 'string' ? item.source : '',
        message: String(item.message ?? ''),
    }));
}

function offsetIn(text, position) {
    const lines = String(text ?? '').split('\n');
    const line = Math.min(Math.max(position?.line ?? 0, 0), Math.max(0, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < line; i++) {offset += lines[i].length + 1;}
    const character = Math.min(Math.max(position?.character ?? 0, 0), lines[line].length);
    return offset + character;
}

function sameDocument(left, right) {
    if (!left || !right) {return false;}
    if (left === right) {return true;}
    const key = (doc) => {
        const uri = doc.uri;
        if (!uri) {return '';}
        if (typeof uri.toString === 'function' && uri.toString !== Object.prototype.toString) {
            const text = uri.toString();
            if (text && text !== '[object Object]') {return text;}
        }
        return uri.fsPath || uri.path || '';
    };
    const a = key(left);
    const b = key(right);
    return Boolean(a) && a === b;
}

/**
 * Ghost text that still belongs at the live cursor. Null when the buffer changed into something else.
 * insertText is only the characters the user has not typed. The range is that cursor, so the editor inserts instead of replacing the line.
 * @param {{ insertText: string, snapshot: string, anchor: { line: number, character: number }, liveText: string, liveCursor: { line: number, character: number } }} input
 * @returns {{ insertText: string, start: { line: number, character: number }, end: { line: number, character: number } }|null}
 */
export function liveInsertion({ insertText, snapshot, anchor, liveText, liveCursor }) {
    const insertion = String(insertText ?? '');
    if (!insertion || !anchor || !liveCursor) {return null;}
    if (liveCursor.line !== anchor.line || liveCursor.character < anchor.character) {return null;}
    const source = String(snapshot ?? '');
    const live = String(liveText ?? '');
    const origin = offsetIn(source, anchor);
    const head = source.slice(0, origin);
    const tail = source.slice(origin);
    if (!live.startsWith(head) || !live.endsWith(tail)) {return null;}
    const typed = live.slice(head.length, live.length - tail.length);
    if (typed.includes('\n') || typed.length !== liveCursor.character - anchor.character) {return null;}
    if (!insertion.startsWith(typed) || typed.length === insertion.length) {return null;}
    // The editor paints ghost text only for a pure insertion. The range is the cursor,
    // and insertText is the part the user has not typed yet.
    return {
        insertText: insertion.slice(typed.length),
        start: { line: liveCursor.line, character: liveCursor.character },
        end: { line: liveCursor.line, character: liveCursor.character },
    };
}

function relativePath(root, fsPath) {
    const full = String(fsPath ?? '').replace(/\\/g, '/');
    const base = String(root ?? '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!full || !base) {return full;}
    const prefix = `${base}/`;
    if (full.toLowerCase().startsWith(prefix.toLowerCase())) {return full.slice(prefix.length);}
    return full;
}

function openReferences(vscode, document) {
    const editors = vscode.window?.visibleTextEditors;
    if (!Array.isArray(editors)) {return [];}
    const root = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? '';
    const out = [];
    for (const editor of editors) {
        const doc = editor?.document;
        if (!doc || sameDocument(doc, document)) {continue;}
        const scheme = doc.uri?.scheme;
        if (scheme !== 'file' && scheme !== 'untitled') {continue;}
        const raw = typeof doc.getText === 'function' ? String(doc.getText() ?? '') : '';
        const content = raw.split('\n').slice(0, 40).join('\n').trim();
        if (!content) {continue;}
        const full = scheme === 'file' ? doc.uri.fsPath : (doc.uri.path || '');
        out.push({
            path: relativePath(root, full),
            language: typeof doc.languageId === 'string' ? doc.languageId : '',
            content,
        });
        if (out.length >= 4) {break;}
    }
    return out;
}

function cursorNow(vscode, document, anchor, version) {
    const editor = vscode.window?.activeTextEditor;
    const active = editor?.selection?.active;
    if (editor && active && sameDocument(editor.document, document)) {
        return { line: active.line, character: active.character };
    }
    if (document.version === version) {return anchor;}
    return null;
}

export function registerAgentCompletion(vscode, client, getSettings, onError) {
    let seq = 0;
    let ticket = 0;
    return vscode.languages.registerInlineCompletionItemProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }],
        {
            async provideInlineCompletionItems(document, position, _context, token) {
                const settings = getSettings();
                if (!settings.completionEnabled) {
                    return { items: [] };
                }
                const mine = ++ticket;
                const cancelled = await wait(settings.debounceMs, token);
                if (cancelled || token?.isCancellationRequested || mine !== ticket) {
                    return undefined;
                }
                const anchor = { line: position.line, character: position.character };
                const snapshot = document.getText();
                const version = document.version;
                try {
                    const id = String(++seq);
                    const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
                    const diagnostics = editorDiagnostics(vscode, document);
                    const body = completionRequest({
                        id,
                        language: document.languageId,
                        path: filePath,
                        text: snapshot,
                        cursor: anchor,
                        model: settings.completionModel,
                        problems: diagnostics,
                        validation: diagnostics,
                        references: openReferences(vscode, document),
                    });
                    if (!body) {
                        return { items: [] };
                    }
                    if (mine !== ticket || token?.isCancellationRequested) {
                        return undefined;
                    }
                    const text = await client.request(body, token);
                    if (!getSettings().completionEnabled) {
                        return { items: [] };
                    }
                    if (mine !== ticket || token?.isCancellationRequested) {
                        return undefined;
                    }
                    if (!text) {
                        return undefined;
                    }
                    const liveCursor = cursorNow(vscode, document, anchor, version);
                    const placed = liveCursor && liveInsertion({
                        insertText: text?.trim?.() || text,
                        snapshot,
                        anchor,
                        liveText: document.getText(),
                        liveCursor,
                    });
                    if (!placed) {
                        return undefined;
                    }
                    // Without a range, the editor replaces the current word through the end of the line
                    // and then hides the item unless that text is a prefix of the insertion.
                    const range = new vscode.Range(placed.start.line, placed.start.character, placed.end.line, placed.end.character);
                    return {
                        items: [{
                            insertText: placed.insertText,
                            filterText: placed.insertText,
                            range,
                        }],
                    };
                } catch (error) {
                    if (mine !== ticket || token?.isCancellationRequested) {
                        return undefined;
                    }
                    onError?.(error?.message || 'Ошибка дополнения.');
                    return { items: [] };
                }
            },
        },
    );
}
