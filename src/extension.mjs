// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {webview} from './webview.mjs';
import {manager} from './manager.ts';
import {mathml}  from './mathcopy.ts';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context) { webview(context); mathml(context); manager(context); }

// This method is called when your extension is deactivated
export function deactivate() {}
