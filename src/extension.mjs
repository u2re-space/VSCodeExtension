// project management
import { manager }  from './views/manager.ts';

// editor tools
import { mathml }   from './editor/mathcopy.ts';
import { markdown } from "./editor/markdown.ts";

// context states
import { contexts } from "./context/states.ts";

// symlink
import { symlink } from './explorer/symlink.ts';
import { customActions } from './explorer/customActions.ts';

// polyfill for Promise.try
if (Promise.try === undefined || Promise.try === null || !("try" in Promise)) {
    Promise.try ??= (fn, ...args)=>{
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
    Promise.try(symlink, context)?.catch?.(e=>console.error(e));
    Promise.try(customActions, context)?.catch?.(e=>console.error(e));
    Promise.try(mathml, context)?.catch?.(e=>console.error(e));
    Promise.try(markdown, context)?.catch?.(e=>console.error(e));
    Promise.try(manager, context)?.catch?.(e=>console.error(e));
    Promise.try(contexts, context)?.catch?.(e=>console.error(e));
}

// This method is called when your extension is deactivated
export function deactivate() {}
