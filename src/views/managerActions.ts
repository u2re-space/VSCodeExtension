//! use only TS types
import type * as vscode from "vscode";

export type ManagerTheme = "auto" | "light" | "dark" | "oled";
export type ManagerLayout = "compactMore";

export interface ManagerUiConfig {
    theme: ManagerTheme;
    layout: ManagerLayout;
    smartActionsEnabled: boolean;
    powerUserEnabled: boolean;
    primaryActions: string[];
}

export interface ManagerActionDef {
    id: string;
    title: string;
    group: "navigate" | "run" | "build" | "git" | "setup" | "smart";
    icon: string;
    scope: "row" | "bulk";
    primary?: boolean;
    dangerous?: boolean;
    smart?: boolean;
    powerUser?: boolean;
    requiresConfirm?: boolean;
}

export const DEFAULT_PRIMARY_ACTIONS: string[] = [
    "open-dir",
    "terminal",
    "dev",
    "build",
    "install"
];

export const MANAGER_ACTIONS: ManagerActionDef[] = [
    { id: "open-dir", title: "Open", group: "navigate", icon: "folder-open", scope: "row" },
    { id: "terminal", title: "Terminal", group: "run", icon: "terminal-window", scope: "row", primary: true },
    { id: "dev", title: "Dev Serve", group: "run", icon: "rocket-launch", scope: "row", primary: true },
    { id: "build", title: "Build", group: "build", icon: "package", scope: "row", primary: true },
    { id: "test", title: "Test", group: "build", icon: "flask", scope: "row", primary: true },
    { id: "watch", title: "Watch", group: "run", icon: "eye", scope: "row" },
    { id: "diff", title: "Git diff", group: "git", icon: "git-diff", scope: "row" },
    { id: "install", title: "Install", group: "setup", icon: "download-simple", scope: "row", primary: true },
    { id: "push", title: "Git push", group: "git", icon: "git-commit", scope: "row", requiresConfirm: true },
    { id: "audit-fix", title: "Audit fix", group: "smart", icon: "shield-check", scope: "row", smart: true },
    { id: "install-fix", title: "Install + audit fix", group: "smart", icon: "wrench", scope: "row", smart: true },
    { id: "copy-file-content", title: "Copy active file content", group: "smart", icon: "file-text", scope: "row", smart: true },
    { id: "copy-file-base64", title: "Copy active file base64", group: "smart", icon: "binary", scope: "row", smart: true },
    {
        id: "git-revert-file",
        title: "Git revert active file",
        group: "smart",
        icon: "arrow-counter-clockwise",
        scope: "row",
        smart: true,
        requiresConfirm: true
    },
    {
        id: "git-reset-file",
        title: "Git reset active file",
        group: "smart",
        icon: "arrows-clockwise",
        scope: "row",
        smart: true,
        powerUser: true,
        dangerous: true,
        requiresConfirm: true
    },
    {
        id: "git-revert-dir",
        title: "Git revert directory",
        group: "smart",
        icon: "folder-notch-minus",
        scope: "row",
        smart: true,
        powerUser: true,
        dangerous: true,
        requiresConfirm: true
    },
    {
        id: "git-reset-dir",
        title: "Git reset directory",
        group: "smart",
        icon: "warning-circle",
        scope: "row",
        smart: true,
        powerUser: true,
        dangerous: true,
        requiresConfirm: true
    },
    { id: "bulk_build", title: "Build all", group: "build", icon: "package", scope: "bulk", primary: true },
    { id: "bulk_install", title: "Install all", group: "setup", icon: "download-simple", scope: "bulk", primary: true },
    { id: "bulk_push", title: "Push all", group: "git", icon: "git-commit", scope: "bulk", requiresConfirm: true }
];

export const getManagerUiConfig = (vscodeAPI: typeof vscode): ManagerUiConfig => {
    const cfg = vscodeAPI.workspace.getConfiguration("vext");
    const userPrimary = cfg.get<string[]>("managerView.primaryActions", DEFAULT_PRIMARY_ACTIONS);
    return {
        theme: cfg.get<ManagerTheme>("managerView.theme", "auto"),
        layout: cfg.get<ManagerLayout>("managerView.layout", "compactMore"),
        smartActionsEnabled: cfg.get<boolean>("managerView.smartActions.enabled", true),
        powerUserEnabled: cfg.get<boolean>("managerView.smartActions.powerUser", true),
        primaryActions: (Array.isArray(userPrimary) && userPrimary.length > 0) ? userPrimary : DEFAULT_PRIMARY_ACTIONS
    };
};

export const getFilteredActions = (cfg: ManagerUiConfig): ManagerActionDef[] => {
    return MANAGER_ACTIONS.filter((action) => {
        if (action.smart && !cfg.smartActionsEnabled) { return false; }
        if (action.powerUser && !cfg.powerUserEnabled) { return false; }
        return true;
    });
};

export const resolveTheme = (vscodeAPI: typeof vscode, explicitTheme: ManagerTheme): "light" | "dark" | "oled" => {
    if (explicitTheme === "light" || explicitTheme === "dark" || explicitTheme === "oled") {
        return explicitTheme;
    }
    const kind = vscodeAPI.window.activeColorTheme?.kind;
    if (kind === vscodeAPI.ColorThemeKind.Light || kind === vscodeAPI.ColorThemeKind.HighContrastLight) {
        return "light";
    }
    return "dark";
};

