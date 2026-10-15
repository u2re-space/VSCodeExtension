import { agentHtml } from './html.mjs';

const nonce32 = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
};

export class AgentViewProvider {
    static viewType = 'vext.agentView';

    constructor(extensionUri, session) {
        this._extensionUri = extensionUri;
        this._session = session;
    }

    resolveWebviewView(webviewView) {
        const webview = webviewView.webview;
        const vscode = this._session.vscode;
        webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        const nonce = nonce32();
        const cssHref = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'icons', 'webview.css')));
        const scriptHref = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'icons', 'agent.mjs')));
        webview.html = agentHtml({ cssHref, scriptHref, nonce, cspSource: webview.cspSource });
        this._session.attach(webview);
        const disposable = webview.onDidReceiveMessage((message) => {
            this._session.onWebview(message);
        });
        webviewView.onDidDispose(() => {
            disposable.dispose();
            this._session.detach(webview);
        });
    }
}
