import vscodeAPI from '../imports/api.ts';

//
const GPTUNNEL_URL = "https://gptunnel.ru/model/gpt-5.2/";

function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
    return text;
}

function getOfflineHtml(webview) {
    const nonce = getNonce();
    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GPTunnel</title>
</head>
<body style="margin:0;padding:14px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
  <div style="max-width: 880px;">
    <h3 style="margin:0 0 8px 0;font-weight:600;">GPTunnel View</h3>
    <p style="margin:0 0 12px 0;opacity:.9;">
      Recent VSCode/Cursor builds often block remote sites inside WebViews (iframes) due to security headers (CSP / X-Frame-Options).
      This view now defaults to an offline/local-safe UI.
    </p>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin: 0 0 12px 0;">
      <button id="openExternal">Open GPTunnel in browser</button>
      <button id="tryEmbed" title="May be blocked by the remote site.">Try embed (may fail)</button>
      <button id="reload">Reload</button>
    </div>

    <div style="padding:10px;border-radius:6px;border:1px solid var(--vscode-editorWidget-border);background:var(--vscode-editorWidget-background);">
      <div style="font-weight:600;margin-bottom:6px;">URL</div>
      <code>${GPTUNNEL_URL}</code>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openExternal').addEventListener('click', () => vscode.postMessage({ command: 'openExternal' }));
    document.getElementById('tryEmbed').addEventListener('click', () => vscode.postMessage({ command: 'tryEmbed' }));
    document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
  </script>
</body>
</html>`;
}

function getEmbedHtml(webview) {
    const nonce = getNonce();
    // NOTE: even with this CSP, the remote site may refuse to be framed via its own CSP/X-Frame-Options.
    const csp = [
        "default-src 'none'",
        `frame-src https:`,
        `img-src ${webview.cspSource} data: https:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GPTunnel</title>
</head>
<body style="inline-size:100dvw;block-size:100dvh;overflow:hidden;padding:0;margin:0;border:none;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);">
  <div id="shell" style="box-sizing:border-box;padding:12px;display:flex;flex-direction:column;gap:10px;block-size:100dvh;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button id="loadFrame">Load embedded iframe</button>
      <button id="openExternal">Open in browser</button>
      <button id="back">Back</button>
      <span style="opacity:.85">(${GPTUNNEL_URL})</span>
    </div>
    <div id="status" style="opacity:.85;">
      The iframe is created lazily on click. If the site blocks framing (CSP / X-Frame-Options), it will stay blank.
    </div>
    <div id="frameHost" style="flex:1;min-block-size:0;border:1px solid var(--vscode-editorWidget-border);border-radius:6px;overflow:hidden;background:var(--vscode-editorWidget-background);"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const host = document.getElementById('frameHost');
    const status = document.getElementById('status');
    let loaded = false;
    let timer = null;

    function setStatus(t) { if (status) status.textContent = t; }

    function createIframe() {
      if (loaded) return;
      loaded = true;
      setStatus('Loading… If this stays blank, the remote site likely blocks being embedded.');

      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'padding:0;margin:0;border:none;box-sizing:border-box;inline-size:100%;block-size:100%;';
      iframe.referrerPolicy = 'no-referrer';
      iframe.src = ${JSON.stringify(GPTUNNEL_URL)};
      iframe.addEventListener('load', () => {
        if (timer) { clearTimeout(timer); timer = null; }
        setStatus('Loaded (or at least navigated). If you still see blank content, it may be blocked inside an iframe.');
      });
      while (host.firstChild) { host.removeChild(host.firstChild); }
      host.appendChild(iframe);

      // If the remote site blocks framing, load may never fire; provide a friendly fallback.
      timer = setTimeout(() => {
        setStatus('Still not showing. This is usually blocked by the site’s own CSP/X-Frame-Options. Use “Open in browser”.');
      }, 6000);
    }

    document.getElementById('loadFrame').addEventListener('click', createIframe);
    document.getElementById('openExternal').addEventListener('click', () => vscode.postMessage({ command: 'openExternal' }));
    document.getElementById('back').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
  </script>
</body>
</html>`;
}

//
export class CustomSidebarViewProvider {
    static viewType = "vext.gptView";
    static panelViewType = "vext.gptPanelView";
    _extensionUri; _view;
    constructor(extensionUri) { this._extensionUri = extensionUri; }

    //
    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };

        webviewView.webview.onDidReceiveMessage?.(async (message) => {
            const vscode = await vscodeAPI;
            switch (message?.command) {
                case "openExternal":
                    return vscode?.env?.openExternal?.(vscode.Uri.parse(GPTUNNEL_URL));
                case "tryEmbed":
                    webviewView.webview.html = getEmbedHtml(webviewView.webview);
                    return;
                case "reload":
                    webviewView.webview.html = getOfflineHtml(webviewView.webview);
                    return;
            }
        });

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    }

    //
    getHtmlContent(webview) {
        return getOfflineHtml(webview);
    }
}

//
export async function webview(context) {
    const vscode = await vscodeAPI;
    const providerSidebar = new CustomSidebarViewProvider(context.extensionUri);
    const providerPanel = new CustomSidebarViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(CustomSidebarViewProvider.viewType, providerSidebar));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(CustomSidebarViewProvider.panelViewType, providerPanel));
    context.subscriptions.push(vscode.commands.registerCommand('vext.openWebview', function () {
        const panel = vscode.window.createWebviewPanel(
            'vext.gptView',
            'GPTUnnel Web View',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel.webview.html = getOfflineHtml(panel.webview);
    }));
}
