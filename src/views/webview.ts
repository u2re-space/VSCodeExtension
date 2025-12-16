//! use only TS types
import type * as vscode from "vscode";

import vscodePromise from "../imports/api.ts";

type WebviewContentOpts = {
    instanceId: string;
    viewType: string;
    version: string;
};

const appendVersion = (u: string, version: string) => {
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}v=${encodeURIComponent(version)}`;
};

const nonce32 = () => {
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
    return text;
};

export async function getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    opts: WebviewContentOpts
): Promise<string> {
    const vscodeAPI = await vscodePromise; // @ts-ignore
    const nonce = nonce32();

    const codiconCSS = appendVersion(
        String(webview.asWebviewUri(vscodeAPI.Uri.joinPath(extensionUri, "icons", "codicon.css"))),
        opts.version
    );
    const webviewCSS = appendVersion(
        String(webview.asWebviewUri(vscodeAPI.Uri.joinPath(extensionUri, "icons", "webview.css"))),
        opts.version
    );
    const actionsJS = appendVersion(
        String(webview.asWebviewUri(vscodeAPI.Uri.joinPath(extensionUri, "icons", "actions.mjs"))),
        opts.version
    );

    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data: https:`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource} data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`
    ].join("; ");

    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="vext-instance" content="${opts.instanceId}" />
  <meta name="vext-viewType" content="${opts.viewType}" />
  <meta name="vext-version" content="${opts.version}" />
  <link rel="stylesheet" href="${codiconCSS}" />
  <link rel="stylesheet" href="${webviewCSS}" />
</head>
<body>
  <div class="toolbar" tabindex="0">
    <span class="toolbar-label">Bulk actions:</span>
    <div class="toolbar-actions">
      <button data-command="bulk_build" title="Build all"><i class="codicon codicon-package"></i></button>
      <button data-command="bulk_install" title="Install all"><i class="codicon codicon-cloud-download"></i></button>
      <button data-command="bulk_push" title="Git add/commit/push all"><i class="codicon codicon-cloud-upload"></i></button>
    </div>
  </div>
  <table id="modulesTable" aria-label="Modules">
    <tbody id="modulesTbody">
      <tr tabindex="0" data-module="./">
        <td class="name">Loading…</td>
        <td class="actions"><div class="actions-container"></div></td>
      </tr>
    </tbody>
  </table>
  <script nonce="${nonce}" type="module" src="${actionsJS}"></script>
</body>
</html>`;
}

