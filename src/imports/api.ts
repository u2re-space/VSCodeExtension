import { createRequire } from 'module';

// @ts-ignore
let vscode: Promise<any> = null;

// @ts-ignore
const VSCODE_MOD_NAME = "vscode";

//
const tryLegacyMethod = ()=>{
    // @ts-ignore
    let require:any = null;
    try {
        require = createRequire(import.meta.url);
    } catch (error) {
        console.warn(error); // @ts-ignore
    }

    try { // @ts-ignore
        return require?.("" + VSCODE_MOD_NAME) ?? (typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi?.() : globalThis);
    } catch (error) {
        console.warn(error); // @ts-ignore
        return (typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi?.() : globalThis);
    }
};

//
try {
    vscode = import("" + VSCODE_MOD_NAME)?.catch?.((e)=>{
        console.warn(e);
        return tryLegacyMethod(); // @ts-ignore
    });
} catch (e) {
    console.warn(e);
    vscode = tryLegacyMethod();
}

//
export default vscode;
