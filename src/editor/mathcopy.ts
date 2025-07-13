//! use only TS types
import * as vscode from "vscode";

//
import { replaceSelectionWith, getSelection } from '../imports/utils.ts';
import vscodePromise from '../imports/api.ts';

//
import temml from "temml";
import { MathMLToLaTeX } from 'mathml-to-latex';
import { escapeML, stripMathDelimiters } from "../imports/str.ts";

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
    const vscodeAPI = await vscodePromise;
    return convertToMathML(await vscodeAPI?.env?.clipboard?.readText?.() || "") || "";
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
    const vscodeAPI = await vscodePromise;
    return convertToLaTeX(await vscodeAPI?.env?.clipboard?.readText?.() || "") || "";
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function mathml(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Math Utils in testing');

    //
    const convertAsTeX = vscodeAPI?.commands?.registerCommand?.('vext.mtl.convert', async () => {
        let LaTeX = convertToLaTeX(await getSelection());
        if (LaTeX) { await replaceSelectionWith(`\$${LaTeX}\$`); }
    });

    //
    const pasteAsTeX = vscodeAPI?.commands?.registerCommand?.('vext.mtl.paste', async () => {
        const LaTeX = await getAsLaTeX();
        if (LaTeX) { await replaceSelectionWith(`\$${LaTeX}\$`); }
    });

    //
    const convertAsMML = vscodeAPI?.commands?.registerCommand?.('vext.ltm.convert', async () => {
        let mathML = await convertToMathML(await getSelection());
        if (mathML) { await replaceSelectionWith(`${mathML}`); }
    });

    //
    const pasteAsMML = vscodeAPI?.commands?.registerCommand?.('vext.ltm.paste', async () => {
        const mathML = await getAsMathML();
        if (mathML) { await replaceSelectionWith(`${mathML}`); }
    });

    //
    const copyAsTeX = vscodeAPI?.commands?.registerCommand?.('vext.mtl.copy', async () => {
        let LaTeX = convertToLaTeX(await getSelection());
        if (LaTeX) {
            vscodeAPI?.env?.clipboard?.writeText?.(`\$${LaTeX}\$`);
            vscodeAPI?.window?.showInformationMessage?.('Copied as LaTeX!');
        }
    });

    //
    const copyAsMML = vscodeAPI?.commands?.registerCommand?.('vext.ltm.copy', async () => {
        let mathML = await convertToMathML(await getSelection());
        if (mathML) {
            vscodeAPI?.env?.clipboard?.writeText?.(mathML);
            vscodeAPI?.window?.showInformationMessage?.('Copied as MathML!');
        }
    });

    //
    context.subscriptions.push(...[convertAsTeX, pasteAsTeX, convertAsMML, pasteAsMML, copyAsTeX, copyAsMML]?.filter?.((v: any)=>v) as any);
}

// This method is called when your extension is deactivated
export function deactivate() {}
