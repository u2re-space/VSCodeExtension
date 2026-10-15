import { spawn } from 'node:child_process';

import vscodeAPI from '../imports/api.ts';
import { createBus } from './bus.mjs';
import { createCompleteClient, registerAgentCompletion } from './complete.mjs';
import { agentHome, loadServeRecord, pidAlive, resolveEndpoint } from './endpoint.mjs';
import { AgentViewProvider } from './panel.mjs';
import { launchOutcome, readAgentSettings, spawnArgs, spawnEnv } from './settings.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const killPid = (pid) => {
    try {
        process.kill(pid);
    } catch (error) {
        if (error?.code !== 'ESRCH') {
            throw error;
        }
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
            try {
                proc.kill();
            } catch { /* already gone */ }
            if (child === proc) {
                child = null;
            }
        }
        if (!killFilePid) {
            return;
        }
        const record = await loadServeRecord(agentHome());
        if (record && pidAlive(record.pid)) {
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
        const proc = spawn(settings.command, spawnArgs(settings), {
            shell: process.platform === 'win32',
            windowsHide: true,
            env: spawnEnv(process.env, settings),
        });
        proc.on('error', (error) => {
            if (!watch.on || spawnError) {
                return;
            }
            spawnError = error;
            wakeWait();
        });
        child = proc;
        const deadline = Date.now() + 10000;
        let found = null;
        try {
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
                ownPid = found.pid;
                post({ type: 'stopVisible', visible: true });
                return;
            }
            await releaseLaunch(proc, pending !== 'spawn-error');
            ownPid = null;
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
            if (wakeLaunch === wakeWait) {
                wakeLaunch = null;
            }
            if (spawnWatch === watch) {
                spawnWatch = null;
            }
        }
    };

    const ensureServer = async (allowLaunch) => {
        endpoint = await currentEndpoint();
        if (endpoint || !allowLaunch) {
            return endpoint;
        }
        if (!launchTask) {
            launchTask = spawnAndWait().finally(() => {
                launchTask = null;
            });
        }
        await launchTask;
        endpoint = await currentEndpoint();
        return endpoint;
    };

    const ensureBus = async (allowLaunch) => {
        if (typeof globalThis.WebSocket !== 'function') {
            post({ type: 'status', state: 'error', detail: 'WebSocket недоступен в этом хосте.' });
            return;
        }
        const next = await ensureServer(allowLaunch);
        if (!next) {
            post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
            return;
        }
        bus.connect(next);
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
            post({ type: 'stopVisible', visible: ownPid !== null });
        },
        detach(webview) {
            views.delete(webview);
        },
        async onWebview(message) {
            if (!message || typeof message.type !== 'string') {
                return;
            }
            if (message.type === 'ready') {
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
                const inFlight = launchTask !== null;
                launchToken += 1;
                const wake = wakeLaunch;
                wakeLaunch = null;
                if (wake) {
                    wake();
                }
                if (spawnWatch) {
                    spawnWatch.on = false;
                }
                try {
                    if (ownPid !== null) {
                        killPid(ownPid);
                    }
                    if (child) {
                        try {
                            child.kill();
                        } catch { /* already gone */ }
                        child = null;
                    }
                    if (inFlight) {
                        const record = await loadServeRecord(agentHome());
                        if (record && pidAlive(record.pid)) {
                            killPid(record.pid);
                        }
                    }
                } finally {
                    ownPid = null;
                    bus.close();
                    complete.close();
                    endpoint = null;
                    completeUrl = '';
                    post({ type: 'stopVisible', visible: false });
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
                if (result.error === 'no-workspace') {
                    post({ type: 'status', state: 'error', detail: 'нет папки workspace' });
                } else if (result.error === 'empty') {
                    post({ type: 'status', state: 'error', detail: 'пустой промпт' });
                } else if (result.error === 'disconnected') {
                    post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
                }
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
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, provider));
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
