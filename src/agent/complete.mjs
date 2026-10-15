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
    let opened = Promise.resolve();
    const waiters = new Map();

    const failAll = () => {
        for (const [id, waiter] of waiters) {
            waiter(null);
            waiters.delete(id);
        }
    };

    const open = () => {
        if (!endpoint?.completeWs) {
            return;
        }
        const gen = ++generation;
        const ws = new WebSocketImpl(endpoint.completeWs);
        socket = ws;
        opened = new Promise((resolve) => {
            ws.onopen = () => resolve();
        });
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
            failAll();
        };
    };

    return {
        connect(next) {
            generation += 1;
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
            endpoint = next;
            open();
        },
        close() {
            generation += 1;
            failAll();
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
        },
        request(body, signal) {
            const sendNow = () => new Promise((resolve) => {
                if (!socket || socket.readyState !== 1) {
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
            return opened.then(sendNow);
        },
        isOpen() {
            return Boolean(socket && socket.readyState === 1);
        },
    };
}

export function registerAgentCompletion(vscode, client, getSettings, onError) {
    let seq = 0;
    return vscode.languages.registerInlineCompletionItemProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }],
        {
            async provideInlineCompletionItems(document, position, _context, token) {
                const settings = getSettings();
                if (!settings.completionEnabled) {
                    return { items: [] };
                }
                const cancelled = await wait(settings.debounceMs, token);
                if (cancelled || token?.isCancellationRequested) {
                    return { items: [] };
                }
                const id = String(++seq);
                const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
                let body;
                try {
                    body = completionRequest({
                        id,
                        language: document.languageId,
                        path: filePath,
                        text: document.getText(),
                        cursor: { line: position.line, character: position.character },
                    });
                } catch (error) {
                    onError?.(error?.message || 'Ошибка дополнения.');
                    return { items: [] };
                }
                if (!body) {
                    return { items: [] };
                }
                try {
                    const text = await client.request(body, token);
                    if (!text) {
                        return { items: [] };
                    }
                    return { items: [{ insertText: text }] };
                } catch (error) {
                    onError?.(error?.message || 'Ошибка дополнения.');
                    return { items: [] };
                }
            },
        },
    );
}
