//! use only TS types
import * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
import TurndownService from 'turndown';
import { marked } from 'marked';
import { replaceSelectionWith, getSelection } from '../imports/utils.ts';
import { escapeML } from "../imports/str.ts";

//
const turndownService = new TurndownService();

//
export const convertToHtml = async (input: string): Promise<string> => {
    const original = escapeML(input);
    // Если уже HTML, не конвертируем
    if (input?.trim()?.startsWith?.("<") && input?.trim()?.endsWith?.(">")) {
        return input;
    }
    try {
        // marked синхронный, но оставим async для совместимости
        input = escapeML(await marked.parse(input) || "") || input;
    } catch (e) {
        input = "";
        console.warn(e);
    }
    input ||= original;
    return (input?.normalize?.()?.trim?.() || input?.trim?.() || input);
};

//
export const getAsHtml = async (): Promise<string> => {
    const vscodeAPI = await vscodePromise;
    return convertToHtml(await vscodeAPI?.env?.clipboard?.readText?.() || "") || "";
};

//
export const convertToMarkdown = (input: string): string => {
    const original = escapeML(input);
    try {
        input = turndownService.turndown(input);
    } catch (e) {
        input = "";
        console.warn(e);
    }
    input ||= original;
    return (input?.normalize?.()?.trim?.() || input?.trim?.() || input);
};

//
export const getAsMarkdown = async (): Promise<string> => {
    const vscodeAPI = await vscodePromise;
    return convertToMarkdown(await vscodeAPI?.env?.clipboard?.readText?.() || "") || "";
};

//
export async function markdown(context: vscode.ExtensionContext) {
    const vscodeAPI = await vscodePromise;
    console.log('HTML/Markdown Utils in testing');

    const convertAsMarkdown = vscodeAPI?.commands?.registerCommand?.('vext.htd.convert', async () => {
        let md = convertToMarkdown(await getSelection());
        if (md) { await replaceSelectionWith(md); }
    });

    const pasteAsMarkdown = vscodeAPI?.commands?.registerCommand?.('vext.htd.paste', async () => {
        const md = await getAsMarkdown();
        if (md) { await replaceSelectionWith(md); }
    });

    const copyAsMarkdown = vscodeAPI?.commands?.registerCommand?.('vext.htd.copy', async () => {
        let md = convertToMarkdown(await getSelection());
        if (md) {
            vscodeAPI?.env?.clipboard?.writeText?.(md);
            vscodeAPI?.window?.showInformationMessage?.('Copied as Markdown!');
        }
    });

    const copyAsHtml = vscodeAPI?.commands?.registerCommand?.('vext.dth.copy', async () => {
        let html = await convertToHtml(await getSelection());
        if (html) {
            vscodeAPI?.env?.clipboard?.writeText?.(html);
            vscodeAPI?.window?.showInformationMessage?.('Copied as HTML!');
        }
    });

    const convertAsHtml = vscodeAPI?.commands?.registerCommand?.('vext.dth.convert', async () => {
        let html = await convertToHtml(await getSelection());
        if (html) { await replaceSelectionWith(html); }
    });

    const pasteAsHtml = vscodeAPI?.commands?.registerCommand?.('vext.dth.paste', async () => {
        const html = await getAsHtml();
        if (html) { await replaceSelectionWith(html); }
    });

    context.subscriptions.push(...[convertAsMarkdown, pasteAsMarkdown, convertAsHtml, pasteAsHtml, copyAsMarkdown, copyAsHtml]?.filter?.((v: any)=>v) as any);
}

// This method is called when your extension is deactivated
export function deactivate() {}
