import vscodePromise from './api.ts';

//
export const getSelection = async (): Promise<string> =>{
    const vscodeAPI = await vscodePromise;
    const editor: any = vscodeAPI?.window?.activeTextEditor;
    const selection = editor?.selection;
    if (selection && !selection.isEmpty) { // @ts-ignore
        const selectionRange = new vscodeAPI.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
        const highlighted = editor?.document?.getText(selectionRange);
        return highlighted;
    }
    return "";
};

//
export const replaceSelectionWith = async (text: string) => {
    const vscodeAPI = await vscodePromise;
    const editor: any = vscodeAPI?.window?.activeTextEditor;
    const selection = editor?.selection;
    if (selection) { // @ts-ignore
        const selectionRange = new vscodeAPI.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
        editor?.edit((builder: any)=>{
            builder.replace(selectionRange, text);
        });
    }
};
