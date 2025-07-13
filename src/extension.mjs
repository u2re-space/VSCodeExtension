// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {webview}  from './chapter/webview.mjs';
import {manager}  from './chapter/manager.ts';
import {mathml}   from './chapter/mathcopy.ts';
import {markdown} from "./chapter/markdown.ts";

//
if (Promise.try === undefined || Promise.try === null || !("try" in Promise)) {
    Promise.try = (fn, ...args)=>{
        return new Promise((resolve, reject)=>{
            try {
                resolve(fn(...args));
            } catch (error) {
                reject(error);
            }
        });
    };
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context) {
    Promise.try(mathml, context)?.catch?.(e=>console.error(e));
    Promise.try(markdown, context)?.catch?.(e=>console.error(e));
    Promise.try(manager, context)?.catch?.(e=>console.error(e));
    Promise.try(webview, context)?.catch?.(e=>console.error(e));
}

// This method is called when your extension is deactivated
export function deactivate() {}
