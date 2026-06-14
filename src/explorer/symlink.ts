//! use only TS types
import type * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

//
import vscodePromise from '../imports/api.ts';

//
function toFs(p: string): string {
    return p.replace(/\\/g, path.sep);
}

function toPosixSegments(p: string): string {
    return p.replace(/\\/g, '/');
}

type ExistsPathFn = (p: string) => boolean;
type RealpathFn = (p: string) => string;

function pathExistsOrSymlink(p: string): boolean {
    try {
        fs.lstatSync(toFs(p));
        return true;
    } catch {
        return false;
    }
}

function safeRealpathDir(dirFs: string, realpathFn: RealpathFn = fs.realpathSync.native): string {
    try {
        return path.resolve(realpathFn(dirFs));
    } catch {
        return path.resolve(dirFs);
    }
}

/** Relative symlink target: POSIX-style slashes, `.` when link and target are the same path. */
function posixRelativeTarget(fromDirFs: string, absoluteTargetFs: string): string {
    let rel = path.relative(fromDirFs, absoluteTargetFs).replace(/\\/g, '/');
    if (!rel) { rel = '.'; }
    return rel;
}

function relativeSymlinkTarget(
    fromDirFs: string,
    targetFs: string,
    realpathFn?: RealpathFn
): string {
    const anchorDirFs = safeRealpathDir(fromDirFs, realpathFn);
    const absoluteTargetFs = path.resolve(targetFs);
    const rel = posixRelativeTarget(anchorDirFs, absoluteTargetFs);
    return path.isAbsolute(rel) ? toPosixSegments(absoluteTargetFs) : rel;
}

function normalizeSymlinkTarget(
    linkPath: string,
    target: string,
    realpathFn?: RealpathFn
): { changed: boolean; resolvedTargetFs: string; relTarget: string } {
    const linkDirFs = path.dirname(linkPath);
    const anchorDirFs = safeRealpathDir(linkDirFs, realpathFn);
    const targetFs = toFs(target);
    const resolvedTargetFs = path.isAbsolute(targetFs)
        ? path.resolve(targetFs)
        : path.resolve(anchorDirFs, targetFs);
    const relTarget = posixRelativeTarget(anchorDirFs, resolvedTargetFs);
    const currentTarget = toPosixSegments(target);
    return {
        changed: path.isAbsolute(targetFs) || currentTarget !== relTarget,
        resolvedTargetFs,
        relTarget,
    };
}

function workspaceRoots(vscodeAPI: typeof vscode): string[] {
    const folders = vscodeAPI.workspace.workspaceFolders ?? [];
    return folders.map((f) => path.resolve(f.uri.fsPath));
}

/** Newline-separated paths and JSON string arrays, e.g. `["a","b"]`. */
function parsePathList(raw: string): string[] {
    const t = raw.trim();
    if (!t) { return []; }
    if (t.startsWith('[')) {
        try {
            const j = JSON.parse(t) as unknown;
            if (Array.isArray(j)) {
                return j.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
            }
        } catch {
            /* fall through */
        }
    }
    return t
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Resolve a user-entered path to an absolute existing path (absolute input or relative to workspace / destination dir). */
function resolveSourcePath(
    raw: string,
    dirToFs: string,
    roots: string[],
    existsPath: ExistsPathFn = pathExistsOrSymlink
): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) { return undefined; }
    const direct = path.normalize(trimmed);
    if (path.isAbsolute(direct) && existsPath(direct)) {
        return path.resolve(direct);
    }
    const candidates = [...roots.map((r) => path.resolve(r, trimmed)), path.resolve(dirToFs, trimmed)];
    for (const c of candidates) {
        if (existsPath(c)) { return path.resolve(c); }
    }
    return undefined;
}

async function getClipboardContent(): Promise<string | undefined> {
    const vscodeAPI = await vscodePromise;
    try {
        return await vscodeAPI.env.clipboard.readText();
    } catch (error) {
        console.error('Error reading clipboard:', error);
        vscodeAPI.window.showErrorMessage('Failed to read clipboard content.');
    }
}

function getBaseName(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').pop() || '';
}

function uniqueLinkPath(dirToFs: string, baseName: string, existsPath: ExistsPathFn = pathExistsOrSymlink): string {
    let candidate = path.join(dirToFs, baseName);
    if (!existsPath(candidate)) { return candidate; }
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    for (let i = 2; ; i++) {
        candidate = path.join(dirToFs, `${stem} (${i})${ext}`);
        if (!existsPath(candidate)) { return candidate; }
    }
}

function linkPathForName(
    dirToFs: string,
    linkName: string,
    autoDeduplicate: boolean,
    existsPath: ExistsPathFn = pathExistsOrSymlink
): string {
    return autoDeduplicate
        ? uniqueLinkPath(dirToFs, linkName, existsPath)
        : path.join(dirToFs, linkName);
}

async function askSingleLinkName(vscodeAPI: any, dirToFs: string, defaultName: string): Promise<string | undefined> {
    let value = defaultName;
    for (;;) {
        const input = await vscodeAPI.window.showInputBox({
            prompt: 'Enter symlink name (leave empty to use original name)',
            value,
        });
        if (input === undefined) { return undefined; }

        const linkName = input.trim() || defaultName;
        const linkPath = linkPathForName(dirToFs, linkName, false);
        if (!pathExistsOrSymlink(linkPath)) {
            return linkName;
        }

        const answer = await vscodeAPI.window.showWarningMessage(
            `Symlink name already exists: ${linkName}`,
            'Choose another name',
            'Cancel'
        );
        if (answer !== 'Choose another name') {
            return undefined;
        }
        value = linkName;
    }
}

// Runs an elevated terminal command: UAC via Start-Process on Windows, sudo on Linux/remote.
// psCmd  — raw PowerShell expression (single-quote paths inside, no outer quoting needed)
// shCmd  — raw shell expression passed verbatim to `sudo sh -c`
function runElevated(vscodeAPI: any, cwd: string, psCmd: string, shCmd: string) {
    let command: string;
    if (process.platform === 'win32' && !vscodeAPI.env.remoteName) {
        const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');
        command = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-EncodedCommand','${encoded}'`;
    } else {
        command = `sudo sh -c ${JSON.stringify(shCmd)}`;
    }
    const terminal = vscodeAPI.window.createTerminal({ cwd, name: 'Symlink (Elevated)' });
    terminal.show();
    terminal.sendText(command);
    vscodeAPI.window.showInformationMessage('Elevated symlink command sent to terminal.');
}

function createSymlinkSync(linkPathFs: string, relTargetPosix: string, linkType: fs.symlink.Type): void {
    fs.symlinkSync(toFs(relTargetPosix), linkPathFs, linkType);
}

function tryCreateSymlinkWithRetry(
    vscodeAPI: any,
    cwdForElevated: string,
    linkPathFs: string,
    relTargetPosix: string,
    linkType: fs.symlink.Type
): 'ok' | 'elevated' | 'fail' {
    try {
        createSymlinkSync(linkPathFs, relTargetPosix, linkType);
        return 'ok';
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const q = (s: string) => s.replace(/'/g, "''");
            const pl = toPosixSegments(linkPathFs);
            const rt = relTargetPosix;
            runElevated(
                vscodeAPI,
                cwdForElevated,
                `New-Item -ItemType SymbolicLink -Path '${q(pl)}' -Target '${q(rt)}'`,
                `ln -s "${rt}" "${pl}"`
            );
            return 'elevated';
        }
        vscodeAPI.window.showErrorMessage(`Failed to create symlink: ${e}`);
        return 'fail';
    }
}

async function createSymlinksFromSources(
    vscodeAPI: any,
    dirToFs: string,
    sourceAbsList: string[]
): Promise<void> {
    const roots = workspaceRoots(vscodeAPI);
    const multiSourceInput = sourceAbsList.filter((s) => s.trim()).length > 1;
    const resolved = sourceAbsList
        .map((raw) => resolveSourcePath(raw, dirToFs, roots) ?? (pathExistsOrSymlink(toFs(raw.trim())) ? path.resolve(toFs(raw.trim())) : undefined))
        .filter((x): x is string => Boolean(x));

    if (resolved.length === 0) {
        vscodeAPI.window.showErrorMessage('No valid source paths to symlink.');
        return;
    }

    // Custom symlink name only when the user supplied exactly one path; multiple paths keep each source basename.
    const wantNamePrompt = !multiSourceInput && resolved.length === 1;

    let singleCustomName: string | undefined;
    if (wantNamePrompt) {
        const src = resolved[0];
        const defaultName = getBaseName(src);
        singleCustomName = await askSingleLinkName(vscodeAPI, dirToFs, defaultName);
        if (singleCustomName === undefined) { return; }
    }

    let ok = 0;
    let elevated = 0;
    let failed = 0;
    let singleLabel = '';
    let singleRel = '';

    for (const srcAbs of resolved) {
        const base =
            wantNamePrompt && singleCustomName !== undefined
                ? singleCustomName
                : getBaseName(srcAbs);
        const linkPathFs = linkPathForName(dirToFs, base, !wantNamePrompt);
        const relTarget = relativeSymlinkTarget(dirToFs, srcAbs);
        const linkType: fs.symlink.Type = fs.statSync(srcAbs).isDirectory() ? 'dir' : 'file';
        const r = tryCreateSymlinkWithRetry(vscodeAPI, dirToFs, linkPathFs, relTarget, linkType);
        if (r === 'ok' || r === 'elevated') {
            if (r === 'ok') { ok++; } else { elevated++; }
            if (resolved.length === 1) {
                singleLabel = path.basename(linkPathFs);
                singleRel = relTarget;
            }
        } else { failed++; }
    }

    if (resolved.length === 1 && ok === 1 && !failed && singleLabel) {
        vscodeAPI.window.showInformationMessage(`Symlink created: ${singleLabel} → ${singleRel}`);
    } else if (resolved.length !== 1 || failed || ok + elevated !== resolved.length) {
        const parts: string[] = [];
        if (ok) { parts.push(`${ok} created`); }
        if (elevated) { parts.push(`${elevated} elevated`); }
        if (failed) { parts.push(`${failed} failed`); }
        if (parts.length) {
            vscodeAPI.window.showInformationMessage(`Symlink batch: ${parts.join(', ')}.`);
        }
    }
}

async function doPasteAsSymlink(vscodeAPI: any, uri?: vscode.Uri) {
    const clipboardContent = await getClipboardContent();
    if (!clipboardContent?.trim()) {
        vscodeAPI.window.showErrorMessage(
            'No paths for symlink. Use “Link targets” on selected Explorer items, or Copy Path (multi-line / JSON).'
        );
        return;
    }

    let dirTo: string;
    if (uri) {
        const stat = await vscodeAPI.workspace.fs.stat(uri);
        dirTo = stat.type & vscodeAPI.FileType.Directory
            ? uri.fsPath
            : path.dirname(uri.fsPath);
    } else {
        const folders = vscodeAPI.workspace.workspaceFolders as vscode.WorkspaceFolder[] | undefined;
        dirTo = folders?.[0]?.uri?.fsPath ?? '';
    }

    if (!dirTo) {
        vscodeAPI.window.showErrorMessage('No target directory found.');
        return;
    }

    const dirToFs = path.resolve(dirTo);
    const rawList = parsePathList(clipboardContent);
    if (rawList.length === 0) {
        vscodeAPI.window.showErrorMessage('No paths parsed from clipboard.');
        return;
    }

    await createSymlinksFromSources(vscodeAPI, dirToFs, rawList);
}

function normalizeSymlinkTargetRebase(vscodeAPI: any, linkPath: string): void {
    let target: string;
    try {
        target = fs.readlinkSync(linkPath);
    } catch (e) {
        vscodeAPI.window.showErrorMessage(`abs2rel: cannot read symlink — ${e}`);
        return;
    }

    const normalized = normalizeSymlinkTarget(linkPath, target);
    const { resolvedTargetFs, relTarget } = normalized;

    if (!normalized.changed) {
        vscodeAPI.window.showInformationMessage('abs2rel: symlink target is already normalized (relative).');
        return;
    }

    const linkType: fs.symlink.Type = (() => {
        try {
            return fs.statSync(resolvedTargetFs).isDirectory() ? 'dir' : 'file';
        } catch {
            return 'file';
        }
    })();

    try {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(toFs(relTarget), linkPath, linkType);
        vscodeAPI.window.showInformationMessage(`abs2rel: ${toPosixSegments(target)}  →  ${relTarget}`);
        console.log(`[abs2rel] ${linkPath}: ${target} → ${relTarget}`);
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const fwd = (s: string) => s.replace(/\\/g, '/');
            const q = (s: string) => s.replace(/'/g, "''");
            const fl = fwd(linkPath);
            const fr = relTarget;
            runElevated(
                vscodeAPI,
                path.dirname(linkPath),
                `Remove-Item -Force '${q(fl)}'; New-Item -ItemType SymbolicLink -Path '${q(fl)}' -Target '${q(fr)}'`,
                `rm -f "${fl}" && ln -s "${fr}" "${fl}"`
            );
        } else {
            vscodeAPI.window.showErrorMessage(`abs2rel: failed to rewrite symlink — ${e}`);
        }
    }
}

function isExplorerUri(x: unknown): x is vscode.Uri {
    return Boolean(x && typeof (x as vscode.Uri).fsPath === 'string');
}

function dedupeExplorerUris(uris: vscode.Uri[]): vscode.Uri[] {
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const u of uris) {
        if (!isExplorerUri(u)) { continue; }
        const key = u.fsPath.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(u);
    }
    return out;
}

function explorerUriList(first?: vscode.Uri | vscode.Uri[]): vscode.Uri[] {
    if (!first) { return []; }
    if (Array.isArray(first)) { return first.filter(isExplorerUri); }
    return [first];
}

/**
 * Explorer context: VS Code passes the right-clicked resource first, then often a second argument
 * `Uri[]` with **all** selected items (see https://github.com/microsoft/vscode/issues/175103 ).
 * Without reading that array, only one path is received.
 */
function collectExplorerUris(first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]): vscode.Uri[] {
    for (const item of rest) {
        if (Array.isArray(item) && item.length > 0 && item.every(isExplorerUri)) {
            return dedupeExplorerUris(item as vscode.Uri[]);
        }
    }

    let list = explorerUriList(first);
    const more = rest.filter(isExplorerUri);
    if (list.length === 1 && more.length) {
        list = [list[0], ...more];
    }
    return dedupeExplorerUris(list);
}

async function symlinkPathsFromUris(vscodeAPI: any, uris: vscode.Uri[], uri?: vscode.Uri): Promise<void> {
    if (uris.length === 0) { return; }

    let dirToFs: string;
    if (uri) {
        const stat = await vscodeAPI.workspace.fs.stat(uri);
        dirToFs =
            stat.type & vscodeAPI.FileType.Directory ? path.resolve(uri.fsPath) : path.dirname(uri.fsPath);
    } else {
        dirToFs = path.dirname(uris[0].fsPath);
    }

    await createSymlinksFromSources(
        vscodeAPI,
        dirToFs,
        uris.map((u) => u.fsPath)
    );
}

async function pickSourcesFromExplorerSelection(vscodeAPI: any, uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
        vscodeAPI.window.showErrorMessage(
            'Link targets: select file(s) in Explorer, then run this from the context menu (needs multi-select).'
        );
        return;
    }

    const text = uris.map((u) => toPosixSegments(u.fsPath)).join('\n');
    await vscodeAPI.env.clipboard.writeText(text);
    vscodeAPI.window.showInformationMessage(
        `Copied ${uris.length} path(s). Use “Symlink here” on the destination.`
    );
}

export async function symlink(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;

    context.subscriptions.push(
        vscodeAPI.commands.registerCommand(
            'vext.symlink',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                const list = collectExplorerUris(first, ...rest);
                const primary = Array.isArray(first) ? undefined : first;

                if (list.length > 1) {
                    const stats = await Promise.all(
                        list.map(async (u) => {
                            try {
                                return { u, stat: await vscodeAPI.workspace.fs.stat(u) };
                            } catch {
                                return { u, stat: null as vscode.FileStat | null };
                            }
                        })
                    );
                    const isSymlink = (s: (typeof stats)[number]) =>
                        Boolean(s.stat && s.stat.type & vscodeAPI.FileType.SymbolicLink);
                    const linkCount = stats.filter(isSymlink).length;
                    if (linkCount === stats.length) {
                        for (const { u } of stats) {
                            normalizeSymlinkTargetRebase(vscodeAPI, u.fsPath);
                        }
                        return;
                    }
                    if (linkCount > 0) {
                        vscodeAPI.window.showErrorMessage(
                            'Symlink: multi-select mixes symlinks with other items. Select only symlinks (normalize targets) or only files/folders (create links).'
                        );
                        return;
                    }
                    await symlinkPathsFromUris(
                        vscodeAPI,
                        stats.map((s) => s.u),
                        primary
                    );
                    return;
                }

                const only = list[0];
                if (only) {
                    const stat = await vscodeAPI.workspace.fs.stat(only);
                    if (stat.type & vscodeAPI.FileType.SymbolicLink) {
                        normalizeSymlinkTargetRebase(vscodeAPI, only.fsPath);
                        return;
                    }
                }

                await doPasteAsSymlink(vscodeAPI, primary ?? only);
            }
        ),

        vscodeAPI.commands.registerCommand(
            'vext.symlink.pickSources',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                await pickSourcesFromExplorerSelection(vscodeAPI, collectExplorerUris(first, ...rest));
            }
        )
    );
}

export const __symlinkTest = {
    resolveSourcePath,
    relativeSymlinkTarget,
    normalizeSymlinkTarget,
    linkPathForName,
};

//
export function deactivate() {}
