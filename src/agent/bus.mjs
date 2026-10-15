import { answerFrame, approveFrame, nextDelay, panelMessageFromHub, submissionFrame } from './protocol.mjs';

export function createBus({ WebSocketImpl, schedule = setTimeout, clearSchedule = clearTimeout, onMessage, onStatus }) {
    let socket = null;
    let endpoint = null;
    let generation = 0;
    let unauthorized = false;
    let stopped = false;
    let delay = 0;
    let timer = null;
    let phase = 'idle';

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

    const open = () => {
        if (!endpoint || stopped || unauthorized) {
            return;
        }
        const gen = ++generation;
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
                status('ready', endpoint.url);
            }
            if (frame.type === 'error' && frame.code === 'unauthorized') {
                unauthorized = true;
            }
            if (frame.type === 'run.started' && frame.run && phase === 'starting') {
                phase = { runId: frame.run.id, command: frame.run.command };
            }
            if (frame.type === 'run.ended' && phase && phase.runId === frame.runId) {
                phase = 'idle';
            }
            deliver(frame);
        };
        ws.onclose = (event) => {
            if (gen !== generation) {
                return;
            }
            clearStartingPhase();
            socket = null;
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

    const send = (frame) => {
        if (!socket || socket.readyState !== 1) {
            return false;
        }
        socket.send(JSON.stringify(frame));
        return true;
    };

    return {
        connect(next) {
            clearStartingPhase();
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
        submit(input) {
            const result = submissionFrame({ ...input, phase });
            if (result.error === 'pending') {
                status('connecting', 'запуск…');
                return result;
            }
            if (result.error) {
                return result;
            }
            if (!socket || socket.readyState !== 1) {
                return { error: 'disconnected' };
            }
            for (const frame of result.frames) {
                send(frame);
            }
            if (result.frames.some((frame) => frame.type === 'start')) {
                phase = 'starting';
            }
            return result;
        },
        approve(requestId, decision) {
            return send(approveFrame(requestId, decision));
        },
        answer(requestId, text) {
            return send(answerFrame(requestId, text));
        },
    };
}
