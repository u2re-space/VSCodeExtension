import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

//
const editor  = vscode?.window?.activeTextEditor, ctxMap = new WeakMap();
const watcher = vscode?.workspace?.createFileSystemWatcher?.('./**');
const MOD_DIR = "modules";

//
const getWorkspaceFolder = (workspace, res = editor?.document?.uri||"")=>{
    let path: string = "";
    if (!workspace.workspaceFolders)
        { path = workspace.rootPath; } else {
        let root = null;
        if (workspace.workspaceFolders.length === 1 || !res)
            { root = workspace.workspaceFolders[0]; } else
            { root = workspace.getWorkspaceFolder(res); }
        // @ts-ignore
        path = root?.uri?.fsPath || "";
    }
    return path || "";
};

//
function getBaseDir(dir: string = MOD_DIR): { baseDir: string, isModules: boolean } {
    const wsd = getWorkspaceFolder(vscode.workspace)||"";
    if (!wsd) {return { baseDir: "", isModules: false };}
    const modulesDir = path.join(wsd, dir);
    let isModules = false;
    try { isModules = fs.statSync(modulesDir).isDirectory(); }
    catch (e) { /* ignore */ }
    return { baseDir: isModules ? modulesDir : wsd, isModules };
}

//
const getDirs = (context, dir = MOD_DIR)=>{
    const { baseDir, isModules } = getBaseDir(dir);
    if (!context || !isModules) { return ["./"]; }
    let modules: string[] = ctxMap.get(context) ?? []; ctxMap.set(context, modules);
    try { modules = fs.readdirSync(baseDir)?.filter?.(f => fs.statSync(path.join(baseDir, f)).isDirectory())?.map?.(f => (isModules ? `${dir}/${f}` : f)); }
    catch (e) { /* ignore */ }; if (modules?.length < 1) { modules?.push?.("./"); }; return modules;
};

//
export class ManagerViewProvider {
    _extensionUri: any; static viewType = "vext.managerView";
    constructor(extensionUri) { this._extensionUri = extensionUri; }

    //
    updateView(webviewView, context) { webviewView.webview.html = getWebviewContent(getDirs(context)||["./"]); }
    resolveWebviewView(webviewView, context, token) {
        const wsd = getWorkspaceFolder(vscode.workspace)||"", modules = getDirs(context)||["./"];
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri]  };

        //
        {
            try { this.updateView(webviewView, context); } catch(e) { console.warn(e); };
            try { context.subscriptions.push(watcher?.onDidCreate?.(() => this.updateView(webviewView, context))); } catch(e) { console.warn(e); };
            try { context.subscriptions.push(watcher?.onDidDelete?.(() => this.updateView(webviewView, context))); } catch(e) { console.warn(e); };
            try { context.subscriptions.push(watcher?.onDidChange?.(() => this.updateView(webviewView, context))); } catch(e) { console.warn(e); };
            try { context.subscriptions.push(vscode.workspace?.onDidChangeWorkspaceFolders?.(() => this.updateView(webviewView, context))); } catch(e) { console.warn(e); };
            try { context.subscriptions.push(vscode.window?.onDidChangeActiveTextEditor?.(() => this.updateView(webviewView, context))); } catch(e) { console.warn(e); };
        }

        //
        if (modules) { try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                const modulePath = path.join(wsd, message.module);
                switch (message.command) {
                    case 'terminal': runInTerminal([''], modulePath); break;
                    case 'build': runInTerminal(['npm run build'], modulePath); break;
                    case 'watch': runInTerminal(['npm run watch'], modulePath); break;
                    case 'test' : runInTerminal(['npm run test'] , modulePath); break;
                    case 'push':
                        const commitMsg = await vscode.window.showInputBox({ prompt: 'Commit Message?', value: '' }) || 'Regular Update';
                        runInTerminal([
                            'git add .',
                            `git commit -m "${commitMsg}"`,
                            'git push --all'
                        ], modulePath);
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
function runInTerminal(cmds: string[], cwd: string) {
    const term = vscode.window.createTerminal({ cwd });
    term.show();
    cmds.forEach(cmd => term.sendText(cmd));
}

//
const defaultCSS = `
* {
    box-sizing: border-box;
}

:root {
    /* VS Code dark theme colors */
    --highlight: color(srgb 1 1 1 / 0.01);
    --background: #1e1e1e;
    --foreground: #d4d4d4;
    --border: #333;
    --button-bg: #2d2d2d;
    --button-hover: #3c3c3c;
    --button-active: #007acc;
    --button-fg: #d4d4d4;
    --button-shadow: 0 2px 8px rgba(0,0,0,0.2);
    --row-hover: color(srgb 1 1 1 / 0.02);
    --scrollbar-bg: #23272e;
    --scrollbar-thumb: color(srgb 1 1 1 / 0.5);
    --scrollbar-thumb-hover: color(srgb 1 1 1 / 0.6);
}

html {
    padding: 0px;
    margin: 0px;
}

body {
    background: var(--background);
    color: var(--foreground);
    font-family: "Segoe UI", "Fira Code", "Consolas", monospace;
    margin: 0;
    padding: 0.5em 1em;
    min-block-size: 100dvh;
    block-size: 100dvh;
    overflow: hidden;
    box-sizing: border-box;
    container-type: size;
    contain: strict;
}

table {
    inline-size: 100%;
    border-radius: 0.5rem;
    border-collapse: collapse;
    clip-path: inset(0 round 0.5rem);
    overflow-y: auto;
    overflow-x: hidden;

    background: var(--highlight);
    min-block-size: max(100%, 100cqh);
    block-size: max(100%, 100cqh);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;

    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;/*var(--scrollbar-bg)*/;
    scrollbar-gutter: auto;
}

tr {
    transition: background 0.2s;
    max-block-size: max-content;
    block-size: max-content;
    overflow: hidden;
    display: flex;
    flex-direction: row;
    flex-grow: 1;
    flex-shrink: 0;
    flex-basis: stretch;
    inline-size: 100%;
    place-content: center;
    place-items: center;
    padding-inline: 0.5rem;
    box-sizing: border-box;
}

tr:hover { background: var(--row-hover); }

td {
    padding: 0px;
    padding-block: 0.5rem;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    flex-direction: row;
    flex-shrink: 0;
    flex-grow: 1;
    flex-basis: stretch;
    text-align: start;
    max-block-size: max-content;
    block-size: max-content;
    box-sizing: border-box;
}

button {
    overflow: hidden;
    background: var(--button-bg);
    color: var(--button-fg);
    border: none;
    border-radius: 6px;
    margin: 0 0.15em;
    padding: 0.5rem;
    font-size: 1em;
    font-family: inherit;
    cursor: pointer;
    /*box-shadow: var(--button-shadow);*/
    transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    outline: none;
    position: relative;
    aspect-ratio: 1 / 1;
    inline-size: 2rem;
    block-size: 2rem;
    display: inline flex;
    place-content: center;
    place-items: center;
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
    /*box-shadow: 0 0 0 2px #007acc55;*/
}

@media (prefers-color-scheme: light) {
    :root {
        --highlight: color(srgb 0 0 0 / 0.01);
        --background: #f3f3f3;
        --foreground: #222;
        --border: #e1e1e1;
        --button-bg: #e7e7e7;
        --button-hover: #d0d0d0;
        --button-active: #007acc;
        --button-fg: #222;
        --button-shadow: 0 2px 8px rgba(0,0,0,0.07);
        --row-hover: color(srgb 0 0 0 / 0.02);
        --scrollbar-bg: #f0f0f0;
        --scrollbar-thumb: color(srgb 0 0 0 / 0.5);
        --scrollbar-thumb-hover: color(srgb 0 0 0 / 0.6);
    }
}
`;

//
function getWebviewContent(modules: string[]): string {
    return `<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons/dist/codicon.css"></head><body style="margin: 0px; border: none 0px transparent; min-block-size: 100dvh;">
    <style>${defaultCSS}</style>
    <table>
        ${modules?.map?.(m => `<tr>
                <td style="flex-basis: max-content; inline-size: -webkit-fill-available; padding-inline-start: 0.5rem; justify-content: start;">${m}</td>
                <td style="flex-basis: max-content; inline-size: max-content; flex-shrink: 0; flex-grow: 0; justify-content: end;">
                    <button onclick="send('watch', '${m}')"><i class="codicon codicon-eye"></i></button>
                    <button onclick="send('debug', '${m}')"><i class="codicon codicon-debug"></i></button>
                    <button onclick="send('build', '${m}')"><i class="codicon codicon-package"></i></button>
                    <button onclick="send('test' , '${m}')"><i class="codicon codicon-beaker"></i></button>
                    <button onclick="send('terminal', '${m}')"><i class="codicon codicon-terminal"></i></button>
                    <button onclick="send('push' , '${m}')"><i class="codicon codicon-cloud-upload"></i></button>
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
