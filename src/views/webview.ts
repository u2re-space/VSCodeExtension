//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
export async function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, modules: string[]): Promise<string> {
    const vscodeAPI = await vscodePromise; // @ts-ignore
    const defaultCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'webview.css'))||'';
    const codiconCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'codicon.css'))||'';

    // @ts-ignore
    return `<html><head><link rel="stylesheet" href="${codiconCSS}"><link rel="stylesheet" href="${defaultCSS}"></head>
    <body style="margin: 0px; border: none 0px transparent; min-block-size: 100svh;">
        <div class="toolbar" tabindex="0">
            <span class="toolbar-label" style="flex-grow: 1;">Bulk actions:</span>
            <div class="toolbar-actions">
                <button onclick="send('bulk_build', '')" title="Build all"><i class='codicon codicon-package'></i></button>
                <button onclick="send('bulk_push', '')" title="Git add/commit/push all"><i class='codicon codicon-cloud-upload'></i></button>
            </div>
        </div>
        <table>${modules?.map?.(m => `<tr tabindex="0">
            <td class="name">${m}</td>
            <td class="actions">
                <div class="actions-container">
                <button onclick="send('open-dir', '${m}')" title="Open"><i class="codicon codicon-folder-opened"></i></button>
                <button onclick="send('audit', '${m}')" title="Audit"><i class="codicon codicon-github-action"></i></button>
                <button onclick="send('watch', '${m}')" title="Watch"><i class="codicon codicon-eye"></i></button>
                <button onclick="send('debug', '${m}')" title="Debug"><i class="codicon codicon-debug"></i></button>
                <button onclick="send('build', '${m}')" title="Build"><i class="codicon codicon-package"></i></button>
                <button onclick="send('test' , '${m}')" title="Test"><i class="codicon codicon-beaker"></i></button>
                <button onclick="send('diff', '${m}')" title="Git diff"><i class="codicon codicon-diff"></i></button>
                <button onclick="send('terminal', '${m}')" title="Terminal"><i class="codicon codicon-terminal"></i></button>
                <button onclick="send('push' , '${m}')" title="Git push"><i class="codicon codicon-cloud-upload"></i></button>
                </div>
            </td>
        </tr>`)?.join?.('')}</table>
        <script>
            const vscode = typeof acquireVsCodeApi != "undefined" ? acquireVsCodeApi?.() : null;
            function send(command, module = "") {
                vscode?.postMessage?.({ command, module });
            }

            // --- Keyboard navigation ---
            const toolbar = document.querySelector('.toolbar');
            const toolbarButtons = Array.from(toolbar.querySelectorAll('button'));
            let rows = Array.from(document.querySelectorAll('tr'));
            let current = 0; // индекс строки таблицы
            let inToolbar = false;
            let toolbarBtnIdx = 0;

            function focusToolbar(idx = 0) {
                inToolbar = true;
                toolbarBtnIdx = idx;
                toolbarButtons[toolbarBtnIdx]?.focus?.();
                rows.forEach(r => r.classList.remove('selected'));
            }

            function focusRow(idx, e) {
                inToolbar = false;
                if (rows[current]) rows[current].classList.remove('selected');
                current = (idx + rows.length) % rows.length;
                rows[current]?.classList?.add?.('selected');
                rows[current]?.focus?.();

                let btns = rows[current]?.querySelectorAll?.('button'), active = document.activeElement;
                let btx = Array.from(btns).indexOf(active); if (btx < 0) { btx = 0; }
                if (btx >= 0) btns[btx]?.focus?.(); else if (btns?.length) btns[btns.length - 1]?.focus?.();
                if (e) e.preventDefault();
            }

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
                        let btn = document.activeElement.tagName === 'BUTTON'
                            ? document.activeElement
                            : rows[current].querySelector('button');
                        if (btn) btn?.click?.();
                        e.preventDefault();
                    }
                    if (e.key === 'ArrowRight') {
                        let btns = rows[current].querySelectorAll('button');
                        let active = document.activeElement;
                        let idx = Array.from(btns).indexOf(active);
                        if (idx >= 0 && idx < btns.length - 1) btns[idx + 1]?.focus?.();
                        else if (btns.length) btns[0]?.focus?.();
                        e.preventDefault();
                    }
                    if (e.key === 'ArrowLeft') {
                        let btns = rows[current].querySelectorAll('button');
                        let active = document.activeElement;
                        let idx = Array.from(btns).indexOf(active);
                        if (idx > 0) btns[idx - 1]?.focus?.();
                        else if (btns.length) btns[btns.length - 1]?.focus?.();
                        e.preventDefault();
                    }
                }
            });
        </script>
    </body>
</html>`;
}
