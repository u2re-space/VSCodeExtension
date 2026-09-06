# src + commands

`activate` in `src/extension.mjs`: `symlink`, `customActions`, `mathml`, `markdown`, `manager`, `contexts`.

| File | Exports / internals |
|---|---|
| `src/imports/api.ts` | default Promise of `vscode` (`createRequire`; webview `acquireVsCodeApi`) |
| `src/imports/utils.ts` | `getSelection`, `replaceSelectionWith` |
| `src/imports/str.ts` | `dummy`, `weak_dummy`, `tryXML`, `stripMathDelimiters`, `escapeML` |
| `src/views/manager.ts` | `ManagerViewProvider`, `manager()`; `scanWorkspaceModules` / `runModuleScan`; `handleWebviewMessage`; persist `vext.managerModulesCacheV2`; project symlinks resolve to workspace-relative realpath (`../name`, `__managerTest`) |
| `src/views/managerActions.ts` | `MANAGER_ACTIONS`, `getManagerUiConfig`, `getFilteredActions`, `resolveTheme` |
| `src/views/webview.ts` | `getWebviewContent`, `getMinimalManagerFallbackHtml` |
| `icons/actions.mjs` | Manager UI client; `postMessage` (`ready`, action ids, `webviewError`) |
| `src/web/webview.mjs` | `CustomSidebarViewProvider`, `webview()` — `vext.gptView` / `vext.gptPanelView` |
| `src/explorer/symlink.ts` | `symlink()`, known-links `vext.symlink.knownLinks`, `__symlinkTest` |
| `src/explorer/customActions.ts` | `customActions()` — `vext.explorer.customAction1..3` |
| `src/editor/markdown.ts` | `vext.htd.*` / `vext.dth.*` |
| `src/editor/mathcopy.ts` | `vext.ltm.*` / `vext.mtl.*` |
| `src/context/states.ts` | `contexts()` — `vext.proxyUndo` / `vext.proxyRedo`, `lineIsEmpty` |

Commands (registrar must match `package.json`):
`vext.symlink{,.pickSources,.abs2rel,.renameRelink}` · `vext.{htd,dth,ltm,mtl}.{paste,convert,copy}` · `vext.explorer.customAction{1,2,3}` · `vext.openManagerPanel` · `vext.proxyUndo` · `vext.proxyRedo` · `vext.openWebview` (gpt, not in `contributes`).

Do not invent command IDs without updating `contributes`.
