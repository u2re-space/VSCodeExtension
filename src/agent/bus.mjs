import { answerFrame, approveFrame, claimFrames, nextDelay, panelMessageFromHub, submissionFrame, toolResultFrame } from './protocol.mjs';

export function createBus({ WebSocketImpl, schedule = setTimeout, clearSchedule = clearTimeout, onMessage, onStatus, onToolRequest = null }) {
    let socket = null;
    let endpoint = null;
    let generation = 0;
    let unauthorized = false;
    let stopped = false;
    let delay = 0;
    let timer = null;
    let phase = 'idle';
    let hubReady = false;
    let pending = null;
    const runDirs = new Map();
    const inflight = new Set();

    const abortInflight = (runId) => {
        for (const controller of inflight) {
            if (runId === undefined || controller.runId === runId) {
                controller.abort();
            }
        }
    };

    const rememberRun = (run) => {
        if (!run || typeof run.id !== 'string' || typeof run.cwd !== 'string') {
            return;
        }
        runDirs.set(run.id, run.cwd);
    };

    const answerTool = async (frame) => {
        if (!frame || typeof frame.requestId !== 'string' || frame.requestId === '') {
            return;
        }
        const gen = generation;
        const controller = new AbortController();
        controller.runId = typeof frame.runId === 'string' ? frame.runId : '';
        inflight.add(controller);
        try {
            const cwd = controller.runId ? (runDirs.get(controller.runId) ?? '') : '';
            const result = onToolRequest
                ? await onToolRequest(frame, cwd, controller.signal)
                : { error: 'Обработка инструмента недоступна.' };
            if (controller.signal.aborted || gen !== generation) {
                return;
            }
            send(toolResultFrame(frame.requestId, result ?? { error: 'Ошибка инструмента.' }));
        } catch (error) {
            if (controller.signal.aborted || gen !== generation || error?.name === 'AbortError') {
                return;
            }
            send(toolResultFrame(frame.requestId, { error: error?.message || String(error) }));
        } finally {
            inflight.delete(controller);
        }
    };

    const clearStartingPhase = () => {
        if (phase === 'starting') {
            phase = 'idle';
        }
    };

    const status = (state, detail = '') => {
        onStatus?.({ type: 'status', state, detail });
    };

    const deliver = (frame) => {
        const message = panelMessageFromHub(frame);
        if (message) {
            onMessage?.(message);
        }
    };

    const failPending = () => {
        const queued = pending;
        pending = null;
        if (!queued) {
            return;
        }
        queued.resolve({ error: 'disconnected' });
    };

    const sameTarget = (next) => Boolean(
        next
        && endpoint
        && endpoint.url === next.url
        && endpoint.token === next.token,
    );

    const socketPendingOrOpen = () => Boolean(socket && (socket.readyState === 0 || socket.readyState === 1));

    const send = (frame) => {
        if (!hubReady || !socket || socket.readyState !== 1) {
            return false;
        }
        socket.send(JSON.stringify(frame));
        return true;
    };

    const dispatch = (result) => {
        for (const frame of result.frames) {
            send(frame);
        }
        if (result.frames.some((frame) => frame.type === 'start')) {
            phase = 'starting';
        }
        return result;
    };

    const flushPending = () => {
        const queued = pending;
        pending = null;
        if (!queued) {
            return;
        }
        if (!hubReady || !socket || socket.readyState !== 1) {
            queued.resolve({ error: 'disconnected' });
            return;
        }
        const result = submissionFrame({ ...queued.input, phase });
        if (result.error === 'pending') {
            status('connecting', 'запуск…');
        }
        if (result.error) {
            queued.resolve(result);
            return;
        }
        queued.resolve(dispatch(result));
    };

    const forgetRunIfAbsent = (runs) => {
        if (!phase || typeof phase !== 'object' || !phase.runId) {
            return;
        }
        const list = Array.isArray(runs) ? runs : [];
        const present = list.some((run) => run && run.id === phase.runId);
        if (!present) {
            phase = 'idle';
        }
    };

    const open = () => {
        if (!endpoint || stopped || unauthorized) {
            return;
        }
        const gen = ++generation;
        hubReady = false;
        status('connecting', endpoint.url);
        const ws = new WebSocketImpl(endpoint.url);
        socket = ws;
        ws.onopen = () => {
            if (gen !== generation) {
                return;
            }
            ws.send(JSON.stringify({ type: 'hello', role: 'client', token: endpoint.token }));
        };
        ws.onmessage = (event) => {
            if (gen !== generation) {
                return;
            }
            let frame;
            try {
                frame = JSON.parse(event.data);
            } catch {
                return;
            }
            if (frame.type === 'ready') {
                delay = 0;
                hubReady = true;
                status('ready', endpoint.url);
                forgetRunIfAbsent(frame.runs);
                if (Array.isArray(frame.runs)) {
                    for (const run of frame.runs) {
                        rememberRun(run);
                    }
                }
                for (const claim of claimFrames(frame.runs)) {
                    send(claim);
                }
                flushPending();
            }
            if (frame.type === 'error' && frame.code === 'unauthorized') {
                unauthorized = true;
            }
            if (frame.type === 'error' && phase === 'starting') {
                phase = 'idle';
            }
            if (frame.type === 'run.started') {
                rememberRun(frame.run);
                if (frame.run && phase === 'starting') {
                    phase = { runId: frame.run.id, command: frame.run.command };
                }
            }
            if (frame.type === 'run.ended') {
                abortInflight(frame.runId);
                if (typeof frame.runId === 'string') {
                    runDirs.delete(frame.runId);
                }
                if (phase && phase.runId === frame.runId) {
                    phase = 'idle';
                }
            }
            if (frame.type === 'tool.request') {
                void answerTool(frame);
            }
            deliver(frame);
        };
        ws.onclose = (event) => {
            if (gen !== generation) {
                return;
            }
            clearStartingPhase();
            hubReady = false;
            socket = null;
            abortInflight();
            failPending();
            if (stopped || unauthorized || event?.code === 1008) {
                if (event?.code === 1008) {
                    unauthorized = true;
                    status('unauthorized', 'Неверный токен.');
                }
                return;
            }
            delay = nextDelay(delay);
            status('disconnected', 'нет связи');
            timer = schedule(open, delay);
        };
    };

    return {
        connect(next) {
            if (!stopped && !unauthorized && sameTarget(next) && socketPendingOrOpen()) {
                return;
            }
            clearStartingPhase();
            failPending();
            abortInflight();
            runDirs.clear();
            hubReady = false;
            stopped = false;
            unauthorized = false;
            delay = 0;
            if (timer) {
                clearSchedule(timer);
                timer = null;
            }
            generation += 1;
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
            endpoint = next;
            open();
        },
        close() {
            clearStartingPhase();
            failPending();
            abortInflight();
            runDirs.clear();
            hubReady = false;
            stopped = true;
            generation += 1;
            if (timer) {
                clearSchedule(timer);
                timer = null;
            }
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
        },
        resetPhase() {
            phase = 'idle';
        },
        submit(input) {
            const stored = {
                command: input.command,
                prompt: input.prompt,
                cwd: input.cwd,
                approve: input.approve,
            };
            if (!hubReady) {
                const preview = submissionFrame({ ...stored, phase });
                if (preview.error === 'pending') {
                    status('connecting', 'запуск…');
                    return preview;
                }
                if (preview.error) {
                    return preview;
                }
                if (!socketPendingOrOpen() || stopped) {
                    return { error: 'disconnected' };
                }
                if (pending) {
                    return { error: 'pending' };
                }
                return new Promise((resolve) => {
                    pending = { input: stored, resolve };
                });
            }
            if (!socket || socket.readyState !== 1) {
                return { error: 'disconnected' };
            }
            const result = submissionFrame({ ...stored, phase });
            if (result.error === 'pending') {
                status('connecting', 'запуск…');
                return result;
            }
            if (result.error) {
                return result;
            }
            return dispatch(result);
        },
        approve(requestId, decision) {
            if (!hubReady) {
                return false;
            }
            return send(approveFrame(requestId, decision));
        },
        answer(requestId, text) {
            if (!hubReady) {
                return false;
            }
            return send(answerFrame(requestId, text));
        },
        cancel() {
            if (!hubReady || !phase || typeof phase !== 'object' || !phase.runId) {
                return false;
            }
            return send({ type: 'cancel', runId: phase.runId });
        },
    };
}
