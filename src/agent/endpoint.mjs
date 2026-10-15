import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function agentHome(env = process.env, homedir = os.homedir()) {
    const custom = typeof env.AI_AGENT_HOME === 'string' ? env.AI_AGENT_HOME.trim() : '';
    if (custom) {
        return custom;
    }
    return path.join(homedir, '.ai-agent');
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

export async function loadServeRecord(dir) {
    try {
        const text = await fs.readFile(path.join(dir, 'serve.json'), 'utf8');
        return parseServeRecord(text);
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
        const owned = ownPid != null && ownPid === record.pid;
        const token = !owned && tokenSetting ? tokenSetting : record.token;
        return { url, token, completeWs: completeWs(url, token) };
    }
    if (port > 0 && tokenSetting) {
        const url = `ws://127.0.0.1:${port}`;
        return { url, token: tokenSetting, completeWs: completeWs(url, tokenSetting) };
    }
    return null;
}

export const __agentTest = { agentHome, parseServeRecord, pidAlive, loadServeRecord, resolveEndpoint };
