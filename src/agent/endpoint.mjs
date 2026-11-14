const decoder = new TextDecoder();

export function homeDirectory(env = process.env) {
    const profile = typeof env?.USERPROFILE === 'string' ? env.USERPROFILE.trim() : '';
    if (profile) {
        return profile;
    }
    const drive = typeof env?.HOMEDRIVE === 'string' ? env.HOMEDRIVE : '';
    const homePath = typeof env?.HOMEPATH === 'string' ? env.HOMEPATH : '';
    if (drive && homePath) {
        const sep = homePath.startsWith('\\') || homePath.startsWith('/') ? '' : '\\';
        return `${drive}${sep}${homePath}`;
    }
    return typeof env?.HOME === 'string' ? env.HOME.trim() : '';
}

function joinPath(root, name) {
    const windows = root.includes('\\') || /^[A-Za-z]:/.test(root);
    const sep = windows ? '\\' : '/';
    return `${String(root).replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function agentHome(env = process.env, homedir = homeDirectory(env)) {
    const custom = typeof env?.AI_AGENT_HOME === 'string' ? env.AI_AGENT_HOME.trim() : '';
    if (custom) {
        return custom;
    }
    if (typeof homedir !== 'string' || !homedir.trim()) {
        return '';
    }
    return joinPath(homedir.trim(), '.ai-agent');
}

/**
 * The home of the package `@u2ai/server`: `AI_SERVE_HOME` or `~/.ai-serve`.
 * @param {object} [env]
 * @param {string} [homedir]
 * @returns {string}
 */
export function serveHome(env = process.env, homedir = homeDirectory(env)) {
    const custom = typeof env?.AI_SERVE_HOME === 'string' ? env.AI_SERVE_HOME.trim() : '';
    if (custom) {
        return custom;
    }
    if (typeof homedir !== 'string' || !homedir.trim()) {
        return '';
    }
    return joinPath(homedir.trim(), '.ai-serve');
}

/**
 * The homes the extension reads, in the order of the priority: the package first,
 * the monolith after. A home without a name is left out.
 * @param {object} [env]
 * @param {string} [homedir]
 * @returns {string[]}
 */
export function homeDirectories(env = process.env, homedir = homeDirectory(env)) {
    const out = [];
    for (const dir of [serveHome(env, homedir), agentHome(env, homedir)]) {
        if (dir && !out.includes(dir)) {
            out.push(dir);
        }
    }
    return out;
}

/** The fields of the record that the extension reads besides the address. */
const RECORD_FIELDS = Object.freeze(['httpURL', 'complete', 'structure', 'completeWs', 'mcp', 'protocol']);

export function parseServeRecord(text) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const pid = value.pid;
    const url = value.url;
    const token = value.token;
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    if (typeof url !== 'string' || !url.startsWith('ws://127.0.0.1:')) {
        return null;
    }
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }
    const record = { pid, url: url.replace(/\/$/, ''), token };
    for (const field of RECORD_FIELDS) {
        const item = value[field];
        if (typeof item === 'string' && item.length > 0) {
            record[field] = item;
        }
    }
    return record;
}

export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function serveUri(vscode, dir) {
    return vscode.Uri.joinPath(vscode.Uri.file(dir), 'serve.json');
}

export async function loadServeRecord(vscode, dir) {
    if (!vscode?.workspace?.fs || typeof dir !== 'string' || !dir.trim() || typeof vscode.Uri?.file !== 'function') {
        return null;
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(serveUri(vscode, dir));
        return parseServeRecord(decoder.decode(bytes));
    } catch {
        return null;
    }
}

/**
 * The record of the first home that has one.
 *
 * The package and the monolith live in different homes: the package writes
 * `~/.ai-serve/serve.json`, the monolith writes `~/.ai-agent/serve.json`. The homes come
 * in the order of the priority, so the package wins.
 *
 * @param {object} vscode
 * @param {string[]} dirs
 * @returns {Promise<object|null>}
 */
export async function loadFirstServeRecord(vscode, dirs) {
    for (const dir of Array.isArray(dirs) ? dirs : []) {
        const record = await loadServeRecord(vscode, dir);
        if (record) {
            return record;
        }
    }
    return null;
}

function completeWs(url, token) {
    return `${url}/v1/complete?token=${encodeURIComponent(token)}`;
}

function withPort(url, port) {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, '');
}

/**
 * The HTTP address of a WebSocket address of the loopback.
 * @param {string} url
 * @returns {string}
 */
export function httpOf(url) {
    const text = String(url ?? '');
    return text.startsWith('ws://') ? `http://${text.slice('ws://'.length)}` : text;
}

/**
 * The address of the server: the bus, the token, and the parts of the server that the
 * record names.
 *
 * The record of the package names the HTTP part, the routes of it and the endpoint of
 * the MCP server. The record of the monolith has no such fields, so the addresses are
 * derived from the bus address.
 *
 * @param {{ record: object|null, settings: object, ownPid?: number|null, alive?: boolean }} input
 * @returns {{ url: string, token: string, completeWs: string, httpURL: string,
 *             complete: string, structure: string, mcp: string|null, protocol: string|null }|null}
 */
export function resolveEndpoint({ record, settings, ownPid = null, alive = false }) {
    const port = Number.isInteger(settings?.port) && settings.port > 0 && settings.port <= 65535 ? settings.port : 0;
    const tokenSetting = typeof settings?.token === 'string' ? settings.token : '';
    const recordOk = Boolean(alive && record && typeof record.url === 'string' && typeof record.token === 'string');
    if (recordOk) {
        const url = port > 0 ? withPort(record.url, port) : record.url.replace(/\/$/, '');
        const owned = ownPid !== null && ownPid !== undefined && ownPid === record.pid;
        const token = !owned && tokenSetting ? tokenSetting : record.token;
        return withParts({ url, token, record, port });
    }
    if (port > 0 && tokenSetting) {
        const url = `ws://127.0.0.1:${port}`;
        return withParts({ url, token: tokenSetting, record: null, port });
    }
    return null;
}

/**
 * Add the addresses of the parts of the server to the address of the bus.
 * @param {{ url: string, token: string, record: object|null, port: number }} input
 * @returns {object}
 */
function withParts({ url, token, record, port }) {
    const httpURL = record?.httpURL
        ? (port > 0 ? withPort(record.httpURL, port) : record.httpURL.replace(/\/$/, ''))
        : httpOf(url);
    const route = (value, fallback) => {
        if (typeof value !== 'string' || !value) {
            return fallback;
        }
        return port > 0 ? withPort(value, port) : value;
    };
    return {
        url,
        token,
        completeWs: completeWs(url, token),
        httpURL,
        complete: route(record?.complete, `${httpURL}/v1/complete`),
        structure: route(record?.structure, `${httpURL}/v1/structure`),
        mcp: route(record?.mcp, `${httpURL}/mcp`),
        protocol: typeof record?.protocol === 'string' ? record.protocol : null,
    };
}

export const __agentTest = {
    homeDirectory,
    agentHome,
    serveHome,
    homeDirectories,
    parseServeRecord,
    pidAlive,
    loadServeRecord,
    loadFirstServeRecord,
    resolveEndpoint,
    httpOf,
};
