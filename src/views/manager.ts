//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent } from "./webview.ts";

//
const MOD_DIR = "modules";
const inWatch = new Set<any>([]);

// Initialize vscode API asynchronously
let vscodeAPI: any = null;
let ctxMap = new WeakMap();

/**
 * `vscode.Uri.joinPath(base, segment)` treats each argument as a single path segment.
 * If we pass "foo/bar" as one segment, VS Code will encode the slash ("foo%2Fbar"),
 * which breaks paths (especially on Linux/SSH workspaces with nested modules).
 */
const normalizeModuleSegments = (modulePath: string): string[] => {
    if (!modulePath) { return []; }
    let m = String(modulePath).trim().replace(/\\/g, '/');
    if (m === '.' || m === './') { return []; }
    m = m.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!m) { return []; }
    return m.split('/').filter(Boolean);
};

const joinModuleUri = (vscodeAPI: any, wsdUri: vscode.Uri, modulePath: string): vscode.Uri => {
    const segs = normalizeModuleSegments(modulePath);
    return segs.length ? vscodeAPI.Uri.joinPath(wsdUri, ...segs) : wsdUri;
};

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
    // Prefer current editor URI if available; keep URI objects as-is.
    // In remote/SSH scenarios, URIs are typically `vscode-remote://...`.
    // If we can't resolve a specific folder, fall back to the first workspace folder.
    res = res || editor?.document?.uri || "";

    let folder: vscode.WorkspaceFolder | undefined;
    if (!workspace.workspaceFolders)
        {}
    else if (workspace.workspaceFolders.length === 1 || !res)
        {folder = workspace.workspaceFolders[0];}
    else
        {folder = workspace.getWorkspaceFolder(res) || workspace.workspaceFolders[0];}

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

// ...
// Вспомогательная функция для поиска директорий с .git или package.json
async function findProjectDirs(
    vscodeAPI: any,
    baseDir: vscode.Uri,
    relPath: string = ""
): Promise<string[]> {
    let result: string[] = [];
    try {
        const entries = await vscodeAPI.workspace.fs.readDirectory(baseDir);
        let hasRepo = false, hasPkg = false;
        for (const [name, type] of entries) {
            // repo markers (dirs)
            if (name === ".git" && type === vscodeAPI.FileType.Directory) { hasRepo = true; }
            if ((name === ".hg" || name === ".svn") && type === vscodeAPI.FileType.Directory) { hasRepo = true; }

            // package/project markers (files)
            if (type === vscodeAPI.FileType.File) {
                if (name === "package.json") { hasPkg = true; }
                if (name === "deno.json" || name === "deno.jsonc") { hasPkg = true; }
                if (name === "jsr.json") { hasPkg = true; }
                if (name === "pnpm-workspace.yaml" || name === "pnpm-lock.yaml") { hasPkg = true; }
                if (name === "yarn.lock") { hasPkg = true; }
                if (name === "Cargo.toml" || name === "go.mod") { hasPkg = true; }
                if (name === "pyproject.toml" || name === "requirements.txt") { hasPkg = true; }
                if (name === "composer.json") { hasPkg = true; }
            }
        }

        // Если есть .git или package.json, добавляем путь
        if (hasRepo || hasPkg) {
            result.push(relPath || "./");
        }

        // Рекурсивно обходим подпапки (кроме node_modules и скрытых)
        const subresults = [...entries]?.map?.(([name, type])=>{
            if (
                type === vscodeAPI.FileType.Directory &&
                name !== "node_modules" &&
                name !== "dist" &&
                name !== "out" &&
                name !== "build" &&
                name !== "coverage" &&
                name !== "target" &&
                !name.startsWith(".")
            ) {
                const subDir = vscodeAPI.Uri.joinPath(baseDir, name);
                const subRelPath = relPath ? `${relPath}/${name}` : name;
                return findProjectDirs(vscodeAPI, subDir, subRelPath);
            }
        })?.flat?.()?.filter?.((e: any)=>!!e) ?? [];

        //
        result.push(...((await Promise.all(subresults?.flat?.() ?? []))?.flat?.() ?? []) as string[]);
    } catch (e) {
        // ignore
    }

    //
    return result?.sort?.((a, b) => a?.localeCompare?.(b) ?? 0) ?? [];
}

// Новый getDirs
const getDirs = async (context) => {
    const vscodeAPI = await initVscodeAPI();
    const wsdUri: vscode.Uri | undefined = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!context || !wsdUri) { return ["./"]; }
    let modules: string[] = ctxMap.get(context) ?? [];
    ctxMap.set(context, modules);

    try {
        modules = await findProjectDirs(vscodeAPI, wsdUri, "");
    } catch (e) { /* ignore */ }

    modules = modules?.length ? modules : ["./"];
    // Always include ./ first
    return Array.from(new Set(["./", ...modules]));
};

//
const plNormalize = (m)=>{
    if (/^\/[a-zA-Z]:\//.test(m)) {
        return m.slice(1);
    }
    return m;
};

//
export class ManagerViewProvider {
    _extensionUri: any; static viewType = "vext.managerView";
    constructor(extensionUri) { this._extensionUri = extensionUri; }

    //
    async updateView(webviewView, context, modules?) {
        modules ??= (await getDirs(context)) || ["./"];
        // async update: avoid resetting html (loses focus) once webview is loaded
        webviewView?.webview?.postMessage?.({ type: 'modules', modules });
    }

    //
    async resolveWebviewView(webviewView, context, token) {
        const vscodeAPI = await initVscodeAPI();
        const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
        let modules = ctxMap.get(context) ?? ["./"];

        const refreshModules = async ()=>{
            try {
                const mods = await getDirs(context) || ["./"];
                await this.updateView(webviewView, context, mods);
            } catch (e) { console.warn(e); }
        };

        //
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri]  };
        try { webviewView.webview.html = await getWebviewContent(webviewView.webview, this._extensionUri); } catch(e) { console.warn(e); };
        // Always show something immediately, even on slow remote FS
        try { await this.updateView(webviewView, context, modules?.length ? modules : ["./"]); } catch(e) { console.warn(e); };
        // Refresh asynchronously (so SSH/remote doesn't appear "stuck")
        Promise.resolve().then(refreshModules);
        inWatch?.add?.(()=>refreshModules());

        //
        if (true) { try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                // Webview error telemetry (helps diagnose Remote-SSH issues)
                if (message?.type === 'webviewError') {
                    console.warn('[vext.managerView:webviewError]', message);
                    // Don't spam popups; show a single concise toast.
                    const msg = message?.message ? String(message.message) : 'Webview error';
                    vscodeAPI?.window?.showWarningMessage?.(`Manager View webview error: ${msg}`);
                    return;
                }

                // Handle initial handshake first (before touching wsdUri / joinPath)
                if (message?.command === 'ready') {
                    return refreshModules();
                }

                // For all other actions, we need a workspace folder
                if (!wsdUri) {
                    vscodeAPI?.window?.showWarningMessage?.('No workspace folder found. Open a folder/workspace first.');
                    return;
                }

                const moduleUri = joinModuleUri(vscodeAPI, wsdUri, message.module);
                modules = await getDirs(context) || ["./"];

                //
                switch (message.command) {
                    case 'bulk_push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message for all?', value: '', default: 'No Description' });
                        if (!commitMsg) { return; }
                        for (const m of modules) {
                            const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
                            runInTerminal([
                                'git rm -r --cached .',
                                'git add .', 'git add *',
                                `git commit -m "${commitMsg}"`,
                                'git pull --rebase --ff',
                                'git push --all'
                            ], plNormalize(mUri?.fsPath || mUri?.path));
                        }
                    }; break;
                    case 'bulk_install':
                        for (const m of modules) { const mUri = joinModuleUri(vscodeAPI, wsdUri, m); runInTerminal(['git pull --rebase --ff', 'npm install -D', 'npm audit fix'], plNormalize(mUri?.fsPath || mUri?.path)); } break;
                    case 'bulk_build': for (const m of modules) { const mUri = joinModuleUri(vscodeAPI, wsdUri, m); runInTerminal(['npm run build'], plNormalize(mUri?.fsPath || mUri?.path)); } break;
                    case 'open-dir': vscodeAPI?.commands?.executeCommand?.('vscode.openFolder', moduleUri); break;
                    case 'terminal': runInTerminal([''], plNormalize(moduleUri?.fsPath || moduleUri?.path), true); break;
                    case 'build': runInTerminal(['npm run build'], plNormalize(moduleUri?.fsPath || moduleUri?.path)); break;
                    case 'watch': runInTerminal(['npm run watch'], plNormalize(moduleUri?.fsPath || moduleUri?.path), true); break;
                    case 'dev' : runInTerminal(['npm run dev'] , plNormalize(moduleUri?.fsPath || moduleUri?.path), true); break;
                    case 'test' : runInTerminal(['npm run test'] , plNormalize(moduleUri?.fsPath || moduleUri?.path), true); break;
                    case 'diff': runInTerminal(['git diff'], plNormalize(moduleUri?.fsPath || moduleUri?.path), true); break;
                    case 'install': runInTerminal([
                        'git pull --rebase --ff',
                        'git submodule update --init --recursive --remote --merge',
                        'npm install -D',
                        'npm audit fix'
                    ], plNormalize(moduleUri?.fsPath || moduleUri?.path)); break;
                    case 'push': {
                        const commitMsg = await vscodeAPI?.window?.showInputBox?.({ prompt: 'Commit Message?', value: '', default: 'No Description' });
                        if (!commitMsg) { return; }
                        runInTerminal([
                            'git rm -r --cached .',
                            'git add .', 'git add *',
                            `git commit -m "${commitMsg}"`,
                            'git pull --rebase --ff',
                            'git push --all'
                        ], plNormalize(moduleUri?.fsPath || moduleUri?.path));
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
