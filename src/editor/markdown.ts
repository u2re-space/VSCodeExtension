//! use only TS types
import type * as vscode from "vscode";

//
import vscodePromise from '../imports/api.ts';

//
import TurndownService from 'turndown';
import { marked, MarkedExtension } from 'marked';
import renderMathInElement from "katex/dist/contrib/auto-render.mjs";
import { replaceSelectionWith, getSelection } from '../imports/utils.ts';
import { escapeML } from "../imports/str.ts";
import markedKatex from "marked-katex-extension";

//
const turndownService = new TurndownService();

//
const MATH_DELIMITER_PATTERN = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|(?<!\$)\$[^$\n]+\$|\\\([\s\S]*?\\\)/;
const FENCED_CODE_PATTERN = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;
const SANITIZE_OPTIONS = {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "applet", "link", "meta", "base", "form", "noscript", "template"],
    FORBID_CONTENTS: ["script", "style", "iframe", "object", "embed", "applet", "noscript", "template"]
};

//
function maskCodeSegments(markdown: string): { masked: string; restore: (value: string) => string } {
    const maskedValues: string[] = [];
    const tokenPrefix = "__MD_MASK_";
    const tokenSuffix = "__";

    const mask = (value: string): string => value.replace(FENCED_CODE_PATTERN, (segment) => {
        const token = `${tokenPrefix}${maskedValues.length}${tokenSuffix}`;
        maskedValues.push(segment);
        return token;
    });

    const maskInline = (value: string): string => value.replace(INLINE_CODE_PATTERN, (segment) => {
        const token = `${tokenPrefix}${maskedValues.length}${tokenSuffix}`;
        maskedValues.push(segment);
        return token;
    });

    const masked = maskInline(mask(markdown));

    return {
        masked,
        restore: (value: string): string => value.replace(/__MD_MASK_(\d+)__/g, (_, index) => maskedValues[Number(index)] ?? "")
    };
}

//
try {

    // Configure marked with KaTeX extension for HTML output with proper delimiters
    marked?.use?.(markedKatex({
        throwOnError: false,
        nonStandard: true,
        output: "mathml",
        strict: false,
    }) as unknown as MarkedExtension,
    {
        hooks: {
            preprocess: (markdown: string): string => {
                if (!MATH_DELIMITER_PATTERN.test(markdown)) {
                    return markdown;
                }
    
                const { masked, restore } = maskCodeSegments(markdown);
                const katexNode = document.createElement("div");
                // Code fragments are masked above, so HTML here is only from non-code markdown.
                katexNode.innerHTML = masked;
                renderMathInElement(katexNode, {
                    throwOnError: false,
                    nonStandard: true,
                    output: "mathml",
                    strict: false,
                    delimiters: [
                        { left: "$$", right: "$$", display: true },
                        { left: "\\[", right: "\\]", display: true },
                        { left: "$", right: "$", display: false },
                        { left: "\\(", right: "\\)", display: false }
                    ]
                });
    
                return restore(katexNode.innerHTML)
                    .replace(/&gt;/g, ">")
                    .replace(/&lt;/g, "<")
                    .replace(/&amp;/g, "&");
            },
        },
    });
} catch(e) {
    console.warn(e);
}

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
