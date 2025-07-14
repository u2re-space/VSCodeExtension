//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
async function updateLineContext() {
    const vscode = await vscodePromise;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.commands.executeCommand('setContext', 'lineIsEmpty', false);
        vscode.commands.executeCommand('setContext', 'cursorAtLineStart', false);
        vscode.commands.executeCommand('setContext', 'cursorAtLineEnd', false);
        vscode.commands.executeCommand('setContext', 'cursorAtLineStartAndEnd', false);
        return;
    }

    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos.line);

    const isEmpty = line.text.length === 0;
    const atStart = pos.character === 0;
    const atEnd = pos.character === line.text.length;
    const atStartAndEnd = atStart && atEnd; // строка пуста и курсор в начале

    vscode.commands.executeCommand('setContext', 'lineIsEmpty', isEmpty);
    vscode.commands.executeCommand('setContext', 'cursorAtLineStart', atStart);
    vscode.commands.executeCommand('setContext', 'cursorAtLineEnd', atEnd);
    vscode.commands.executeCommand('setContext', 'cursorAtLineStartAndEnd', atStartAndEnd);
}

// @ts-ignore
let debounceTimer: NodeJS.Timeout | undefined;


//
async function proxyUndo() {
    const vscode = await vscodePromise;
    await vscode?.commands?.executeCommand?.('undo').then(
        () => {
            vscode?.commands?.executeCommand?.('setContext', 'canUndo', !!vscode?.window?.activeTextEditor);
            vscode?.commands?.executeCommand?.('redo');
        },
        () => {
            vscode?.commands?.executeCommand?.('setContext', 'canUndo', false);
        }
    );
}

//
async function proxyRedo() {
    const vscode = await vscodePromise;
    await vscode?.commands?.executeCommand?.('redo').then(
        () => {
            vscode?.commands?.executeCommand?.('setContext', 'canRedo', !!vscode?.window?.activeTextEditor);
            vscode.commands?.executeCommand?.('undo');
        },
        () => {
            vscode?.commands?.executeCommand?.('setContext', 'canRedo', false);
        }
    );
}


//
function checkUndoRedo(vscode) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.commands.executeCommand('setContext', 'canUndo', false);
        vscode.commands.executeCommand('setContext', 'canRedo', false);
        return;
    }

    //
    proxyUndo();
    proxyRedo();
}


//
async function updateUndoRedoContext() {
    const vscode = await vscodePromise;

    //
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = undefined; }
    debounceTimer = setTimeout(() => checkUndoRedo(vscode), 1000);
}


//
export async function contexts(context: vscode.ExtensionContext) {
    const vscode = await vscodePromise;
    vscode?.commands?.executeCommand?.('setContext', 'canUndo', false);
    vscode?.commands?.executeCommand?.('setContext', 'canRedo', false);

    //
    context?.subscriptions?.push?.(
        vscode?.window?.onDidChangeTextEditorSelection?.(updateUndoRedoContext),
        vscode?.window?.onDidChangeActiveTextEditor?.(updateUndoRedoContext),
        vscode?.workspace?.onDidChangeTextDocument?.(updateUndoRedoContext)
    );

    //
    context?.subscriptions?.push?.(
        vscode?.window?.onDidChangeTextEditorSelection?.(updateLineContext),
        vscode?.window?.onDidChangeActiveTextEditor?.(updateLineContext),
        vscode?.workspace?.onDidChangeTextDocument?.(updateLineContext)
    );

    //
    context?.subscriptions?.push?.(
        vscode?.commands?.registerCommand?.('vext.proxyUndo', proxyUndo),
        vscode?.commands?.registerCommand?.('vext.proxyRedo', proxyRedo),
        vscode?.workspace?.onDidChangeTextDocument?.(updateUndoRedoContext),
        vscode?.window?.onDidChangeActiveTextEditor?.(updateUndoRedoContext)
    );

    //
    checkUndoRedo(vscode);
    updateUndoRedoContext();
    updateLineContext();
}

//
export function deactivate() {}
