// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {webview}  from './chapter/webview.mjs';
import {manager}  from './chapter/manager.ts';
import {mathml}   from './chapter/mathcopy.ts';
import {markdown} from "./chapter/markdown.ts";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context) { webview(context); mathml(context); manager(context); markdown(context); }

// This method is called when your extension is deactivated
export function deactivate() {}
