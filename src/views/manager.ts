//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent, getMinimalManagerFallbackHtml } from "./webview.ts";
import { getFilteredActions, getManagerUiConfig, resolveTheme } from "./managerActions.ts";

//
const inWatch = new Set<(force?: boolean) => void>();
let managerWatcherRefs = 0;
let managerWatchers: { dispose(): void }[] = [];
let workspaceFolderListener: { dispose(): void } | undefined;

const WATCH_PATTERNS = [
    '**/package.json',
    '**/pnpm-workspace.yaml',
    '**/Cargo.toml',
    '**/go.mod',
    '**/pyproject.toml',
];

function notifyManagerWatchers(force = true) {
    inWatch.forEach((cb) => cb?.(force));
}

function isManagerFileWatchEnabled(vscodeAPI: any): boolean {
    return Boolean(vscodeAPI.workspace.getConfiguration('vext').get('managerView.fileWatch', false));
}

function acquireManagerFileWatch(vscodeAPI: any) {
    managerWatcherRefs++;
    if (!isManagerFileWatchEnabled(vscodeAPI) || managerWatchers.length > 0) {
        return;
    }
    for (const pattern of WATCH_PATTERNS) {
        const w = vscodeAPI.workspace.createFileSystemWatcher(pattern);
        w.onDidCreate(() => notifyManagerWatchers(true));
        w.onDidDelete(() => notifyManagerWatchers(true));
        managerWatchers.push(w);
    }
    workspaceFolderListener = vscodeAPI.workspace.onDidChangeWorkspaceFolders(() => notifyManagerWatchers(true));
}

function releaseManagerFileWatch() {
    managerWatcherRefs = Math.max(0, managerWatcherRefs - 1);
    if (managerWatcherRefs > 0) { return; }
    for (const w of managerWatchers) {
        try { w.dispose(); } catch { /* ignore */ }
    }
    managerWatchers = [];
    workspaceFolderListener?.dispose();
    workspaceFolderListener = undefined;
}

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


const SCAN_DEADLINE_MS = 3000;
const SCAN_DEADLINE_REMOTE_MS = 30000;
const SCAN_HARD_TIMEOUT_MS = 4500;
const SCAN_HARD_TIMEOUT_REMOTE_MS = 35000;
const SCAN_CACHE_TTL_MS = 15000;
const SCAN_CACHE_TTL_REMOTE_MS = 120000;
const REFRESH_DEBOUNCE_MS = 1500;
const PERSIST_KEY = 'vext.managerModulesCacheV2';

const FIND_EXCLUDE = '**/{node_modules,dist,out,build,coverage,target,.git,.turbo,.next,.nuxt,.cache,vendor,__pycache__,.pnpm-store,.vscode-test,.yarn}/**';

const FIND_PACKAGE_JSON = '**/package.json';

/** Shallow readDirectory probes — monorepo roots only */
const QUICK_PROBE_ROOTS = ['modules/projects', 'modules', 'apps', 'packages', 'externals'];

const MAX_MODULE_DEPTH = 7;
const MAX_FIND_RESULTS_REMOTE = 64;
const MAX_FIND_RESULTS_LOCAL = 128;

type PersistedModulesCache = Record<string, { modules: string[]; savedAt: number }>;

function scanTiming(vscodeAPI: any) {
    const remote = Boolean(vscodeAPI.env?.remoteName);
    return {
        remote,
        deadlineMs: Date.now() + (remote ? SCAN_DEADLINE_REMOTE_MS : SCAN_DEADLINE_MS),
        hardTimeoutMs: remote ? SCAN_HARD_TIMEOUT_REMOTE_MS : SCAN_HARD_TIMEOUT_MS,
        cacheTtlMs: remote ? SCAN_CACHE_TTL_REMOTE_MS : SCAN_CACHE_TTL_MS,
        findMaxResults: remote ? MAX_FIND_RESULTS_REMOTE : MAX_FIND_RESULTS_LOCAL,
    };
}

function workspaceCacheKey(wsdUri: vscode.Uri): string {
    return wsdUri.toString();
}

function getExtraModules(vscodeAPI: any): string[] {
    const raw = vscodeAPI.workspace.getConfiguration('vext').get('managerView.extraModules', []) as string[];
    return Array.isArray(raw) ? raw.map((m) => String(m || '').trim()).filter(Boolean) : [];
}

function normalizeUriPath(uri: vscode.Uri): string {
    let p = uri.path || '';
    if (p.endsWith('/') && p.length > 1) { p = p.slice(0, -1); }
    return p;
}

const EXCLUDE_DIRS = new Set([
    "node_modules", "dist", "out", "build", "coverage", "target",
    ".git", ".hg", ".svn", ".turbo", ".next", ".nuxt", ".cache",
    "vendor", "__pycache__", ".pnpm-store", ".vscode-test", ".yarn",
    ".pnpm", "bower_components",
]);

function relPathIsExcluded(rel: string): boolean {
    if (!rel || rel === './' || rel === '.') { return false; }
    const segs = normalizeModuleSegments(rel);
    for (const seg of segs) {
        if (EXCLUDE_DIRS.has(seg)) { return true; }
    }
    const lower = rel.replace(/\\/g, '/').toLowerCase();
    if (lower.includes('/node_modules/') || lower.startsWith('node_modules/')) { return true; }
    return segs.length > MAX_MODULE_DEPTH;
}

function uriPathIsExcluded(uri: vscode.Uri): boolean {
    const parts = normalizeUriPath(uri).split('/').filter(Boolean);
    for (const seg of parts) {
        if (EXCLUDE_DIRS.has(seg)) { return true; }
    }
    return false;
}

function isValidModulePath(modulePath: string): boolean {
    const s = String(modulePath || '').trim().replace(/\\/g, '/');
    if (s === './' || s === '.') { return true; }
    if (/^[a-zA-Z]:/.test(s)) { return false; }
    if (s.includes(':/')) { return false; }
    if (s.startsWith('/') && !s.startsWith('./')) { return false; }
    let ups = 0;
    for (const part of s.split('/')) {
        if (part === '..') { ups++; }
        else { break; }
    }
    if (ups > 2) { return false; }
    return true;
}

function moduleRelFromUri(vscodeAPI: any, wsdUri: vscode.Uri, dirUri: vscode.Uri): string | null {
    if (uriPathIsExcluded(dirUri)) { return null; }
    const folder = vscodeAPI.workspace.getWorkspaceFolder(dirUri);
    if (!folder) {
        if (uriPathKey(dirUri) === uriPathKey(wsdUri)) { return './'; }
        return null;
    }

    let rel = String(vscodeAPI.workspace.asRelativePath(dirUri, false) || '').replace(/\\/g, '/');
    if (!rel || rel === '.') { return './'; }

    if (/^[a-zA-Z]:/.test(rel) || (rel.startsWith('/') && !rel.startsWith('./'))) {
        return null;
    }

    if (!rel.startsWith('.') && !rel.startsWith('/')) { rel = './' + rel; }
    return isValidModulePath(rel) && !relPathIsExcluded(rel) ? rel : null;
}

class ModuleCollector {
    private display = new Map<string, string>();
    private identityMap = new Map<string, { rel: string; pathKey: string }>();
    private pathKeys = new Set<string>();
    private identityCache = new Map<string, string>();

    constructor(
        private vscodeAPI: any,
        private wsdUri: vscode.Uri
    ) {}

    private relKey(rel: string): string {
        return rel.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    addRoot(): void {
        this.display.set('./', './');
        this.pathKeys.add(uriPathKey(this.wsdUri));
    }

    async addRelative(rel: string): Promise<boolean> {
        if (rel === './' || rel === '.') {
            this.addRoot();
            return true;
        }
        if (relPathIsExcluded(rel) || !isValidModulePath(rel)) { return false; }
        return this.addDirUri(joinModuleUri(this.vscodeAPI, this.wsdUri, rel));
    }

    async addDirUri(dirUri: vscode.Uri): Promise<boolean> {
        if (uriPathIsExcluded(dirUri)) { return false; }

        const rel = moduleRelFromUri(this.vscodeAPI, this.wsdUri, dirUri);
        if (!rel) { return false; }

        const pathKey = uriPathKey(dirUri);
        if (this.pathKeys.has(pathKey)) { return false; }

        const identity = await this.dirIdentity(dirUri);
        const prev = this.identityMap.get(identity);
        if (prev) {
            if (rel.length >= prev.rel.length) { return false; }
            this.display.delete(this.relKey(prev.rel));
            this.pathKeys.delete(prev.pathKey);
        }

        this.pathKeys.add(pathKey);
        this.identityMap.set(identity, { rel, pathKey });
        this.display.set(this.relKey(rel), rel);
        return true;
    }

    private async dirIdentity(dirUri: vscode.Uri): Promise<string> {
        const key = uriPathKey(dirUri);
        const cached = this.identityCache.get(key);
        if (cached) { return cached; }

        let id = `path:${key}`;
        try {
            const bytes = await this.vscodeAPI.workspace.fs.readFile(
                this.vscodeAPI.Uri.joinPath(dirUri, 'package.json')
            );
            const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
            if (json?.name) { id = `npm:${String(json.name)}`; }
        } catch { /* not a package dir */ }

        this.identityCache.set(key, id);
        return id;
    }

    toList(): string[] {
        const items = Array.from(this.display.values());
        if (!items.some((m) => m === './')) { items.unshift('./'); }
        return items.sort((a, b) => a.localeCompare(b));
    }
}

function mergeModuleLists(...lists: (string[] | undefined)[]): string[] {
    const out = new Set<string>();
    for (const list of lists) {
        for (const item of list || []) {
            const m = String(item || '').trim();
            if (!m) { continue; }
            const normalized = m === '.' ? './' : m;
            if (isValidModulePath(normalized) && !relPathIsExcluded(normalized)) {
                out.add(normalized);
            }
        }
    }
    out.add('./');
    return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function uriPathKey(uri: vscode.Uri): string {
    return normalizeUriPath(uri).toLowerCase();
}

async function loadPersistedModules(extContext: vscode.ExtensionContext, wsdUri: vscode.Uri): Promise<string[] | undefined> {
    const store = extContext.globalState.get(PERSIST_KEY, {}) as PersistedModulesCache;
    const entry = store[workspaceCacheKey(wsdUri)];
    if (entry?.modules?.length) { return entry.modules; }
    return undefined;
}

async function savePersistedModules(extContext: vscode.ExtensionContext, wsdUri: vscode.Uri, modules: string[]) {
    const store = extContext.globalState.get(PERSIST_KEY, {}) as PersistedModulesCache;
    store[workspaceCacheKey(wsdUri)] = { modules, savedAt: Date.now() };
    await extContext.globalState.update(PERSIST_KEY, store);
}

async function ensureCacheHydrated(extContext: vscode.ExtensionContext, wsdUri: vscode.Uri): Promise<ModulesCache> {
    let cache = ctxMap.get(extContext);
    if (!cache) {
        cache = { modules: ['./'], lastScanMs: 0 };
        ctxMap.set(extContext, cache);
    }
    if (cache.lastScanMs === 0) {
        const persisted = await loadPersistedModules(extContext, wsdUri);
        if (persisted?.length) {
            cache.modules = mergeModuleLists(persisted);
            cache.lastScanMs = Date.now() - 1;
            savePersistedModules(extContext, wsdUri, cache.modules).catch(console.warn);
        }
    }
    return cache;
}

function peekModules(extContext: vscode.ExtensionContext, extra: string[] = []): string[] {
    const cache = ctxMap.get(extContext);
    return mergeModuleLists(cache?.modules, extra);
}

async function moduleHasGit(vscodeAPI: any, moduleUri: vscode.Uri): Promise<boolean> {
    try {
        const gitUri = vscodeAPI.Uri.joinPath(moduleUri, '.git');
        const stat = await vscodeAPI.workspace.fs.stat(gitUri);
        if (stat.type === vscodeAPI.FileType.Directory) {
            await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(gitUri, 'HEAD'));
            return true;
        }
        if (stat.type === vscodeAPI.FileType.File) {
            const bytes = await vscodeAPI.workspace.fs.readFile(gitUri);
            const text = Buffer.from(bytes).toString('utf8').trim();
            return text.startsWith('gitdir:');
        }
    } catch {
        /* no local .git at this module root */
    }
    return false;
}

async function filterModulesWithGit(vscodeAPI: any, wsdUri: vscode.Uri, modules: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const m of mergeModuleLists(modules)) {
        if (m === './' || m === '.') {
            if (await moduleHasGit(vscodeAPI, wsdUri)) {
                out.push('./');
            }
            continue;
        }
        if (await moduleHasGit(vscodeAPI, joinModuleUri(vscodeAPI, wsdUri, m))) {
            out.push(m);
        }
    }
    return out;
}

async function resolveBulkModules(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    command: string,
    modules: string[]
): Promise<string[] | null> {
    if (command !== 'bulk_push') {
        return mergeModuleLists(modules);
    }
    const withGit = await filterModulesWithGit(vscodeAPI, wsdUri, modules);
    if (!withGit.length) {
        vscodeAPI.window.showWarningMessage('Bulk push: no modules with .git found.');
        return null;
    }
    const skipped = mergeModuleLists(modules).filter((m) => !withGit.includes(m)).length;
    if (skipped > 0) {
        vscodeAPI.window.showInformationMessage(
            `Bulk push: ${withGit.length} repo(s), ${skipped} skipped (no local .git).`
        );
    }
    return withGit;
}

/** Shell family used for manager-launched git command lines. Mirrors gitPushGuardShellCmd's platform rule. */
function managerGitShellFamily(vscodeAPI: any): 'bash' | 'pwsh' {
    const remote = Boolean(vscodeAPI.env?.remoteName);
    const win = !remote && process.platform === 'win32';
    return win ? 'pwsh' : 'bash';
}

function gitPushGuardShellCmd(vscodeAPI: any): string {
    if (managerGitShellFamily(vscodeAPI) === 'pwsh') {
        return 'if (-not (Test-Path -LiteralPath .git)) { Write-Host "[vext] skip: no .git"; exit 0 }';
    }
    return 'test -e .git || test -f .git || { echo "[vext] skip: no .git"; exit 0; }';
}

/** Delay (seconds) before auto-closing a manager terminal after a successful git pull/push. */
const GIT_AUTO_CLOSE_DELAY_SEC = 2;

/**
 * Trailing command appended after git pull/push commands. Closes the terminal only when the
 * preceding command succeeded (exit 0); on failure the shell stays open so the user can read
 * the error. Bash uses `$?`, PowerShell uses `$LASTEXITCODE` (set by native `git` calls).
 */
function gitAutoCloseTrailerCmd(vscodeAPI: any, delaySec = GIT_AUTO_CLOSE_DELAY_SEC): string {
    if (managerGitShellFamily(vscodeAPI) === 'pwsh') {
        return `if ($LASTEXITCODE -eq 0) { Start-Sleep -Seconds ${delaySec}; exit 0 }`;
    }
    return `__vext_rc=$?; if [ "$__vext_rc" -eq 0 ]; then sleep ${delaySec}; exit 0; fi`;
}

function createThrottledCallback<T extends (...args: never[]) => void>(fn: T, ms: number): T {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latestArgs: Parameters<T> | undefined;
    const flush = () => {
        timer = undefined;
        if (latestArgs) { fn(...latestArgs); }
    };
    return ((...args: Parameters<T>) => {
        latestArgs = args;
        if (!timer) { timer = setTimeout(flush, ms); }
    }) as T;
}

async function expandWorkspaceGlobPath(
    collector: ModuleCollector,
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    rawPath: string
): Promise<void> {
    let p = String(rawPath || '').trim().replace(/\\/g, '/');
    if (!p) { return; }
    if (p.endsWith('/*') || p.endsWith('/**') || p.includes('*')) {
        const base = p.replace(/^\.\//, '').replace(/\/?\*+.*$/, '');
        const segs = normalizeModuleSegments(base);
        const baseUri = segs.length ? vscodeAPI.Uri.joinPath(wsdUri, ...segs) : wsdUri;
        if (uriPathIsExcluded(baseUri)) { return; }
        let entries: [string, number][];
        try {
            entries = await vscodeAPI.workspace.fs.readDirectory(baseUri);
        } catch {
            return;
        }
        for (const [name, type] of entries) {
            if (name.startsWith('.') || EXCLUDE_DIRS.has(name)) { continue; }
            if (type !== vscodeAPI.FileType.Directory) { continue; }
            await collector.addDirUri(vscodeAPI.Uri.joinPath(baseUri, name));
        }
        return;
    }
    await collector.addRelative(p.startsWith('./') ? p : './' + p);
}

async function findModulesFromManifests(
    collector: ModuleCollector,
    vscodeAPI: any,
    wsdUri: vscode.Uri
): Promise<void> {
    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, 'pnpm-workspace.yaml'));
        const text = Buffer.from(bytes).toString('utf8');
        for (const match of text.matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?\s*$/gm)) {
            await expandWorkspaceGlobPath(collector, vscodeAPI, wsdUri, match[1].trim());
        }
    } catch { /* no pnpm workspace */ }

    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, 'package.json'));
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const workspaces = json?.workspaces;
        const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
        if (Array.isArray(list)) {
            for (const ws of list) {
                await expandWorkspaceGlobPath(collector, vscodeAPI, wsdUri, String(ws));
            }
        }
    } catch { /* no root package.json workspaces */ }

    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, '.gitmodules'));
        const text = Buffer.from(bytes).toString('utf8');
        for (const match of text.matchAll(/^\s*path\s*=\s*(.+)\s*$/gm)) {
            await collector.addRelative('./' + match[1].trim().replace(/\\/g, '/'));
        }
    } catch { /* no gitmodules */ }
}

async function findModulesByQuickProbe(
    collector: ModuleCollector,
    vscodeAPI: any,
    wsdUri: vscode.Uri
): Promise<void> {
    for (const rootSeg of QUICK_PROBE_ROOTS) {
        const segs = normalizeModuleSegments(rootSeg);
        const rootUri = vscodeAPI.Uri.joinPath(wsdUri, ...segs);
        if (uriPathIsExcluded(rootUri)) { continue; }

        let entries: [string, number][];
        try {
            entries = await vscodeAPI.workspace.fs.readDirectory(rootUri);
        } catch {
            continue;
        }

        try {
            await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(rootUri, 'package.json'));
            await collector.addDirUri(rootUri);
        } catch { /* root has no package.json */ }

        for (const [name, type] of entries) {
            if (name.startsWith('.') || EXCLUDE_DIRS.has(name)) { continue; }
            if (type !== vscodeAPI.FileType.Directory) { continue; }
            const childUri = vscodeAPI.Uri.joinPath(rootUri, name);
            if (uriPathIsExcluded(childUri)) { continue; }
            try {
                await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(childUri, 'package.json'));
                await collector.addDirUri(childUri);
            } catch { /* not a package dir */ }
        }
    }
}

async function findModulesByPackageJson(
    collector: ModuleCollector,
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    deadlineMs: number,
    maxResults: number
): Promise<void> {
    if (Date.now() >= deadlineMs) { return; }
    const remaining = Math.max(400, deadlineMs - Date.now());
    const source = new vscodeAPI.CancellationTokenSource();
    const timer = setTimeout(() => source.cancel(), remaining);
    try {
        const files = await vscodeAPI.workspace.findFiles(
            new vscodeAPI.RelativePattern(wsdUri, FIND_PACKAGE_JSON),
            FIND_EXCLUDE,
            maxResults,
            source.token
        );
        for (const fileUri of files) {
            if (uriPathIsExcluded(fileUri)) { continue; }
            const moduleUri = vscodeAPI.Uri.joinPath(fileUri, '..');
            if (uriPathIsExcluded(moduleUri)) { continue; }
            await collector.addDirUri(moduleUri);
        }
    } catch {
        /* cancelled or remote overload */
    } finally {
        clearTimeout(timer);
        source.dispose();
    }
}

async function runModuleScan(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    stale: string[],
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const { deadlineMs, hardTimeoutMs, findMaxResults } = scanTiming(vscodeAPI);

    const scanWork = async (): Promise<string[]> => {
        const collector = new ModuleCollector(vscodeAPI, wsdUri);
        collector.addRoot();

        const publish = () => {
            onPartial?.(mergeModuleLists(stale, collector.toList()));
        };

        await findModulesFromManifests(collector, vscodeAPI, wsdUri);
        await findModulesByQuickProbe(collector, vscodeAPI, wsdUri);
        publish();

        if (collector.toList().length <= 1 && Date.now() < deadlineMs) {
            await findModulesByPackageJson(collector, vscodeAPI, wsdUri, deadlineMs, findMaxResults);
            publish();
        }

        return mergeModuleLists(stale, collector.toList());
    };

    return Promise.race([
        scanWork(),
        new Promise<string[]>((resolve) => {
            setTimeout(() => resolve(stale), hardTimeoutMs);
        }),
    ]);
}

async function scanWorkspaceModules(
    extContext: vscode.ExtensionContext,
    force = false,
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const vscodeAPI = await initVscodeAPI();
    const wsdUri: vscode.Uri | undefined = await getWorkspaceFolder(vscodeAPI?.workspace);
    const extra = getExtraModules(vscodeAPI);
    if (!extContext || !wsdUri) { return mergeModuleLists(['./'], extra); }

    const cache = await ensureCacheHydrated(extContext, wsdUri);
    const { cacheTtlMs } = scanTiming(vscodeAPI);
    const now = Date.now();

    if (!force && cache.modules?.length && (now - cache.lastScanMs) < cacheTtlMs) {
        const hasSubmodules = cache.modules.some((m) => m !== './');
        if (hasSubmodules) {
            return mergeModuleLists(cache.modules, extra);
        }
    }

    if (!force && cache.inflight) {
        const { hardTimeoutMs } = scanTiming(vscodeAPI);
        try {
            const mods = await Promise.race([
                cache.inflight,
                new Promise<string[]>((resolve) => {
                    setTimeout(() => resolve(cache.modules?.length ? cache.modules : ['./']), hardTimeoutMs);
                }),
            ]);
            return mergeModuleLists(mods, extra);
        } catch {
            return mergeModuleLists(cache.modules || ['./'], extra);
        }
    }

    const stale = mergeModuleLists(cache.modules?.length ? cache.modules : ['./'], extra);

    const runScan = (): Promise<string[]> => {
        return runModuleScan(vscodeAPI, wsdUri, stale, (partial) => {
            onPartial?.(mergeModuleLists(partial, extra));
        });
    };

    try {
        cache.inflight = runScan();
        const modules = await cache.inflight;
        cache.modules = modules?.length ? modules : stale;
        cache.lastScanMs = Date.now();
        savePersistedModules(extContext, wsdUri, cache.modules).catch(console.warn);
    } catch {
        cache.modules = stale;
    } finally {
        cache.inflight = undefined;
    }

    return mergeModuleLists(cache.modules, extra);
}

// getDirs (cached per ExtensionContext) — awaits full scan; UI should use peek + background scan
const getDirs = async (extContext: vscode.ExtensionContext, force = false) => {
    return scanWorkspaceModules(extContext, force);
};

// Git commands for push operations
const getGitPushCommands = (commitMsg: string, vscodeAPI?: any, requireLocalDotGit = false) => {
    const cmds = [
        'git rm -r --cached .',
        'git add .', 'git add *',
        `git commit -m "${commitMsg}"`,
        'git pull --rebase --ff',
        'git push --all'
    ];
    if (requireLocalDotGit && vscodeAPI) {
        cmds.unshift(gitPushGuardShellCmd(vscodeAPI));
    }
    return cmds;
};

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

    if (message?.command === 'refresh-modules') {
        return refreshModules(true);
    }

    if (message?.command === 'open-wide-manager') {
        return vscodeAPI.commands.executeCommand('vext.openManagerPanel');
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
            const bulkModules = await resolveBulkModules(vscodeAPI, wsdUri, message.command, modules);
            if (!bulkModules) { return; }
            for (const m of bulkModules) {
                const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
                if (message.command === 'bulk_push' && !(await moduleHasGit(vscodeAPI, mUri))) {
                    continue;
                }
                const mPath = normalizePath(vscodeAPI, mUri);
                const mCtx = { ...ctxVars, module: m, modulePath: mPath };
                let resolvedCmds = overrideCmds.map(c => resolvePlaceholders(c, mCtx));
                if (message.command === 'bulk_push') {
                    resolvedCmds = [gitPushGuardShellCmd(vscodeAPI), ...resolvedCmds];
                }
                runInTerminal(resolvedCmds, mPath, false, message.command === 'bulk_push');
            }
        } else {
            const resolvedCmds = overrideCmds.map(c => resolvePlaceholders(c, ctxVars));
            const openInNew = ['terminal', 'watch', 'dev', 'test', 'restart', 'stop', 'diff'];
            runInTerminal(resolvedCmds, path, openInNew?.indexOf?.(message.command) >= 0, message.command === 'push');
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
            'bulk_push': getGitPushCommands(escapeDoubleQuoted(commitMsg!), vscodeAPI, true),
            'bulk_install': ['git pull --rebase --ff', 'npm install -D', 'npm audit fix'],
            'bulk_build': ['npm run build']
        };

        const bulkModules = await resolveBulkModules(vscodeAPI, wsdUri, message.command, modules);
        if (!bulkModules) { return; }

        for (const m of bulkModules) {
            const mUri = joinModuleUri(vscodeAPI, wsdUri, m);
            if (message.command === 'bulk_push' && !(await moduleHasGit(vscodeAPI, mUri))) {
                continue;
            }
            const mPath = normalizePath(vscodeAPI, mUri);
            runInTerminal(commandMap?.[message.command] || [], mPath, false, message.command === 'bulk_push');
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
        'publish': ['npm run build && npm run publish'],
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
            if (!(await moduleHasGit(vscodeAPI, moduleUri))) {
                vscodeAPI.window.showWarningMessage('Git push: this module has no .git directory.');
                return;
            }
            const commitMsg = await vscodeAPI?.window?.showInputBox?.({
                prompt: 'Commit Message?',
                value: '',
                default: 'No Description'
            });
            if (!commitMsg) { return; }
            runInTerminal(getGitPushCommands(escapeDoubleQuoted(commitMsg), vscodeAPI, true), path, false, true);
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

function buildRefreshModules(
    extContext: vscode.ExtensionContext,
    publish: (modules: string[], scanning?: boolean) => Promise<void>
) {
    let scanGen = 0;
    const throttledPublish = createThrottledCallback(
        (mods: string[], scanning?: boolean) => { publish(mods, scanning).catch(console.warn); },
        400
    );

    return async (force = false) => {
        const gen = ++scanGen;
        const vscodeAPI = await initVscodeAPI();
        const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
        const extra = getExtraModules(vscodeAPI);
        if (wsdUri) { await ensureCacheHydrated(extContext, wsdUri); }
        const instant = peekModules(extContext, extra);
        await publish(instant, true);

        try {
            const mods = await scanWorkspaceModules(extContext, force, (partial) => {
                if (gen !== scanGen) { return; }
                throttledPublish(partial, true);
            });
            if (gen !== scanGen) { return; }
            await publish(mods, false);
        } catch (e) {
            console.warn('[vext:manager] module scan failed', e);
            if (gen === scanGen) {
                await publish(instant, false);
            }
        }
    };
}

//
export class ManagerViewProvider {
    _extensionUri: any;
    _viewType: string;
    _extContext: vscode.ExtensionContext;

    static viewType = "vext.managerView";

    constructor(extContext: vscode.ExtensionContext, extensionUri, viewType: string) {
        this._extContext = extContext;
        this._extensionUri = extensionUri;
        this._viewType = viewType;
    }

    async updateView(webviewView, context, modules?, scanning = false) {
        const vscodeAPI = await initVscodeAPI();
        const uiConfig = getManagerUiConfig(vscodeAPI);
        const list = modules ?? peekModules(this._extContext, getExtraModules(vscodeAPI));
        const normalized = mergeModuleLists(list);
        webviewView?.webview?.postMessage?.({
            type: 'modules',
            modules: normalized,
            scanning: Boolean(scanning),
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
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };

        const extVersion = String(this._extContext?.extension?.packageJSON?.version ?? "0.0.0");
        const instanceId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
        const uiConfig = getManagerUiConfig(vscodeAPI);
        const theme = resolveTheme(vscodeAPI, uiConfig.theme);
        const actionCatalog = getFilteredActions(uiConfig);

        let html = "";
        try {
            html = await getWebviewContent(webviewView.webview, this._extensionUri, {
                instanceId,
                viewType: this._viewType,
                version: extVersion,
                theme,
                actionCatalog,
                initialModules: ['./'],
                uiFlags: {
                    layout: uiConfig.layout,
                    primaryActions: uiConfig.primaryActions,
                    secondaryActions: uiConfig.secondaryActions,
                    bulkActions: uiConfig.bulkActions
                }
            });
        } catch (e) {
            console.warn('[vext:manager] webview html failed', e);
        }
        webviewView.webview.html = html || getMinimalManagerFallbackHtml(theme);

        const refreshModules = buildRefreshModules(this._extContext, (mods, scanning) =>
            this.updateView(webviewView, _resolveContext, mods, scanning)
        );
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let pendingForce = false;
        const scheduleRefresh = (force = false) => {
            pendingForce = pendingForce || force;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            refreshTimer = setTimeout(() => {
                const shouldForce = pendingForce;
                pendingForce = false;
                refreshModules(shouldForce).catch(console.warn);
            }, REFRESH_DEBOUNCE_MS);
        };

        const startBackgroundWork = () => {
            getWorkspaceFolder(vscodeAPI?.workspace).then((wsdUri) => {
                if (!wsdUri) {
                    refreshModules(false).catch(console.warn);
                    return;
                }
                ensureCacheHydrated(this._extContext, wsdUri)
                    .then(() => refreshModules(false))
                    .catch((e) => {
                        console.warn('[vext:manager] hydrate failed', e);
                        refreshModules(false).catch(console.warn);
                    });
            }).catch(console.warn);
        };

        acquireManagerFileWatch(vscodeAPI);
        setTimeout(startBackgroundWork, 100);

        const watchCb = (force = false) => scheduleRefresh(force);
        inWatch?.add?.(watchCb);
        const disposables: { dispose(): void }[] = [];
        webviewView?.onDidDispose?.(() => {
            inWatch?.delete?.(watchCb);
            releaseManagerFileWatch();
            if (refreshTimer) { clearTimeout(refreshTimer); }
            for (const d of disposables) {
                try { d.dispose(); } catch { /* ignore */ }
            }
        });
        webviewView?.onDidChangeVisibility?.(() => {
            if (webviewView?.visible) { scheduleRefresh(false); }
        });
        disposables.push(
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

    const webviewOptions = { retainContextWhenHidden: true };
    const prov1 = vscodeAPI?.window?.registerWebviewViewProvider?.(
        ManagerViewProvider.viewType, providerSidebar, { webviewOptions }
    );
    if (prov1) { context?.subscriptions?.push?.(prov1); }

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
            { enableScripts: true, localResourceRoots: [context.extensionUri], retainContextWhenHidden: true }
        );

        let panelHtml = "";
        try {
            panelHtml = await getWebviewContent(panel.webview, context.extensionUri, {
                instanceId,
                viewType: "vext.managerPanel",
                version: extVersion,
                theme,
                actionCatalog,
                initialModules: peekModules(context, getExtraModules(vscodeAPI)),
                uiFlags: {
                    layout: uiConfig.layout,
                    primaryActions: uiConfig.primaryActions,
                    secondaryActions: uiConfig.secondaryActions,
                    bulkActions: uiConfig.bulkActions
                }
            });
        } catch (e) {
            console.warn('[vext:manager] panel html failed', e);
        }
        panel.webview.html = panelHtml || getMinimalManagerFallbackHtml(theme);

        const publishPanelModules = async (mods: string[], scanning = false) => {
            const liveConfig = getManagerUiConfig(vscodeAPI);
            const normalized = mergeModuleLists(mods);
            panel?.webview?.postMessage?.({
                type: "modules",
                modules: normalized,
                scanning: Boolean(scanning),
                theme: resolveTheme(vscodeAPI, liveConfig.theme),
                actionCatalog: getFilteredActions(liveConfig),
                uiFlags: {
                    layout: liveConfig.layout,
                    primaryActions: liveConfig.primaryActions
                }
            });
        };

        const refreshModules = buildRefreshModules(context, publishPanelModules);
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        let pendingForce = false;
        const scheduleRefresh = (force = false) => {
            pendingForce = pendingForce || force;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            refreshTimer = setTimeout(() => {
                const shouldForce = pendingForce;
                pendingForce = false;
                refreshModules(shouldForce).catch(console.warn);
            }, REFRESH_DEBOUNCE_MS);
        };

        const watchCb = (force = false) => scheduleRefresh(force);
        acquireManagerFileWatch(vscodeAPI);
        inWatch.add(watchCb);
        panel.onDidDispose(() => {
            inWatch.delete(watchCb);
            releaseManagerFileWatch();
            if (refreshTimer) { clearTimeout(refreshTimer); }
        });
        setTimeout(() => {
            getWorkspaceFolder(vscodeAPI?.workspace).then((wsdUri) => {
                if (!wsdUri) {
                    refreshModules(false).catch(console.warn);
                    return;
                }
                ensureCacheHydrated(context, wsdUri)
                    .then(() => refreshModules(false))
                    .catch(() => refreshModules(false).catch(console.warn));
            }).catch(console.warn);
        }, 100);
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
type TerminalEntry = { terminal: vscode.Terminal, status: TerminalStatus, preambleSent?: boolean };
const terminalMap = new Map<string, TerminalEntry>();

type TerminalHistoryMode = 'suppress' | 'persist';

function getManagerTerminalHistoryMode(vscodeAPI: any): TerminalHistoryMode {
    const v = String(vscodeAPI?.workspace?.getConfiguration?.('vext')?.get?.('managerView.terminal.history', 'suppress') || 'suppress');
    return v === 'persist' ? 'persist' : 'suppress';
}

/** Best-effort shell family detection for history-suppression preamble. */
function detectManagerShellFamily(vscodeAPI: any): 'bash' | 'pwsh' {
    if (Boolean(vscodeAPI?.env?.remoteName)) { return 'bash'; }
    if (process.platform !== 'win32') { return 'bash'; }
    const def = String(
        vscodeAPI?.workspace?.getConfiguration?.('terminal.integrated')?.get?.('defaultProfile.windows', 'PowerShell')
        || 'PowerShell'
    );
    const s = def.toLowerCase();
    if (s.includes('bash') || s.includes('wsl') || s.includes('zsh') || s.includes('fish')) { return 'bash'; }
    return 'pwsh';
}

/**
 * One-time preamble enabling leading-space history suppression for the detected shell.
 * Bash/zsh honor `HISTCONTROL=ignorespace` / `HIST_IGNORE_SPACE`; PowerShell uses a
 * PSReadLine `AddToHistoryHandler` that rejects lines starting with whitespace.
 */
function shellHistoryPreamble(family: 'bash' | 'pwsh'): string {
    if (family === 'pwsh') {
        return ` Set-PSReadLineOption -AddToHistoryHandler { param($line) -not ($line -match '^\\s') } # vext`;
    }
    return ` export HISTCONTROL=ignorespace:erasedups 2>/dev/null; setopt HIST_IGNORE_SPACE 2>/dev/null # vext`;
}

async function runInTerminal(cmds: string[], cwd: string, longRunning = false, autoCloseOnSuccess = false) {
    const vscodeAPI = await initVscodeAPI();
    const suppress = getManagerTerminalHistoryMode(vscodeAPI) === 'suppress';

    let entry = !longRunning ? Array.from(terminalMap.entries()).find(([dir, obj]) => dir === cwd && obj.status === 'free') : null;
    let termObj = entry?.[1];

    if (!termObj) {
        const terminal = vscodeAPI?.window.createTerminal({ cwd, isTransient: suppress });
        termObj = { terminal, status: longRunning ? 'busy' : 'free', preambleSent: false };
        if (!longRunning) { terminalMap.set(cwd, termObj); }
    } else if (longRunning) {
        termObj.status = 'busy';
    }

    termObj?.terminal?.show();

    if (suppress && termObj && !termObj.preambleSent) {
        termObj.preambleSent = true;
        termObj.terminal?.sendText?.(shellHistoryPreamble(detectManagerShellFamily(vscodeAPI)));
    }

    const prefix = suppress ? ' ' : '';
    const lines = cmds.slice();
    if (autoCloseOnSuccess) {
        lines.push(gitAutoCloseTrailerCmd(vscodeAPI));
    }
    lines.forEach(cmd => termObj?.terminal?.sendText?.(`${prefix}${cmd}`));
}
