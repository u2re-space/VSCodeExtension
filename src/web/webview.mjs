import vscodeAPI from '../imports/api.ts';

//
const view = `<iframe style="padding:0px;margin:0px;border:none 0px transparent;box-sizing:border-box;inline-size:100dvw;block-size:100dvh;" src="https://gptunnel.ru/model/gpt-4.1/"></iframe>`;
const html = `<html><body style="inline-size:100dvw;block-size:100dvh;overflow:hidden;padding:0px;margin:0px;border:none 0px transparent;">${view}</body></html>`;

//
export class CustomSidebarViewProvider {
    static viewType = "vext.gptView";
    constructor(extensionUri) {}

    //
    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    }

    //
    getHtmlContent(webview) {
        return html;
    }
}

//
export async function webview(context) {
    const vscode = await vscodeAPI;
    const provider = new CustomSidebarViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(CustomSidebarViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('vext.openWebview', function () {
        const panel = vscode.window.createWebviewPanel(
            'vext.gptView',
            'GPTUnnel Web View',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel.webview.html = html;
    }));
}
