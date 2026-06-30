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

//
// Known-links registry — persists link→target pairs created/normalized by this
// extension so "Rename and relink" can update out-of-workspace links too.
//
type KnownLinksMap = Record<string, string>;

interface KnownLinksRegistry {
    get(): KnownLinksMap;
    add(linkFs: string, targetFs: string): void;
    remove(linkFs: string): void;
    renameLink(oldLinkFs: string, newLinkFs: string): void;
    updateTarget(oldTargetFs: string, newTargetFs: string): string[];
}

function createKnownLinksRegistry(context: vscode.ExtensionContext): KnownLinksRegistry {
    const KEY = 'vext.symlink.knownLinks';
    let cache: KnownLinksMap | undefined;

    const load = (): KnownLinksMap => {
        if (!cache) {
            cache = (context.globalState.get(KEY) as KnownLinksMap | undefined) ?? {};
        }
        return cache;
    };
    const persist = (): void => {
        const snap = { ...load() };
        void context.globalState.update(KEY, snap);
    };

    return {
        get: load,
        add: (linkFs, targetFs) => {
            const m = load();
            m[path.resolve(linkFs)] = path.resolve(targetFs);
            persist();
        },
        remove: (linkFs) => {
            const m = load();
            delete m[path.resolve(linkFs)];
            persist();
        },
        renameLink: (oldLinkFs, newLinkFs) => {
            const m = load();
            const old = path.resolve(oldLinkFs);
            if (Object.prototype.hasOwnProperty.call(m, old)) {
                m[path.resolve(newLinkFs)] = m[old];
                delete m[old];
                persist();
            }
        },
        updateTarget: (oldTargetFs, newTargetFs) => {
            const m = load();
            const old = path.resolve(oldTargetFs).toLowerCase();
            const neu = path.resolve(newTargetFs);
            const changed: string[] = [];
            for (const [link, target] of Object.entries(m)) {
                if (path.resolve(target).toLowerCase() === old) {
                    m[link] = neu;
                    changed.push(link);
                }
            }
            if (changed.length) { persist(); }
            return changed;
        },
    };
}

let knownLinks: KnownLinksRegistry | undefined;

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

/**
 * Detects a "stub" file: a regular file whose entire content is a single path that resolves
 * to an existing directory. Such files appear when a symlink is committed/copied through a
 * system that doesn't preserve symlinks (the link target text becomes the file content).
 * Returns the raw target string from the file, or undefined when the file is not a stub.
 */
function readStubLinkTarget(filePath: string, maxSize = 4096): string | undefined {
    let lstat: fs.Stats;
    try {
        lstat = fs.lstatSync(filePath);
    } catch {
        return undefined;
    }
    if (!lstat.isFile() || lstat.size > maxSize) { return undefined; }

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }

    const lines = content.split(/\r?\n/);
    // tolerate a single trailing newline
    if (lines.length > 0 && lines[lines.length - 1] === '') { lines.pop(); }
    if (lines.length !== 1) { return undefined; }

    const raw = lines[0].trim();
    if (!raw) { return undefined; }

    const fileDirFs = path.dirname(filePath);
    const targetFs = path.isAbsolute(raw) ? path.resolve(toFs(raw)) : path.resolve(fileDirFs, toFs(raw));
    try {
        if (!fs.statSync(targetFs).isDirectory()) { return undefined; }
    } catch {
        return undefined;
    }
    return raw;
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
            knownLinks?.add(linkPathFs, srcAbs);
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
        vscodeAPI.window.showErrorMessage(`Normalize link: cannot read symlink — ${e}`);
        return;
    }

    const normalized = normalizeSymlinkTarget(linkPath, target);
    const { resolvedTargetFs, relTarget } = normalized;

    if (!normalized.changed) {
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
        knownLinks?.add(linkPath, resolvedTargetFs);
        vscodeAPI.window.showInformationMessage(`Normalize link: ${toPosixSegments(target)}  →  ${relTarget}`);
        console.log(`[normalize-link] ${linkPath}: ${target} → ${relTarget}`);
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
            vscodeAPI.window.showErrorMessage(`Normalize link: failed to rewrite symlink — ${e}`);
        }
    }
}

function restoreSymlinkFromStub(
    vscodeAPI: any,
    filePath: string
): 'restored' | 'elevated' | 'fail' | 'not-stub' {
    const rawTarget = readStubLinkTarget(filePath);
    if (rawTarget === undefined) { return 'not-stub'; }

    const { relTarget, resolvedTargetFs } = normalizeSymlinkTarget(filePath, rawTarget);
    // readStubLinkTarget already verified the target is an existing directory.
    const linkType: fs.symlink.Type = 'dir';

    try {
        fs.unlinkSync(filePath);
        fs.symlinkSync(toFs(relTarget), filePath, linkType);
        knownLinks?.add(filePath, resolvedTargetFs);
        vscodeAPI.window.showInformationMessage(
            `Normalize link: restored symlink from stub → ${relTarget}`
        );
        console.log(`[normalize-link:restore] ${filePath}: stub "${rawTarget}" → ${relTarget}`);
        return 'restored';
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const fwd = (s: string) => s.replace(/\\/g, '/');
            const q = (s: string) => s.replace(/'/g, "''");
            const fl = fwd(filePath);
            const fr = relTarget;
            runElevated(
                vscodeAPI,
                path.dirname(filePath),
                `Remove-Item -Force '${q(fl)}'; New-Item -ItemType SymbolicLink -Path '${q(fl)}' -Target '${q(fr)}'`,
                `rm -f "${fl}" && ln -s "${fr}" "${fl}"`
            );
            return 'elevated';
        }
        vscodeAPI.window.showErrorMessage(`Normalize link: failed to restore symlink from stub — ${e}`);
        return 'fail';
    }
}

//
// Rename and relink
//

/** Resolved target of a symlink (absolute), regardless of absolute/relative raw target. */
function resolveLinkTarget(linkFs: string): string | undefined {
    let raw: string;
    try {
        raw = fs.readlinkSync(linkFs);
    } catch {
        return undefined;
    }
    const t = toFs(raw);
    const dir = path.dirname(linkFs);
    return path.isAbsolute(t) ? path.resolve(t) : path.resolve(dir, t);
}

/** Depth-first walk yielding symlink paths only (does not recurse into symlinked dirs). */
function* walkSymlinks(rootFs: string): Generator<string> {
    const stack: string[] = [rootFs];
    while (stack.length) {
        const dir = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isSymbolicLink()) {
                yield full;
            } else if (e.isDirectory()) {
                stack.push(full);
            }
        }
    }
}

type InboundMatch = { linkFs: string; newTargetAbs: string };

/**
 * Finds symlinks whose resolved target is the renamed resource or lives inside it
 * (when renaming a directory). Searches workspace roots plus the known-links registry.
 */
function findInboundSymlinks(oldAbs: string, newAbs: string, roots: string[]): InboundMatch[] {
    const isDir = (() => {
        try {
            return fs.statSync(oldAbs).isDirectory();
        } catch {
            return false;
        }
    })();
    const lowerOld = oldAbs.toLowerCase();
    const sepLower = path.sep.toLowerCase();
    const lowerPrefix = lowerOld + sepLower;
    const out: InboundMatch[] = [];
    const seen = new Set<string>();

    const newTargetFor = (resolved: string): string => {
        if (resolved.toLowerCase() === lowerOld) {
            return newAbs;
        }
        // resolved is inside the renamed directory: swap the prefix.
        return newAbs + resolved.slice(oldAbs.length);
    };
    const consider = (linkFs: string): void => {
        const key = linkFs.toLowerCase();
        if (seen.has(key)) { return; }
        const resolved = resolveLinkTarget(linkFs);
        if (resolved === undefined) { return; }
        const lr = resolved.toLowerCase();
        const matches =
            lr === lowerOld ||
            (isDir && (lr + sepLower).startsWith(lowerPrefix));
        if (!matches) { return; }
        seen.add(key);
        out.push({ linkFs, newTargetAbs: newTargetFor(resolved) });
    };

    for (const root of roots) {
        for (const link of walkSymlinks(root)) {
            consider(link);
        }
    }
    if (knownLinks) {
        for (const linkFs of Object.keys(knownLinks.get())) {
            consider(linkFs);
        }
    }
    return out;
}

function rewriteSymlinkTarget(
    vscodeAPI: any,
    linkFs: string,
    newTargetAbs: string
): 'ok' | 'elevated' | 'skip' | 'fail' {
    const rel = relativeSymlinkTarget(path.dirname(linkFs), newTargetAbs);
    let linkType: fs.symlink.Type;
    try {
        linkType = fs.statSync(newTargetAbs).isDirectory() ? 'dir' : 'file';
    } catch {
        linkType = 'file';
    }
    try {
        fs.unlinkSync(linkFs);
        fs.symlinkSync(toFs(rel), linkFs, linkType);
        knownLinks?.add(linkFs, newTargetAbs);
        return 'ok';
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const fwd = (s: string) => s.replace(/\\/g, '/');
            const q = (s: string) => s.replace(/'/g, "''");
            const fl = fwd(linkFs);
            const fr = rel;
            runElevated(
                vscodeAPI,
                path.dirname(linkFs),
                `Remove-Item -Force '${q(fl)}'; New-Item -ItemType SymbolicLink -Path '${q(fl)}' -Target '${q(fr)}'`,
                `rm -f "${fl}" && ln -s "${fr}" "${fl}"`
            );
            return 'elevated';
        }
        if (e?.code === 'ENOENT') {
            // The link (or its parent directory) is already gone — nothing to relink.
            // Drop the stale registry entry and continue with the remaining links.
            knownLinks?.remove(linkFs);
            console.log(`[relink:skip] ${linkFs}: no such file or directory`);
            return 'skip';
        }
        vscodeAPI.window.showErrorMessage(`Relink: failed to rewrite symlink ${linkFs} — ${e}`);
        return 'fail';
    }
}

async function renameAndRelink(vscodeAPI: any, uri?: vscode.Uri): Promise<void> {
    if (!uri || !uri.fsPath) {
        vscodeAPI.window.showErrorMessage(
            'Rename and relink: invoke from the Explorer context menu on a file or directory.'
        );
        return;
    }

    const oldFs = path.resolve(uri.fsPath);
    const oldBase = path.basename(oldFs);
    const oldDir = path.dirname(oldFs);

    if (!pathExistsOrSymlink(oldFs)) {
        vscodeAPI.window.showErrorMessage(`Rename and relink: "${oldBase}" does not exist.`);
        return;
    }

    const newName = await vscodeAPI.window.showInputBox({
        prompt: 'New name. Inbound symlinks in the workspace (and known links) will be relinked.',
        value: oldBase,
        validateInput: (v: string) => {
            const t = v.trim();
            if (!t) { return 'Name cannot be empty.'; }
            if (/[\\/]/.test(t)) { return 'Name must not contain path separators.'; }
            if (t === oldBase) { return 'Enter a new name.'; }
            return null;
        },
    });
    if (newName === undefined) { return; }
    const trimmed = newName.trim();
    const newFs = path.join(oldDir, trimmed);

    if (pathExistsOrSymlink(newFs)) {
        const overwrite = await vscodeAPI.window.showWarningMessage(
            `"${trimmed}" already exists. Overwrite it?`,
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') { return; }
    }

    const roots = workspaceRoots(vscodeAPI);
    const inbound = findInboundSymlinks(oldFs, newFs, roots);

    try {
        if (pathExistsOrSymlink(newFs)) {
            fs.rmSync(newFs, { recursive: true, force: true });
        }
        fs.renameSync(oldFs, newFs);
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const fwd = (s: string) => s.replace(/\\/g, '/');
            const q = (s: string) => s.replace(/'/g, "''");
            const fo = fwd(oldFs);
            const fn = fwd(newFs);
            runElevated(
                vscodeAPI,
                oldDir,
                `Rename-Item -Force '${q(fo)}' '${q(fn)}'`,
                `mv -f "${fo}" "${fn}"`
            );
        } else {
            vscodeAPI.window.showErrorMessage(`Rename and relink: failed to rename — ${e}`);
            return;
        }
    }

    let ok = 0;
    let elevated = 0;
    let skipped = 0;
    let failed = 0;
    for (const { linkFs, newTargetAbs } of inbound) {
        const r = rewriteSymlinkTarget(vscodeAPI, linkFs, newTargetAbs);
        if (r === 'ok') { ok++; }
        else if (r === 'elevated') { elevated++; }
        else if (r === 'skip') { skipped++; }
        else { failed++; }
    }

    // Keep the registry in sync: the resource may itself be a known link, and any
    // registered link that targeted the old path now targets the new path.
    knownLinks?.renameLink(oldFs, newFs);
    knownLinks?.updateTarget(oldFs, newFs);

    const actionable = inbound.length - skipped;
    const relinkSummary = inbound.length
        ? `; relinked ${ok + elevated}/${actionable} link(s)${elevated ? ` (${elevated} elevated)` : ''}${skipped ? `, ${skipped} gone` : ''}${failed ? `, ${failed} failed` : ''}`
        : '; no inbound symlinks found';
    vscodeAPI.window.showInformationMessage(
        `Renamed "${oldBase}" → "${trimmed}"${relinkSummary}.`
    );
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

async function normalizeSymlinksFromExplorer(vscodeAPI: any, uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
        vscodeAPI.window.showErrorMessage('Normalize link: select symbolic link(s) in Explorer.');
        return;
    }

    const symlinkPaths: string[] = [];
    const candidateStubPaths: string[] = [];
    for (const u of uris) {
        try {
            const stat = await vscodeAPI.workspace.fs.stat(u);
            if (stat.type & vscodeAPI.FileType.SymbolicLink) {
                symlinkPaths.push(u.fsPath);
            } else if (stat.type & vscodeAPI.FileType.File) {
                candidateStubPaths.push(u.fsPath);
            }
        } catch {
            /* skip */
        }
    }

    let stubsRestored = 0;
    let stubsElevated = 0;
    let stubsFailed = 0;
    let stubsNotCandidate = 0;
    for (const stubPath of candidateStubPaths) {
        const r = restoreSymlinkFromStub(vscodeAPI, stubPath);
        switch (r) {
            case 'restored': stubsRestored++; break;
            case 'elevated': stubsElevated++; break;
            case 'fail': stubsFailed++; break;
            default: stubsNotCandidate++; break;
        }
    }

    for (const linkPath of symlinkPaths) {
        normalizeSymlinkTargetRebase(vscodeAPI, linkPath);
    }

    if (
        symlinkPaths.length === 0 &&
        stubsRestored === 0 &&
        stubsElevated === 0 &&
        candidateStubPaths.length === stubsNotCandidate + stubsFailed
    ) {
        vscodeAPI.window.showErrorMessage(
            'Normalize link: no symbolic links (or stub files) in selection.'
        );
    }
}

export async function symlink(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;
    knownLinks = createKnownLinksRegistry(context);

    context.subscriptions.push(
        vscodeAPI.commands.registerCommand(
            'vext.symlink',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                const list = collectExplorerUris(first, ...rest);
                const primary = Array.isArray(first) ? undefined : first;

                if (list.length > 1) {
                    await symlinkPathsFromUris(vscodeAPI, list, primary);
                    return;
                }

                await doPasteAsSymlink(vscodeAPI, primary ?? list[0]);
            }
        ),

        vscodeAPI.commands.registerCommand(
            'vext.symlink.abs2rel',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                await normalizeSymlinksFromExplorer(vscodeAPI, collectExplorerUris(first, ...rest));
            }
        ),

        vscodeAPI.commands.registerCommand(
            'vext.symlink.pickSources',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                await pickSourcesFromExplorerSelection(vscodeAPI, collectExplorerUris(first, ...rest));
            }
        ),

        vscodeAPI.commands.registerCommand(
            'vext.symlink.renameRelink',
            async (first?: vscode.Uri | vscode.Uri[], ...rest: unknown[]) => {
                const list = collectExplorerUris(first, ...rest);
                const primary = Array.isArray(first) ? undefined : first;
                const target = primary ?? list[0];
                if (!target) {
                    vscodeAPI.window.showErrorMessage(
                        'Rename and relink: select a file or directory in Explorer.'
                    );
                    return;
                }
                await renameAndRelink(vscodeAPI, target);
            }
        )
    );
}

export const __symlinkTest = {
    resolveSourcePath,
    relativeSymlinkTarget,
    normalizeSymlinkTarget,
    linkPathForName,
    readStubLinkTarget,
    resolveLinkTarget,
    newTargetFor: (oldAbs: string, newAbs: string, resolved: string) => {
        const lowerOld = oldAbs.toLowerCase();
        if (resolved.toLowerCase() === lowerOld) { return newAbs; }
        return newAbs + resolved.slice(oldAbs.length);
    },
};

//
export function deactivate() {}
