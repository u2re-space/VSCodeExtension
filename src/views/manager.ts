//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent } from "./webview.ts";
import { getFilteredActions, getManagerUiConfig, resolveTheme } from "./managerActions.ts";

import * as fs from 'fs';
import * as path from 'path';

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
    wsdUri: vscode.Uri,
    currentDir: vscode.Uri,
    visitedPaths: Set<string> = new Set()
): Promise<string[]> {
    const result: string[] = [];
    try {
        let realPath = currentDir.fsPath;
        try {
            realPath = await fs.promises.realpath(currentDir.fsPath);
        } catch { /* ignore */ }

        // Deduplicate by absolute path
        const normRealPath = realPath.replace(/\\/g, '/');
        if (visitedPaths.has(normRealPath)) {
            return [];
        }
        visitedPaths.add(normRealPath);

        const entries = await vscodeAPI.workspace.fs.readDirectory(currentDir);
        let hasRepo = false, hasPkg = false;

        const subDirs: { name: string, uri: vscode.Uri }[] = [];

        for (const [name, type] of entries) {
            let isDir = type === vscodeAPI.FileType.Directory;
            let isFile = type === vscodeAPI.FileType.File;
            
            const entryUri = vscodeAPI.Uri.joinPath(currentDir, name);
            
            if (type === vscodeAPI.FileType.SymbolicLink || type === (vscodeAPI.FileType.Directory | vscodeAPI.FileType.SymbolicLink) || type === (vscodeAPI.FileType.File | vscodeAPI.FileType.SymbolicLink)) {
                try {
                    const stat = await fs.promises.stat(entryUri.fsPath);
                    isDir = stat.isDirectory();
                    isFile = stat.isFile();
                } catch {
                    try {
                        const vStat = await vscodeAPI.workspace.fs.stat(entryUri);
                        isDir = (vStat.type & vscodeAPI.FileType.Directory) !== 0;
                        isFile = (vStat.type & vscodeAPI.FileType.File) !== 0;
                    } catch { /* ignore */ }
                }
            }

            // repo markers (dirs)
            if (isDir) {
                if (name === ".git" || name === ".hg" || name === ".svn") { hasRepo = true; }
            }
            // package/project markers (files)
            if (isFile) {
                const pkgMarkers = [
                    "package.json", "deno.json", "deno.jsonc", "jsr.json",
                    "pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock",
                    "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "composer.json"
                ];
                if (pkgMarkers.includes(name)) { hasPkg = true; }
            }

            if (isDir) {
                subDirs.push({ name, uri: entryUri });
            }
        }

        if (hasRepo || hasPkg) {
            let rel = path.relative(wsdUri.fsPath, realPath).replace(/\\/g, '/');
            if (rel === '') { rel = './'; }
            else if (!rel.startsWith('.') && !rel.startsWith('/')) { rel = './' + rel; }
            result.push(rel);
        }

        // Recursively traverse subdirectories (exclude node_modules and hidden dirs)
        const excludeDirs = ["node_modules", "dist", "out", "build", "coverage", "target"];
        const subPromises = subDirs
            .filter(({ name }) => !excludeDirs.includes(name) && !name.startsWith("."))
            .map(({ uri }) => findProjectDirs(vscodeAPI, wsdUri, uri, visitedPaths));

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
        cache.inflight = findProjectDirs(vscodeAPI, wsdUri, wsdUri);
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

const escapeDoubleQuoted = (input: string): string => String(input || "").replace(/["`$\\]/g, "\\$&").replace(/\r?\n/g, " ");

const getActiveEditorPath = async (): Promise<string | undefined> => {
    const vscodeAPI = await initVscodeAPI();
    return vscodeAPI.window.activeTextEditor?.document?.uri?.fsPath;
};

const readActiveFileText = async (): Promise<string | undefined> => {
    const vscodeAPI = await initVscodeAPI();
    const editorUri = vscodeAPI.window.activeTextEditor?.document?.uri;
    if (!editorUri) { return undefined; }
    const bytes = await vscodeAPI.workspace.fs.readFile(editorUri);
    return Buffer.from(bytes).toString("utf8");
};

const readActiveFileBase64 = async (): Promise<string | undefined> => {
    const vscodeAPI = await initVscodeAPI();
    const editorUri = vscodeAPI.window.activeTextEditor?.document?.uri;
    if (!editorUri) { return undefined; }
    const bytes = await vscodeAPI.workspace.fs.readFile(editorUri);
    return Buffer.from(bytes).toString("base64");
};

const confirmDangerousAction = async (title: string): Promise<boolean> => {
    const vscodeAPI = await initVscodeAPI();
    const answer = await vscodeAPI.window.showWarningMessage(
        `${title}: this is a power-user operation and may be destructive.`,
        { modal: true },
        "Run"
    );
    return answer === "Run";
};

const resolvePlaceholders = (cmd: string, ctx: Record<string, string>): string => {
    let result = cmd;
    for (const [key, value] of Object.entries(ctx)) {
        // use regex to replace all occurrences
        result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }
    return result;
};

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

    const uiConfig = getManagerUiConfig(vscodeAPI);
    const actionCatalog = getFilteredActions(uiConfig);
    const actionIds = new Set(actionCatalog.map((a) => a.id));

    if (!actionIds.has(message?.command)) {
        return;
    }

    // Get workspace folder
    const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!wsdUri) {
        vscodeAPI?.window?.showWarningMessage?.('No workspace folder found. Open a folder/workspace first.');
        return;
    }

    //
    const moduleUri = joinModuleUri(vscodeAPI, wsdUri, message.module);
    const modules = await getDirs(extContext, false);
    const path = normalizePath(vscodeAPI, moduleUri);

    // Check for custom command overrides (extended branching)
    const customCommands = uiConfig.commands || {};
    let isOverridden = false;
    let overrideCmds: string[] = [];

    // Global override
    if (customCommands[message.command]) {
        isOverridden = true;
        const override = customCommands[message.command];
        overrideCmds = Array.isArray(override) ? override : [String(override)];
    }
    // Per-module override (higher priority)
    if (message.module && customCommands[message.module] && customCommands[message.module][message.command]) {
        isOverridden = true;
        const override = customCommands[message.module][message.command];
        overrideCmds = Array.isArray(override) ? override : [String(override)];
    }

    if (isOverridden) {
        const ctxVars = {
            module: String(message.module || ''),
            command: String(message.command || ''),
            workspaceFolder: normalizePath(vscodeAPI, wsdUri),
            modulePath: path
        };

        if (message.command?.startsWith?.('bulk_')) {
            for (const m of modules) {
                const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
                const mPath = normalizePath(vscodeAPI, mUri);
                const mCtx = { ...ctxVars, module: m, modulePath: mPath };
                const resolvedCmds = overrideCmds.map(c => resolvePlaceholders(c, mCtx));
                runInTerminal(resolvedCmds, mPath);
            }
        } else {
            const resolvedCmds = overrideCmds.map(c => resolvePlaceholders(c, ctxVars));
            const openInNew = ['terminal', 'watch', 'dev', 'test', 'restart', 'stop', 'diff'];
            runInTerminal(resolvedCmds, path, openInNew?.indexOf?.(message.command) >= 0);
        }
        return;
    }

    // Handle bulk operations - ask for input BEFORE the loop
    if (message.command?.startsWith?.('bulk_')) {
        let commitMsg: string | undefined;
        if (message.command === 'bulk_push') {
            commitMsg = await vscodeAPI?.window?.showInputBox?.({
                prompt: 'Commit Message for all?',
                value: '',
                default: 'No Description'
            });
            if (!commitMsg) { return; }
        }

        const commandMap = {
            'bulk_push': getGitPushCommands(escapeDoubleQuoted(commitMsg!)),
            'bulk_install': ['git pull --rebase --ff', 'npm install -D', 'npm audit fix'],
            'bulk_build': ['npm run build']
        };

        for (const m of modules) {
            const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
            const mPath = normalizePath(vscodeAPI, mUri);
            runInTerminal(commandMap?.[message.command] || [], mPath);
        }

        return;
    }

    //
    const commandMap = {
        'terminal': [''],
        'build': ['npm run build'],
        'watch': ['npm run watch'],
        'dev': ['npm run dev'],
        'test': ['npm run test'],
        'restart': ['npm run restart'],
        'stop': ['npm run stop'],
        'diff': ['git diff'],
        'install': getInstallCommands(),
        'audit-fix': ['npm audit fix'],
        'install-fix': ['npm install -D', 'npm audit fix']
    };

    //
    const openInNew = ['terminal', 'watch', 'dev', 'test', 'restart', 'stop', 'diff'];

    // Handle single module operations
    switch (message.command) {
        case 'open-dir':
            vscodeAPI?.commands?.executeCommand?.('vscode.openFolder', moduleUri);
            break;
        case 'push': {
            const commitMsg = await vscodeAPI?.window?.showInputBox?.({
                prompt: 'Commit Message?',
                value: '',
                default: 'No Description'
            });
            if (!commitMsg) { return; }
            runInTerminal(getGitPushCommands(escapeDoubleQuoted(commitMsg)), path);
        } break;
        case 'copy-file-content': {
            const text = await readActiveFileText();
            if (!text) { vscodeAPI.window.showWarningMessage("No active file content to copy."); return; }
            await vscodeAPI.env.clipboard.writeText(text);
            vscodeAPI.window.showInformationMessage("Active file content copied.");
        } break;
        case 'copy-file-base64': {
            const b64 = await readActiveFileBase64();
            if (!b64) { vscodeAPI.window.showWarningMessage("No active file content to encode."); return; }
            await vscodeAPI.env.clipboard.writeText(b64);
            vscodeAPI.window.showInformationMessage("Active file base64 copied.");
        } break;
        case 'git-revert-file': {
            const activePath = await getActiveEditorPath();
            if (!activePath) { vscodeAPI.window.showWarningMessage("No active file for git revert."); return; }
            if (!(await confirmDangerousAction("Git revert active file"))) { return; }
            const rel = normalizePath(vscodeAPI, vscodeAPI.Uri.file(activePath)).replace(normalizePath(vscodeAPI, wsdUri) + "/", "");
            runInTerminal([`git restore -- "${escapeDoubleQuoted(rel)}"`], normalizePath(vscodeAPI, wsdUri));
        } break;
        case 'git-reset-file': {
            const activePath = await getActiveEditorPath();
            if (!activePath) { vscodeAPI.window.showWarningMessage("No active file for git reset."); return; }
            if (!(await confirmDangerousAction("Git reset active file"))) { return; }
            const rel = normalizePath(vscodeAPI, vscodeAPI.Uri.file(activePath)).replace(normalizePath(vscodeAPI, wsdUri) + "/", "");
            runInTerminal([`git reset HEAD -- "${escapeDoubleQuoted(rel)}"`], normalizePath(vscodeAPI, wsdUri));
        } break;
        case 'git-revert-dir': {
            if (!(await confirmDangerousAction("Git revert directory"))) { return; }
            runInTerminal([`git restore --source=HEAD -- .`], path);
        } break;
        case 'git-reset-dir': {
            if (!(await confirmDangerousAction("Git reset directory"))) { return; }
            runInTerminal([`git reset --hard HEAD`], path);
        } break;
        default:
            runInTerminal(commandMap?.[message.command] || [], path, openInNew?.indexOf?.(message.command) >= 0);
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
        const vscodeAPI = await initVscodeAPI();
        const uiConfig = getManagerUiConfig(vscodeAPI);
        modules ??= (await getDirs(this._extContext)) || ["./"];
        webviewView?.webview?.postMessage?.({
            type: 'modules',
            modules,
            theme: resolveTheme(vscodeAPI, uiConfig.theme),
            actionCatalog: getFilteredActions(uiConfig),
            uiFlags: {
                layout: uiConfig.layout,
                primaryActions: uiConfig.primaryActions,
                secondaryActions: uiConfig.secondaryActions,
                bulkActions: uiConfig.bulkActions
            }
        });
    }

    async resolveWebviewView(webviewView, _resolveContext) {
        const vscodeAPI = await initVscodeAPI();
        const extVersion = String(this._extContext?.extension?.packageJSON?.version ?? "0.0.0");
        const instanceId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
        const uiConfig = getManagerUiConfig(vscodeAPI);
        const theme = resolveTheme(vscodeAPI, uiConfig.theme);
        const actionCatalog = getFilteredActions(uiConfig);

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
            version: extVersion,
            theme,
            actionCatalog,
            uiFlags: {
                layout: uiConfig.layout,
                primaryActions: uiConfig.primaryActions,
                secondaryActions: uiConfig.secondaryActions,
                bulkActions: uiConfig.bulkActions
            }
        }).catch((e) => { console.warn(e); return ""; });
        if (html) { webviewView.webview.html = html; }

        const watchCb = () => refreshModules(true);
        inWatch?.add?.(watchCb);
        webviewView?.onDidDispose?.(() => inWatch?.delete?.(watchCb));
        webviewView?.onDidChangeVisibility?.(() => { if (webviewView?.visible) { refreshModules(false); } });
        this._extContext.subscriptions.push(
            vscodeAPI.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration("vext.managerView")) {
                    this.updateView(webviewView, _resolveContext).catch(console.warn);
                }
            }),
            vscodeAPI.window.onDidChangeActiveColorTheme(() => {
                if (getManagerUiConfig(vscodeAPI).theme === "auto") {
                    this.updateView(webviewView, _resolveContext).catch(console.warn);
                }
            })
        );

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
        const uiConfig = getManagerUiConfig(vscodeAPI);
        const theme = resolveTheme(vscodeAPI, uiConfig.theme);
        const actionCatalog = getFilteredActions(uiConfig);
        const panel = vscodeAPI.window.createWebviewPanel(
            "vext.managerPanel",
            `Manager (${extVersion})`,
            vscodeAPI.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [context.extensionUri] }
        );

        panel.webview.html = await getWebviewContent(panel.webview, context.extensionUri, {
            instanceId,
            viewType: "vext.managerPanel",
            version: extVersion,
            theme,
            actionCatalog,
            uiFlags: {
                layout: uiConfig.layout,
                primaryActions: uiConfig.primaryActions,
                secondaryActions: uiConfig.secondaryActions,
                bulkActions: uiConfig.bulkActions
            }
        });

        const refreshModules = async (force = false) => {
            try {
                const mods = await getDirs(context, force);
                const liveConfig = getManagerUiConfig(vscodeAPI);
                panel?.webview?.postMessage?.({
                    type: "modules",
                    modules: mods,
                    theme: resolveTheme(vscodeAPI, liveConfig.theme),
                    actionCatalog: getFilteredActions(liveConfig),
                    uiFlags: {
                        layout: liveConfig.layout,
                        primaryActions: liveConfig.primaryActions
                    }
                });
            } catch (e) { console.warn(e); }
        };

        const watchCb = () => refreshModules(true);
        inWatch.add(watchCb);
        panel.onDidDispose(() => inWatch.delete(watchCb));
        refreshModules(false);
        context.subscriptions.push(
            vscodeAPI.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration("vext.managerView")) {
                    refreshModules(false).catch(console.warn);
                }
            }),
            vscodeAPI.window.onDidChangeActiveColorTheme(() => {
                if (getManagerUiConfig(vscodeAPI).theme === "auto") {
                    refreshModules(false).catch(console.warn);
                }
            })
        );

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
