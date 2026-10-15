import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { __agentTest } from '../src/agent/endpoint.mjs';
import { __agentTest as protocolTest } from '../src/agent/protocol.mjs';

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
