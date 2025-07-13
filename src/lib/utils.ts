import vscodeAPI from '../imports/api.ts';

//
export const dummy = (unsafe: string)=>{
    return unsafe?.trim()?.replace?.(/&amp;/g, '&')
    ?.replace?.(/&lt;/g, '<')
    ?.replace?.(/&gt;/g, '>')
    ?.replace?.(/&quot;/g, '"')
    ?.replace?.(/&nbsp;/g, " ")
    ?.replace?.(/&#39;/g, "'") || unsafe;
};

//
export const weak_dummy = (unsafe: string)=>{
    return unsafe?.trim()?.replace?.(/&amp;/g, '&')
    ?.replace?.(/&nbsp;/g, " ")
    ?.replace?.(/&quot;/g, '"')
    ?.replace?.(/&#39;/g, "'") || unsafe;
};

//
export const tryXML = (unsafe: string): string => {
    return dummy(unsafe) || unsafe;
};

//
export const stripMathDelimiters = (input: string): string => {
    return input?.trim?.()?.replace?.(/^\${1,2}([\s\S]*)\${1,2}$/, '$1')?.trim?.();
};

//
export const escapeML = (unsafe: string): string => {
    if (/&amp;|&quot;|&#39;|&lt;|&gt;|&nbsp;/.test((unsafe = stripMathDelimiters(unsafe) || unsafe)?.trim?.())) {
        if (unsafe?.trim()?.startsWith?.("&lt;") && unsafe?.trim()?.endsWith?.("&gt;")) {
            return tryXML(unsafe) || dummy(unsafe) || unsafe;
        }
        if (!(unsafe?.trim()?.startsWith?.("<") && unsafe?.trim()?.endsWith?.(">"))) {
            return dummy(unsafe) || unsafe;
        }
    }
    return weak_dummy(unsafe) || unsafe;
};

//
export const getSelection = (): string =>{
    const editor: any = vscodeAPI?.window?.activeTextEditor;
    const selection = editor?.selection;
    if (selection && !selection.isEmpty) { // @ts-ignore
        const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
        const highlighted = editor?.document?.getText(selectionRange);
        return highlighted;
    }
    return "";
};

//
export const replaceSelectionWith = (text: string) => {
    const editor: any = vscodeAPI?.window?.activeTextEditor;
    const selection = editor?.selection;
    if (selection) { // @ts-ignore
        const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
        editor?.edit((builder: any)=>{
            builder.replace(selectionRange, text);
        });
    }
};
