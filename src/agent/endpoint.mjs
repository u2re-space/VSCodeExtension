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
    return { pid, url: url.replace(/\/$/, ''), token };
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

function completeWs(url, token) {
    return `${url}/v1/complete?token=${encodeURIComponent(token)}`;
}

function withPort(url, port) {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, '');
}

export function resolveEndpoint({ record, settings, ownPid = null, alive = false }) {
    const port = Number.isInteger(settings?.port) && settings.port > 0 && settings.port <= 65535 ? settings.port : 0;
    const tokenSetting = typeof settings?.token === 'string' ? settings.token : '';
    const recordOk = Boolean(alive && record && typeof record.url === 'string' && typeof record.token === 'string');
    if (recordOk) {
        const url = port > 0 ? withPort(record.url, port) : record.url.replace(/\/$/, '');
        const owned = ownPid !== null && ownPid !== undefined && ownPid === record.pid;
        const token = !owned && tokenSetting ? tokenSetting : record.token;
        return { url, token, completeWs: completeWs(url, token) };
    }
    if (port > 0 && tokenSetting) {
        const url = `ws://127.0.0.1:${port}`;
        return { url, token: tokenSetting, completeWs: completeWs(url, tokenSetting) };
    }
    return null;
}

export const __agentTest = { homeDirectory, agentHome, parseServeRecord, pidAlive, loadServeRecord, resolveEndpoint };
