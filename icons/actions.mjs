// @ts-ignore
const vscode = typeof acquireVsCodeApi != "undefined" ? acquireVsCodeApi?.() : null;

// --- Keyboard navigation ---
const toolbar = document.querySelector('.toolbar');
const toolbarButtons = Array.from(toolbar?.querySelectorAll?.('button')||[]);

//
let rows = Array.from(document.querySelectorAll('tr'));
let current = 0; // индекс строки таблицы
let inToolbar = false;
let toolbarBtnIdx = 0;

//
function send(command, module = "") {
    vscode?.postMessage?.({ command, module });
}

//
function focusToolbar(idx = 0) {
    inToolbar = true;
    toolbarBtnIdx = idx;
    toolbarButtons[toolbarBtnIdx]?.focus?.();
    rows.forEach(r => r.classList.remove('selected'));
}

//
function focusRow(idx, e) {
    inToolbar = false;
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
            // ничего не делаем, или можно зациклить на последнюю строку
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
