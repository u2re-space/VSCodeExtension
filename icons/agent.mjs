const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const log = document.getElementById('log');
const approval = document.getElementById('approval');
const prompt = document.getElementById('prompt');
const stop = document.getElementById('stop');

const append = (className, text) => {
    const row = document.createElement('div');
    row.className = className || '';
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
};

document.getElementById('reconnect').addEventListener('click', () => {
    vscode.postMessage({ type: 'reconnect' });
});
stop.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
});
document.getElementById('cancel').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
});
document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const command = event.submitter?.dataset?.command;
    if (!command) {
        return;
    }
    vscode.postMessage({ type: 'start', command, prompt: prompt.value });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
        return;
    }
    if (message.type === 'status') {
        status.textContent = message.detail || message.state;
        return;
    }
    if (message.type === 'stopVisible') {
        stop.hidden = !message.visible;
        return;
    }
    if (message.type === 'text') {
        const last = log.lastElementChild;
        if (last && last.dataset.kind === 'text') {
            last.textContent += message.text;
        } else {
            const row = document.createElement('div');
            row.dataset.kind = 'text';
            row.textContent = message.text;
            log.appendChild(row);
        }
        log.scrollTop = log.scrollHeight;
        return;
    }
    if (message.type === 'log') {
        append(message.level, message.text);
        return;
    }
    if (message.type === 'run' && message.status === 'ended') {
        append('info', `завершено (${message.exitCode})`);
        approval.hidden = true;
        approval.replaceChildren();
        return;
    }
    if (message.type === 'approval') {
        approval.hidden = false;
        approval.replaceChildren();
        const title = document.createElement('div');
        title.textContent = `${message.name || 'действие'} · ${message.category || ''} ${message.preview || ''}`.trim();
        approval.appendChild(title);
        for (const decision of ['yes', 'no', 'always', 'abort']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = decision;
            button.addEventListener('click', () => {
                vscode.postMessage({ type: 'approve', requestId: message.requestId, decision });
                approval.hidden = true;
            });
            approval.appendChild(button);
        }
        return;
    }
    if (message.type === 'question') {
        approval.hidden = false;
        approval.replaceChildren();
        const title = document.createElement('div');
        title.textContent = message.question;
        const input = document.createElement('input');
        input.type = 'text';
        const send = document.createElement('button');
        send.type = 'button';
        send.textContent = 'Ответить';
        send.addEventListener('click', () => {
            vscode.postMessage({ type: 'answer', requestId: message.requestId, text: input.value });
            approval.hidden = true;
        });
        approval.append(title, input, send);
    }
});

vscode.postMessage({ type: 'ready' });
