import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import vscodeAPI from '../imports/api.ts';
import { createBus } from './bus.mjs';
import { createCompleteClient, registerAgentCompletion } from './complete.mjs';
import { agentHome, loadServeRecord, pidAlive, resolveEndpoint } from './endpoint.mjs';
import { AgentViewProvider } from './panel.mjs';
import { launchOutcome, readAgentSettings, shouldKillSpawnedPid, spawnArgs, spawnEnv } from './settings.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STDERR_CAP = 4096;

const positivePid = (pid) => (Number.isInteger(pid) && pid > 0 ? pid : null);

const killPid = (pid) => {
    try {
        process.kill(pid);
    } catch (error) {
        if (error?.code !== 'ESRCH') {
            throw error;
        }
    }
};

const killChild = (proc) => {
    if (!proc) {
        return;
    }
    const pid = proc.pid;
    if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
        try {
            execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 5000,
            });
        } catch {
            /* already gone */
        }
    }
    try {
        proc.kill();
    } catch {
        /* already gone */
    }
};

const launchLockFile = () => path.join(agentHome(), 'launch.lock');

const takeLaunchLock = async () => {
    const file = launchLockFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const write = async () => {
        await fs.writeFile(file, String(process.pid), { flag: 'wx' });
        return { file };
    };
    try {
        return await write();
    } catch (error) {
        if (error?.code !== 'EEXIST') {
            throw error;
        }
    }
    let holder = 0;
    try {
        holder = Number(await fs.readFile(file, 'utf8'));
    } catch {
        return null;
    }
    if (Number.isInteger(holder) && pidAlive(holder)) {
        return null;
    }
    try {
        await fs.unlink(file);
    } catch {
        return null;
    }
    try {
        return await write();
    } catch {
        return null;
    }
};

const releaseLaunchLock = async (lock) => {
    if (!lock) {
        return;
    }
    try {
        const current = Number(await fs.readFile(lock.file, 'utf8'));
        if (current === process.pid) {
            await fs.unlink(lock.file);
        }
    } catch {
        /* already gone */
    }
};

export async function agent(context) {
    const vscode = await vscodeAPI;
    const views = new Set();
    let ownPid = null;
    let child = null;
    let endpoint = null;
    let completeUrl = '';
    let launchTask = null;
    let launchToken = 0;
    let wakeLaunch = null;
    let spawnWatch = null;

    const settingsOf = () => readAgentSettings((key) => vscode.workspace.getConfiguration().get(key));

    const post = (message) => {
        for (const webview of views) {
            webview.postMessage(message);
        }
    };

    const showStop = () => {
        post({ type: 'stopVisible', visible: ownPid !== null || child !== null });
    };

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.name = 'U2RE Agent';
    statusBar.text = 'U2RE Agent';
    statusBar.show();
    context.subscriptions.push(statusBar);

    const flash = (detail) => {
        statusBar.text = detail;
        post({ type: 'status', state: 'error', detail });
        setTimeout(() => {
            statusBar.text = 'U2RE Agent';
        }, 4000);
    };

    const bus = createBus({
        WebSocketImpl: globalThis.WebSocket,
        onMessage: (message) => post(message),
        onStatus: (message) => {
            const detail = message.detail || (message.state === 'ready' ? endpoint?.url : message.state);
            post({ ...message, detail: message.detail || detail });
            if (message.state === 'ready' && endpoint) {
                post({ type: 'status', state: 'ready', detail: endpoint.url });
            }
        },
    });

    const complete = createCompleteClient({
        WebSocketImpl: globalThis.WebSocket,
        onStatus: (detail) => flash(detail),
    });

    const currentEndpoint = async () => {
        const settings = settingsOf();
        const record = await loadServeRecord(agentHome());
        const alive = record ? pidAlive(record.pid) : false;
        return resolveEndpoint({
            record,
            settings: { port: settings.port, token: settings.token },
            ownPid,
            alive,
        });
    };

    const releaseLaunch = async (proc, killFilePid) => {
        if (spawnWatch) {
            spawnWatch.on = false;
        }
        if (proc) {
            killChild(proc);
            if (child === proc) {
                child = null;
            }
        }
        if (!killFilePid) {
            return;
        }
        const record = await loadServeRecord(agentHome());
        const spawnedPid = positivePid(proc?.pid);
        if (record && pidAlive(record.pid) && shouldKillSpawnedPid({
            ownPid: spawnedPid,
            spawnedPid,
            livePid: record.pid,
        })) {
            killPid(record.pid);
        }
    };

    const spawnAndWait = async () => {
        const token = ++launchToken;
        const cancelled = () => token !== launchToken;
        let spawnError = null;
        let wakeWait = () => {};
        const woken = new Promise((resolve) => {
            wakeWait = resolve;
        });
        wakeLaunch = wakeWait;
        const watch = { on: true };
        spawnWatch = watch;
        const settings = settingsOf();
        let lock = null;
        let proc = null;
        try {
            if (!cancelled()) {
                try {
                    lock = await takeLaunchLock();
                } catch (error) {
                    spawnError = error;
                }
            }
            if (lock && !spawnError && !cancelled()) {
                let stderrText = '';
                proc = spawn(settings.command, spawnArgs(settings), {
                    shell: process.platform === 'win32',
                    windowsHide: true,
                    env: spawnEnv(process.env, settings),
                    stdio: ['ignore', 'ignore', 'pipe'],
                });
                child = proc;
                const spawnedNow = positivePid(proc?.pid);
                if (spawnedNow !== null) {
                    ownPid = spawnedNow;
                }
                proc.stderr?.on('data', (chunk) => {
                    if (stderrText.length >= STDERR_CAP) {
                        return;
                    }
                    stderrText += chunk.toString();
                    if (stderrText.length > STDERR_CAP) {
                        stderrText = stderrText.slice(0, STDERR_CAP);
                    }
                });
                proc.on('error', (error) => {
                    if (!watch.on || spawnError) {
                        return;
                    }
                    spawnError = error;
                    wakeWait();
                });
                proc.on('exit', (code) => {
                    if (!watch.on || spawnError || code === 0 || code === null) {
                        return;
                    }
                    const detail = stderrText.trim();
                    const message = detail
                        ? `${settings.command} exited with code ${code}: ${detail}`
                        : `${settings.command} exited with code ${code}`;
                    spawnError = new Error(message);
                    wakeWait();
                });
            }
            const deadline = Date.now() + 10000;
            let found = null;
            while (Date.now() < deadline && !cancelled() && !spawnError) {
                const record = await loadServeRecord(agentHome());
                if (cancelled() || spawnError) {
                    break;
                }
                if (record && pidAlive(record.pid)) {
                    found = record;
                    break;
                }
                await Promise.race([sleep(200), woken]);
            }
            const pending = launchOutcome({ cancelled: cancelled(), spawnError, found });
            if (pending === 'adopt') {
                watch.on = false;
                const spawnedPid = positivePid(proc?.pid) ?? positivePid(child?.pid);
                if (shouldKillSpawnedPid({ ownPid: spawnedPid, spawnedPid, livePid: found.pid })) {
                    ownPid = spawnedPid;
                    if (proc) {
                        child = proc;
                    }
                } else if (!proc) {
                    child = null;
                    ownPid = null;
                } else {
                    ownPid = null;
                }
                showStop();
                return;
            }
            await releaseLaunch(proc, proc !== null && pending !== 'spawn-error');
            ownPid = null;
            showStop();
            const outcome = launchOutcome({ cancelled: cancelled(), spawnError, found });
            if (outcome === 'spawn-error') {
                const message = spawnError.message || String(spawnError);
                vscode.window.showErrorMessage(message);
                post({ type: 'status', state: 'error', detail: message });
                return;
            }
            if (outcome !== 'timeout') {
                return;
            }
            const message = 'serve.json не появился за 10 с';
            vscode.window.showErrorMessage(message);
            post({ type: 'status', state: 'error', detail: message });
        } finally {
            await releaseLaunchLock(lock);
            if (wakeLaunch === wakeWait) {
                wakeLaunch = null;
            }
            if (spawnWatch === watch) {
                spawnWatch = null;
            }
        }
    };

    const ensureServer = async (allowLaunch) => {
        const tokenAtStart = launchToken;
        endpoint = await currentEndpoint();
        const tokenMoved = () => tokenAtStart !== launchToken;
        if (endpoint || !allowLaunch) {
            if (tokenMoved()) {
                return null;
            }
            return endpoint;
        }
        if (tokenMoved() && !launchTask) {
            return null;
        }
        if (!launchTask) {
            launchTask = spawnAndWait().finally(() => {
                launchTask = null;
            });
        }
        const launchedAs = launchToken;
        await launchTask;
        if (launchedAs !== launchToken) {
            return null;
        }
        endpoint = await currentEndpoint();
        if (launchedAs !== launchToken) {
            return null;
        }
        return endpoint;
    };

    const ensureBus = async (allowLaunch) => {
        if (typeof globalThis.WebSocket !== 'function') {
            post({ type: 'status', state: 'error', detail: 'WebSocket недоступен в этом хосте.' });
            return;
        }
        const seen = launchToken;
        const next = await ensureServer(allowLaunch);
        if (seen !== launchToken && (!next || launchToken !== seen + 1)) {
            return;
        }
        if (!next) {
            post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
            return;
        }
        bus.connect(next);
    };

    const reportSubmit = (result) => {
        if (!result) {
            return;
        }
        if (result.error === 'no-workspace') {
            post({ type: 'status', state: 'error', detail: 'нет папки workspace' });
        } else if (result.error === 'empty') {
            post({ type: 'status', state: 'error', detail: 'пустой промпт' });
        } else if (result.error === 'disconnected') {
            post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
        }
    };

    const ensureComplete = async () => {
        if (typeof globalThis.WebSocket !== 'function') {
            flash('WebSocket недоступен в этом хосте.');
            return;
        }
        const next = await currentEndpoint();
        if (!next) {
            return;
        }
        endpoint = next;
        if (completeUrl !== next.completeWs || !complete.isOpen()) {
            completeUrl = next.completeWs;
            complete.connect(next);
        }
    };

    const session = {
        vscode,
        attach(webview) {
            views.add(webview);
            showStop();
        },
        detach(webview) {
            views.delete(webview);
        },
        async onWebview(message) {
            if (!message || typeof message.type !== 'string') {
                return;
            }
            if (message.type === 'ready') {
                showStop();
                await ensureBus(settingsOf().launch);
                return;
            }
            if (message.type === 'reconnect') {
                bus.close();
                complete.close();
                endpoint = null;
                completeUrl = '';
                await ensureBus(false);
                return;
            }
            if (message.type === 'stop') {
                launchToken += 1;
                const wake = wakeLaunch;
                wakeLaunch = null;
                if (wake) {
                    wake();
                }
                if (spawnWatch) {
                    spawnWatch.on = false;
                }
                const spawnedPid = positivePid(child?.pid);
                const ownedPid = ownPid;
                const proc = child;
                child = null;
                try {
                    const record = await loadServeRecord(agentHome());
                    const livePid = record && pidAlive(record.pid) ? record.pid : null;
                    if (shouldKillSpawnedPid({ ownPid: ownedPid, spawnedPid, livePid })) {
                        killPid(livePid);
                    }
                    if (proc) {
                        const childPid = positivePid(proc.pid);
                        const killingLive = childPid !== null && childPid === livePid;
                        if (!killingLive || shouldKillSpawnedPid({ ownPid: ownedPid, spawnedPid: childPid, livePid })) {
                            killChild(proc);
                        }
                    }
                } finally {
                    ownPid = null;
                    child = null;
                    bus.resetPhase();
                    bus.close();
                    complete.close();
                    endpoint = null;
                    completeUrl = '';
                    showStop();
                    post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
                }
                return;
            }
            if (message.type === 'start') {
                await ensureBus(true);
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                const result = bus.submit({
                    command: message.command,
                    prompt: message.prompt,
                    cwd,
                    approve: settingsOf().approve,
                });
                if (result && typeof result.then === 'function') {
                    reportSubmit(await result);
                    return;
                }
                reportSubmit(result);
                return;
            }
            if (message.type === 'cancel') {
                bus.cancel();
                return;
            }
            if (message.type === 'approve') {
                bus.approve(message.requestId, message.decision);
                return;
            }
            if (message.type === 'answer') {
                bus.answer(message.requestId, message.text);
            }
        },
    };

    const provider = new AgentViewProvider(context.extensionUri, session);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(registerAgentCompletion(vscode, {
        request: async (body, token) => {
            await ensureComplete();
            return complete.request(body, token);
        },
    }, settingsOf, flash));
    context.subscriptions.push(vscode.commands.registerCommand('vext.agent.start', () => ensureBus(true)));
    context.subscriptions.push(vscode.commands.registerCommand('vext.agent.stop', () => session.onWebview({ type: 'stop' })));
    context.subscriptions.push(vscode.commands.registerCommand('vext.agent.reconnect', () => session.onWebview({ type: 'reconnect' })));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('vext.agent')) {
            return;
        }
        bus.close();
        complete.close();
        endpoint = null;
        completeUrl = '';
        const launch = settingsOf().launch;
        if (views.size > 0 || launch) {
            void ensureBus(launch);
        }
    }));
    if (settingsOf().launch) {
        void ensureServer(true);
    }
    context.subscriptions.push({ dispose: () => { bus.close(); complete.close(); } });
}
