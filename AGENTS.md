# Agent entry

**U2RE-toolset** — VS Code/Cursor extension (`vext.*`).

1. Locate code with `.cursor/maps/index.md`. Do not start with a repo-wide grep.
2. Prior facts: `.cursor/memory.md` — read or append only when needed (cap ~40 lines).
3. Always-on rule: `.cursor/rules/core.mdc` only.
4. After substantive edits: `npm run lint` and `npm run build`.
