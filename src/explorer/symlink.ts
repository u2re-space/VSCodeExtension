//! use only TS types
import type * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

//
import vscodePromise from '../imports/api.ts';

//
async function getClipboardContent(): Promise<string | undefined> {
    const vscodeAPI = await vscodePromise;

    //
    try {
        const clipboardContent = await vscodeAPI.env.clipboard.readText();
        console.log('Clipboard content:', clipboardContent);
        vscodeAPI.window.showInformationMessage(`Clipboard: ${clipboardContent}`);
        return clipboardContent;
    } catch (error) {
        console.error('Error reading clipboard:', error);
        vscodeAPI.window.showErrorMessage('Failed to read clipboard content.');
    }
}

//
function getBaseName(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').pop() || '';
}

// Runs an elevated terminal command: UAC via Start-Process on Windows, sudo on Linux/remote.
// psCmd  — raw PowerShell expression (single-quote paths inside, no outer quoting needed)
// shCmd  — raw shell expression passed verbatim to `sudo sh -c`
function runElevated(vscodeAPI: any, cwd: string, psCmd: string, shCmd: string) {
    let command: string;
    if (process.platform === 'win32' && !vscodeAPI.env.remoteName) {
        // base64-encode the PS command to sidestep all quoting/escaping issues
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

//
async function doPasteAsSymlink(vscodeAPI: any, uri?: vscode.Uri) {
    const clipboardContent = await getClipboardContent();
    if (!clipboardContent) {
        vscodeAPI.window.showErrorMessage('No path copied for symlink.'); return;
    }

    let dirTo: string;
    if (uri) {
        const stat = await vscodeAPI.workspace.fs.stat(uri);
        dirTo = (stat.type & vscodeAPI.FileType.Directory)
            ? uri.fsPath.replace(/\\/g, '/')
            : path.dirname(uri.fsPath.replace(/\\/g, '/'));
    } else {
        const folders = vscodeAPI.workspace.workspaceFolders as vscode.WorkspaceFolder[] | undefined;
        dirTo = (folders?.[0]?.uri?.fsPath ?? '').replace(/\\/g, '/');
    }

    if (!dirTo) { vscodeAPI.window.showErrorMessage('No target directory found.'); return; }

    const copiedPath = clipboardContent.trim().replace(/\\/g, '/');

    if (!path.isAbsolute(copiedPath) && !path.isAbsolute(clipboardContent.trim())) {
        vscodeAPI.window.showErrorMessage(`Symlink source is not an absolute path: "${copiedPath}"`); return;
    }
    if (!fs.existsSync(copiedPath.replace(/\//g, path.sep))) {
        vscodeAPI.window.showErrorMessage(`Symlink source does not exist: "${copiedPath}"`); return;
    }

    const defaultName = getBaseName(copiedPath);
    const input = await vscodeAPI.window.showInputBox({
        prompt: 'Enter symlink name (leave empty to use original name)',
        value: defaultName
    });
    if (input === undefined) { return; }

    const linkName  = input.trim() || defaultName;
    const linkPath  = path.join(dirTo, linkName).replace(/\\/g, '/');
    const relTarget = path.relative(dirTo, copiedPath).replace(/\\/g, '/') || copiedPath;
    const linkType  = fs.statSync(copiedPath.replace(/\//g, path.sep)).isDirectory() ? 'dir' : 'file';

    try {
        fs.symlinkSync(relTarget.replace(/\//g, path.sep), linkPath.replace(/\//g, path.sep), linkType);
        vscodeAPI.window.showInformationMessage(`Symlink created: ${linkName} → ${relTarget}`);
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const q = (s: string) => s.replace(/'/g, "''");
            runElevated(
                vscodeAPI, dirTo,
                `New-Item -ItemType SymbolicLink -Path '${q(linkPath)}' -Target '${q(relTarget)}'`,
                `ln -s "${relTarget}" "${linkPath}"`
            );
        } else {
            vscodeAPI.window.showErrorMessage(`Failed to create symlink: ${e}`);
        }
    }
}

//
function doAbsToRel(vscodeAPI: any, linkPath: string) {
    let target: string;
    try {
        target = fs.readlinkSync(linkPath);
    } catch (e) {
        vscodeAPI.window.showErrorMessage(`abs2rel: cannot read symlink — ${e}`); return;
    }

    if (!path.isAbsolute(target)) {
        vscodeAPI.window.showInformationMessage('abs2rel: symlink target is already relative.'); return;
    }

    const relTarget = path.relative(path.dirname(linkPath), target);
    if (!relTarget) {
        vscodeAPI.window.showErrorMessage('abs2rel: could not compute relative path.'); return;
    }

    const linkType = (() => { try { return fs.statSync(target).isDirectory() ? 'dir' : 'file'; } catch { return 'file'; } })();

    try {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(relTarget, linkPath, linkType);
        vscodeAPI.window.showInformationMessage(`abs2rel: ${target}  →  ${relTarget}`);
        console.log(`[abs2rel] ${linkPath}: ${target} → ${relTarget}`);
    } catch (e: any) {
        if (e?.code === 'EPERM' || e?.code === 'EACCES') {
            const fwd = (s: string) => s.replace(/\\/g, '/');
            const q   = (s: string) => s.replace(/'/g, "''");
            const fl  = fwd(linkPath), fr = fwd(relTarget);
            runElevated(
                vscodeAPI, path.dirname(linkPath),
                `Remove-Item -Force '${q(fl)}'; New-Item -ItemType SymbolicLink -Path '${q(fl)}' -Target '${q(fr)}'`,
                `rm -f "${fl}" && ln -s "${fr}" "${fl}"`
            );
        } else {
            vscodeAPI.window.showErrorMessage(`abs2rel: failed to rewrite symlink — ${e}`);
        }
    }
}

//
export async function symlink(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;

    context.subscriptions.push(
        vscodeAPI.commands.registerCommand('vext.symlink', async (uri?: vscode.Uri) => {
            if (uri) {
                const stat = await vscodeAPI.workspace.fs.stat(uri);
                if (stat.type & vscodeAPI.FileType.SymbolicLink) {
                    doAbsToRel(vscodeAPI, uri.fsPath);
                    return;
                }
            }
            await doPasteAsSymlink(vscodeAPI, uri);
        })
    );
}

//
export function deactivate() {}
