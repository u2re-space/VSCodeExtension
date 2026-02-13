//! use only TS types
import type * as vscode from "vscode";
import * as path from "path";

import vscodePromise from "../imports/api.ts";

type ActionRuntime = "auto" | "bash" | "pwsh" | "ssh" | "node" | "deno" | "js";

interface ActionConfig {
    enabled?: boolean;
    title?: string;
    runtime?: ActionRuntime;
    runtimeArgs?: string[];
    template?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    openTerminal?: boolean;
}

const ACTION_IDS = [1, 2, 3] as const;
const CMD_PREFIX = "vext.explorer.customAction";
const CONFIG_PREFIX = "explorer.customAction";
const GLOBAL_EXPLORER_CONFIG = "explorer.customActions.enableSubmenu";

function getCommandId(index: (typeof ACTION_IDS)[number]): string {
    return `${CMD_PREFIX}${index}`;
}

function getConfig(section: vscode.WorkspaceConfiguration, index: (typeof ACTION_IDS)[number]): ActionConfig {
    const base = `${CONFIG_PREFIX}${index}`;
    const legacy = section.get<ActionConfig>(base, {});
    const enabled = section.get<boolean>(`${base}.enabled`, legacy.enabled ?? false);
    const title = section.get<string>(`${base}.title`, legacy.title ?? `Explorer Action ${index}`);
    const runtime = section.get<ActionRuntime>(`${base}.runtime`, legacy.runtime ?? "auto");
    const runtimeArgs = section.get<string[]>(`${base}.runtimeArgs`, legacy.runtimeArgs ?? []);
    const template = section.get<string>(`${base}.template`, legacy.template ?? "");
    const command = section.get<string>(`${base}.command`, legacy.command ?? "");
    const args = section.get<string[]>(`${base}.args`, legacy.args ?? []);
    const cwd = section.get<string>(`${base}.cwd`, legacy.cwd ?? "");
    const env = section.get<Record<string, string>>(`${base}.env`, legacy.env ?? {});
    const openTerminal = section.get<boolean>(`${base}.openTerminal`, legacy.openTerminal ?? true);

    return {
        enabled,
        title,
        runtime,
        runtimeArgs,
        template,
        command,
        args,
        cwd,
        env,
        openTerminal
    };
}

async function getTargetKind(vscodeAPI: typeof vscode, uri: vscode.Uri): Promise<"file" | "directory" | "unknown"> {
    try {
        const st = await vscodeAPI.workspace.fs.stat(uri);
        if (st.type & vscodeAPI.FileType.Directory) {
            return "directory";
        }
        return "file";
    } catch {
        return "unknown";
    }
}

function normalizeSlashes(input: string): string {
    return input.replace(/\\/g, "/");
}

function isRemoteUri(uri: vscode.Uri): boolean {
    return uri.scheme !== "file";
}

function getTargetPath(uri: vscode.Uri): string {
    return isRemoteUri(uri) ? uri.path : uri.fsPath;
}

function shellQuote(value: string): string {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
}

function quoteArg(value: string): string {
    const escaped = value.replace(/"/g, '\\"');
    return `"${escaped}"`;
}

function applyRuntime(runtime: ActionRuntime, command: string, filePath: string, runtimeArgs: string[]): string {
    const trimmed = command.trim();
    const renderedRuntimeArgs = runtimeArgs.map((arg) => quoteArg(arg)).join(" ");
    const runtimeArgPart = renderedRuntimeArgs ? ` ${renderedRuntimeArgs}` : "";
    switch (runtime) {
        case "bash":
            return `bash${runtimeArgPart} -lc ${quoteArg(trimmed)}`;
        case "pwsh":
            return `pwsh -NoLogo${runtimeArgPart} -Command ${quoteArg(trimmed)}`;
        case "node":
            return `node${runtimeArgPart} ${trimmed}`;
        case "deno":
            return `deno run${runtimeArgPart} ${trimmed}`;
        case "js":
            return trimmed.length > 0 ? `node${runtimeArgPart} ${trimmed}` : `node${runtimeArgPart} ${quoteArg(filePath)}`;
        case "ssh":
            return `ssh${runtimeArgPart} ${trimmed}`;
        case "auto":
        default:
            return trimmed;
    }
}

function interpolate(input: string, map: Record<string, string>): string {
    return input.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => map[key] ?? "");
}

function toCommandFromTyped(config: ActionConfig, vars: Record<string, string>): string {
    const command = (config.command || "").trim();
    const args = Array.isArray(config.args) ? config.args : [];
    const builtArgs = args.map((arg) => quoteArg(interpolate(String(arg), vars)));
    if (!command && builtArgs.length === 0) {
        return "";
    }
    if (!command) {
        return builtArgs.join(" ");
    }
    return [interpolate(command, vars), ...builtArgs].join(" ").trim();
}

async function resolveCwd(vscodeAPI: typeof vscode, config: ActionConfig, vars: Record<string, string>): Promise<string | undefined> {
    const raw = (config.cwd || "").trim();
    if (!raw) {
        return vars.workspaceFolder || vars.fileDir || undefined;
    }
    return interpolate(raw, vars);
}

function getPathApiForUri(uri: vscode.Uri): typeof path | typeof path.posix {
    return isRemoteUri(uri) ? path.posix : path;
}

async function runAction(index: (typeof ACTION_IDS)[number], uri?: vscode.Uri): Promise<void> {
    const vscodeAPI = await vscodePromise;
    const fallbackUri = vscodeAPI.window.activeTextEditor?.document?.uri;
    const targetUri = uri || fallbackUri;
    if (!targetUri) {
        vscodeAPI.window.showErrorMessage(`Custom Action ${index}: no target file or folder selected (right-click a file in Explorer or open a file in the editor).`);
        return;
    }

    const config = getConfig(vscodeAPI.workspace.getConfiguration("vext"), index);
    if (config.enabled === false) {
        vscodeAPI.window.showWarningMessage(`Custom Action ${index} is disabled in settings.`);
        return;
    }

    const pathApi = getPathApiForUri(targetUri);
    const filePath = getTargetPath(targetUri);
    const fileName = pathApi.basename(filePath);
    const fileExt = pathApi.extname(filePath);
    const fileBaseName = pathApi.basename(filePath, fileExt);
    const fileDir = pathApi.dirname(filePath);
    const workspaceFolderUri = vscodeAPI.workspace.getWorkspaceFolder(targetUri)?.uri;
    const workspaceFolder = workspaceFolderUri ? getTargetPath(workspaceFolderUri) : "";
    const relativePath = workspaceFolder ? pathApi.relative(workspaceFolder, filePath) : fileName;
    const kind = await getTargetKind(vscodeAPI, targetUri);

    const vars: Record<string, string> = {
        // raw OS-native paths
        filePath,
        fileName,
        fileBaseName,
        fileExt,
        fileDir,
        workspaceFolder,
        relativePath,
        resourceType: kind,

        // forward-slash (Unix-style) variants
        filePathUnix: normalizeSlashes(filePath),
        fileDirUnix: normalizeSlashes(fileDir),
        workspaceFolderUnix: normalizeSlashes(workspaceFolder),
        relativePathUnix: normalizeSlashes(relativePath),

        // shell-safe quoted variants (wrapped in double quotes with escaping)
        filePathQuoted: shellQuote(filePath),
        fileDirQuoted: shellQuote(fileDir),
        workspaceFolderQuoted: shellQuote(workspaceFolder),
        relativePathQuoted: shellQuote(relativePath),
        fileNameQuoted: shellQuote(fileName),

        // platform info
        pathSep: isRemoteUri(targetUri) ? "/" : path.sep,
        platform: process.platform
    };

    const template = (config.template || "").trim();
    const fromTemplate = template ? interpolate(template, vars) : "";
    const fromTyped = toCommandFromTyped(config, vars);
    const rawCommand = fromTemplate || fromTyped;
    if (!rawCommand) {
        vscodeAPI.window.showErrorMessage(
            `Custom Action ${index}: configure "vext.explorer.customAction${index}.template" or typed command fields.`
        );
        return;
    }

    const runtime: ActionRuntime = config.runtime || "auto";
    const runtimeArgs = Array.isArray(config.runtimeArgs)
        ? config.runtimeArgs
            .map((arg) => interpolate(String(arg), vars).trim())
            .filter((arg) => arg.length > 0)
        : [];
    const finalCommand = applyRuntime(runtime, rawCommand, filePath, runtimeArgs);
    const cwd = await resolveCwd(vscodeAPI, config, vars);
    const terminal = vscodeAPI.window.createTerminal({
        name: config.title?.trim() || `Custom Action ${index}`,
        cwd,
        env: config.env
    });

    const openTerminal = config.openTerminal !== false;
    if (openTerminal) {
        terminal.show();
    }
    terminal.sendText(finalCommand);
}

async function updateActionContexts(): Promise<void> {
    const vscodeAPI = await vscodePromise;
    const section = vscodeAPI.workspace.getConfiguration("vext");
    const submenuEnabled = section.get<boolean>(GLOBAL_EXPLORER_CONFIG, true);
    let anyEnabled = false;

    for (const idx of ACTION_IDS) {
        const cfg = getConfig(section, idx);
        const enabled = submenuEnabled && cfg.enabled !== false;
        anyEnabled = anyEnabled || enabled;
        await vscodeAPI.commands.executeCommand("setContext", `vext.explorer.customAction${idx}.enabled`, enabled);
    }

    await vscodeAPI.commands.executeCommand("setContext", "vext.explorer.customActions.anyEnabled", anyEnabled);
}

export async function customActions(context: vscode.ExtensionContext): Promise<void> {
    const vscodeAPI = await vscodePromise;
    await updateActionContexts();

    context.subscriptions.push(
        vscodeAPI.workspace.onDidChangeConfiguration(async (event: vscode.ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("vext.explorer.customAction1") ||
                event.affectsConfiguration("vext.explorer.customAction2") ||
                event.affectsConfiguration("vext.explorer.customAction3") ||
                event.affectsConfiguration("vext.explorer.customActions")) {
                await updateActionContexts();
            }
        })
    );

    for (const idx of ACTION_IDS) {
        context.subscriptions.push(
            vscodeAPI.commands.registerCommand(getCommandId(idx), async (uri: vscode.Uri) => {
                // Called from Explorer with URI, or from Command Palette without URI.
                await runAction(idx, uri);
            })
        );
    }
}

