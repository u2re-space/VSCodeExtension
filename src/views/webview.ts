//! use only TS types
import type * as vscode from "vscode";

import vscodePromise from "../imports/api.ts";

type WebviewContentOpts = {
    instanceId: string;
    viewType: string;
    version: string;
    theme?: string;
    actionCatalog?: unknown[];
    uiFlags?: {
        layout?: string;
        primaryActions?: string[];
    };
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

const PHOSPHOR_SPRITE = `
<span class="ph-sprite" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" class="ph-sprite-svg" aria-hidden="true" focusable="false">
  <symbol id="ph-dots-three" viewBox="0 0 256 256"><circle cx="60" cy="128" r="14"></circle><circle cx="128" cy="128" r="14"></circle><circle cx="196" cy="128" r="14"></circle></symbol>
  <symbol id="ph-folder-open" viewBox="0 0 256 256"><path d="M24 96h77l16-24h115M24 96v112a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V96Z" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-terminal-window" viewBox="0 0 256 256"><rect x="24" y="40" width="208" height="176" rx="16" fill="none" stroke="currentColor" stroke-width="16"></rect><path d="m72 104 32 24-32 24M128 160h56" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-rocket-launch" viewBox="0 0 256 256"><path d="M168 40c-36 8-80 52-88 88l48 48c36-8 80-52 88-88Z" fill="none" stroke="currentColor" stroke-width="16"></path><circle cx="156" cy="100" r="16"></circle></symbol>
  <symbol id="ph-package" viewBox="0 0 256 256"><path d="m40 80 88 48 88-48M40 80v96l88 48 88-48V80M128 128v96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-flask" viewBox="0 0 256 256"><path d="M88 32h80M104 32v44l-52 96a24 24 0 0 0 21 36h110a24 24 0 0 0 21-36l-52-96V32" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-eye" viewBox="0 0 256 256"><path d="M24 128s40-64 104-64 104 64 104 64-40 64-104 64-104-64-104-64Z" fill="none" stroke="currentColor" stroke-width="16"></path><circle cx="128" cy="128" r="28"></circle></symbol>
  <symbol id="ph-git-diff" viewBox="0 0 256 256"><circle cx="72" cy="64" r="12"></circle><circle cx="72" cy="192" r="12"></circle><circle cx="184" cy="128" r="12"></circle><path d="M72 76v104m12-52h88" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-download-simple" viewBox="0 0 256 256"><path d="m128 40 0 96m-32-32 32 32 32-32M48 176h160v40H48z" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-git-commit" viewBox="0 0 256 256"><circle cx="128" cy="128" r="16"></circle><path d="M24 128h72m64 0h72" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-shield-check" viewBox="0 0 256 256"><path d="M128 24 48 56v64c0 56 40 94 80 112 40-18 80-56 80-112V56Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="m92 128 20 20 52-52" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-wrench" viewBox="0 0 256 256"><path d="M208 80a56 56 0 0 1-77 52L68 195a20 20 0 1 1-28-28l63-63a56 56 0 0 1 52-77l-28 28 40 40 28-28A56 56 0 0 1 208 80Z" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-file-text" viewBox="0 0 256 256"><path d="M160 32v48h48M48 32h112l48 48v144H48Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="M88 132h80M88 164h80" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-binary" viewBox="0 0 256 256"><path d="M72 72v112m112-112v112M48 92h52m-52 72h52m56-72h52m-52 72h52" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-arrow-counter-clockwise" viewBox="0 0 256 256"><path d="M56 48H8v56M56 80a88 88 0 1 1-8 96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-arrows-clockwise" viewBox="0 0 256 256"><path d="M200 48h48v56M56 208H8v-56M200 80a88 88 0 1 0 8 96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-folder-notch-minus" viewBox="0 0 256 256"><path d="M24 96h77l16-24h115M24 96v112a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V96M104 160h48" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-warning-circle" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="none" stroke="currentColor" stroke-width="16"></circle><path d="M128 76v60m0 40h.01" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
</svg></span>`;

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
    const bootstrap = JSON.stringify({
        actionCatalog: opts.actionCatalog || [],
        uiFlags: opts.uiFlags || { layout: "compactMore", primaryActions: [] },
        theme: opts.theme || "dark"
    });

    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data: https:`,
        `style-src ${webview.cspSource}`,
        `font-src ${webview.cspSource} data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`
    ].join("; ");

    return `<!doctype html>
<html data-theme="${opts.theme || "dark"}">
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
<body data-theme="${opts.theme || "dark"}">
  ${PHOSPHOR_SPRITE}
  <div class="toolbar" tabindex="0">
    <span class="toolbar-label">Bulk actions:</span>
    <div class="toolbar-actions">
      <button data-command="bulk_build" data-icon="package" title="Build all"></button>
      <button data-command="bulk_install" data-icon="download-simple" title="Install all"></button>
      <button data-command="bulk_push" data-icon="git-commit" title="Git add/commit/push all"></button>
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
  <script nonce="${nonce}">window.__VEXT_BOOTSTRAP = ${bootstrap};</script>
  <script nonce="${nonce}" type="module" src="${actionsJS}"></script>
</body>
</html>`;
}

