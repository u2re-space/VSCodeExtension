// @ts-ignore
const vscode = (() => {
    try {
        // @ts-ignore
        if (globalThis.__vscodeApi) { return globalThis.__vscodeApi; }
        // @ts-ignore
        if (typeof acquireVsCodeApi !== "undefined") {
            // @ts-ignore
            globalThis.__vscodeApi = acquireVsCodeApi();
            // @ts-ignore
            return globalThis.__vscodeApi;
        }
    } catch {}
    return null;
})();

const meta = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    // @ts-ignore
    return el?.content || "";
};
const INSTANCE_ID = meta("vext-instance");
const VIEW_TYPE = meta("vext-viewType");
const VERSION = meta("vext-version");
// @ts-ignore
const BOOT = globalThis.__VEXT_BOOTSTRAP || {};

let actionCatalog = Array.isArray(BOOT.actionCatalog) ? BOOT.actionCatalog : [];
let uiFlags = BOOT.uiFlags || { layout: "compactMore", primaryActions: [], secondaryActions: [], bulkActions: [] };

const report = (payload) => {
    try {
        vscode?.postMessage?.({ type: "webviewError", instanceId: INSTANCE_ID, viewType: VIEW_TYPE, version: VERSION, ...payload });
    } catch {}
};

window.addEventListener("error", (e) => {
    report({ message: e?.message, filename: e?.filename, lineno: e?.lineno, colno: e?.colno, stack: e?.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
    report({ message: "unhandledrejection", reason: String(e?.reason ?? "") });
});

function applyTheme(theme) {
    const t = theme || "dark";
    document.documentElement.setAttribute("data-theme", t);
    document.body?.setAttribute?.("data-theme", t);
}

/** Icon slugs must match <symbol id="ph-…"> in the webview sprite (kebab-case). */
function resolveSymbolId(name) {
    const raw = String(name || "").trim() || "dots-three";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
        return "ph-dots-three";
    }
    const id = `ph-${raw}`;
    try {
        if (document.querySelector(`svg.ph-sprite-svg symbol#${id}`)) {
            return id;
        }
    } catch {
        /* invalid selector */
    }
    return "ph-dots-three";
}

function makePhosphorIcon(name) {
    const id = resolveSymbolId(name);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ph-icon");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    const href = `#${id}`;
    use.setAttribute("href", href);
    try {
        use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    } catch {
        /* ignore */
    }
    svg.appendChild(use);
    return svg;
}

function mkBtn(cmd, mod, title, icon, dangerous = false) {
    const b = document.createElement("button");
    b.dataset.command = cmd;
    b.dataset.module = mod;
    b.title = title;
    if (dangerous) { b.classList.add("danger"); }
    b.appendChild(makePhosphorIcon(icon || "dots-three"));
    return b;
}

function getRowActions() {
    return actionCatalog.filter((a) => a.scope === "row");
}

function renderToolbar() {
    const container = document.getElementById("toolbarActions");
    if (!container) return;
    container.textContent = "";
    
    const bulkIds = Array.isArray(uiFlags.bulkActions) && uiFlags.bulkActions.length > 0 
        ? uiFlags.bulkActions 
        : [];
        
    const bulkActions = actionCatalog.filter(a => a.scope === "bulk");
    
    if (bulkIds.length > 0) {
        bulkIds.forEach(id => {
            const action = bulkActions.find(a => a.id === id);
            if (action) {
                container.appendChild(mkBtn(action.id, "", action.title, action.icon, !!action.dangerous));
            }
        });
    } else {
        bulkActions.forEach(action => {
            container.appendChild(mkBtn(action.id, "", action.title, action.icon, !!action.dangerous));
        });
    }

    toolbarButtons = Array.from(document.querySelectorAll(".toolbar-actions button[data-command]"));
}

function renderMoreMenu(secondary, moduleName) {
    const details = document.createElement("details");
    details.className = "more-menu";

    const summary = document.createElement("summary");
    summary.title = "More actions";
    summary.appendChild(makePhosphorIcon("dots-three"));
    details.appendChild(summary);

    const menu = document.createElement("div");
    menu.className = "more-menu-list";
    secondary.forEach((action) => {
        menu.appendChild(mkBtn(action.id, moduleName, action.title, action.icon, !!action.dangerous));
    });

    details.appendChild(menu);
    return details;
}

function renderModules(modules = []) {
    const tbody = document.getElementById("modulesTbody");
    if (!tbody) { return; }
    const rowActions = getRowActions();
    const list = Array.from(new Set(["./", ...(modules || [])].filter(Boolean)));
    tbody.textContent = "";

    for (const m of list) {
        const tr = document.createElement("tr");
        tr.tabIndex = 0;
        tr.dataset.module = m;

        const tdName = document.createElement("td");
        tdName.className = "name";
        tdName.textContent = m;

        const tdActions = document.createElement("td");
        tdActions.className = "actions";

        const wrap = document.createElement("div");
        wrap.className = "actions-container";

        let primary = [];
        let secondary = [];

        const explicitPrimary = Array.isArray(uiFlags.primaryActions) && uiFlags.primaryActions.length > 0 ? uiFlags.primaryActions : null;
        const explicitSecondary = Array.isArray(uiFlags.secondaryActions) && uiFlags.secondaryActions.length > 0 ? uiFlags.secondaryActions : null;

        if (explicitPrimary) {
            explicitPrimary.forEach(id => {
                const act = rowActions.find(a => a.id === id);
                if (act) primary.push(act);
            });
        } else {
            primary = rowActions.filter((a) => a.primary);
        }

        if (explicitSecondary) {
            explicitSecondary.forEach(id => {
                const act = rowActions.find(a => a.id === id);
                if (act) secondary.push(act);
            });
        } else {
            const primaryIds = new Set(primary.map(a => a.id));
            secondary = rowActions.filter(a => !primaryIds.has(a.id));
        }

        primary.forEach((action) => {
            wrap.appendChild(mkBtn(action.id, m, action.title, action.icon, !!action.dangerous));
        });
        if (secondary.length > 0) {
            wrap.appendChild(renderMoreMenu(secondary, m));
        }

        tdActions.appendChild(wrap);
        tr.appendChild(tdName);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
    }
    rows = Array.from(document.querySelectorAll("tr"));
}

let toolbar = null;
let toolbarButtons = [];
let rows = Array.from(document.querySelectorAll("tr"));
let current = 0;
let inToolbar = false;
let toolbarBtnIdx = 0;

function send(command, module = "") {
    vscode?.postMessage?.({ command, module, instanceId: INSTANCE_ID, viewType: VIEW_TYPE, version: VERSION });
}

function focusToolbar(idx = 0) {
    inToolbar = true;
    toolbarBtnIdx = idx;
    toolbarButtons[toolbarBtnIdx]?.focus?.();
    rows = Array.from(document.querySelectorAll("tr"));
    rows.forEach((r) => r.classList.remove("selected"));
}

function focusRow(idx, e) {
    inToolbar = false;
    rows = Array.from(document.querySelectorAll("tr"));
    if (!rows.length) { return; }
    if (rows[current]) { rows[current].classList.remove("selected"); }
    current = (idx + rows.length) % rows.length;
    rows[current]?.classList?.add?.("selected");
    rows[current]?.focus?.();

    const btns = rows[current]?.querySelectorAll?.("button[data-command]");
    // @ts-ignore
    const active = document.activeElement;
    let btx = Array.from(btns || []).indexOf(active);
    if (btx < 0) { btx = 0; }
    if (btx >= 0) { btns?.[btx]?.focus?.(); }
    if (e) { e.preventDefault(); }
}

document.body.addEventListener("click", (e) => {
    // @ts-ignore
    const btn = e?.target?.closest?.("button[data-command]");
    if (!btn) { return; }
    // @ts-ignore
    send(btn.dataset.command, btn.dataset.module || "");
});

document.body.addEventListener("keydown", (e) => {
    if (inToolbar) {
        if (e.key === "ArrowDown") { focusRow(current + 1, e); }
        if (e.key === "ArrowRight") {
            toolbarBtnIdx = (toolbarBtnIdx + 1) % toolbarButtons.length;
            toolbarButtons[toolbarBtnIdx]?.focus?.();
            e.preventDefault();
        }
        if (e.key === "ArrowLeft") {
            toolbarBtnIdx = (toolbarBtnIdx - 1 + toolbarButtons.length) % toolbarButtons.length;
            toolbarButtons[toolbarBtnIdx]?.focus?.();
            e.preventDefault();
        }
        if (e.key === "Enter") {
            toolbarButtons[toolbarBtnIdx]?.click?.();
            e.preventDefault();
        }
    } else {
        if (e.key === "ArrowDown") { focusRow(current + 1); e.preventDefault(); }
        if (e.key === "ArrowUp") {
            if (current === 0) {
                focusToolbar(0);
            } else {
                focusRow(current - 1);
            }
            e.preventDefault();
        }
        if (e.key === "Enter") {
            const btn = document.activeElement?.tagName === "BUTTON"
                ? document.activeElement
                : rows[current]?.querySelector?.("button[data-command]");
            // @ts-ignore
            if (btn) { btn?.click?.(); }
            e.preventDefault();
        }
        if (e.key === "ArrowRight") {
            const btns = rows[current]?.querySelectorAll?.("button[data-command]") || [];
            // @ts-ignore
            const active = document.activeElement;
            const idx = Array.from(btns).indexOf(active);
            if (idx >= 0 && idx < btns.length - 1) { btns[idx + 1]?.focus?.(); }
            else if (btns.length) { btns[0]?.focus?.(); }
            e.preventDefault();
        }
        if (e.key === "ArrowLeft") {
            const btns = rows[current]?.querySelectorAll?.("button[data-command]") || [];
            // @ts-ignore
            const active = document.activeElement;
            const idx = Array.from(btns).indexOf(active);
            if (idx > 0) { btns[idx - 1]?.focus?.(); }
            else if (btns.length) { btns[btns.length - 1]?.focus?.(); }
            e.preventDefault();
        }
    }
});

window.addEventListener("message", (event) => {
    const msg = event?.data;
    if (msg?.theme) {
        applyTheme(msg.theme);
    }
    if (Array.isArray(msg?.actionCatalog)) {
        actionCatalog = msg.actionCatalog;
    }
    if (msg?.uiFlags) {
        uiFlags = msg.uiFlags;
    }
    if (msg?.type === "modules") {
        renderToolbar();
        renderModules(msg.modules || []);
    }
});

window.addEventListener("DOMContentLoaded", () => {
    applyTheme(BOOT.theme || "dark");
    toolbar = document.querySelector(".toolbar");
    renderToolbar();
    rows = Array.from(document.querySelectorAll("tr"));
    send("ready", "");
});