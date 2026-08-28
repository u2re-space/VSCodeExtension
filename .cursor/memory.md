# Durable facts

Read only when the task needs prior decisions. Append a line only if a later chat would miss it. Cap ~40 lines. Do not duplicate `.cursor/maps/`.

- This tree is `U2RE-toolset` (`u2re-dev`, `vext.*`). `modules/` is a test stub — no fest sources here.
- fest (other repos only): [fest-live](https://github.com/fest-live) · npm `@fest-lib/{core,dom,object,lure,icon,image,uniform,veela,fl-ui}`. Public GH: `core.ts`, `dom.ts`, `object.ts`, `lur.e`, `icon.ts`, `image.ts`, `uniform.ts`, `img-code.mjs`.
- Runtime `vscode`: `src/imports/api.ts`. Types: `import type * as vscode from "vscode"`.
- New command / menu / setting: `package.json` `contributes` **and** a registrar in `src/`.
- Manager cache key `vext.managerModulesCacheV2`. `vext.managerView.fileWatch` defaults off (broad watchers fight agents).
- Scan order: manifests → quick probe (`modules/projects`, `modules`, `apps`, `packages`, `externals`) → `package.json` find. Extra paths: `vext.managerView.extraModules`.
- Known symlink pairs: `vext.symlink.knownLinks` on `globalState`.
- GPT webview is offline-first (host CSP / X-Frame-Options).
- Convert prefixes: `htd` HTML→MD, `dth` MD→HTML, `ltm` LaTeX→MathML, `mtl` MathML→LaTeX.
