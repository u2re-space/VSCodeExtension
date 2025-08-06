//! use only TS types
import * as vscode from "vscode";
import * as path from "path";

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
async function getDirectoryFromUri(uri: vscode.Uri): Promise<string> {
    const vscodeAPI = await vscodePromise;
    const stat = await vscodeAPI.workspace.fs.stat(uri);

    //
    if (stat.type & vscodeAPI.FileType.Directory) {
        return uri.fsPath.replace(/\\/g, '/');
    } else {
        return path.dirname(uri.fsPath.replace(/\\/g, '/'));
    }
}

//
function getBaseName(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').pop() || '';
}

//
let copiedPath: string | undefined;
export async function symlink(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;

    //
    context.subscriptions.push(
        vscodeAPI.commands.registerCommand('vext.pasteAsSymlink', async (uri: vscode.Uri) => {
            const clipboardContent = await getClipboardContent();
            if (!clipboardContent) {
                vscodeAPI.window.showErrorMessage('No path copied for symlink.'); return;
            } else {
                copiedPath = clipboardContent;
            }

            //
            copiedPath = copiedPath?.replace?.(/\\/g, '/');
            const dirTo = await getDirectoryFromUri(uri);
            const defaultName = getBaseName(copiedPath);
            const linkName = (await vscodeAPI.window.showInputBox({
                prompt: 'Enter symlink name (leave empty to use original name)',
                value: defaultName
            })) || defaultName;

            //
            const finalLinkName = linkName.trim() === '' ? defaultName : linkName.trim();
            const linkPath = path.join(dirTo, finalLinkName)?.replace?.(/\\/g, '/');

            //
            let command = '';
            if (process.platform === 'win32' && !vscodeAPI.env.remoteName) {
                command = `New-Item -ItemType SymbolicLink -Path "${linkPath}" -Target "${copiedPath}"`;
            } else {
                command = `ln -s "${copiedPath}" "${linkPath}"`;
            }

            //
            const terminal = vscodeAPI.window.createTerminal({ cwd: dirTo, name: 'Symlink Creator' }); terminal.show(); terminal.sendText(command);
            vscodeAPI.window.showInformationMessage('Symlink command sent to terminal. Press Enter in terminal if needed.');
        })
    );
}

//
export function deactivate() {}
