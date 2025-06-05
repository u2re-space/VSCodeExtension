// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

//
import * as vscode from 'vscode';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { escapeML, replaceSelectionWith, getSelection } from '../lib/utils';

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
    return convertToHtml(await vscode.env.clipboard.readText()) || "";
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
    return convertToMarkdown(await vscode.env.clipboard.readText()) || "";
};

//
export function markdown(context: vscode.ExtensionContext) {
    console.log('HTML/Markdown Utils in testing');

    const convertAsMarkdown = vscode.commands.registerCommand('vext.htd.convert', () => {
        let md = convertToMarkdown(getSelection());
        if (md) { replaceSelectionWith(md); }
    });

    const pasteAsMarkdown = vscode.commands.registerCommand('vext.htd.paste', async () => {
        const md = await getAsMarkdown();
        if (md) { replaceSelectionWith(md); }
    });

    const copyAsMarkdown = vscode.commands.registerCommand('vext.htd.copy', () => {
        let md = convertToMarkdown(getSelection());
        if (md) {
            vscode.env.clipboard.writeText(md);
            vscode.window.showInformationMessage('Copied as Markdown!');
        }
    });

    const copyAsHtml = vscode.commands.registerCommand('vext.dth.copy', async () => {
        let html = await convertToHtml(getSelection());
        if (html) {
            vscode.env.clipboard.writeText(html);
            vscode.window.showInformationMessage('Copied as HTML!');
        }
    });

    const convertAsHtml = vscode.commands.registerCommand('vext.dth.convert', async () => {
        let html = await convertToHtml(getSelection());
        if (html) { replaceSelectionWith(html); }
    });

    const pasteAsHtml = vscode.commands.registerCommand('vext.dth.paste', async () => {
        const html = await getAsHtml();
        if (html) { replaceSelectionWith(html); }
    });

    context.subscriptions.push(convertAsMarkdown, pasteAsMarkdown, convertAsHtml, pasteAsHtml, copyAsMarkdown, copyAsHtml);
}

// This method is called when your extension is deactivated
export function deactivate() {}
