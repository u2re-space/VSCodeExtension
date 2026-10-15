import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { __agentTest } from '../src/agent/endpoint.mjs';

const { agentHome, parseServeRecord, pidAlive, loadServeRecord, resolveEndpoint } = __agentTest;

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
