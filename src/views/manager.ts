//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent } from "./webview.ts";

//
const MOD_DIR = "modules";
const inWatch = new Set<any>([]);

// Initialize vscode API asynchronously
let vscodeAPI: any = null;
let ctxMap = new WeakMap();

//
async function initVscodeAPI() {
    if (!vscodeAPI) {
        vscodeAPI = await vscodePromise;

        // Set up watchers and event listeners
        const watcher = vscodeAPI?.workspace?.createFileSystemWatcher?.('./**');
        watcher?.onDidCreate?.(() => inWatch.forEach((cb: any)=>cb?.()));
        watcher?.onDidDelete?.(() => inWatch.forEach((cb: any)=>cb?.()));
        watcher?.onDidChange?.(() => inWatch.forEach((cb: any)=>cb?.()));
        vscodeAPI?.workspace?.onDidChangeWorkspaceFolders?.(() => () => inWatch.forEach((cb: any)=>cb?.()));
        vscodeAPI?.window?.onDidChangeActiveTextEditor?.(() => () => inWatch.forEach((cb: any)=>cb?.()));
        vscodeAPI?.window?.onDidCloseTerminal?.((closedTerminal) => {
            for (const [cwd, obj] of terminalMap.entries())
                { if (obj.terminal === closedTerminal) { terminalMap.delete(cwd); break; } }
        });
    }
    return vscodeAPI;
}

//
const getWorkspaceFolder = async (workspace, res = "") => {
    const vscodeAPI = await initVscodeAPI();
    const editor = vscodeAPI?.window?.activeTextEditor;
    res = res || editor?.document?.uri || "";

    let folder: vscode.WorkspaceFolder | undefined;
    if (!workspace.workspaceFolders)
        {}
    else if (workspace.workspaceFolders.length === 1 || !res)
        {folder = workspace.workspaceFolders[0];}
    else
        {folder = workspace.getWorkspaceFolder(res);}

    return folder?.uri || undefined;
};

//
async function getBaseDir(dir: string = MOD_DIR): Promise<{ baseDir: vscode.Uri, isModules: boolean }> {
    const vscodeAPI = await initVscodeAPI();
    const wsdUri: vscode.Uri | undefined = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!wsdUri) {
        return { baseDir: vscodeAPI.Uri.file(''), isModules: false };
    }

    const modulesDirUri = vscodeAPI.Uri.joinPath(wsdUri, dir);
    let isModules = false;
    try {
        const stat = await vscodeAPI.workspace.fs.stat(modulesDirUri);
        isModules = stat.type === vscodeAPI.FileType.Directory;
    } catch (e) {
        // ignore
    }
    return { baseDir: isModules ? modulesDirUri : wsdUri, isModules };
}

//
const getDirs = async (context, dir = MOD_DIR) => {
    const { baseDir, isModules } = await getBaseDir(dir);
    if (!context || !isModules) { return ["./"]; }
    let modules: string[] = ctxMap.get(context) ?? [];
    ctxMap.set(context, modules);

    try {
        const entries = await vscodeAPI?.workspace?.fs?.readDirectory?.(baseDir);
        modules = entries
            .filter(([name, type]) => type === vscodeAPI?.FileType?.Directory)
            .map(([name]) => (isModules ? `${dir}/${name}` : name));
    } catch (e) { /* ignore */ }

    if (modules?.length < 1) { modules?.push?.("./"); }
    return modules;
};

//
export class ManagerViewProvider {
    _extensionUri: any; static viewType = "vext.managerView";
    constructor(extensionUri) { this._extensionUri = extensionUri; }

    //
    async updateView(webviewView, context, modules?) {
        modules ??= (await getDirs(context)) || ["./"];
        webviewView.webview.html = await getWebviewContent(webviewView.webview, this._extensionUri, modules);
    }

    //
    async resolveWebviewView(webviewView, context, token) {
        const vscodeAPI = await initVscodeAPI();
        const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace); // vscode.Uri
        let modules = await getDirs(context) || ["./"];
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri]  };
        try { await this.updateView(webviewView, context, modules); } catch(e) { console.warn(e); };
        inWatch?.add?.(()=>this.updateView(webviewView, context));

        if (modules = await getDirs(context) || ["./"]) { try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                // Получаем Uri для модуля
                const moduleUri = vscodeAPI.Uri.joinPath(wsdUri, message.module);
                const modules = await getDirs(context) || ["./"];
                switch (message.command) {
                    case 'bulk_push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message for all?', value: '' }) || 'Bulk Update';
                        for (const m of modules) {
                            const mUri = vscodeAPI.Uri.joinPath(wsdUri, m);
                            runInTerminal([
                                'git add .', 'git add *',
                                `git commit -m "${commitMsg}"`,
                                'git push --all'
                            ], mUri.fsPath);
                        }
                    }; break;
                    case 'bulk_build':
                        for (const m of modules) {
                            const mUri = vscodeAPI.Uri.joinPath(wsdUri, m);
                            runInTerminal(['npm run build'], mUri.fsPath);
                        }
                        break;
                    case 'terminal': runInTerminal([''], moduleUri.fsPath); break;
                    case 'build': runInTerminal(['npm run build'], moduleUri.fsPath); break;
                    case 'watch': runInTerminal(['npm run watch'], moduleUri.fsPath, true); break;
                    case 'test' : runInTerminal(['npm run test'] , moduleUri.fsPath, true); break;
                    case 'diff': runInTerminal(['git diff'], moduleUri.fsPath, true); break;
                    case 'push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message?', value: '' }) || 'Regular Update';
                        runInTerminal([
                            'git add .', 'git add *',
                            `git commit -m "${commitMsg}"`,
                            'git push --all'
                        ], moduleUri.fsPath);
                    }; break;
                }
            });
        } catch(e) { console.warn(e); }}
    }
}

//
export async function manager(context: vscode.ExtensionContext) {
    const vscodeAPI = await initVscodeAPI();
    const provider = new ManagerViewProvider(context?.extensionUri);
    const prov = vscodeAPI?.window?.registerWebviewViewProvider?.(ManagerViewProvider.viewType, provider);
    if (prov) { context?.subscriptions?.push?.(prov); }
}

//
type TerminalStatus = 'free' | 'busy';
const terminalMap = new Map<string, { terminal: vscode.Terminal, status: TerminalStatus }>();
async function runInTerminal(cmds: string[], cwd: string, longRunning = false) {
    const vscodeAPI = await initVscodeAPI();
    // longRunning = true для watch/dev/test, false для diff/build/push
    let entry = !longRunning ? Array.from(terminalMap.entries()).find(([dir, obj]) => (dir === cwd && obj.status === 'free')) : null, termObj = entry?.[1];

    if (!termObj) {
        const terminal = vscodeAPI?.window.createTerminal({ cwd }); // @ts-ignore
        termObj = { terminal, status: longRunning ? 'busy' : 'free' }; if (!longRunning) { terminalMap.set(cwd, termObj); }
    } else if (longRunning) {
        termObj.status = 'busy';
    }

    termObj?.terminal?.show();
    cmds.forEach(cmd => termObj?.terminal?.sendText?.(cmd));
}

//
// Initialize terminal event listener
initVscodeAPI().then(vscodeAPI => {
    vscodeAPI?.window?.onDidCloseTerminal?.((closedTerminal) => {
        for (const [cwd, obj] of terminalMap.entries())
            { if (obj.terminal === closedTerminal) { terminalMap.delete(cwd); break; } }
    });
});
