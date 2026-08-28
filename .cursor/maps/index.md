# Search map

Do not start with repo-wide Grep. Open one row, then search inside that file.

| Need | File |
|---|---|
| Activation | `src/extension.mjs` |
| Manager scan / cache / messages | `src/views/manager.ts` |
| Action catalog / theme | `src/views/managerActions.ts` |
| Manager HTML + CSP | `src/views/webview.ts` |
| Manager webview client | `icons/actions.mjs` |
| GPTunnel views | `src/web/webview.mjs` |
| Symlink / relink | `src/explorer/symlink.ts` |
| Custom explorer actions | `src/explorer/customActions.ts` |
| HTML ↔ Markdown | `src/editor/markdown.ts` |
| MathML ↔ LaTeX | `src/editor/mathcopy.ts` |
| Line/undo context | `src/context/states.ts` |
| `vscode` loader | `src/imports/api.ts` |
| Selection helpers | `src/imports/utils.ts` |
| HTML/XML escape | `src/imports/str.ts` |
| Commands / menus / settings | `package.json` → `contributes` |
| Bundle | `esbuild.js` → `dist/extension.mjs` |
| Tests | `test/extension.test.js`, `test/symlink.test.js` |
| Host extension cache | `scripts/clean-extension-cache.mjs` |

Aliases: scan/modules → `manager.ts`; GPT → `src/web/webview.mjs`; junction → `symlink.ts`; katex → `mathcopy.ts`; turndown → `markdown.ts`; undo → `states.ts`.

Exports, commands, persist keys: `.cursor/maps/src.md`.
