//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

// @types/vscode
import * as path from 'path';
import * as fs from 'fs';
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
const getWorkspaceFolder = async (workspace, res = "")=>{
    const vscodeAPI = await initVscodeAPI();
    const editor = vscodeAPI?.window?.activeTextEditor;
    res = res || editor?.document?.uri || "";

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
async function getBaseDir(dir: string = MOD_DIR): Promise<{ baseDir: string, isModules: boolean }> {
    const vscodeAPI = await initVscodeAPI();
    const wsd = await getWorkspaceFolder(vscodeAPI?.workspace) || "";
    if (!wsd) {return { baseDir: "", isModules: false };}
    const modulesDir = path.join(wsd, dir);
    let isModules = false;
    try { isModules = fs.statSync(modulesDir).isDirectory(); }
    catch (e) { /* ignore */ }
    return { baseDir: isModules ? modulesDir : wsd, isModules };
}

//
const getDirs = async (context, dir = MOD_DIR)=>{
    const { baseDir, isModules } = await getBaseDir(dir);
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
    async updateView(webviewView, context) {
        const modules = await getDirs(context) || ["./"];
        webviewView.webview.html = await getWebviewContent(webviewView.webview, this._extensionUri, modules);
    }

    async resolveWebviewView(webviewView, context, token) {
        const weak = new WeakRef(this), view = new WeakRef(webviewView), ctx  = new WeakRef(context);
        const vscodeAPI = await initVscodeAPI();
        let wsd = await getWorkspaceFolder(vscodeAPI?.workspace) || "", modules = await getDirs(context) || ["./"];
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri]  };
        try { await this.updateView(webviewView, context); } catch(e) { console.warn(e); };
        inWatch?.add?.(()=>weak?.deref?.()?.updateView?.(view?.deref?.(), ctx?.deref?.()));

        //
        if (modules = await getDirs(context) || ["./"]) { try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                const modulePath = path.join(wsd, message.module);
                const modules = await getDirs(context) || ["./"];
                switch (message.command) {
                    case 'bulk_push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message for all?', value: '' }) || 'Bulk Update';
                        for (const m of modules) {
                            runInTerminal([
                                'git add .', 'git add *',
                                `git commit -m "${commitMsg}"`,
                                'git push --all'
                            ], path.join(wsd, m));
                        }
                    }; break;
                    case 'bulk_build': for (const m of modules) { runInTerminal(['npm run build'], path.join(wsd, m)); }; break;

                    //
                    case 'terminal': runInTerminal([''], modulePath); break;
                    case 'build': runInTerminal(['npm run build'], modulePath); break;
                    case 'watch': runInTerminal(['npm run watch'], modulePath, true); break;
                    case 'test' : runInTerminal(['npm run test'] , modulePath, true); break;
                    case 'diff': runInTerminal(['git diff'], modulePath, true); break;
                    case 'push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message?', value: '' }) || 'Regular Update';
                        runInTerminal([
                            'git add .', 'git add *',
                            `git commit -m "${commitMsg}"`,
                            'git push --all'
                        ], modulePath);
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

