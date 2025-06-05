// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

//
import { MathMLToLaTeX } from 'mathml-to-latex';
import { escapeML, replaceSelectionWith, getSelection, stripMathDelimiters } from '../lib/utils';
import * as vscode from 'vscode';
import temml from "temml";

//
export const convertToMathML = async (mathML: string): Promise<string> =>{
    const original = escapeML(mathML);
    if (!(mathML?.trim()?.startsWith?.("<") && mathML?.trim()?.endsWith?.(">"))) {
        try { mathML = escapeML(temml?.renderToString?.(stripMathDelimiters(mathML) || mathML, {
            throwOnError: true,
            strict: false,
            xml: true
        }) || "") || mathML; } catch (e) { mathML = ""; console.warn(e); }
        mathML ||= original;
    }
    return (mathML?.normalize?.()?.trim?.() || mathML?.trim?.() || mathML);
};

//
export const getAsMathML = async (): Promise<string> =>{
    return convertToMathML(await vscode.env.clipboard.readText()) || "";
};

//
export const convertToLaTeX = (LaTeX: string): string =>{
    const original = escapeML(LaTeX);
    try { LaTeX = MathMLToLaTeX.convert(LaTeX); } catch (e) { LaTeX = ""; console.warn(e); }
    LaTeX ||= original;
    return (LaTeX?.normalize?.()?.trim?.() || LaTeX?.trim?.() || LaTeX);
};

//
export const getAsLaTeX = async (): Promise<string> =>{
    return convertToLaTeX(await vscode.env.clipboard.readText()) || "";
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function mathml(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Math Utils in testing');

    //
    const convertAsTeX = vscode.commands.registerCommand('vext.mtl.convert', () => {
        let LaTeX = convertToLaTeX(getSelection());
        if (LaTeX) { replaceSelectionWith(`\$${LaTeX}\$`); }
    });

    //
    const pasteAsTeX = vscode.commands.registerCommand('vext.mtl.paste', async () => {
        const LaTeX = await getAsLaTeX();
        if (LaTeX) { replaceSelectionWith(`\$${LaTeX}\$`); }
    });

    //
    const convertAsMML = vscode.commands.registerCommand('vext.ltm.convert', async () => {
        let mathML = await convertToMathML(getSelection());
        if (mathML) { replaceSelectionWith(`${mathML}`); }
    });

    //
    const pasteAsMML = vscode.commands.registerCommand('vext.ltm.paste', async () => {
        const mathML = await getAsMathML();
        if (mathML) { replaceSelectionWith(`${mathML}`); }
    });

    const copyAsTeX = vscode.commands.registerCommand('vext.mtl.copy', () => {
        let LaTeX = convertToLaTeX(getSelection());
        if (LaTeX) {
            vscode.env.clipboard.writeText(`\$${LaTeX}\$`);
            vscode.window.showInformationMessage('Copied as LaTeX!');
        }
    });

    const copyAsMML = vscode.commands.registerCommand('vext.ltm.copy', async () => {
        let mathML = await convertToMathML(getSelection());
        if (mathML) {
            vscode.env.clipboard.writeText(mathML);
            vscode.window.showInformationMessage('Copied as MathML!');
        }
    });

    //
    context.subscriptions.push(convertAsTeX, pasteAsTeX, convertAsMML, pasteAsMML, copyAsTeX, copyAsMML);
}

// This method is called when your extension is deactivated
export function deactivate() {}
