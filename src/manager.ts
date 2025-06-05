import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

//
const editor = vscode?.window?.activeTextEditor;
const ctxMap = new WeakMap();
const watcher = vscode.workspace.createFileSystemWatcher('**');

//
const getWorkspaceFolder = (workspace, res = editor?.document?.uri||"")=>{
    let path: string = "";
    if (!workspace.workspaceFolders) {
        path = workspace.rootPath;
    } else {
        let root = null;
        if (workspace.workspaceFolders.length === 1 || !res) {
            root = workspace.workspaceFolders[0];
        } else {
            root = workspace.getWorkspaceFolder(res);
        }
        // @ts-ignore
        path = root?.uri?.fsPath || "";
    }
    return path || "";
};

//
function getBaseDir(): { baseDir: string, isModules: boolean } {
    const workspaceFolder = getWorkspaceFolder(vscode.workspace);
    if (!workspaceFolder) {return { baseDir: "", isModules: false };}

    const wsd = workspaceFolder;
    const modulesDir = path.join(wsd, "modules");
    let isModules = false;
    try {
        isModules = fs.statSync(modulesDir).isDirectory();
    } catch (e) { /* ignore */ }
    return { baseDir: isModules ? modulesDir : wsd, isModules };
}

//
const getDirs = (context)=>{
    const { baseDir, isModules } = getBaseDir();
    let modules: string[] = ctxMap.get(context) ?? [];
    ctxMap.set(context, modules);
    try {
        modules = fs.readdirSync(baseDir)
            .filter(f => fs.statSync(path.join(baseDir, f)).isDirectory())
            .map(f => (isModules ? `modules/${f}` : f));
    } catch (e) { /* ignore */ }
    if (modules?.length < 1) { modules?.push?.("./"); }
    return modules;
};

//
export class ManagerViewProvider {
    _extensionUri: any; static viewType = "vext.managerView";
    constructor(extensionUri) { this._extensionUri = extensionUri; }

    //
    updateView(webviewView, context) {
        webviewView.webview.html = getWebviewContent(getDirs(context)||["./"]);
    }

    //
    resolveWebviewView(webviewView, context, token) {
        const wsd = getWorkspaceFolder(vscode.workspace)||"", modules = getDirs(context);
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri]  };
        webviewView.webview.html    = getWebviewContent(modules||["./"]);

        //
        context.subscriptions.push(watcher.onDidCreate(() => this.updateView(webviewView, context)));
        context.subscriptions.push(watcher.onDidDelete(() => this.updateView(webviewView, context)));
        context.subscriptions.push(watcher.onDidChange(() => this.updateView(webviewView, context)));

        //
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateView(webviewView, context)));
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateView(webviewView, context)));

        //
        if (modules) { try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                const modulePath = path.join(wsd, message.module);
                switch (message.command) {
                    case 'terminal': runInTerminal('', modulePath); break;
                    case 'build': runInTerminal('npm run build', modulePath); break;
                    case 'watch': runInTerminal('npm run watch', modulePath); break;
                    case 'test' : runInTerminal('npm run test' , modulePath); break;
                    case 'push':
                        const commitMsg = await vscode.window.showInputBox({ prompt: 'Почему?', value: '' }) || 'update';
                        runInTerminal(`git add * && git add . && git commit -m "${commitMsg}" && git push --all`, modulePath);
                        break;
                }
            });
        } catch(e) { console.warn(e); }}
    }
}



//
export function manager(context: vscode.ExtensionContext) {
    const provider = new ManagerViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ManagerViewProvider.viewType, provider));
}

//
function runInTerminal(cmd: string, cwd: string) {
    const term = vscode.window.createTerminal({ cwd });
    if (cmd) {term.sendText(cmd);} term.show();
}

//
const defaultCSS = `
:root {
    /* VS Code dark theme colors */
    --background: #1e1e1e;
    --foreground: #d4d4d4;
    --border: #333;
    --button-bg: #2d2d2d;
    --button-hover: #3c3c3c;
    --button-active: #007acc;
    --button-fg: #d4d4d4;
    --button-shadow: 0 2px 8px rgba(0,0,0,0.2);
    --row-hover: #232323;
}

body {
    background: var(--background);
    color: var(--foreground);
    font-family: "Segoe UI", "Fira Code", "Consolas", monospace;
    margin: 0;
    padding: 0.5em 1em;
}

table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0.5em;
}

tr {
    border-bottom: 1px solid var(--border);
    transition: background 0.2s;
}

tr:hover {
    background: var(--row-hover);
}

td {
    padding: 0.5em 0.5em;
    vertical-align: middle;
}

button {
    background: var(--button-bg);
    color: var(--button-fg);
    border: none;
    border-radius: 6px;
    margin: 0 0.15em;
    padding: 0.35em 0.7em;
    font-size: 1em;
    font-family: inherit;
    cursor: pointer;
    box-shadow: var(--button-shadow);
    transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    outline: none;
    position: relative;
}

button:hover {
    background: var(--button-hover);
    color: #fff;
}

button:active {
    background: var(--button-active);
    color: #fff;
}

button:focus {
    box-shadow: 0 0 0 2px #007acc55;
}

@media (prefers-color-scheme: light) {
    :root {
        --background: #f3f3f3;
        --foreground: #222;
        --border: #e1e1e1;
        --button-bg: #e7e7e7;
        --button-hover: #d0d0d0;
        --button-active: #007acc;
        --button-fg: #222;
        --button-shadow: 0 2px 8px rgba(0,0,0,0.07);
        --row-hover: #eaeaea;
    }
}
`;

//
function getWebviewContent(modules: string[]): string {
    return `<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css"></head><body style="padding: 0px; margin: 0px; border: none 0px transparent;">
    <style>${defaultCSS}</style>
    <table>
        ${modules?.map?.(m => `<tr>
                <td style="inline-size: stretch; inline-size: -webkit-fill-available;">${m}</td>
                <td style="inline-size: max-content; text-align: end;">
                    <button onclick="send('watch', '${m}')"><i class="codicon codicon-eye"></i></button>
                    <button onclick="send('debug', '${m}')"><i class="codicon codicon-debug"></i></button>
                    <button onclick="send('build', '${m}')"><i class="codicon codicon-package"></i></button>
                    <button onclick="send('test', '${m}')"><i class="codicon codicon-beaker"></i></button>
                    <button onclick="send('terminal', '${m}')"><i class="codicon codicon-terminal"></i></button>
                    <button onclick="send('push', '${m}')"><i class="codicon codicon-cloud-upload"></i></button>
                </td>
            </tr>`)?.join?.('')}
    </table>
    <script>
        const vscode = acquireVsCodeApi();
        function send(command, module) {
            vscode.postMessage({ command, module });
        }
    </script>
</body>
</html>`;
}
