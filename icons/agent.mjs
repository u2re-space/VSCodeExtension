const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const log = document.getElementById('log');
const approval = document.getElementById('approval');
const approvalText = document.getElementById('approvalText');
const approvalInput = document.getElementById('approvalInput');
const approvalActions = document.getElementById('approvalActions');
const prompt = document.getElementById('prompt');
const stop = document.getElementById('stop');

const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ph-icon');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#ph-${name}`);
    svg.appendChild(use);
    return svg;
};

const choice = (decision, glyph, dangerous) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = decision;
    button.setAttribute('aria-label', decision);
    if (dangerous) {
        button.classList.add('danger');
    }
    button.appendChild(icon(glyph));
    return button;
};

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
        const text = message.detail || message.state;
        status.textContent = text;
        status.title = text;
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
        approvalText.textContent = '';
        approvalInput.hidden = true;
        approvalInput.value = '';
        approvalActions.replaceChildren();
        return;
    }
    if (message.type === 'approval') {
        approval.hidden = false;
        approvalInput.hidden = true;
        approvalText.textContent = `${message.name || 'действие'} · ${message.category || ''} ${message.preview || ''}`.trim();
        approvalActions.replaceChildren();
        const choices = [
            ['yes', 'check', false],
            ['no', 'x', true],
            ['always', 'shield-check', false],
            ['abort', 'stop-circle', true],
        ];
        for (const [decision, glyph, dangerous] of choices) {
            const button = choice(decision, glyph, dangerous);
            button.addEventListener('click', () => {
                vscode.postMessage({ type: 'approve', requestId: message.requestId, decision });
                approval.hidden = true;
            });
            approvalActions.appendChild(button);
        }
        return;
    }
    if (message.type === 'question') {
        approval.hidden = false;
        approvalText.textContent = message.question;
        approvalInput.hidden = false;
        approvalInput.value = '';
        approvalActions.replaceChildren();
        const send = document.createElement('button');
        send.type = 'button';
        send.title = 'Ответить';
        send.setAttribute('aria-label', 'Ответить');
        send.appendChild(icon('paper-plane-tilt'));
        send.addEventListener('click', () => {
            vscode.postMessage({ type: 'answer', requestId: message.requestId, text: approvalInput.value });
            approval.hidden = true;
            approvalInput.hidden = true;
        });
        approvalActions.append(send);
    }
});

const more = document.querySelector('.more-menu');
more?.addEventListener('toggle', () => {
    document.body.classList.toggle('has-more-overlay', Boolean(more.open));
});

vscode.postMessage({ type: 'ready' });
