//! use only TS types
import type * as vscode from "vscode";

import vscodePromise from "../imports/api.ts";

type WebviewContentOpts = {
    instanceId: string;
    viewType: string;
    version: string;
    theme?: string;
    actionCatalog?: unknown[];
    initialModules?: string[];
    uiFlags?: {
        layout?: string;
        primaryActions?: string[];
        secondaryActions?: string[];
        bulkActions?: string[];
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
<span class="ph-sprite" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" class="ph-sprite-svg" aria-hidden="true" focusable="false" width="0" height="0">
<defs>
  <symbol id="ph-dots-three" viewBox="0 0 256 256"><circle cx="60" cy="128" r="14" fill="currentColor"></circle><circle cx="128" cy="128" r="14" fill="currentColor"></circle><circle cx="196" cy="128" r="14" fill="currentColor"></circle></symbol>
  <symbol id="ph-folder-open" viewBox="0 0 256 256"><path d="M24 96h77l16-24h115M24 96v112a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V96Z" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-terminal-window" viewBox="0 0 256 256"><rect x="24" y="40" width="208" height="176" rx="16" fill="none" stroke="currentColor" stroke-width="16"></rect><path d="m72 104 32 24-32 24M128 160h56" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-rocket-launch" viewBox="0 0 256 256"><path fill="currentColor" d="M223.85,47.12a16,16,0,0,0-15-15c-12.58-.75-44.73.4-71.41,27.07L132.69,64H74.36A15.91,15.91,0,0,0,63,68.68L28.7,103a16,16,0,0,0,9.07,27.16l38.47,5.37,44.21,44.21,5.37,38.49a15.94,15.94,0,0,0,10.78,12.92,16.11,16.11,0,0,0,5.1.83A15.91,15.91,0,0,0,153,227.3L187.32,193A15.91,15.91,0,0,0,192,181.64V123.31l4.77-4.77C223.45,91.86,224.6,59.71,223.85,47.12ZM74.36,80h42.33L77.16,119.52,40,114.34Zm74.41-9.45a76.65,76.65,0,0,1,59.11-22.47,76.46,76.46,0,0,1-22.42,59.16L128,164.68,91.32,128ZM176,181.64,141.67,216l-5.19-37.17L176,139.31Zm-74.16,9.5C97.34,201,82.29,224,40,224a8,8,0,0,1-8-8c0-42.29,23-57.34,32.86-61.85a8,8,0,0,1,6.64,14.56c-6.43,2.93-20.62,12.36-23.12,38.91,26.55-2.5,36-16.69,38.91-23.12a8,8,0,1,1,14.56,6.64Z"></path></symbol>
  <symbol id="ph-package" viewBox="0 0 256 256"><path fill="currentColor" d="M223.68,66.15,135.68,18a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32l80.34,44-29.77,16.3-80.35-44ZM128,120,47.66,76l33.9-18.56,80.34,44ZM40,90l80,43.78v85.79L40,175.82Zm176,85.78h0l-80,43.79V133.82l32-17.51V152a8,8,0,0,0,16,0V107.55L216,90v85.77Z"></path></symbol>
  <symbol id="ph-flask" viewBox="0 0 256 256"><path fill="currentColor" d="M221.69,199.77,160,96.92V40h8a8,8,0,0,0,0-16H88a8,8,0,0,0,0,16h8V96.92L34.31,199.77A16,16,0,0,0,48,224H208a16,16,0,0,0,13.72-24.23ZM110.86,103.25A7.93,7.93,0,0,0,112,99.14V40h32V99.14a7.93,7.93,0,0,0,1.14,4.11L183.36,167c-12,2.37-29.07,1.37-51.75-10.11-15.91-8.05-31.05-12.32-45.22-12.81ZM48,208l28.54-47.58c14.25-1.74,30.31,1.85,47.82,10.72,19,9.61,35,12.88,48,12.88a69.89,69.89,0,0,0,19.55-2.7L208,208Z"></path></symbol>
  <symbol id="ph-eye" viewBox="0 0 256 256"><path d="M24 128s40-64 104-64 104 64 104 64-40 64-104 64-104-64-104-64Z" fill="none" stroke="currentColor" stroke-width="16"></path><circle cx="128" cy="128" r="28" fill="none" stroke="currentColor" stroke-width="16"></circle></symbol>
  <symbol id="ph-git-diff" viewBox="0 0 256 256"><circle cx="72" cy="64" r="12" fill="none" stroke="currentColor" stroke-width="16"></circle><circle cx="72" cy="192" r="12" fill="none" stroke="currentColor" stroke-width="16"></circle><circle cx="184" cy="128" r="12" fill="none" stroke="currentColor" stroke-width="16"></circle><path d="M72 76v104m12-52h88" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-download-simple" viewBox="0 0 256 256"><path fill="currentColor" d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z"></path></symbol>
  <symbol id="ph-git-commit" viewBox="0 0 256 256"><path fill="currentColor" d="M248,120H183.42a56,56,0,0,0-110.84,0H8a8,8,0,0,0,0,16H72.58a56,56,0,0,0,110.84,0H248a8,8,0,0,0,0-16ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"></path></symbol>
  <symbol id="ph-shield-check" viewBox="0 0 256 256"><path d="M128 24 48 56v64c0 56 40 94 80 112 40-18 80-56 80-112V56Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="m92 128 20 20 52-52" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-wrench" viewBox="0 0 256 256"><path d="M208 80a56 56 0 0 1-77 52L68 195a20 20 0 1 1-28-28l63-63a56 56 0 0 1 52-77l-28 28 40 40 28-28A56 56 0 0 1 208 80Z" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-file-text" viewBox="0 0 256 256"><path d="M160 32v48h48M48 32h112l48 48v144H48Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="M88 132h80M88 164h80" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-binary" viewBox="0 0 256 256"><path d="M72 72v112m112-112v112M48 92h52m-52 72h52m56-72h52m-52 72h52" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-arrow-counter-clockwise" viewBox="0 0 256 256"><path d="M56 48H8v56M56 80a88 88 0 1 1-8 96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-arrows-clockwise" viewBox="0 0 256 256"><path d="M200 48h48v56M56 208H8v-56M200 80a88 88 0 1 0 8 96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-folder-notch-minus" viewBox="0 0 256 256"><path d="M24 96h77l16-24h115M24 96v112a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V96M104 160h48" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-warning-circle" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="none" stroke="currentColor" stroke-width="16"></circle><path d="M128 76v60m0 40h.01" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-arrow-clockwise" viewBox="0 0 256 256"><path d="M224 48v56h-56M198 104a88 88 0 1 0-8 96" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-stop-circle" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="none" stroke="currentColor" stroke-width="16"></circle><rect x="108" y="108" width="40" height="40" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></rect></symbol>
</defs>
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
        initialModules: Array.isArray(opts.initialModules) && opts.initialModules.length ? opts.initialModules : ["./"],
        uiFlags: opts.uiFlags || { layout: "compactMore", primaryActions: [], secondaryActions: [], bulkActions: [] },
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
    <div class="toolbar-actions" id="toolbarActions">
    </div>
    <button type="button" class="refresh-modules" id="refreshModules" title="Refresh module list" aria-label="Refresh module list">
      <svg class="ph-icon" viewBox="0 0 256 256" aria-hidden="true"><use href="#ph-arrow-clockwise"></use></svg>
    </button>
    <span class="scan-status" id="scanStatus" hidden>Scanning…</span>
  </div>
  <table id="modulesTable" aria-label="Modules">
    <tbody id="modulesTbody">
    </tbody>
  </table>
  <script nonce="${nonce}">window.__VEXT_BOOTSTRAP = ${bootstrap};</script>
  <script nonce="${nonce}" type="module" src="${actionsJS}"></script>
</body>
</html>`;
}

