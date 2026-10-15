import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { agentHtml } from '../src/agent/html.mjs';
import { createBus } from '../src/agent/bus.mjs';
import { createCompleteClient } from '../src/agent/complete.mjs';
import { __agentTest } from '../src/agent/endpoint.mjs';
import { __agentTest as protocolTest } from '../src/agent/protocol.mjs';
import { readAgentSettings, spawnArgs, spawnEnv } from '../src/agent/settings.mjs';

const { agentHome, parseServeRecord, pidAlive, loadServeRecord, resolveEndpoint } = __agentTest;

const {
    nextDelay, submissionFrame, approveFrame, completionRequest, acceptCompletion,
    panelMessageFromEvent, panelMessageFromHub, FULL_BYTES,
} = protocolTest;

suite('agent endpoint', () => {
    const live = { pid: 42, url: 'ws://127.0.0.1:1111', token: 'file-token' };

    test('uses AI_AGENT_HOME when it is set', () => {
        assert.strictEqual(agentHome({ AI_AGENT_HOME: ' D:\\ai ' }, 'C:\\Users\\me'), 'D:\\ai');
        assert.strictEqual(agentHome({}, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.ai-agent'));
    });

    test('parses a serve record and rejects broken json', () => {
        assert.deepStrictEqual(parseServeRecord(JSON.stringify(live)), live);
        assert.strictEqual(parseServeRecord('{'), null);
        assert.strictEqual(parseServeRecord(JSON.stringify({ pid: 0, url: live.url, token: 'x' })), null);
    });

    test('treats this process as alive and a non pid as dead', () => {
        assert.strictEqual(pidAlive(process.pid), true);
        assert.strictEqual(pidAlive(0), false);
        assert.strictEqual(pidAlive('42'), false);
    });

    test('reads serve.json from a directory', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vext-agent-'));
        fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify(live));
        assert.deepStrictEqual(await loadServeRecord(dir), live);
        fs.writeFileSync(path.join(dir, 'serve.json'), '{');
        assert.strictEqual(await loadServeRecord(dir), null);
        assert.strictEqual(await loadServeRecord(path.join(dir, 'missing')), null);
    });

    test('returns the file url and token for a live record', () => {
        const got = resolveEndpoint({ record: live, settings: { port: 0, token: '' }, ownPid: null, alive: true });
        assert.strictEqual(got.url, 'ws://127.0.0.1:1111');
        assert.strictEqual(got.token, 'file-token');
        assert.strictEqual(got.completeWs, 'ws://127.0.0.1:1111/v1/complete?token=file-token');
    });

    test('replaces only the port when the setting is nonzero', () => {
        const got = resolveEndpoint({ record: live, settings: { port: 8765, token: '' }, ownPid: null, alive: true });
        assert.strictEqual(got.url, 'ws://127.0.0.1:8765');
        assert.strictEqual(got.token, 'file-token');
        assert.strictEqual(got.completeWs, 'ws://127.0.0.1:8765/v1/complete?token=file-token');
    });

    test('replaces the token unless this extension owns the pid', () => {
        const foreign = resolveEndpoint({ record: live, settings: { port: 0, token: 'other' }, ownPid: 7, alive: true });
        assert.strictEqual(foreign.token, 'other');
        assert.strictEqual(foreign.completeWs, 'ws://127.0.0.1:1111/v1/complete?token=other');
        const owned = resolveEndpoint({ record: live, settings: { port: 0, token: 'other' }, ownPid: 42, alive: true });
        assert.strictEqual(owned.token, 'file-token');
    });

    test('encodes the token in the completion url', () => {
        const got = resolveEndpoint({
            record: { pid: 42, url: 'ws://127.0.0.1:1111', token: 'a+b/c=' },
            settings: { port: 0, token: '' },
            ownPid: null,
            alive: true,
        });
        assert.strictEqual(got.completeWs, 'ws://127.0.0.1:1111/v1/complete?token=a%2Bb%2Fc%3D');
    });

    test('has no address when the pid is dead and settings are empty', () => {
        assert.strictEqual(resolveEndpoint({ record: live, settings: { port: 0, token: '' }, ownPid: null, alive: false }), null);
        assert.strictEqual(resolveEndpoint({ record: null, settings: { port: 0, token: '' }, ownPid: null, alive: false }), null);
    });

    test('uses the settings address when the file is not live', () => {
        const got = resolveEndpoint({ record: live, settings: { port: 9000, token: 'set' }, ownPid: null, alive: false });
        assert.strictEqual(got.url, 'ws://127.0.0.1:9000');
        assert.strictEqual(got.token, 'set');
    });
});

suite('agent protocol', () => {
    test('doubles the reconnect delay up to 30 seconds', () => {
        assert.strictEqual(nextDelay(0), 2000);
        assert.strictEqual(nextDelay(2000), 4000);
        assert.strictEqual(nextDelay(4000), 8000);
        assert.strictEqual(nextDelay(8000), 16000);
        assert.strictEqual(nextDelay(16000), 30000);
        assert.strictEqual(nextDelay(30000), 30000);
    });

    test('builds start and cancels a run that is still going', () => {
        const idle = submissionFrame({ command: 'run', prompt: 'fix', cwd: 'C:\\work', approve: 'ask', phase: 'idle' });
        assert.deepStrictEqual(idle.frames, [
            { type: 'start', command: 'run', prompt: 'fix', cwd: 'C:\\work', approve: 'ask' },
        ]);
        const busy = submissionFrame({
            command: 'ask', prompt: 'why', cwd: 'C:\\work', approve: 'read', phase: { runId: 'r1', command: 'run' },
        });
        assert.strictEqual(busy.frames[0].type, 'cancel');
        assert.strictEqual(busy.frames[0].runId, 'r1');
        assert.strictEqual(busy.frames[1].command, 'ask');
        const image = submissionFrame({ command: 'image', prompt: 'icon', cwd: 'C:\\work', approve: 'ask', phase: 'idle' });
        assert.strictEqual(image.frames[0].command, 'image');
    });

    test('sends chat follow-ups as input', () => {
        const first = submissionFrame({ command: 'chat', prompt: 'hi', cwd: 'C:\\work', approve: 'ask', phase: 'idle' });
        assert.strictEqual(first.frames[0].type, 'start');
        const next = submissionFrame({
            command: 'chat', prompt: '/exit', cwd: '', approve: 'ask', phase: { runId: 'c1', command: 'chat' },
        });
        assert.deepStrictEqual(next.frames, [{ type: 'input', runId: 'c1', text: '/exit' }]);
    });

    test('rejects an empty prompt, a missing folder, and a start that has not been acknowledged', () => {
        assert.strictEqual(submissionFrame({ command: 'run', prompt: '  ', cwd: 'C:\\work', approve: 'ask', phase: 'idle' }).error, 'empty');
        assert.strictEqual(submissionFrame({ command: 'run', prompt: 'x', cwd: '', approve: 'ask', phase: 'idle' }).error, 'no-workspace');
        assert.strictEqual(submissionFrame({ command: 'run', prompt: 'x', cwd: 'C:\\work', approve: 'ask', phase: 'starting' }).error, 'pending');
    });

    test('builds approval decisions', () => {
        for (const decision of ['yes', 'no', 'always', 'abort']) {
            assert.deepStrictEqual(approveFrame('q1', decision), { type: 'approve', requestId: 'q1', decision });
        }
    });

    test('sends a small document whole and windows a large one', () => {
        const small = completionRequest({
            id: '1', language: 'javascript', path: 'C:\\a.js', text: 'let a = ', cursor: { line: 0, character: 8 },
        });
        assert.strictEqual(small.content, 'let a = ');
        assert.strictEqual(small.path, 'C:\\a.js');
        assert.strictEqual(small.cursor.line, 0);
        const line = 'x'.repeat(80);
        const lines = Array.from({ length: 4000 }, () => line);
        const text = lines.join('\n');
        assert.ok(Buffer.byteLength(text, 'utf8') > FULL_BYTES);
        const windowed = completionRequest({
            id: '2', language: 'javascript', path: 'C:\\a.js', text, cursor: { line: 1000, character: 3 },
        });
        assert.notStrictEqual(windowed.content, text);
        assert.strictEqual(windowed.cursor.line, 200);
        assert.strictEqual(windowed.cursor.character, 3);
        const huge = 'y'.repeat(900001);
        assert.strictEqual(completionRequest({
            id: '3', language: 'plaintext', path: undefined, text: huge, cursor: { line: 0, character: 0 },
        }), null);
    });

    test('accepts only the matching nonempty completion', () => {
        assert.strictEqual(acceptCompletion('2', { type: 'completion', id: '2', text: 'items.length' }), 'items.length');
        assert.strictEqual(acceptCompletion('2', { type: 'completion', id: '1', text: 'nope' }), null);
        assert.strictEqual(acceptCompletion('2', { type: 'completion', id: '2', text: '' }), null);
    });

    test('maps stream events and drops reasoning from the log', () => {
        assert.deepStrictEqual(panelMessageFromEvent({ type: 'text.delta', text: 'hi' }), { type: 'text', text: 'hi' });
        assert.strictEqual(panelMessageFromEvent({ type: 'tool.exec.done', name: 'write', ok: true, summary: 'saved' }).type, 'log');
        assert.strictEqual(panelMessageFromEvent({ type: 'reasoning.delta', text: 'secret' }).type, 'status');
        assert.notStrictEqual(panelMessageFromEvent({ type: 'reasoning.delta', text: 'secret' }).type, 'log');
        const ended = panelMessageFromHub({ type: 'run.ended', runId: 'r1', status: 'completed', exitCode: 0 });
        assert.strictEqual(ended.status, 'ended');
        assert.strictEqual(ended.exitCode, 0);
    });
});

class FakeSocket {
    static latest = null;
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.listeners = {};
        FakeSocket.latest = this;
    }
    send(data) {
        this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code });
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    receive(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

suite('agent bus', () => {
    test('says hello and starts a run', () => {
        const messages = [];
        const statuses = [];
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: (message) => messages.push(message),
            onStatus: (message) => statuses.push(message),
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        FakeSocket.latest.open();
        assert.deepStrictEqual(FakeSocket.latest.sent[0], { type: 'hello', role: 'client', token: 'tok' });
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        assert.strictEqual(statuses.at(-1).state, 'ready');
        const result = bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(result.frames[0].type, 'start');
        assert.strictEqual(FakeSocket.latest.sent.at(-1).command, 'run');
        const pending = bus.submit({ command: 'ask', prompt: 'more', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(pending.error, 'pending');
        FakeSocket.latest.receive({ type: 'run.started', run: { id: 'r1', command: 'run', status: 'running' } });
        const follow = bus.submit({ command: 'chat', prompt: 'hi', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(follow.frames[0].type, 'cancel');
        bus.close();
    });

    test('stops retrying after an unauthorized hello', () => {
        const scheduled = [];
        const statuses = [];
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: (message) => statuses.push(message),
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'bad' });
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'error', code: 'unauthorized', message: 'Неверный токен.' });
        FakeSocket.latest.close(1008);
        assert.strictEqual(scheduled.length, 0);
        assert.strictEqual(statuses.at(-1).state, 'unauthorized');
        bus.close();
    });

    test('schedules a growing retry after a drop', () => {
        const scheduled = [];
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        FakeSocket.latest.open();
        FakeSocket.latest.close(1006);
        assert.strictEqual(scheduled[0].ms, 2000);
        scheduled[0].fn();
        FakeSocket.latest.open();
        FakeSocket.latest.close(1006);
        assert.strictEqual(scheduled[1].ms, 4000);
        bus.close();
    });

    test('ignores run.started before a local start', () => {
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        FakeSocket.latest.receive({ type: 'run.started', run: { id: 'r1', command: 'run', status: 'running' } });
        const result = bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(result.frames.length, 1);
        assert.strictEqual(result.frames[0].type, 'start');
        bus.close();
    });

    test('clears starting phase after a drop so submit can start again', () => {
        const scheduled = [];
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        FakeSocket.latest.close(1006);
        scheduled[0].fn();
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        const result = bus.submit({ command: 'run', prompt: 'again', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(result.error, undefined);
        assert.strictEqual(result.frames[0].type, 'start');
        bus.close();
    });
});

suite('agent complete', () => {
    test('resolves the completion with the same id', async () => {
        const client = createCompleteClient({ WebSocketImpl: FakeSocket, onStatus: () => {} });
        client.connect({ completeWs: 'ws://127.0.0.1:8765/v1/complete?token=tok' });
        FakeSocket.latest.open();
        const pending = client.request({ type: 'complete', id: '7', content: 'a', cursor: { line: 0, character: 1 } }, { isCancellationRequested: false, onCancellationRequested: () => {} });
        assert.strictEqual(FakeSocket.latest.sent[0].id, '7');
        FakeSocket.latest.receive({ type: 'completion', id: '1', text: 'stale' });
        FakeSocket.latest.receive({ type: 'completion', id: '7', text: 'bc' });
        assert.strictEqual(await pending, 'bc');
        client.close();
    });

    test('returns null for an empty completion', async () => {
        const client = createCompleteClient({ WebSocketImpl: FakeSocket, onStatus: () => {} });
        client.connect({ completeWs: 'ws://127.0.0.1:8765/v1/complete?token=tok' });
        FakeSocket.latest.open();
        const pending = client.request({ type: 'complete', id: '8', content: 'a', cursor: { line: 0, character: 1 } }, { isCancellationRequested: false, onCancellationRequested: () => {} });
        FakeSocket.latest.receive({ type: 'completion', id: '8', text: '' });
        assert.strictEqual(await pending, null);
        client.close();
    });

    test('resolves null when closed before the socket opens', async () => {
        const client = createCompleteClient({ WebSocketImpl: FakeSocket, onStatus: () => {} });
        client.connect({ completeWs: 'ws://127.0.0.1:8765/v1/complete?token=tok' });
        const pending = client.request({ type: 'complete', id: '9', content: 'a', cursor: { line: 0, character: 1 } }, { isCancellationRequested: false, onCancellationRequested: () => {} });
        client.close();
        assert.strictEqual(await pending, null);
        assert.strictEqual(FakeSocket.latest.sent.length, 0);
    });

    test('resolves null when cancelled before the socket opens', async () => {
        const client = createCompleteClient({ WebSocketImpl: FakeSocket, onStatus: () => {} });
        client.connect({ completeWs: 'ws://127.0.0.1:8765/v1/complete?token=tok' });
        const pending = client.request({ type: 'complete', id: '10', content: 'a', cursor: { line: 0, character: 1 } }, { isCancellationRequested: true, onCancellationRequested: () => {} });
        assert.strictEqual(await pending, null);
        assert.strictEqual(FakeSocket.latest.sent.length, 0);
        client.close();
    });
});

suite('agent panel', () => {
    test('renders the command buttons and a locked down csp', () => {
        const html = agentHtml({
            cssHref: 'https://vscode.local/webview.css',
            scriptHref: 'https://vscode.local/agent.mjs',
            nonce: 'abc',
            cspSource: 'https://vscode.local',
        });
        assert.match(html, /default-src 'none'/);
        assert.match(html, /script-src https:\/\/vscode\.local 'nonce-abc'/);
        assert.match(html, /data-command="run"/);
        assert.match(html, /data-command="ask"/);
        assert.match(html, /data-command="chat"/);
        assert.match(html, /data-command="image"/);
        assert.match(html, /id="reconnect"/);
        assert.match(html, /id="stop"/);
        assert.match(html, /id="prompt"/);
        assert.match(html, /id="log"/);
        assert.match(html, /agent-body/);
    });
});

suite('agent settings', () => {
    test('reads defaults and spawn inputs', () => {
        const values = new Map([
            ['vext.agent.port', 8765],
            ['vext.agent.token', ''],
            ['vext.agent.openaiBaseUrl', 'https://example.test/v1'],
            ['vext.agent.openaiApiKey', ''],
            ['vext.agent.launch', false],
            ['vext.agent.command', 'ai'],
            ['vext.agent.approve', 'nope'],
            ['vext.agent.completion.enabled', true],
            ['vext.agent.completion.debounceMs', 350],
        ]);
        const settings = readAgentSettings((key) => values.get(key));
        assert.strictEqual(settings.port, 8765);
        assert.strictEqual(settings.approve, 'ask');
        assert.deepStrictEqual(spawnArgs(settings), ['serve', '--port', '8765']);
        assert.deepStrictEqual(spawnArgs({ ...settings, port: 0 }), ['serve']);
        const env = spawnEnv({ PATH: 'C:\\bin' }, { ...settings, openaiApiKey: 'secret' });
        assert.strictEqual(env.OPENAI_BASE_URL, 'https://example.test/v1');
        assert.strictEqual(env.OPENAI_API_KEY, 'secret');
        assert.strictEqual(env.PATH, 'C:\\bin');
        const untouched = spawnEnv({ PATH: 'C:\\bin' }, { ...settings, openaiBaseUrl: '', openaiApiKey: '' });
        assert.strictEqual(untouched.OPENAI_API_KEY, undefined);
    });

    test('package.json contributes the agent view, commands, and settings', () => {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const ids = pkg.contributes.commands.map((command) => command.command);
        assert.ok(ids.includes('vext.agent.start'));
        assert.ok(ids.includes('vext.agent.stop'));
        assert.ok(ids.includes('vext.agent.reconnect'));
        assert.ok(pkg.contributes.views.agentView.some((view) => view.id === 'vext.agentView'));
        assert.strictEqual(pkg.contributes.configuration.properties['vext.agent.port'].default, 0);
        assert.strictEqual(pkg.contributes.configuration.properties['vext.agent.launch'].default, false);
        assert.strictEqual(pkg.contributes.configuration.properties['vext.agent.completion.debounceMs'].default, 350);
    });
});
