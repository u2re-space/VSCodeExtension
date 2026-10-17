import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { agentHtml } from '../src/agent/html.mjs';
import { createBus } from '../src/agent/bus.mjs';
import { createCompleteClient, registerAgentCompletion } from '../src/agent/complete.mjs';
import { __agentTest } from '../src/agent/endpoint.mjs';
import { createWorkspaceIo, executeProcessing } from '../src/agent/processing.mjs';
import { __agentTest as protocolTest } from '../src/agent/protocol.mjs';
import { launchOutcome, readAgentSettings, shouldKillSpawnedPid, shouldReconnectAgent, spawnArgs, spawnEnv } from '../src/agent/settings.mjs';

const { agentHome, parseServeRecord, pidAlive, loadServeRecord, resolveEndpoint } = __agentTest;

const {
    nextDelay, submissionFrame, approveFrame, completionRequest, acceptCompletion,
    panelMessageFromEvent, panelMessageFromHub, FULL_BYTES,
    PROCESSABLE, claimFrames, toolResultFrame,
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
        const vscode = {
            Uri: {
                file: (file) => ({ fsPath: file, scheme: 'file' }),
                joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), scheme: 'file' }),
            },
            workspace: {
                fs: {
                    readFile: async (uri) => fs.readFileSync(uri.fsPath),
                },
            },
        };
        fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify(live));
        assert.deepStrictEqual(await loadServeRecord(vscode, dir), live);
        fs.writeFileSync(path.join(dir, 'serve.json'), '{');
        assert.strictEqual(await loadServeRecord(vscode, dir), null);
        assert.strictEqual(await loadServeRecord(vscode, path.join(dir, 'missing')), null);
        fs.rmSync(dir, { recursive: true, force: true });
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
            { type: 'start', command: 'run', prompt: 'fix', cwd: 'C:\\work', approve: 'ask', processing: PROCESSABLE.slice() },
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
        assert.strictEqual(next.frames[0].processing, undefined);
    });

    test('claims only a running client run and builds a tool result', () => {
        assert.deepStrictEqual(claimFrames([
            { id: 'c1', source: 'client', status: 'running' },
            { id: 't1', source: 'terminal', status: 'running' },
            { id: 'old', source: 'client', status: 'ended' },
            { id: '', source: 'client', status: 'running' },
        ]), [{ type: 'processing.claim', runId: 'c1', tools: PROCESSABLE.slice() }]);
        assert.deepStrictEqual(claimFrames(null), []);
        const done = toolResultFrame('q1', { output: 'body', summary: 'sum', changes: [{ op: 'edit', path: 'a.js' }, { op: 'nope', path: 'b.js' }] });
        assert.deepStrictEqual(done, { type: 'tool.result', requestId: 'q1', output: 'body', summary: 'sum', changes: [{ op: 'edit', path: 'a.js' }] });
        assert.deepStrictEqual(toolResultFrame('q2', { error: ' Файл не найден ' }), { type: 'tool.result', requestId: 'q2', error: 'Файл не найден' });
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
            model: 'x-ai/grok-4.7',
        });
        assert.strictEqual(small.model, 'x-ai/grok-4.7');
        assert.strictEqual(small.content, 'let a = ');
        assert.strictEqual(small.path, 'C:\\a.js');
        assert.strictEqual(small.cursor.line, 0);
        const withContext = completionRequest({
            id: '1', language: 'javascript', path: 'C:\\a.js', text: 'let a = ', cursor: { line: 0, character: 8 },
            problems: [{ line: 0, character: 0, severity: 'error', source: 'eslint', message: 'oops' }],
            validation: [{ line: 1, character: 0, severity: 'error', source: 'typescript', message: 'missing' }],
            files: ['src/a.js', 'node_modules/pkg/index.js'],
        });
        assert.strictEqual(withContext.problems[0].source, 'eslint');
        assert.strictEqual(withContext.validation[0].source, 'typescript');
        assert.deepStrictEqual(withContext.files, ['src/a.js', 'node_modules/pkg/index.js']);
        const headed = completionRequest({
            id: '4', language: 'javascript', path: 'C:\\a.js',
            text: 'import x from "./x.js";\n\nconst n = ',
            cursor: { line: 2, character: 10 },
            references: [{ path: 'src/util.js', language: 'javascript', content: 'export const n = 1;\n' }],
        });
        assert.match(headed.header, /import x from "\.\/x\.js"/);
        assert.strictEqual(headed.references[0].path, 'src/util.js');
        assert.match(headed.references[0].content, /export const n/);
        const line = 'x'.repeat(80);
        const lines = Array.from({ length: 4000 }, () => line);
        const text = lines.join('\n');
        assert.ok(Buffer.byteLength(text, 'utf8') > FULL_BYTES);
        const windowed = completionRequest({
            id: '2', language: 'javascript', path: 'C:\\a.js', text, cursor: { line: 1000, character: 3 },
            model: 'x-ai/grok-4.7',
        });
        assert.strictEqual(windowed.model, 'x-ai/grok-4.7');
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
        assert.deepStrictEqual(panelMessageFromEvent({ type: 'processing.held', tools: ['read_file', 'write_file'] }), {
            type: 'log', level: 'info', text: 'редактор выполняет: read_file, write_file',
        });
        assert.deepStrictEqual(panelMessageFromHub({ type: 'processing.released', tools: ['read_file'] }), {
            type: 'log', level: 'warn', text: 'редактор отпустил: read_file',
        });
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
        assert.deepStrictEqual(result.frames[0].processing, PROCESSABLE);
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

    test('sends a submit that arrived before ready', async () => {
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        const pending = bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(FakeSocket.latest.sent.some((frame) => frame.type === 'start'), false);
        FakeSocket.latest.open();
        assert.deepStrictEqual(FakeSocket.latest.sent, [{ type: 'hello', role: 'client', token: 'tok' }]);
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        const result = await pending;
        assert.strictEqual(result.frames[0].type, 'start');
        assert.strictEqual(FakeSocket.latest.sent.at(-1).type, 'start');
        bus.close();
    });

    test('drops a queued submit when the socket closes before ready', async () => {
        const scheduled = [];
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        const pending = bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        FakeSocket.latest.close(1006);
        assert.deepStrictEqual(await pending, { error: 'disconnected' });
        scheduled[0].fn();
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        assert.strictEqual(FakeSocket.latest.sent.some((frame) => frame.type === 'start'), false);
        bus.close();
    });

    test('an error while starting lets the next submit start', () => {
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
        bus.submit({ command: 'run', prompt: 'fix tests', cwd: 'C:\\work', approve: 'ask' });
        FakeSocket.latest.receive({ type: 'error', message: 'failed' });
        const result = bus.submit({ command: 'run', prompt: 'again', cwd: 'C:\\work', approve: 'ask' });
        assert.notStrictEqual(result.error, 'pending');
        assert.strictEqual(result.frames[0].type, 'start');
        bus.close();
    });

    test('a ready frame without the current run returns to idle', () => {
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
        FakeSocket.latest.receive({ type: 'run.started', run: { id: 'r1', command: 'run', status: 'running' } });
        FakeSocket.latest.close(1006);
        scheduled[0].fn();
        FakeSocket.latest.open();
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        const result = bus.submit({ command: 'ask', prompt: 'next', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(result.frames.length, 1);
        assert.strictEqual(result.frames[0].type, 'start');
        bus.close();
    });

    test('rebuilds a queued chat follow-up as start when ready omits the run', async () => {
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
        FakeSocket.latest.receive({ type: 'ready', runs: [{ id: 'r1' }] });
        bus.submit({ command: 'chat', prompt: 'hi', cwd: 'C:\\work', approve: 'ask' });
        FakeSocket.latest.receive({ type: 'run.started', run: { id: 'r1', command: 'chat', status: 'running' } });
        FakeSocket.latest.close(1006);
        scheduled[0].fn();
        FakeSocket.latest.open();
        const pending = bus.submit({ command: 'chat', prompt: 'more', cwd: 'C:\\work', approve: 'ask' });
        assert.strictEqual(FakeSocket.latest.sent.some((frame) => frame.type === 'input' || frame.type === 'start'), false);
        FakeSocket.latest.receive({ type: 'ready', runs: [] });
        const result = await pending;
        assert.strictEqual(result.frames.length, 1);
        assert.strictEqual(result.frames[0].type, 'start');
        assert.strictEqual(result.frames[0].command, 'chat');
        assert.strictEqual(result.frames[0].prompt, 'more');
        assert.strictEqual(FakeSocket.latest.sent.some((frame) => frame.type === 'input'), false);
        assert.strictEqual(FakeSocket.latest.sent.some((frame) => frame.type === 'cancel'), false);
        assert.strictEqual(FakeSocket.latest.sent.at(-1).type, 'start');
        bus.close();
    });

    test('does not replace a socket already connecting to the same target', () => {
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        const first = FakeSocket.latest;
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        assert.strictEqual(FakeSocket.latest, first);
        assert.strictEqual(first.readyState, 0);
        first.open();
        first.receive({ type: 'ready', runs: [] });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        assert.strictEqual(FakeSocket.latest, first);
        assert.strictEqual(first.readyState, 1);
        bus.close();
    });

    test('claims a live client run on connect and returns the tool result', async () => {
        let seen;
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
            onToolRequest: async (frame, cwd) => {
                seen = { name: frame.name, cwd };
                return { output: 'body', summary: 'sum', changes: [{ op: 'edit', path: 'a.js' }] };
            },
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        FakeSocket.latest.open();
        FakeSocket.latest.receive({
            type: 'ready',
            runs: [
                { id: 'c1', source: 'client', status: 'running', cwd: 'C:\\work' },
                { id: 't1', source: 'terminal', status: 'running', cwd: 'C:\\term' },
            ],
        });
        const claims = FakeSocket.latest.sent.filter((frame) => frame.type === 'processing.claim');
        assert.strictEqual(claims.length, 1);
        assert.strictEqual(claims[0].runId, 'c1');
        assert.deepStrictEqual(claims[0].tools, PROCESSABLE);
        FakeSocket.latest.receive({ type: 'tool.request', runId: 'c1', requestId: 'q', name: 'read_file', args: { path: 'a.js' } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(seen, { name: 'read_file', cwd: 'C:\\work' });
        assert.deepStrictEqual(FakeSocket.latest.sent.find((frame) => frame.type === 'tool.result'), {
            type: 'tool.result', requestId: 'q', output: 'body', summary: 'sum', changes: [{ op: 'edit', path: 'a.js' }],
        });
        bus.close();
    });

    test('remembers cwd from run.started and drops a result after close', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const bus = createBus({
            WebSocketImpl: FakeSocket,
            schedule: () => 0,
            clearSchedule: () => {},
            onMessage: () => {},
            onStatus: () => {},
            onToolRequest: () => gate.then(() => ({ output: 'late', summary: 's' })),
        });
        bus.connect({ url: 'ws://127.0.0.1:8765', token: 'tok' });
        const socket = FakeSocket.latest;
        socket.open();
        socket.receive({ type: 'ready', runs: [] });
        socket.receive({ type: 'run.started', run: { id: 'r9', command: 'ask', status: 'running', cwd: 'D:\\proj', source: 'client' } });
        assert.strictEqual(socket.sent.some((frame) => frame.type === 'processing.claim'), false);
        socket.receive({ type: 'tool.request', runId: 'r9', requestId: 'q2', name: 'list_files', args: {} });
        bus.close();
        release();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(socket.sent.some((frame) => frame.type === 'tool.result'), false);
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
        assert.match(html, /id="cancel"/);
        assert.match(html, /id="prompt"/);
        assert.match(html, /id="log"/);
        assert.match(html, /agent-body/);
        assert.match(html, /class="more-menu"/);
        assert.match(html, /ph-rocket-launch/);
        assert.match(html, /ph-arrow-clockwise/);
        assert.match(html, /actions-container/);
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
        assert.strictEqual(settings.debounceMs, 350);
        assert.strictEqual(settings.completionModel, 'gpt-6-luna');
        assert.deepStrictEqual(spawnArgs(settings), ['serve', '--port', '8765']);
        assert.deepStrictEqual(spawnArgs({ ...settings, port: 0 }), ['serve']);
        const env = spawnEnv({ PATH: 'C:\\bin' }, { ...settings, openaiApiKey: 'secret' });
        assert.strictEqual(env.OPENAI_BASE_URL, 'https://example.test/v1');
        assert.strictEqual(env.OPENAI_API_KEY, 'secret');
        assert.strictEqual(env.PATH, 'C:\\bin');
        const untouched = spawnEnv({ PATH: 'C:\\bin' }, { ...settings, openaiBaseUrl: '', openaiApiKey: '' });
        assert.strictEqual(untouched.OPENAI_API_KEY, undefined);
    });

    test('an unrecognized completion model setting falls back to gpt-6-luna', () => {
        const settings = readAgentSettings((key) => (key === 'vext.agent.completion.model' ? 'nope' : undefined));
        assert.strictEqual(settings.completionModel, 'gpt-6-luna');
    });

    test('every completion model enum id round-trips through readAgentSettings', () => {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const ids = pkg.contributes.configuration.properties['vext.agent.completion.model'].enum;
        for (const id of ids) {
            const settings = readAgentSettings((key) => (key === 'vext.agent.completion.model' ? id : undefined));
            assert.strictEqual(settings.completionModel, id);
        }
    });

    test('a completion setting change does not reconnect the agent', () => {
        const reconnects = (changed) => shouldReconnectAgent((section) => changed.includes(section));
        assert.strictEqual(reconnects(['vext.agent.completion.model']), false);
        assert.strictEqual(reconnects(['vext.agent.completion.enabled']), false);
        assert.strictEqual(reconnects(['vext.agent.completion.debounceMs']), false);
        assert.strictEqual(reconnects(['vext.agent.approve']), false);
        assert.strictEqual(reconnects(['vext.agent.port']), true);
        assert.strictEqual(reconnects(['vext.agent.token']), true);
        assert.strictEqual(reconnects(['vext.agent.openaiBaseUrl']), true);
        assert.strictEqual(reconnects(['vext.agent.openaiApiKey']), true);
        assert.strictEqual(reconnects(['vext.agent.launch']), true);
        assert.strictEqual(reconnects(['vext.agent.command']), true);
    });

    function host() {
        let provider = null;
        const vscode = {
            Range: class Range {
                constructor(startLine, startCharacter, endLine, endCharacter) {
                    this.start = { line: startLine, character: startCharacter };
                    this.end = { line: endLine, character: endCharacter };
                }
            },
            languages: {
                registerInlineCompletionItemProvider(_selector, value) {
                    provider = value;
                    return { dispose() {} };
                },
            },
        };
        return {
            vscode,
            provider: () => provider,
        };
    }

    test('ghost text inserts at the cursor and sends the selected model', async () => {
        let sent = null;
        const client = { request(body) { sent = body; return Promise.resolve('next'); } };
        const { vscode, provider } = host();
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'x-ai/grok-4.7',
        }));
        const items = await provider().provideInlineCompletionItems(
            { languageId: 'javascript', uri: { scheme: 'untitled' }, version: 1, getText: () => 'const n = ' },
            { line: 0, character: 10 },
            {},
            { isCancellationRequested: false },
        );
        assert.strictEqual(sent.model, 'x-ai/grok-4.7');
        assert.strictEqual(sent.files, undefined);
        assert.strictEqual(sent.references, undefined);
        assert.strictEqual(items.items[0].insertText, 'next');
        assert.strictEqual(items.items[0].filterText, 'next');
        assert.deepStrictEqual(items.items[0].range.start, { line: 0, character: 10 });
        assert.deepStrictEqual(items.items[0].range.end, { line: 0, character: 10 });
    });

    test('open editors are sent as references and the focused file is not repeated', async () => {
        let sent = null;
        const client = { request(body) { sent = body; return Promise.resolve('length'); } };
        const { vscode, provider } = host();
        const focused = {
            languageId: 'javascript',
            uri: { scheme: 'file', fsPath: 'C:\\work\\src\\a.js', toString() { return 'file:///C:/work/src/a.js'; } },
            version: 1,
            getText: () => 'import x from "./util.js";\n\nconst n = ',
        };
        const other = {
            languageId: 'javascript',
            uri: { scheme: 'file', fsPath: 'C:\\work\\src\\util.js', toString() { return 'file:///C:/work/src/util.js'; } },
            getText: () => 'export function total(items) {\n  return items.length;\n}\n',
        };
        vscode.window = { visibleTextEditors: [{ document: focused }, { document: other }] };
        vscode.workspace = { workspaceFolders: [{ uri: { fsPath: 'C:\\work' } }] };
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'gpt-6-luna',
        }));
        const items = await provider().provideInlineCompletionItems(
            focused,
            { line: 2, character: 10 },
            {},
            { isCancellationRequested: false },
        );
        assert.match(sent.header, /import x from "\.\/util\.js"/);
        assert.strictEqual(sent.references.length, 1);
        assert.strictEqual(sent.references[0].path, 'src/util.js');
        assert.match(sent.references[0].content, /function total/);
        assert.strictEqual(items.items[0].insertText, 'length');
        assert.deepStrictEqual(items.items[0].range.start, { line: 2, character: 10 });
        assert.deepStrictEqual(items.items[0].range.end, { line: 2, character: 10 });
    });

    test('a later cursor is not dropped while an older request is in flight', async () => {
        let release = () => {};
        const sent = [];
        const client = {
            request(body) {
                sent.push(body.cursor.character);
                if (body.cursor.character === 1) {
                    return new Promise((resolve) => { release = () => resolve('stale'); });
                }
                return Promise.resolve('fresh');
            },
        };
        const { vscode, provider } = host();
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'gpt-6-luna',
        }));
        const doc = { languageId: 'javascript', uri: { scheme: 'untitled' }, version: 1, getText: () => 'a' };
        const first = provider().provideInlineCompletionItems(doc, { line: 0, character: 1 }, {}, { isCancellationRequested: false });
        const until = Date.now() + 1000;
        while (sent.length < 1 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        const second = await provider().provideInlineCompletionItems(
            { ...doc, getText: () => 'ab' },
            { line: 0, character: 2 },
            {},
            { isCancellationRequested: false },
        );
        release();
        assert.strictEqual(await first, undefined);
        assert.deepStrictEqual(sent, [1, 2]);
        assert.strictEqual(second.items[0].insertText, 'fresh');
        assert.strictEqual(second.items[0].filterText, 'fresh');
        assert.deepStrictEqual(second.items[0].range.start, { line: 0, character: 2 });
        assert.deepStrictEqual(second.items[0].range.end, { line: 0, character: 2 });
    });

    test('a suggestion is not shown after an unrelated edit', async () => {
        let ready = false;
        let release = () => {};
        const client = {
            request() {
                return new Promise((resolve) => {
                    ready = true;
                    release = () => resolve('1');
                });
            },
        };
        const { vscode, provider } = host();
        const doc = {
            languageId: 'javascript',
            uri: { scheme: 'untitled', fsPath: 'mem' },
            version: 1,
            getText: () => 'const a = ',
        };
        vscode.window = {
            activeTextEditor: { document: doc, selection: { active: { line: 0, character: 10 } } },
        };
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'gpt-6-luna',
        }));
        const pending = provider().provideInlineCompletionItems(doc, { line: 0, character: 10 }, {}, { isCancellationRequested: false });
        const until = Date.now() + 1000;
        while (!ready && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(ready, true);
        doc.version = 2;
        doc.getText = () => 'let other = 1;\n';
        vscode.window.activeTextEditor.selection.active = { line: 0, character: 0 };
        release();
        assert.strictEqual(await pending, undefined);
    });

    test('typed text that matches the suggestion leaves only the rest as ghost text', async () => {
        let ready = false;
        let release = () => {};
        const client = {
            request() {
                return new Promise((resolve) => {
                    ready = true;
                    release = () => resolve('1;');
                });
            },
        };
        const { vscode, provider } = host();
        const doc = {
            languageId: 'javascript',
            uri: { scheme: 'untitled', fsPath: 'mem' },
            version: 1,
            getText: () => 'const a = ',
        };
        vscode.window = {
            activeTextEditor: { document: doc, selection: { active: { line: 0, character: 10 } } },
        };
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'gpt-6-luna',
        }));
        const pending = provider().provideInlineCompletionItems(doc, { line: 0, character: 10 }, {}, { isCancellationRequested: false });
        const until = Date.now() + 1000;
        while (!ready && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(ready, true);
        doc.version = 2;
        doc.getText = () => 'const a = 1';
        vscode.window.activeTextEditor.selection.active = { line: 0, character: 11 };
        release();
        const items = await pending;
        assert.strictEqual(items.items[0].insertText, ';');
        assert.strictEqual(items.items[0].filterText, ';');
        assert.deepStrictEqual(items.items[0].range.start, { line: 0, character: 11 });
        assert.deepStrictEqual(items.items[0].range.end, { line: 0, character: 11 });
    });

    test('a cancelled completion does not publish an empty list', async () => {
        const client = { request() { return Promise.resolve('next'); } };
        const { vscode, provider } = host();
        registerAgentCompletion(vscode, client, () => ({
            completionEnabled: true, debounceMs: 0, completionModel: 'gpt-6-luna',
        }));
        const items = await provider().provideInlineCompletionItems(
            { languageId: 'javascript', uri: { scheme: 'untitled' }, version: 1, getText: () => 'a' },
            { line: 0, character: 1 },
            {},
            { isCancellationRequested: true },
        );
        assert.strictEqual(items, undefined);
    });

    test('does not adopt a launch the user stopped', () => {
        const found = { pid: 42 };
        const spawnError = new Error('spawn ai ENOENT');
        assert.strictEqual(launchOutcome({ cancelled: false, spawnError: null, found }), 'adopt');
        assert.strictEqual(launchOutcome({ cancelled: true, spawnError: null, found }), 'cancelled');
        assert.strictEqual(launchOutcome({ cancelled: true, spawnError: null, found: null }), 'cancelled');
        assert.strictEqual(launchOutcome({ cancelled: false, spawnError: null, found: null }), 'timeout');
        assert.strictEqual(launchOutcome({ cancelled: false, spawnError, found: null }), 'spawn-error');
        assert.strictEqual(launchOutcome({ cancelled: true, spawnError, found }), 'spawn-error');
    });

    test('kills the owned live pid even when the shell pid differs', () => {
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 42, spawnedPid: 42, livePid: 42 }), true);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 42, spawnedPid: 7, livePid: 42 }), true);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 42, spawnedPid: 7, livePid: 99 }), false);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 42, spawnedPid: 42, livePid: 99 }), false);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 7, spawnedPid: 42, livePid: 42 }), false);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: null, spawnedPid: null, livePid: 42 }), false);
        assert.strictEqual(shouldKillSpawnedPid({ ownPid: 42, spawnedPid: 42, livePid: null }), false);
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
        const completionModel = pkg.contributes.configuration.properties['vext.agent.completion.model'];
        assert.strictEqual(completionModel.default, 'gpt-6-luna');
        assert.deepStrictEqual(completionModel.enum, [
            'gpt-6-luna',
            'anthropic/claude-haiku-5-5',
            'qwen/qwen3.8-omni-flash',
            'qwen/qwen3.8-flash',
            'z-ai/glm-5.3-flash',
            'x-ai/grok-4.7',
            'gemini-3.8-flash',
            'deepseek/deepseek-v4.1-flash',
        ]);
        assert.match(completionModel.description, /gemini-3\.8-flash may be expensive/);
        assert.match(completionModel.description, /deepseek\/deepseek-v4\.1-flash is expensive/);
        for (const key of ['vext.agent.command', 'vext.agent.launch', 'vext.agent.openaiBaseUrl', 'vext.agent.openaiApiKey', 'vext.agent.approve']) {
            assert.strictEqual(pkg.contributes.configuration.properties[key].scope, 'machine');
        }
    });
});

suite('agent processing', () => {
    const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vext-process-'));
    const diskIo = (root) => {
        const fsp = fs.promises;
        return {
            root,
            async readFile(abs) {
                try {
                    return await fsp.readFile(abs);
                } catch (error) {
                    if (error?.code === 'ENOENT') {
                        return null;
                    }
                    throw error;
                }
            },
            async writeFile(abs, text) {
                await fsp.mkdir(path.dirname(abs), { recursive: true });
                await fsp.writeFile(abs, text, 'utf8');
            },
            async deleteFile(abs) {
                await fsp.unlink(abs);
            },
            async stat(abs) {
                try {
                    const info = await fsp.stat(abs);
                    return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymbolicLink: false, size: info.size };
                } catch (error) {
                    if (error?.code === 'ENOENT') {
                        return null;
                    }
                    throw error;
                }
            },
            async readdir(abs) {
                const entries = await fsp.readdir(abs, { withFileTypes: true });
                return entries.map((entry) => ({
                    name: entry.name,
                    isFile: entry.isFile(),
                    isDirectory: entry.isDirectory(),
                    isSymbolicLink: entry.isSymbolicLink(),
                }));
            },
            spawn() {
                throw new Error('Терминал редактора недоступен.');
            },
        };
    };

    test('processing host does not import node fs or child_process', () => {
        const source = fs.readFileSync(new URL('../src/agent/processing.mjs', import.meta.url), 'utf8');
        assert.doesNotMatch(source, /node:fs|node:child_process|node:path/);
        const launch = fs.readFileSync(new URL('../src/agent/index.mjs', import.meta.url), 'utf8');
        assert.doesNotMatch(launch, /node:fs|node:child_process|node:path/);
        const endpoint = fs.readFileSync(new URL('../src/agent/endpoint.mjs', import.meta.url), 'utf8');
        assert.doesNotMatch(endpoint, /node:fs|node:os|node:path/);
    });

    test('reads, edits, and deletes inside the work directory', async () => {
        const dir = temp();
        try {
            fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
            fs.mkdirSync(path.join(dir, 'sub'));
            fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'needle');
            const io = diskIo(dir);
            const read = await executeProcessing({ name: 'read_file', args: { path: 'a.txt' } }, io);
            assert.match(read.output, /# a\.txt — строки 1-1 из 1/);
            assert.match(read.output, /1\| hello/);
            assert.strictEqual(read.summary, 'a.txt: строки 1-1/1');
            const replaced = await executeProcessing({
                name: 'replace_text', args: { path: 'a.txt', search: 'hello', replacement: 'hi', all: false },
            }, io);
            assert.deepStrictEqual(replaced.changes, [{ op: 'edit', path: 'a.txt' }]);
            assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hi');
            const created = await executeProcessing({
                name: 'write_file', args: { path: 'sub/c.txt', content: 'new', overwrite: false },
            }, io);
            assert.deepStrictEqual(created.changes, [{ op: 'create', path: 'sub/c.txt' }]);
            const blocked = await executeProcessing({
                name: 'write_file', args: { path: 'a.txt', content: 'no', overwrite: false },
            }, io);
            assert.match(blocked.error, /overwrite=false/);
            const found = await executeProcessing({ name: 'search_files', args: { query: 'needle', path: null, regex: false, scope: 'all' } }, io);
            assert.match(found.output, /sub\/b\.txt:1: needle/);
            const listed = await executeProcessing({ name: 'list_files', args: { path: '.', depth: 2, include_hidden: false } }, io);
            assert.match(listed.output, /sub\//);
            assert.match(listed.output, /a\.txt/);
            const removed = await executeProcessing({ name: 'delete_file', args: { path: 'a.txt' } }, io);
            assert.deepStrictEqual(removed.changes, [{ op: 'delete', path: 'a.txt' }]);
            assert.strictEqual(fs.existsSync(path.join(dir, 'a.txt')), false);
            const outside = await executeProcessing({ name: 'read_file', args: { path: '../secret' } }, io);
            assert.match(outside.error, /вне рабочего каталога/);
            const secret = await executeProcessing({ name: 'read_file', args: { path: '.env' } }, io);
            assert.match(secret.error, /секретами/);
            const crlf = path.join(dir, 'win.txt');
            fs.writeFileSync(crlf, 'one\r\ntwo');
            const mismatch = await executeProcessing({
                name: 'replace_text', args: { path: 'win.txt', search: 'one\ntwo', replacement: 'x', all: false },
            }, io);
            assert.match(mismatch.error, /CRLF\/LF/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('uses an open editor buffer for read and replace', async () => {
        const dir = temp();
        try {
            const abs = path.join(dir, 'a.txt');
            fs.writeFileSync(abs, 'disk');
            let saved = 0;
            let applied = null;
            const doc = {
                uri: { scheme: 'file', fsPath: abs },
                isDirty: true,
                getText: () => 'alpha beta',
                positionAt: (offset) => ({ line: 0, character: offset }),
                save: async () => {
                    saved += 1;
                    return true;
                },
            };
            const vscode = {
                Uri: { file: (file) => ({ fsPath: file, scheme: 'file' }) },
                Position: class { constructor(line, character) { this.line = line; this.character = character; } },
                Range: class { constructor(start, end) { this.start = start; this.end = end; } },
                WorkspaceEdit: class { replace(uri, range, text) { this.uri = uri; this.range = range; this.text = text; } },
                workspace: {
                    workspaceFolders: [{ uri: { scheme: 'file', fsPath: dir } }],
                    textDocuments: [doc],
                    applyEdit: async (edit) => {
                        applied = edit;
                        return true;
                    },
                    fs: {
                        stat: async () => ({ type: 1, size: 4 }),
                        readFile: async () => {
                            throw new Error('workspace.fs.readFile');
                        },
                        writeFile: async () => {
                            throw new Error('workspace.fs.writeFile');
                        },
                        createDirectory: async () => {},
                        delete: async () => {
                            throw new Error('workspace.fs.delete');
                        },
                        readDirectory: async () => [],
                    },
                },
                window: {},
            };
            const io = createWorkspaceIo(vscode, dir);
            const read = await executeProcessing({ name: 'read_file', args: { path: 'a.txt' } }, io);
            assert.match(read.output, /alpha beta/);
            assert.doesNotMatch(read.output, /disk/);
            const replaced = await executeProcessing({
                name: 'replace_text', args: { path: 'a.txt', search: 'alpha', replacement: 'gamma', all: false },
            }, io);
            assert.strictEqual(applied.text, 'gamma beta');
            assert.strictEqual(saved, 1);
            assert.deepStrictEqual(replaced.changes, [{ op: 'edit', path: 'a.txt' }]);
            assert.strictEqual(fs.readFileSync(abs, 'utf8'), 'disk');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('reports a command from the editor terminal', async () => {
        const dir = temp();
        try {
            const io = diskIo(dir);
            let launched = null;
            io.spawn = async (spec) => {
                launched = spec;
                return { exitCode: 0, timedOut: false, cancelled: false, durationMs: 4, truncated: false, stdout: 'hi\n', stderr: '', error: null };
            };
            const result = await executeProcessing({
                name: 'run_command', args: { command: 'echo hi', shell: '', cwd: null, timeout_seconds: 5, reason: 'test' },
            }, io);
            assert.match(launched.commandLine, /echo hi/);
            assert.match(result.output, /exit code 0/);
            assert.match(result.output, /hi/);
            assert.strictEqual(result.summary, 'exit code 0');
            fs.writeFileSync(path.join(dir, 'hi.cmd'), '@echo off\r\n');
            const script = await executeProcessing({
                name: 'run_script', args: { path: 'hi.cmd', args: ['--x'], shell: '', cwd: null, timeout_seconds: null, reason: 'test' },
            }, io);
            assert.strictEqual(script.summary, 'exit code 0');
            assert.match(launched.commandLine, /hi\.cmd/);
            assert.match(launched.commandLine, /--x/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('writes through workspace.fs and runs in the integrated terminal', async () => {
        const written = [];
        let execution = null;
        let endListener = null;
        const vscode = {
            Uri: {
                file: (file) => ({ fsPath: file, scheme: 'file' }),
                joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/'), scheme: base.scheme }),
            },
            workspace: {
                workspaceFolders: [{ uri: { scheme: 'file', fsPath: 'C:\\work' } }],
                textDocuments: [],
                fs: {
                    stat: async (uri) => {
                        if (uri.fsPath.replace(/\\/g, '/').toLowerCase().endsWith('/a.txt')) {
                            const error = new Error('missing');
                            error.code = 'FileNotFound';
                            throw error;
                        }
                        return { type: 2, size: 0 };
                    },
                    readDirectory: async () => [['a.txt', 1]],
                    createDirectory: async () => {},
                    writeFile: async (uri, bytes) => {
                        written.push({ uri, text: new TextDecoder().decode(bytes) });
                    },
                    readFile: async () => new TextEncoder().encode('a'),
                    delete: async () => {},
                },
            },
            window: {
                createTerminal() {
                    return {
                        shellIntegration: {
                            executeCommand(line) {
                                execution = {
                                    line,
                                    read: async function* read() {
                                        yield 'hi\n';
                                    },
                                };
                                queueMicrotask(() => endListener?.({ execution, exitCode: 0 }));
                                return execution;
                            },
                        },
                        dispose() {},
                    };
                },
                onDidEndTerminalShellExecution(listener) {
                    endListener = listener;
                    return { dispose() {} };
                },
            },
        };
        const io = createWorkspaceIo(vscode, 'C:\\work');
        const created = await executeProcessing({
            name: 'write_file', args: { path: 'a.txt', content: 'hi', overwrite: true },
        }, io);
        assert.deepStrictEqual(created.changes, [{ op: 'create', path: 'a.txt' }]);
        assert.strictEqual(written[0].text, 'hi');
        const ran = await executeProcessing({
            name: 'run_command', args: { command: 'echo hi', shell: 'cmd', cwd: null, timeout_seconds: 5, reason: 'test' },
        }, io);
        assert.match(execution.line, /echo hi/);
        assert.match(ran.output, /hi/);
        assert.strictEqual(ran.summary, 'exit code 0');
    });
});
