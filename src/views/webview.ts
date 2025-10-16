//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
export async function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, modules: string[]): Promise<string> {
    const vscodeAPI = await vscodePromise; // @ts-ignore
    const defaultCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'webview.css'))||'';
    const codiconCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'codicon.css'))||'';
    const actionsJS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'actions.mjs'))||'';

    // @ts-ignore
    let layout = `<html><head><link rel="stylesheet" href="${codiconCSS}"><link rel="stylesheet" href="${defaultCSS}"><script src="${actionsJS}" async defer></script></head>
    <body style="margin: 0px; border: none 0px transparent; min-block-size: 100svh;">
        <div class="toolbar" tabindex="0">
            <span class="toolbar-label" style="flex-grow: 1;">Bulk actions:</span>
            <div class="toolbar-actions">
                <button onclick="send('bulk_build', '')" title="Build all"><i class='codicon codicon-package'></i></button>
                <button onclick="send('bulk_push', '')" title="Git add/commit/push all"><i class='codicon codicon-cloud-upload'></i></button>
            </div>
        </div>
        <table>${modules?.map?.(m => `<tr tabindex="0">
            <td class="name" style="display: flex; flex-basis: max-content; inline-size: -webkit-fill-available; inline-size: stretch;">${m}</td>
            <td class="actions" style="min-inline-size: fit-content; inline-size: fit-content; max-inline-size: -webkit-fill-available; max-inline-size: stretch;">
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
    </body>
</html>`;

    // needs to remove indent and spaces "gas" from string (but needs to remain one space in tags)
    layout = layout.replace(/[\s\t]+/g, ' ');

    return layout;
}
