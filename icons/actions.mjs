// @ts-ignore
// NOTE: acquireVsCodeApi() can only be called once per webview.
// Cache it on globalThis to avoid "already been acquired" errors (common on Remote-SSH too).
const vscode = (() => {
    try {
        // @ts-ignore
        if (globalThis.__vscodeApi) { return globalThis.__vscodeApi; }
        // @ts-ignore
        if (typeof acquireVsCodeApi !== "undefined") {
            // @ts-ignore
            globalThis.__vscodeApi = acquireVsCodeApi();
            // @ts-ignore
            return globalThis.__vscodeApi;
        }
    } catch {}
    return null;
})();

const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    // @ts-ignore
    return el?.content || "";
};
const INSTANCE_ID = meta("vext-instance");
const VIEW_TYPE = meta("vext-viewType");
const VERSION = meta("vext-version");

const report = (payload) => {
    try {
        vscode?.postMessage?.({ type: "webviewError", instanceId: INSTANCE_ID, viewType: VIEW_TYPE, version: VERSION, ...payload });
    } catch {}
};

// Hardening: surface any runtime issues in Extension Host logs
window.addEventListener("error", (e) => {
    report({ message: e?.message, filename: e?.filename, lineno: e?.lineno, colno: e?.colno, stack: e?.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
    report({ message: "unhandledrejection", reason: String(e?.reason ?? "") });
});

//
function renderModules(modules = []) {
    const tbody = document.getElementById('modulesTbody');
    if (!tbody) return;

    const list = Array.from(new Set([
        "./",
        ...(modules || [])
    ].filter(Boolean)));

    // Trusted Types: avoid innerHTML. Build DOM nodes directly.
    tbody.textContent = '';

    const mkIcon = (name) => {
        const i = document.createElement('i');
        i.className = `codicon ${name}`;
        return i;
    };

    const mkBtn = (cmd, mod, title, icon) => {
        const b = document.createElement('button');
        b.dataset.command = cmd;
        b.dataset.module = mod;
        b.title = title;
        b.appendChild(mkIcon(icon));
        return b;
    };

    for (const m of list) {
        const tr = document.createElement('tr');
        tr.tabIndex = 0;
        tr.dataset.module = m;

        const tdName = document.createElement('td');
        tdName.className = 'name';
        tdName.textContent = m;

        const tdActions = document.createElement('td');
        tdActions.className = 'actions';

        const wrap = document.createElement('div');
        wrap.className = 'actions-container';

        wrap.appendChild(mkBtn('open-dir', m, 'Open', 'codicon-folder-opened'));
        wrap.appendChild(mkBtn('terminal', m, 'Terminal', 'codicon-terminal'));
        wrap.appendChild(mkBtn('dev', m, 'Dev Serve', 'codicon-debug-alt'));
        wrap.appendChild(mkBtn('build', m, 'Build', 'codicon-package'));
        wrap.appendChild(mkBtn('test', m, 'Test', 'codicon-beaker'));
        wrap.appendChild(mkBtn('watch', m, 'Watch', 'codicon-eye'));
        wrap.appendChild(mkBtn('debug', m, 'Debug', 'codicon-debug'));
        wrap.appendChild(mkBtn('diff', m, 'Git diff', 'codicon-diff'));
        wrap.appendChild(mkBtn('install', m, 'Install', 'codicon-cloud-download'));
        wrap.appendChild(mkBtn('push', m, 'Git push', 'codicon-cloud-upload'));

        tdActions.appendChild(wrap);
        tr.appendChild(tdName);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
    }

    // refresh cached rows for keyboard navigation
    rows = Array.from(document.querySelectorAll('tr'));
}

// --- Keyboard navigation ---
let toolbar = null;
let toolbarButtons = [];

//
let rows = Array.from(document.querySelectorAll('tr'));
let current = 0; // ?????? ?????? ???????
let inToolbar = false;
let toolbarBtnIdx = 0;

//
function send(command, module = "") {
    vscode?.postMessage?.({ command, module, instanceId: INSTANCE_ID, viewType: VIEW_TYPE, version: VERSION });
}

//
function focusToolbar(idx = 0) {
    inToolbar = true;
    toolbarBtnIdx = idx;
    toolbarButtons[toolbarBtnIdx]?.focus?.();
    rows = Array.from(document.querySelectorAll('tr'));
    rows.forEach(r => r.classList.remove('selected'));
}

//
function focusRow(idx, e) {
    inToolbar = false;
    rows = Array.from(document.querySelectorAll('tr'));
    if (!rows.length) return;
    if (rows[current]) rows[current].classList.remove('selected');
    current = (idx + rows.length) % rows.length;
    rows[current]?.classList?.add?.('selected');
    rows[current]?.focus?.();

    let btns = rows[current]?.querySelectorAll?.('button'), active = document.activeElement; // @ts-ignore
    let btx = Array.from(btns).indexOf(active); if (btx < 0) { btx = 0; }
    if (btx >= 0) btns[btx]?.focus?.(); else if (btns?.length) btns[btns.length - 1]?.focus?.();
    if (e) e.preventDefault();
}

//
document.body.addEventListener('click', (e) => {
    // @ts-ignore
    const btn = e?.target?.closest?.('button[data-command]');
    if (!btn) return;
    // @ts-ignore
    send(btn.dataset.command, btn.dataset.module || "");
});

//
document.body.addEventListener('keydown', e => {
    if (inToolbar) {
        if (e.key === 'ArrowDown') { focusRow(current + 1, e); }
        if (e.key === 'ArrowRight') {
            toolbarBtnIdx = (toolbarBtnIdx + 1) % toolbarButtons.length;
            toolbarButtons[toolbarBtnIdx]?.focus?.();
            e.preventDefault();
        }
        if (e.key === 'ArrowLeft') {
            toolbarBtnIdx = (toolbarBtnIdx - 1 + toolbarButtons.length) % toolbarButtons.length;
            toolbarButtons[toolbarBtnIdx]?.focus?.();
            e.preventDefault();
        }
        if (e.key === 'ArrowUp') {
            // ?????? ?? ??????, ??? ????? ????????? ?? ????????? ??????
        }
        if (e.key === 'Enter') {
            toolbarButtons[toolbarBtnIdx]?.click?.();
            e.preventDefault();
        }
    } else {
        if (e.key === 'ArrowDown') { focusRow(current + 1); e.preventDefault(); }
        if (e.key === 'ArrowUp') {
            if (current === 0) {
                focusToolbar(0);
            } else {
                focusRow(current - 1);
            }
            e.preventDefault();
        }
        if (e.key === 'Enter') {
            let btn = document.activeElement?.tagName === 'BUTTON'
                ? document.activeElement
                : rows[current].querySelector('button');

            // @ts-ignore
            if (btn) btn?.click?.();
            e.preventDefault();
        }
        if (e.key === 'ArrowRight') {
            let btns = rows[current].querySelectorAll('button');
            let active = document.activeElement; // @ts-ignore
            let idx = Array.from(btns).indexOf(active);
            if (idx >= 0 && idx < btns.length - 1) btns[idx + 1]?.focus?.();
            else if (btns.length) btns[0]?.focus?.();
            e.preventDefault();
        }
        if (e.key === 'ArrowLeft') {
            let btns = rows[current].querySelectorAll('button');
            let active = document.activeElement; // @ts-ignore
            let idx = Array.from(btns).indexOf(active);
            if (idx > 0) btns[idx - 1]?.focus?.();
            else if (btns.length) btns[btns.length - 1]?.focus?.();
            e.preventDefault();
        }
    }
});

//
window.addEventListener('message', (event) => {
    const msg = event?.data;
    if (msg?.type === 'modules') {
        renderModules(msg.modules || []);
    }
});

//
window.addEventListener('DOMContentLoaded', () => {
    toolbar = document.querySelector('.toolbar');
    toolbarButtons = Array.from(toolbar?.querySelectorAll?.('button') || []);
    rows = Array.from(document.querySelectorAll('tr'));

    send('ready', '');
});