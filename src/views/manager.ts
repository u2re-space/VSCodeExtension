//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent } from "./webview.ts";

//
const inWatch = new Set<any>([]);

// Initialize vscode API asynchronously
let vscodeAPI: any = null;

type ModulesCache = {
    modules: string[];
    lastScanMs: number;
    inflight?: Promise<string[]>;
};
const ctxMap = new WeakMap<vscode.ExtensionContext, ModulesCache>();

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

/** Normalize path: fix Windows drive prefix and convert backslashes to forward slashes */
const normalizePath = (vscode: any, uri: vscode.Uri): string => {
    let p = uri?.fsPath || uri?.path || '';
    // Fix Windows drive prefix (/C:/ -> C:/)
    if (/^\/[a-zA-Z]:\//.test(p)) { p = p.slice(1); }
    // Always normalize to forward slashes for consistency
    return p.replace(/\\/g, '/');
};

//
async function initVscodeAPI() {
    if (!vscodeAPI) {
        vscodeAPI = await vscodePromise;

        // Set up watchers and event listeners
        const watcher = vscodeAPI?.workspace?.createFileSystemWatcher?.('./**');
        watcher?.onDidCreate?.(() => inWatch.forEach((cb: any) => cb?.()));
        watcher?.onDidDelete?.(() => inWatch.forEach((cb: any) => cb?.()));
        watcher?.onDidChange?.(() => inWatch.forEach((cb: any) => cb?.()));
        vscodeAPI?.workspace?.onDidChangeWorkspaceFolders?.(() => inWatch.forEach((cb: any) => cb?.()));
        vscodeAPI?.window?.onDidChangeActiveTextEditor?.(() => inWatch.forEach((cb: any) => cb?.()));
        vscodeAPI?.window?.onDidCloseTerminal?.((closedTerminal) => {
            for (const [cwd, obj] of terminalMap.entries()) {
                if (obj.terminal === closedTerminal) { terminalMap.delete(cwd); break; }
            }
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
    if (!workspace.workspaceFolders) {}
    else if (workspace.workspaceFolders.length === 1 || !res) { folder = workspace.workspaceFolders[0]; }
    else { folder = workspace.getWorkspaceFolder(res) || workspace.workspaceFolders[0]; }

    return folder?.uri || undefined;
};


// Helper to find directories with .git or package.json
async function findProjectDirs(
    vscodeAPI: any,
    baseDir: vscode.Uri,
    relPath: string = ""
): Promise<string[]> {
    const result: string[] = [];
    try {
        const entries = await vscodeAPI.workspace.fs.readDirectory(baseDir);
        let hasRepo = false, hasPkg = false;

        for (const [name, type] of entries) {
            // repo markers (dirs)
            if (type === vscodeAPI.FileType.Directory) {
                if (name === ".git" || name === ".hg" || name === ".svn") { hasRepo = true; }
            }
            // package/project markers (files)
            if (type === vscodeAPI.FileType.File) {
                const pkgMarkers = [
                    "package.json", "deno.json", "deno.jsonc", "jsr.json",
                    "pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock",
                    "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "composer.json"
                ];
                if (pkgMarkers.includes(name)) { hasPkg = true; }
            }
        }

        if (hasRepo || hasPkg) { result.push(relPath || "./"); }

        // Recursively traverse subdirectories (exclude node_modules and hidden dirs)
        const excludeDirs = ["node_modules", "dist", "out", "build", "coverage", "target"];
        const subPromises = entries
            .filter(([name, type]) => type === vscodeAPI.FileType.Directory && !excludeDirs.includes(name) && !name.startsWith("."))
            .map(([name]) => findProjectDirs(vscodeAPI, vscodeAPI.Uri.joinPath(baseDir, name), relPath ? `${relPath}/${name}` : name));

        const subResults = await Promise.all(subPromises);
        result.push(...subResults.flat());
    } catch { /* ignore */ }

    return result.sort((a, b) => a.localeCompare(b));
}

// getDirs (cached per ExtensionContext)
const getDirs = async (extContext: vscode.ExtensionContext, force = false) => {
    const vscodeAPI = await initVscodeAPI();
    const wsdUri: vscode.Uri | undefined = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!extContext || !wsdUri) { return ["./"]; }

    const now = Date.now();
    let cache = ctxMap.get(extContext);
    if (!cache) {
        cache = { modules: ["./"], lastScanMs: 0 };
        ctxMap.set(extContext, cache);
    }

    const TTL_MS = 5000;
    if (!force && cache.modules?.length && (now - cache.lastScanMs) < TTL_MS) {
        return Array.from(new Set(["./", ...cache.modules]));
    }

    if (!force && cache.inflight) {
        const mods = await cache.inflight.catch(() => cache?.modules || ["./"]);
        return Array.from(new Set(["./", ...mods]));
    }

    try {
        cache.inflight = findProjectDirs(vscodeAPI, wsdUri, "");
        const modules = await cache.inflight;
        cache.modules = modules?.length ? modules : ["./"];
        cache.lastScanMs = Date.now();
    } catch { /* ignore */ }
    cache.inflight = undefined;

    return Array.from(new Set(["./", ...cache.modules]));
};

// Git commands for push operations
const getGitPushCommands = (commitMsg: string) => [
    'git rm -r --cached .',
    'git add .', 'git add *',
    `git commit -m "${commitMsg}"`,
    'git pull --rebase --ff',
    'git push --all'
];

// Install commands
const getInstallCommands = () => [
    'git pull --rebase --ff',
    'git submodule update --init --recursive --remote --merge',
    'npm install -D',
    'npm audit fix'
];

/** Unified message handler for webview messages */
async function handleWebviewMessage(
    message: any,
    extContext: vscode.ExtensionContext,
    refreshModules: (force?: boolean) => Promise<void>
) {
    const vscodeAPI = await initVscodeAPI();

    // Handle webview errors
    if (message?.type === 'webviewError') {
        console.warn('[vext:webviewError]', message);
        const msg = message?.message ? String(message.message) : 'Webview error';
        vscodeAPI?.window?.showWarningMessage?.(`Manager webview error: ${msg}`);
        return;
    }

    // Handle ready handshake
    if (message?.command === 'ready') {
        return refreshModules(false);
    }

    // Get workspace folder
    const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!wsdUri) {
        vscodeAPI?.window?.showWarningMessage?.('No workspace folder found. Open a folder/workspace first.');
        return;
    }

    const moduleUri = joinModuleUri(vscodeAPI, wsdUri, message.module);
    const modules = await getDirs(extContext, false);
    const path = normalizePath(vscodeAPI, moduleUri);

    // Handle bulk operations
    if (message.command?.startsWith('bulk_')) {
        for (const m of modules) {
            const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
            const mPath = normalizePath(vscodeAPI, mUri);

            switch (message.command) {
                case 'bulk_push': {
                    const commitMsg = await vscodeAPI?.window?.showInputBox?.({
                        prompt: 'Commit Message for all?',
                        value: '',
                        default: 'No Description'
                    });
                    if (!commitMsg) { return; }
                    runInTerminal(getGitPushCommands(commitMsg), mPath);
                } break;
                case 'bulk_install':
                    runInTerminal(['git pull --rebase --ff', 'npm install -D', 'npm audit fix'], mPath);
                    break;
                case 'bulk_build':
                    runInTerminal(['npm run build'], mPath);
                    break;
            }
        }
        return;
    }

    // Handle single module operations
    switch (message.command) {
        case 'open-dir':
            vscodeAPI?.commands?.executeCommand?.('vscode.openFolder', moduleUri);
            break;
        case 'terminal':
            runInTerminal([''], path, true);
            break;
        case 'build':
            runInTerminal(['npm run build'], path);
            break;
        case 'watch':
            runInTerminal(['npm run watch'], path, true);
            break;
        case 'dev':
            runInTerminal(['npm run dev'], path, true);
            break;
        case 'test':
            runInTerminal(['npm run test'], path, true);
            break;
        case 'diff':
            runInTerminal(['git diff'], path, true);
            break;
        case 'install':
            runInTerminal(getInstallCommands(), path);
            break;
        case 'push': {
            const commitMsg = await vscodeAPI?.window?.showInputBox?.({
                prompt: 'Commit Message?',
                value: '',
                default: 'No Description'
            });
            if (!commitMsg) { return; }
            runInTerminal(getGitPushCommands(commitMsg), path);
        } break;
    }
}

//
export class ManagerViewProvider {
    _extensionUri: any;
    _viewType: string;
    _extContext: vscode.ExtensionContext;

    static viewType = "vext.managerView";
    static panelViewType = "vext.managerPanelView";

    constructor(extContext: vscode.ExtensionContext, extensionUri, viewType: string) {
        this._extContext = extContext;
        this._extensionUri = extensionUri;
        this._viewType = viewType;
    }

    async updateView(webviewView, context, modules?) {
        modules ??= (await getDirs(this._extContext)) || ["./"];
        webviewView?.webview?.postMessage?.({ type: 'modules', modules });
    }

    async resolveWebviewView(webviewView, _resolveContext) {
        await initVscodeAPI();
        const extVersion = String(this._extContext?.extension?.packageJSON?.version ?? "0.0.0");
        const instanceId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();

        const refreshModules = async (force = false) => {
            try {
                const mods = await getDirs(this._extContext, force) || ["./"];
                await this.updateView(webviewView, _resolveContext, mods);
            } catch (e) { console.warn(e); }
        };

        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        const html = await getWebviewContent(webviewView.webview, this._extensionUri, {
            instanceId,
            viewType: this._viewType,
            version: extVersion
        }).catch((e) => { console.warn(e); return ""; });
        if (html) { webviewView.webview.html = html; }

        const watchCb = () => refreshModules(true);
        inWatch?.add?.(watchCb);
        webviewView?.onDidDispose?.(() => inWatch?.delete?.(watchCb));
        webviewView?.onDidChangeVisibility?.(() => { if (webviewView?.visible) { refreshModules(false); } });

        try {
            webviewView?.webview?.onDidReceiveMessage?.(async message => {
                await handleWebviewMessage(message, this._extContext, refreshModules);
            });
        } catch (e) { console.warn(e); }
    }
}

//
export async function manager(context: vscode.ExtensionContext) {
    const vscodeAPI = await initVscodeAPI();
    const providerSidebar = new ManagerViewProvider(context, context?.extensionUri, ManagerViewProvider.viewType);
    const providerPanel = new ManagerViewProvider(context, context?.extensionUri, ManagerViewProvider.panelViewType);

    const prov1 = vscodeAPI?.window?.registerWebviewViewProvider?.(ManagerViewProvider.viewType, providerSidebar);
    const prov2 = vscodeAPI?.window?.registerWebviewViewProvider?.(ManagerViewProvider.panelViewType, providerPanel);
    if (prov1) { context?.subscriptions?.push?.(prov1); }
    if (prov2) { context?.subscriptions?.push?.(prov2); }

    // Multi-instance support: open Manager as a standalone WebviewPanel
    const openPanelCmd = vscodeAPI?.commands?.registerCommand?.("vext.openManagerPanel", async () => {
        const extVersion = String(context?.extension?.packageJSON?.version ?? "0.0.0");
        const instanceId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
        const panel = vscodeAPI.window.createWebviewPanel(
            "vext.managerPanel",
            `Manager (${extVersion})`,
            vscodeAPI.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [context.extensionUri] }
        );

        panel.webview.html = await getWebviewContent(panel.webview, context.extensionUri, {
            instanceId,
            viewType: "vext.managerPanel",
            version: extVersion
        });

        const refreshModules = async (force = false) => {
            try {
                const mods = await getDirs(context, force);
                panel?.webview?.postMessage?.({ type: "modules", modules: mods });
            } catch (e) { console.warn(e); }
        };

        const watchCb = () => refreshModules(true);
        inWatch.add(watchCb);
        panel.onDidDispose(() => inWatch.delete(watchCb));
        refreshModules(false);

        panel.webview.onDidReceiveMessage(async (message) => {
            await handleWebviewMessage(message, context, refreshModules);
        });
    });
    if (openPanelCmd) { context?.subscriptions?.push?.(openPanelCmd); }
}

//
type TerminalStatus = 'free' | 'busy';
const terminalMap = new Map<string, { terminal: vscode.Terminal, status: TerminalStatus }>();

async function runInTerminal(cmds: string[], cwd: string, longRunning = false) {
    const vscodeAPI = await initVscodeAPI();
    let entry = !longRunning ? Array.from(terminalMap.entries()).find(([dir, obj]) => dir === cwd && obj.status === 'free') : null;
    let termObj = entry?.[1];

    if (!termObj) {
        const terminal = vscodeAPI?.window.createTerminal({ cwd });
        termObj = { terminal, status: longRunning ? 'busy' : 'free' };
        if (!longRunning) { terminalMap.set(cwd, termObj); }
    } else if (longRunning) {
        termObj.status = 'busy';
    }

    termObj?.terminal?.show();
    cmds.forEach(cmd => termObj?.terminal?.sendText?.(cmd));
}
