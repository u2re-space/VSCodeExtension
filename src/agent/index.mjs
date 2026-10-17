import vscodeAPI from '../imports/api.ts';
import { createBus } from './bus.mjs';
import { createCompleteClient, registerAgentCompletion } from './complete.mjs';
import { createWorkspaceIo, executeProcessing } from './processing.mjs';
import { agentHome, loadServeRecord, pidAlive, resolveEndpoint } from './endpoint.mjs';
import { AgentViewProvider } from './panel.mjs';
import { launchOutcome, readAgentSettings, shouldKillSpawnedPid, shouldReconnectAgent, spawnArgs, spawnEnv } from './settings.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const positivePid = (pid) => (Number.isInteger(pid) && pid > 0 ? pid : null);

const missingFile = (error) => error?.code === 'FileNotFound' || error?.code === 'EntryNotFound';

const isWindows = (vscode) => {
    const shell = String(vscode.env?.shell ?? '');
    return shell.includes('\\') || /\.exe$/i.test(shell);
};

const lockUri = (vscode) => vscode.Uri.joinPath(vscode.Uri.file(agentHome()), 'launch.lock');

const readLock = async (vscode, uri) => {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return decoder.decode(bytes).trim();
};

const taskPresentation = (vscode) => ({
    reveal: vscode.TaskRevealKind.Never,
    echo: false,
    focus: false,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: false,
    close: true,
});

const runTask = async (vscode, name, execution, onStart, onEnd) => {
    const task = new vscode.Task({ type: execution instanceof vscode.ProcessExecution ? 'process' : 'shell' }, vscode.TaskScope.Global, name, 'U2RE Agent', execution);
    task.presentationOptions = taskPresentation(vscode);
    const started = [];
    const ended = [];
    let executionHandle = null;
    const handle = {
        execution: null,
        pid: null,
        kill() {
            try {
                executionHandle?.terminate();
            } catch {
                /* already gone */
            }
        },
        dispose() {},
    };
    const remember = (bucket, event) => {
        if (!executionHandle || event.execution === executionHandle) {
            bucket.push(event);
        }
    };
    const startSub = vscode.tasks.onDidStartTaskProcess((event) => {
        if (!executionHandle) {
            remember(started, event);
            return;
        }
        if (event.execution === executionHandle && positivePid(event.processId)) {
            handle.pid = event.processId;
            onStart?.(event.processId);
        }
    });
    const endSub = vscode.tasks.onDidEndTaskProcess((event) => {
        if (!executionHandle) {
            remember(ended, event);
            return;
        }
        if (event.execution === executionHandle) {
            onEnd?.(event.exitCode);
        }
    });
    try {
        executionHandle = await vscode.tasks.executeTask(task);
    } catch (error) {
        startSub.dispose();
        endSub.dispose();
        throw error;
    }
    handle.execution = executionHandle;
    handle.dispose = () => {
        startSub.dispose();
        endSub.dispose();
    };
    for (const event of started) {
        if (event.execution === executionHandle && positivePid(event.processId)) {
            handle.pid = event.processId;
            onStart?.(event.processId);
        }
    }
    for (const event of ended) {
        if (event.execution === executionHandle) {
            onEnd?.(event.exitCode);
        }
    }
    return handle;
};

const endPid = async (vscode, pid) => {
    if (!positivePid(pid)) {
        return;
    }
    const execution = isWindows(vscode)
        ? new vscode.ProcessExecution('taskkill', ['/T', '/F', '/PID', String(pid)])
        : new vscode.ProcessExecution('kill', ['-KILL', String(pid)]);
    try {
        const handle = await runTask(vscode, 'stop', execution);
        handle.dispose();
    } catch {
        /* already gone */
    }
};

const killHandle = (proc) => {
    if (!proc) {
        return;
    }
    proc.kill?.();
    proc.dispose?.();
};

const takeLaunchLock = async (vscode) => {
    const uri = lockUri(vscode);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(agentHome()));
    const marker = String(process.pid);
    const claim = async () => {
        await vscode.workspace.fs.writeFile(uri, encoder.encode(marker));
        const current = await readLock(vscode, uri);
        if (current !== marker) {
            return null;
        }
        return { uri, marker };
    };
    let existing = null;
    try {
        existing = await readLock(vscode, uri);
    } catch (error) {
        if (!missingFile(error)) {
            throw error;
        }
    }
    if (existing !== null) {
        const holder = Number(existing);
        if (Number.isInteger(holder) && pidAlive(holder)) {
            return null;
        }
        try {
            await vscode.workspace.fs.delete(uri);
        } catch {
            return null;
        }
    }
    try {
        return await claim();
    } catch {
        return null;
    }
};

const releaseLaunchLock = async (vscode, lock) => {
    if (!lock) {
        return;
    }
    try {
        const current = await readLock(vscode, lock.uri);
        if (current === lock.marker) {
            await vscode.workspace.fs.delete(lock.uri);
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
    let completionOffline = false;

    const settingsOf = () => readAgentSettings((key) => vscode.workspace.getConfiguration().get(key));

    const post = (message) => {
        for (const webview of views) {
            webview.postMessage(message);
        }
    };

    const showStop = () => {
        post({ type: 'stopVisible', visible: ownPid !== null });
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
        onToolRequest: (frame, cwd, signal) => {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const root = typeof cwd === 'string' && cwd.trim() ? cwd : folder;
            if (!root) {
                return executeProcessing(frame, { root: '' }, signal);
            }
            return executeProcessing(frame, createWorkspaceIo(vscode, root), signal);
        },
        onMessage: (message) => post(message),
        onStatus: (message) => {
            const detail = message.detail || (message.state === 'ready' ? endpoint?.url : message.state);
            post({ ...message, detail: message.detail || detail });
            if (message.state === 'ready' && endpoint) {
                post({ type: 'status', state: 'ready', detail: endpoint.url });
                if (settingsOf().completionEnabled) {
                    void ensureComplete();
                }
            }
        },
    });

    const complete = createCompleteClient({
        WebSocketImpl: globalThis.WebSocket,
        onStatus: (detail) => flash(detail),
    });

    const currentEndpoint = async () => {
        const settings = settingsOf();
        const record = await loadServeRecord(vscode, agentHome());
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
            killHandle(proc);
            if (child === proc) {
                child = null;
            }
        }
        if (!killFilePid) {
            return;
        }
        const record = await loadServeRecord(vscode, agentHome());
        const spawnedPid = positivePid(proc?.pid);
        if (record && pidAlive(record.pid) && shouldKillSpawnedPid({
            ownPid: spawnedPid,
            livePid: record.pid,
        })) {
            await endPid(vscode, record.pid);
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
                    lock = await takeLaunchLock(vscode);
                } catch (error) {
                    spawnError = error;
                }
            }
            if (lock && !spawnError && !cancelled()) {
                const env = spawnEnv({}, settings);
                const options = Object.keys(env).length > 0 ? { env } : undefined;
                try {
                    proc = await runTask(
                        vscode,
                        'serve',
                        new vscode.ShellExecution(settings.command, spawnArgs(settings), options),
                        (pid) => {
                            if (ownPid === null && watch.on) {
                                ownPid = pid;
                                showStop();
                            }
                        },
                        (code) => {
                            if (!watch.on || spawnError || code === 0 || code === undefined || code === null) {
                                return;
                            }
                            spawnError = new Error(`${settings.command} exited with code ${code}`);
                            wakeWait();
                        },
                    );
                } catch (error) {
                    spawnError = error;
                    wakeWait();
                }
                child = proc;
                const spawnedNow = positivePid(proc?.pid);
                if (spawnedNow !== null && ownPid === null) {
                    ownPid = spawnedNow;
                }
            }
            const deadline = Date.now() + 10000;
            let found = null;
            while (Date.now() < deadline && !cancelled() && !spawnError) {
                const record = await loadServeRecord(vscode, agentHome());
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
                if (proc) {
                    child = proc;
                    const filePid = positivePid(found.pid);
                    if (filePid !== null) {
                        ownPid = filePid;
                    }
                } else {
                    child = null;
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
            await releaseLaunchLock(vscode, lock);
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
            if (settingsOf().completionEnabled && !completionOffline) {
                completionOffline = true;
                flash('агент не запущен');
            }
            return;
        }
        completionOffline = false;
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
                const ownedPid = ownPid;
                const proc = child;
                child = null;
                try {
                    const record = await loadServeRecord(vscode, agentHome());
                    const livePid = record && pidAlive(record.pid) ? record.pid : null;
                    if (shouldKillSpawnedPid({ ownPid: ownedPid, livePid })) {
                        await endPid(vscode, livePid);
                    }
                    if (proc) {
                        const childPid = positivePid(proc.pid);
                        const killingLive = childPid !== null && childPid === livePid;
                        if (!killingLive || shouldKillSpawnedPid({ ownPid: ownedPid, livePid })) {
                            killHandle(proc);
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
        if (!shouldReconnectAgent((section) => event.affectsConfiguration(section))) {
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
        void ensureServer(true).then(() => {
            if (settingsOf().completionEnabled) {
                void ensureComplete();
            }
        });
    }
    context.subscriptions.push({ dispose: () => { bus.close(); complete.close(); } });
}
