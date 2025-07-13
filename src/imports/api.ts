import { createRequire } from 'module';
const require = createRequire(import.meta.url); // @ts-ignore
const vscode  = require?.("vscode") ?? (typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi?.() : globalThis);
export default vscode;
