//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
const makeDebouncer = (delay: number = 1000)=>{
    let timer: NodeJS.Timeout | undefined;
    return (fn: ()=>void)=>{
        if (timer) { clearTimeout(timer); timer = undefined; }
        timer = setTimeout(fn, delay);
    };
};

//
const cmdDBN = makeDebouncer();
const ctxDBN = makeDebouncer();

//
const redDBN = makeDebouncer(100);
const undDBN = makeDebouncer(100);

// temporary...
const changeFlags = {
    redo: false,
    undo: false
};

//
async function updateLineContext() {
    const vscode = await vscodePromise;
    const editor = vscode.window.activeTextEditor;

    //
    if (!editor) {
        vscode?.commands?.executeCommand?.('setContext', 'lineIsEmpty', false);
        vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineStart', false);
        vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineEnd', false);
        vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineStartAndEnd', false);
        return;
    }

    //
    const pos = editor.selection.active;
    const line = editor.document.lineAt(pos?.line);

    //
    const isEmpty = line?.text?.length === 0;
    const atStart = pos?.character === 0;
    const atEnd = pos?.character === line?.text?.length;
    const atStartAndEnd = atStart && atEnd; // строка пуста и курсор в начале

    //
    vscode?.commands?.executeCommand?.('setContext', 'lineIsEmpty', isEmpty);
    vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineStart', atStart);
    vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineEnd', atEnd);
    vscode?.commands?.executeCommand?.('setContext', 'cursorAtLineStartAndEnd', atStartAndEnd);
}

//
async function proxyUndo() {
    const vscode = await vscodePromise;
    const unflag = () => { // run cursor command!
        changeFlags.undo = false;
        clearTimeout(timer);
    };
    await vscode?.commands?.executeCommand?.('undo')?.catch?.(unflag);
    const timer = setTimeout(()=>{
        if (!changeFlags.undo) { unflag?.(); }
        changeFlags.undo = false;
    }, 10);
}

//
async function proxyRedo() {
    const vscode = await vscodePromise;
    const unflag = () => { // run cursor command!
        changeFlags.redo = false; clearTimeout(timer);
        return vscode?.commands?.executeCommand?.("editor.action.acceptCursorTabSuggestion");
    };
    await vscode?.commands?.executeCommand?.('redo')?.catch?.(unflag);
    const timer = setTimeout(()=>{
        if (!changeFlags.redo) { unflag?.(); }
        changeFlags.redo = false;
    }, 10);
}

//
export async function contexts(context: vscode.ExtensionContext) {
    const vscode = await vscodePromise;
    vscode?.commands?.executeCommand?.('setContext', 'canRedo', false);
    vscode?.commands?.executeCommand?.('setContext', 'canUndo', false);

    //
    changeFlags.redo = false;
    changeFlags.undo = false;

    //
    context?.subscriptions?.push?.(
        vscode?.workspace?.onDidChangeTextDocument?.((ev)=>{
            if (ev?.reason == 2) { changeFlags.redo = true; redDBN(()=>(changeFlags.redo = false)); };
            if (ev?.reason == 1) { changeFlags.undo = true; undDBN(()=>(changeFlags.undo = false));  };
        })
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
        vscode?.commands?.registerCommand?.('vext.proxyRedo', proxyRedo)
    );

    //
    updateLineContext();
}

//
export function deactivate() {}
