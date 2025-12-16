//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
export async function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
    const vscodeAPI = await vscodePromise; // @ts-ignore
    const defaultCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'webview.css'))||'';
    const codiconCSS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'codicon.css'))||'';
    const actionsJS = webview?.asWebviewUri(vscodeAPI?.Uri?.joinPath?.(extensionUri, 'icons', 'actions.mjs'))||'';

    const nonce = (() => {
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let text = "";
        for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
        return text;
    })();

    // @ts-ignore
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        // Use nonce-based CSP for maximum compatibility (incl. Remote-SSH).
        // Keep `${webview.cspSource}` so external scripts loaded via asWebviewUri work.
        `script-src ${webview.cspSource} 'nonce-${nonce}'`
    ].join('; ');

    let layout = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codiconCSS}">
    <link rel="stylesheet" href="${defaultCSS}">
    <script nonce="${nonce}">
      // acquireVsCodeApi() can only be called once. Cache it globally for other scripts.
      let vscode = null;
      try {
        // @ts-ignore
        vscode = globalThis.__vscodeApi || (typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null);
        // @ts-ignore
        if (vscode) globalThis.__vscodeApi = vscode;
      } catch {}
      window.addEventListener('error', (e) => {
        try { vscode?.postMessage?.({ type: 'webviewError', message: e?.message, filename: e?.filename, lineno: e?.lineno, colno: e?.colno, stack: e?.error?.stack }); } catch {}
      });
      window.addEventListener('unhandledrejection', (e) => {
        try { vscode?.postMessage?.({ type: 'webviewError', message: 'unhandledrejection', reason: String(e?.reason ?? '') }); } catch {}
      });
    </script>
    <script nonce="${nonce}" src="${actionsJS}" type="module"></script></head>
    <body style="margin: 0px; border: none 0px transparent; min-block-size: 100svh;">
        <div class="toolbar" tabindex="0">
            <span class="toolbar-label" style="flex-grow: 1;">Bulk actions:</span>
            <div class="toolbar-actions">
                <button data-command="bulk_build" title="Build all"><i class='codicon codicon-package'></i></button>
                <button data-command="bulk_install" title="Install all"><i class='codicon codicon-cloud-download'></i></button>
                <button data-command="bulk_push" title="Git add/commit/push all"><i class='codicon codicon-cloud-upload'></i></button>
            </div>
        </div>
        <table id="modulesTable" aria-label="Modules"><tbody id="modulesTbody">
            <tr tabindex="0" data-module="./">
                <td class="name" style="display:flex;flex-basis:max-content;inline-size:-webkit-fill-available;inline-size:stretch;">Loading…</td>
                <td class="actions" style="min-inline-size:fit-content;inline-size:fit-content;max-inline-size:-webkit-fill-available;max-inline-size:stretch;">
                    <div class="actions-container"></div>
                </td>
            </tr>
        </tbody></table>
    </body>
</html>`;

    // needs to remove indent and spaces "gas" from string (but needs to remain one space in tags)
    layout = layout.replace(/[\s\t]+/g, ' ');
    return layout;
}

