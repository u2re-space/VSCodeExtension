//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';
import { getWebviewContent } from "./webview.ts";
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
const SCAN_MAX_DIRS = 500;
const SCAN_BFS_BATCH_LOCAL = 6;
const SCAN_BFS_BATCH_REMOTE = 2;
const PERSIST_KEY = 'vext.managerModulesCache';

const FIND_EXCLUDE = '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/coverage/**,**/target/**,**/.git/**,**/.turbo/**,**/.next/**,**/.nuxt/**,**/.cache/**,**/vendor/**,**/__pycache__/**,**/.pnpm-store/**,**/.vscode-test/**,**/.yarn/**}';

const FIND_MARKER_PATTERNS = [
    '**/package.json',
    '**/pnpm-workspace.yaml',
    '**/Cargo.toml',
    '**/go.mod',
    '**/pyproject.toml',
    '**/.git/HEAD',
];

const FIND_MARKER_PATTERNS_REST = FIND_MARKER_PATTERNS.filter((p) => p !== '**/package.json');

/** Shallow readDirectory probes — fast on SSH vs full findFiles */
const QUICK_PROBE_ROOTS = ['modules/projects', 'modules', 'apps', 'packages', 'externals'];

type PersistedModulesCache = Record<string, { modules: string[]; savedAt: number }>;

function scanTiming(vscodeAPI: any) {
    const remote = Boolean(vscodeAPI.env?.remoteName);
    return {
        remote,
        deadlineMs: Date.now() + (remote ? SCAN_DEADLINE_REMOTE_MS : SCAN_DEADLINE_MS),
        hardTimeoutMs: remote ? SCAN_HARD_TIMEOUT_REMOTE_MS : SCAN_HARD_TIMEOUT_MS,
        cacheTtlMs: remote ? SCAN_CACHE_TTL_REMOTE_MS : SCAN_CACHE_TTL_MS,
        findMaxResults: remote ? 400 : 200,
        bfsBatch: remote ? SCAN_BFS_BATCH_REMOTE : SCAN_BFS_BATCH_LOCAL,
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
    return isValidModulePath(rel) ? rel : null;
}

function addModuleDir(dirs: Set<string>, vscodeAPI: any, wsdUri: vscode.Uri, dirUri: vscode.Uri) {
    const rel = moduleRelFromUri(vscodeAPI, wsdUri, dirUri);
    if (rel) { dirs.add(rel); }
}

function mergeModuleLists(...lists: (string[] | undefined)[]): string[] {
    const out = new Set<string>();
    for (const list of lists) {
        for (const item of list || []) {
            const m = String(item || '').trim();
            if (!m) { continue; }
            const normalized = m === '.' ? './' : m;
            if (isValidModulePath(normalized)) { out.add(normalized); }
        }
    }
    out.add('./');
    return Array.from(out).sort((a, b) => a.localeCompare(b));
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
        await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(moduleUri, '.git'));
        return true;
    } catch {
        return false;
    }
}

async function filterModulesWithGit(vscodeAPI: any, wsdUri: vscode.Uri, modules: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const m of modules) {
        if (await moduleHasGit(vscodeAPI, joinModuleUri(vscodeAPI, wsdUri, m))) {
            out.push(m);
        }
    }
    return out;
}

const EXCLUDE_DIRS = new Set([
    "node_modules", "dist", "out", "build", "coverage", "target",
    ".git", ".hg", ".svn", ".turbo", ".next", ".nuxt", ".cache",
    "vendor", "__pycache__", ".pnpm-store", ".vscode-test", ".yarn",
]);

const PKG_MARKERS = new Set([
    "package.json", "deno.json", "deno.jsonc", "jsr.json",
    "pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock",
    "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "composer.json",
]);

function uriPathKey(uri: vscode.Uri): string {
    return normalizeUriPath(uri).toLowerCase();
}

function moduleUriFromMarkerFile(vscodeAPI: any, fileUri: vscode.Uri, pattern: string): vscode.Uri {
    return pattern.includes('.git/HEAD')
        ? vscodeAPI.Uri.joinPath(fileUri, '../..')
        : vscodeAPI.Uri.joinPath(fileUri, '..');
}

async function expandWorkspaceGlobPath(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    rawPath: string,
    dirs: Set<string>
): Promise<void> {
    let p = String(rawPath || '').trim().replace(/\\/g, '/');
    if (!p) { return; }
    if (p.endsWith('/*') || p.endsWith('/**') || p.includes('*')) {
        const base = p.replace(/^\.\//, '').replace(/\/?\*+.*$/, '');
        const segs = normalizeModuleSegments(base);
        const baseUri = segs.length ? vscodeAPI.Uri.joinPath(wsdUri, ...segs) : wsdUri;
        let entries: [string, number][];
        try {
            entries = await vscodeAPI.workspace.fs.readDirectory(baseUri);
        } catch {
            return;
        }
        for (const [name, type] of entries) {
            if (name.startsWith('.') || EXCLUDE_DIRS.has(name)) { continue; }
            if (type !== vscodeAPI.FileType.Directory) { continue; }
            addModuleDir(dirs, vscodeAPI, wsdUri, vscodeAPI.Uri.joinPath(baseUri, name));
        }
        return;
    }
    const rel = p.startsWith('./') ? p : './' + p;
    if (isValidModulePath(rel)) { dirs.add(rel); }
}

async function findModulesFromManifests(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const dirs = new Set<string>();

    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, 'pnpm-workspace.yaml'));
        const text = Buffer.from(bytes).toString('utf8');
        for (const match of text.matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?\s*$/gm)) {
            await expandWorkspaceGlobPath(vscodeAPI, wsdUri, match[1].trim(), dirs);
        }
    } catch { /* no pnpm workspace */ }

    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, 'package.json'));
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const workspaces = json?.workspaces;
        const list = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
        if (Array.isArray(list)) {
            for (const ws of list) {
                await expandWorkspaceGlobPath(vscodeAPI, wsdUri, String(ws), dirs);
            }
        }
    } catch { /* no root package.json workspaces */ }

    try {
        const bytes = await vscodeAPI.workspace.fs.readFile(vscodeAPI.Uri.joinPath(wsdUri, '.gitmodules'));
        const text = Buffer.from(bytes).toString('utf8');
        for (const match of text.matchAll(/^\s*path\s*=\s*(.+)\s*$/gm)) {
            const rel = './' + match[1].trim().replace(/\\/g, '/');
            if (isValidModulePath(rel)) { dirs.add(rel); }
        }
    } catch { /* no gitmodules */ }

    const found = Array.from(dirs).sort((a, b) => a.localeCompare(b));
    if (found.length) { onPartial?.(found); }
    return found;
}

async function findModulesByQuickProbe(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const dirs = new Set<string>();

    for (const rootSeg of QUICK_PROBE_ROOTS) {
        const segs = normalizeModuleSegments(rootSeg);
        const rootUri = vscodeAPI.Uri.joinPath(wsdUri, ...segs);
        let entries: [string, number][];
        try {
            entries = await vscodeAPI.workspace.fs.readDirectory(rootUri);
        } catch {
            continue;
        }

        try {
            await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(rootUri, 'package.json'));
            addModuleDir(dirs, vscodeAPI, wsdUri, rootUri);
        } catch { /* root has no package.json */ }

        for (const [name, type] of entries) {
            if (name.startsWith('.') || EXCLUDE_DIRS.has(name)) { continue; }
            if (type !== vscodeAPI.FileType.Directory) { continue; }
            const childUri = vscodeAPI.Uri.joinPath(rootUri, name);
            try {
                await vscodeAPI.workspace.fs.stat(vscodeAPI.Uri.joinPath(childUri, 'package.json'));
                addModuleDir(dirs, vscodeAPI, wsdUri, childUri);
            } catch { /* not a package dir */ }
        }
    }

    const found = Array.from(dirs).sort((a, b) => a.localeCompare(b));
    if (found.length) { onPartial?.(found); }
    return found;
}

async function findModulesByPattern(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    pattern: string,
    deadlineMs: number,
    maxResults: number,
    dirs: Set<string>,
    onPartial?: (modules: string[]) => void,
    streamPartial = false
): Promise<void> {
    if (Date.now() >= deadlineMs) { return; }
    const remaining = Math.max(400, deadlineMs - Date.now());
    const source = new vscodeAPI.CancellationTokenSource();
    const timer = setTimeout(() => source.cancel(), remaining);
    try {
        const files = await vscodeAPI.workspace.findFiles(
            new vscodeAPI.RelativePattern(wsdUri, pattern),
            FIND_EXCLUDE,
            maxResults,
            source.token
        );
        for (const fileUri of files) {
            addModuleDir(dirs, vscodeAPI, wsdUri, moduleUriFromMarkerFile(vscodeAPI, fileUri, pattern));
            if (streamPartial && dirs.size > 0) {
                onPartial?.(Array.from(dirs).sort((a, b) => a.localeCompare(b)));
            }
        }
        if (dirs.size > 0) {
            onPartial?.(Array.from(dirs).sort((a, b) => a.localeCompare(b)));
        }
    } catch {
        /* cancelled or remote overload */
    } finally {
        clearTimeout(timer);
        source.dispose();
    }
}

async function findModulesByMarkers(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    deadlineMs: number,
    maxResults: number,
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const dirs = new Set<string>();

    await findModulesByPattern(
        vscodeAPI, wsdUri, '**/package.json', deadlineMs, maxResults, dirs, onPartial, true
    );

    await Promise.allSettled(FIND_MARKER_PATTERNS_REST.map(async (pattern) => {
        await findModulesByPattern(vscodeAPI, wsdUri, pattern, deadlineMs, maxResults, dirs, onPartial, false);
    }));

    return Array.from(dirs).sort((a, b) => a.localeCompare(b));
}

// Bounded BFS fallback when findFiles is slow or incomplete on remote
async function findProjectDirsBfs(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    deadlineMs: number,
    remote: boolean,
    batchSize: number,
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const result = new Set<string>();
    const visited = new Set<string>();
    const queue: vscode.Uri[] = [wsdUri];

    while (queue.length > 0 && Date.now() < deadlineMs && visited.size < SCAN_MAX_DIRS) {
        const batch = queue.splice(0, batchSize);
        await Promise.allSettled(batch.map(async (currentDir) => {
            if (Date.now() >= deadlineMs || visited.size >= SCAN_MAX_DIRS) { return; }
            const visitKey = uriPathKey(currentDir);
            if (visited.has(visitKey)) { return; }
            visited.add(visitKey);

            let entries: [string, number][];
            try {
                entries = await vscodeAPI.workspace.fs.readDirectory(currentDir);
            } catch {
                return;
            }

            let hasRepo = false;
            let hasPkg = false;
            const subDirs: vscode.Uri[] = [];

            for (const [name, type] of entries) {
                let isDir = type === vscodeAPI.FileType.Directory;
                let isFile = type === vscodeAPI.FileType.File;

                if (
                    !remote
                    && (
                        type === vscodeAPI.FileType.SymbolicLink
                        || type === (vscodeAPI.FileType.Directory | vscodeAPI.FileType.SymbolicLink)
                        || type === (vscodeAPI.FileType.File | vscodeAPI.FileType.SymbolicLink)
                    )
                ) {
                    const entryUri = vscodeAPI.Uri.joinPath(currentDir, name);
                    try {
                        const vStat = await vscodeAPI.workspace.fs.stat(entryUri);
                        isDir = (vStat.type & vscodeAPI.FileType.Directory) !== 0;
                        isFile = (vStat.type & vscodeAPI.FileType.File) !== 0;
                    } catch {
                        continue;
                    }
                } else if (
                    remote
                    && (
                        type === vscodeAPI.FileType.SymbolicLink
                        || type === (vscodeAPI.FileType.Directory | vscodeAPI.FileType.SymbolicLink)
                    )
                ) {
                    continue;
                }

                if (name === '.git' || name === '.hg' || name === '.svn') {
                    hasRepo = true;
                }
                if (isFile && PKG_MARKERS.has(name)) {
                    hasPkg = true;
                }
                if (isDir && !EXCLUDE_DIRS.has(name) && !name.startsWith('.')) {
                    subDirs.push(vscodeAPI.Uri.joinPath(currentDir, name));
                }
            }

            if (hasRepo || hasPkg) {
                addModuleDir(result, vscodeAPI, wsdUri, currentDir);
                onPartial?.(Array.from(result).sort((a, b) => a.localeCompare(b)));
            }

            queue.push(...subDirs);
        }));
    }

    return Array.from(result).sort((a, b) => a.localeCompare(b));
}

async function runModuleScan(
    vscodeAPI: any,
    wsdUri: vscode.Uri,
    stale: string[],
    onPartial?: (modules: string[]) => void
): Promise<string[]> {
    const { remote, deadlineMs, hardTimeoutMs, findMaxResults, bfsBatch } = scanTiming(vscodeAPI);

    const scanWork = async (): Promise<string[]> => {
        const partialMerge = (partial: string[]) => {
            onPartial?.(mergeModuleLists(stale, partial));
        };

        const [fromManifest, fromProbe] = await Promise.all([
            findModulesFromManifests(vscodeAPI, wsdUri, partialMerge),
            findModulesByQuickProbe(vscodeAPI, wsdUri, partialMerge),
        ]);
        let merged = mergeModuleLists(stale, fromManifest, fromProbe);
        partialMerge(merged);

        if (remote) {
            const [fromFind, fromBfs] = await Promise.all([
                findModulesByMarkers(vscodeAPI, wsdUri, deadlineMs, findMaxResults, partialMerge),
                findProjectDirsBfs(vscodeAPI, wsdUri, deadlineMs, remote, bfsBatch, partialMerge),
            ]);
            merged = mergeModuleLists(merged, fromFind, fromBfs);
        } else {
            const fromFind = await findModulesByMarkers(vscodeAPI, wsdUri, deadlineMs, findMaxResults, partialMerge);
            merged = mergeModuleLists(merged, fromFind);
            if (merged.length <= 1 && Date.now() < deadlineMs) {
                const fromBfs = await findProjectDirsBfs(vscodeAPI, wsdUri, deadlineMs, remote, bfsBatch, partialMerge);
                merged = mergeModuleLists(merged, fromBfs);
            }
        }

        return merged;
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

    if (message?.command === 'refresh-modules') {
        return refreshModules(true);
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
            let bulkModules = modules;
            if (message.command === 'bulk_push') {
                bulkModules = await filterModulesWithGit(vscodeAPI, wsdUri, modules);
                if (!bulkModules.length) {
                    vscodeAPI.window.showWarningMessage('Bulk push: no modules with .git found.');
                    return;
                }
            }
            for (const m of bulkModules) {
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

        let bulkModules = modules;
        if (message.command === 'bulk_push') {
            bulkModules = await filterModulesWithGit(vscodeAPI, wsdUri, modules);
            if (!bulkModules.length) {
                vscodeAPI.window.showWarningMessage('Bulk push: no modules with .git found.');
                return;
            }
        }

        for (const m of bulkModules) {
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

function buildRefreshModules(
    extContext: vscode.ExtensionContext,
    publish: (modules: string[], scanning?: boolean) => Promise<void>
) {
    let scanGen = 0;

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
                publish(partial, true).catch(console.warn);
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

async function prefetchManagerModules(extContext: vscode.ExtensionContext) {
    const vscodeAPI = await initVscodeAPI();
    if (!vscodeAPI.env?.remoteName) { return; }
    const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
    if (!wsdUri) { return; }
    await ensureCacheHydrated(extContext, wsdUri);
    scanWorkspaceModules(extContext, false).catch(console.warn);
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
        const extVersion = String(this._extContext?.extension?.packageJSON?.version ?? "0.0.0");
        const instanceId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
        const uiConfig = getManagerUiConfig(vscodeAPI);
        const theme = resolveTheme(vscodeAPI, uiConfig.theme);
        const actionCatalog = getFilteredActions(uiConfig);
        const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
        if (wsdUri) { await ensureCacheHydrated(this._extContext, wsdUri); }
        const initialModules = peekModules(this._extContext, getExtraModules(vscodeAPI));

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

        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        const html = await getWebviewContent(webviewView.webview, this._extensionUri, {
            instanceId,
            viewType: this._viewType,
            version: extVersion,
            theme,
            actionCatalog,
            initialModules,
            uiFlags: {
                layout: uiConfig.layout,
                primaryActions: uiConfig.primaryActions,
                secondaryActions: uiConfig.secondaryActions,
                bulkActions: uiConfig.bulkActions
            }
        }).catch((e) => { console.warn(e); return ""; });
        if (html) { webviewView.webview.html = html; }

        acquireManagerFileWatch(vscodeAPI);
        refreshModules(false).catch(console.warn);

        const watchCb = (force = false) => scheduleRefresh(force);
        inWatch?.add?.(watchCb);
        webviewView?.onDidDispose?.(() => {
            inWatch?.delete?.(watchCb);
            releaseManagerFileWatch();
            if (refreshTimer) { clearTimeout(refreshTimer); }
        });
        webviewView?.onDidChangeVisibility?.(() => { if (webviewView?.visible) { scheduleRefresh(false); } });
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
    prefetchManagerModules(context).catch(console.warn);
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
        const wsdUri = await getWorkspaceFolder(vscodeAPI?.workspace);
        if (wsdUri) { await ensureCacheHydrated(context, wsdUri); }
        const initialModules = peekModules(context, getExtraModules(vscodeAPI));
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
            initialModules,
            uiFlags: {
                layout: uiConfig.layout,
                primaryActions: uiConfig.primaryActions,
                secondaryActions: uiConfig.secondaryActions,
                bulkActions: uiConfig.bulkActions
            }
        });

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
