import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const getArg = (name) => {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
};
const hasFlag = (name) => argv.includes(name);

const id = getArg("--id") || "u2re-dev.vext";
const apply = hasFlag("--apply");
const purge = hasFlag("--purge");
const dryRun = hasFlag("--dry-run") || !apply;

const parseId = (extId) => {
  const [publisher, name] = String(extId).split(".", 2);
  if (!publisher || !name) throw new Error(`Bad --id "${extId}". Expected "publisher.name".`);
  return { publisher, name, prefix: `${publisher}.${name}-` };
};

const { prefix } = parseId(id);

const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const existsDir = async (p) => {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
};

const home = os.homedir();
const candidates = uniq([
  // Cursor (local UI)
  path.join(home, ".cursor", "extensions"),
  // Cursor (remote / server)
  path.join(home, ".cursor-server", "extensions"),
  // VS Code (local)
  path.join(home, ".vscode", "extensions"),
  // VS Code (remote / server)
  path.join(home, ".vscode-server", "extensions"),
  // Common custom drive setups (your notes)
  "H:\\.cursor\\extensions",
  "H:\\.cursor-server\\extensions",
]);

const semverKey = (v) => {
  const parts = String(v).split(".").map((n) => Number(n));
  while (parts.length < 3) parts.push(0);
  return parts.map((n) => (Number.isFinite(n) ? n : 0));
};
const semverCmp = (a, b) => {
  const aa = semverKey(a);
  const bb = semverKey(b);
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
};

const main = async () => {
  const roots = [];
  for (const p of candidates) if (await existsDir(p)) roots.push(p);

  if (!roots.length) {
    console.log(`[clean-extension-cache] No extension roots found. Looked at:`);
    for (const p of candidates) console.log(`- ${p}`);
    process.exitCode = 0;
    return;
  }

  console.log(`[clean-extension-cache] id=${id} prefix=${prefix}`);
  console.log(`[clean-extension-cache] mode=${dryRun ? "dry-run" : "apply"}`);
  console.log(`[clean-extension-cache] purge=${purge ? "true" : "false"}`);

  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    const matches = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => {
        const ver = e.name.slice(prefix.length);
        return { name: e.name, ver, full: path.join(root, e.name) };
      })
      .filter((e) => e.ver && /^\d+\.\d+\.\d+/.test(e.ver));

    if (!matches.length) continue;

    matches.sort((a, b) => semverCmp(a.ver, b.ver));
    const keep = purge ? null : matches[matches.length - 1];
    const toRemove = purge ? matches : matches.slice(0, -1);

    console.log(`\n[root] ${root}`);
    if (keep) console.log(`- keep:   ${keep.name}`);
    for (const r of toRemove) console.log(`- remove: ${r.name}`);

    if (!dryRun) {
      for (const r of toRemove) {
        await fs.rm(r.full, { recursive: true, force: true });
      }
    }
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


