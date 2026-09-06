import { createRequire } from "module";

// NOTE:
// Cursor's extension host can fail to resolve the `vscode` module via ESM `import(...)`.
// Using CommonJS `require('vscode')` via createRequire is the most compatible approach.

// @ts-ignore
const VSCODE_MOD_NAME = "vscode";

const getVsCodeApi = () => {
    // Extension host (Node): prefer require('vscode')
    try {
        const require = createRequire(import.meta.url);
        // @ts-ignore
        return require(VSCODE_MOD_NAME);
    } catch (e) {
        console.warn(e);
    }

    // Webview (browser): fallback to acquireVsCodeApi
    try {
        // @ts-ignore
        const acquire = globalThis.acquireVsCodeApi;
        if (typeof acquire === "function") { return acquire(); }
    } catch (e) {
        console.warn(e);
    }

    // Last resort
    return globalThis;
};

// @ts-ignore
const vscode = Promise.resolve().then(getVsCodeApi);

export default vscode;