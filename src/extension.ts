// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { MathMLToLaTeX } from 'mathml-to-latex';

//
export const getSelection = (): string =>{
	const editor: any = vscode.window.activeTextEditor;
	const selection = editor.selection;
	if (selection && !selection.isEmpty) {
		const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
		const highlighted = editor.document.getText(selectionRange);
		return highlighted;
	}
	return "";
};

//
export const replaceSelectionWith = (text: string) => {
	const editor: any = vscode.window.activeTextEditor;
	const selection = editor.selection;
	if (selection && !selection.isEmpty) {
		const selectionRange = new vscode.Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
		//const highlighted = editor.document.getText(selectionRange);
		editor.edit((builder: any)=>{
			builder.replace(selectionRange, text);
		});
	}
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('MLtoTeX in testing');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('MLtoTeX.convert', () => {
		const math: string = getSelection();

		//
		let tex = ""; try { tex = MathMLToLaTeX.convert(math?.normalize?.()?.trim?.()||""); }
		catch(e: any) { vscode.window.showErrorMessage(e.message as string); }

		//
		if (tex) { replaceSelectionWith(`\$${tex?.normalize?.()?.trim?.()||""}\$`); }
	});

	//
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
