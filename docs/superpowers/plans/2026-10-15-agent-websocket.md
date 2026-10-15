# Universal-AI WebSocket Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the U2RE-toolset extension to a local `ai serve` as a WebSocket client, with Tab ghost-text completion and a sidebar that sends `run`, `ask`, `chat`, and `image`.

**Architecture:** `serve.json` plus settings resolve one `ws://127.0.0.1:<port>` and token. The sidebar keeps a command-bus socket. Tab uses a second socket at `/v1/complete` on that same port. Spawning `ai serve` is off unless a setting or the Start command asks for it. OpenAI variables are copied only into that child process.

**Tech Stack:** Existing extension (`src/extension.mjs`, esbuild, `package.json` contributes). Node ESM. Host global `WebSocket`. VS Code `InlineCompletionItemProvider` and a webview. Tests are Mocha suites run by `npm test` (`@vscode/test-cli`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-15-agent-websocket-design.md`. Do not change GPTunnel (`src/web/webview.mjs`, `vext.gptView`).
- No new npm dependencies. Sockets use the host global `WebSocket`. Completion auth is `?token=`, never an `Authorization` header.
- `vscode` is loaded only through `src/imports/api.ts` inside `src/agent/index.mjs`. Other agent modules receive the module as an argument.
- Pure modules export `__agentTest`. ESLint on `src` warns on missing semicolons, missing braces, and `==`.
- Defaults: `vext.agent.port` `0`, `vext.agent.token` `""`, `vext.agent.launch` `false`, `vext.agent.command` `ai`, `vext.agent.approve` `ask`, `vext.agent.completion.enabled` `true`, `vext.agent.completion.debounceMs` `350`.
- A whole document is sent only when `Buffer.byteLength(text, 'utf8')` is at most `262144`. Otherwise the window radii are `200/50`, `100/25`, `50/12`, `25/6`, `12/3`, `6/1`, then the cursor line. A JSON body above `900000` bytes is not sent.
- Reconnect delays are `2000`, then double, capped at `30000`. Spawn wait is `10000` ms. `shell: true` only when `process.platform === 'win32'`.
- When `ownPid` equals the live file `pid`, the token is the file token even if the setting is non-empty.
- In `test/agent.test.js`, every `import` stays at the top of the file. New suites are appended after the suites already there.

---

### Task 1: Serve endpoint

**Files:**
- Create: `src/agent/endpoint.mjs`
- Test: `test/agent.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `agentHome(env, homedir) -> string`
  - `parseServeRecord(text) -> { pid: number, url: string, token: string } | null`
  - `pidAlive(pid) -> boolean`
  - `loadServeRecord(dir) -> Promise<record|null>`
  - `resolveEndpoint({ record, settings, ownPid, alive }) -> { url, token, completeWs } | null`
  - `__agentTest` with those functions

- [ ] **Step 1: Write the failing test**

Create `test/agent.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent endpoint"`

Expected: FAIL because `../src/agent/endpoint.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/agent/endpoint.mjs`:

```javascript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --grep "agent endpoint"`

Expected: PASS for every test in `agent endpoint`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/endpoint.mjs test/agent.test.js
git commit -m "feat: resolve the local ai serve endpoint"
```

---

### Task 2: Command frames, completion window, and panel events

**Files:**
- Create: `src/agent/protocol.mjs`
- Modify: `test/agent.test.js`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `nextDelay(previous) -> number`
  - `submissionFrame({ command, prompt, cwd, approve, phase }) -> { frames } | { error }`
  - `approveFrame(requestId, decision) -> object`
  - `answerFrame(requestId, text) -> object`
  - `completionRequest({ id, language, path, text, cursor }) -> object | null`
  - `acceptCompletion(expectedId, message) -> string | null`
  - `panelMessageFromEvent(event) -> object | null`
  - `panelMessageFromHub(frame) -> object | null`
  - `__agentTest` with those functions plus `FULL_BYTES` and `JSON_BYTES`

`phase` is `'idle'`, `'starting'`, or `{ runId, command }`.

- [ ] **Step 1: Write the failing test**

Append this suite to `test/agent.test.js`:

```javascript
import { __agentTest as protocolTest } from '../src/agent/protocol.mjs';

const {
    nextDelay, submissionFrame, approveFrame, completionRequest, acceptCompletion,
    panelMessageFromEvent, panelMessageFromHub, FULL_BYTES,
} = protocolTest;

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent protocol"`

Expected: FAIL because `../src/agent/protocol.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/agent/protocol.mjs`:

```javascript
export const FULL_BYTES = 262144;
export const JSON_BYTES = 900000;

const RADII = [[200, 50], [100, 25], [50, 12], [25, 6], [12, 3], [6, 1], [0, 0]];

export function nextDelay(previous) {
    const current = Number(previous) || 0;
    if (current <= 0) {
        return 2000;
    }
    return Math.min(current * 2, 30000);
}

export function approveFrame(requestId, decision) {
    return { type: 'approve', requestId, decision };
}

export function answerFrame(requestId, text) {
    return { type: 'answer', requestId, text: String(text ?? '') };
}

export function submissionFrame({ command, prompt, cwd, approve, phase }) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
        return { error: 'empty' };
    }
    if (phase === 'starting') {
        return { error: 'pending' };
    }
    const running = phase !== null && typeof phase === 'object';
    if (command === 'chat' && running && phase.command === 'chat' && phase.runId) {
        return { frames: [{ type: 'input', runId: phase.runId, text: prompt }] };
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') {
        return { error: 'no-workspace' };
    }
    const start = { type: 'start', command, prompt, cwd, approve };
    if (running && phase.runId) {
        return { frames: [{ type: 'cancel', runId: phase.runId }, start] };
    }
    return { frames: [start] };
}

function buildBody({ id, language, path: filePath, content, cursor }) {
    const body = {
        type: 'complete',
        id,
        language,
        content,
        cursor: { line: cursor.line, character: cursor.character },
    };
    if (filePath) {
        body.path = filePath;
    }
    return body;
}

export function completionRequest({ id, language, path: filePath, text, cursor }) {
    const full = String(text ?? '');
    if (Buffer.byteLength(full, 'utf8') <= FULL_BYTES) {
        return buildBody({ id, language, path: filePath, content: full, cursor });
    }
    const lines = full.split('\n');
    for (const [before, after] of RADII) {
        const start = Math.max(0, cursor.line - before);
        const end = Math.min(lines.length - 1, cursor.line + after);
        const content = lines.slice(start, end + 1).join('\n');
        const body = buildBody({
            id,
            language,
            path: filePath,
            content,
            cursor: { line: cursor.line - start, character: cursor.character },
        });
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') <= JSON_BYTES) {
            return body;
        }
    }
    return null;
}

export function acceptCompletion(expectedId, message) {
    if (!message || message.type !== 'completion') {
        return null;
    }
    if (message.id !== expectedId) {
        return null;
    }
    if (typeof message.text !== 'string' || message.text === '') {
        return null;
    }
    return message.text;
}

export function panelMessageFromEvent(event) {
    if (!event || typeof event.type !== 'string') {
        return null;
    }
    if (event.type === 'text.delta') {
        return { type: 'text', text: String(event.text ?? '') };
    }
    if (event.type === 'tool.exec.start') {
        return { type: 'log', level: 'action', text: String(event.name ?? 'tool') };
    }
    if (event.type === 'tool.exec.done') {
        const summary = event.summary || (event.ok ? 'готово' : 'ошибка');
        return { type: 'log', level: event.ok ? 'ok' : 'fail', text: `${event.name} · ${summary}` };
    }
    if (event.type === 'warning') {
        return { type: 'log', level: 'warn', text: String(event.message ?? '') };
    }
    if (event.type === 'error') {
        return { type: 'log', level: 'fail', text: String(event.message ?? '') };
    }
    if (event.type === 'image.saved') {
        return { type: 'log', level: 'info', text: `Изображение сохранено: ${event.path}` };
    }
    if (event.type === 'response.done') {
        const usage = event.usage;
        const parts = [];
        if (usage && Number.isFinite(usage.input)) {
            parts.push(`↑ ${usage.input}`);
        }
        if (usage && Number.isFinite(usage.output)) {
            parts.push(`↓ ${usage.output}`);
        }
        if (Number.isFinite(event.costUsd)) {
            parts.push(`${event.costUsd} USD`);
        }
        if (parts.length === 0) {
            return null;
        }
        return { type: 'log', level: 'info', text: parts.join(' · ') };
    }
    if (event.type === 'reasoning.delta' || event.type === 'reasoning.start') {
        return { type: 'status', state: 'ready', detail: 'думает…' };
    }
    if (event.type === 'image.progress') {
        return { type: 'status', state: 'ready', detail: 'генерирует изображение…' };
    }
    return null;
}

export function panelMessageFromHub(frame) {
    if (!frame || typeof frame.type !== 'string') {
        return null;
    }
    if (frame.type === 'ready') {
        return { type: 'status', state: 'ready', detail: '' };
    }
    if (frame.type === 'error' && frame.code === 'unauthorized') {
        return { type: 'status', state: 'unauthorized', detail: String(frame.message ?? 'Неверный токен.') };
    }
    if (frame.type === 'error') {
        return { type: 'status', state: 'error', detail: String(frame.message ?? '') };
    }
    if (frame.type === 'run.started' && frame.run) {
        return { type: 'run', runId: frame.run.id, command: frame.run.command, status: 'started' };
    }
    if (frame.type === 'run.ended') {
        return { type: 'run', runId: frame.runId, status: 'ended', exitCode: frame.exitCode };
    }
    if (frame.type === 'run.event') {
        const inner = panelMessageFromEvent(frame.event);
        if (!inner) {
            return null;
        }
        return { ...inner, runId: frame.runId };
    }
    if (frame.type === 'approval.request') {
        return {
            type: 'approval',
            runId: frame.runId,
            requestId: frame.requestId,
            name: frame.name ?? '',
            category: frame.category ?? '',
            preview: frame.preview ?? '',
        };
    }
    if (frame.type === 'question.request') {
        return { type: 'question', runId: frame.runId, requestId: frame.requestId, question: String(frame.question ?? '') };
    }
    return null;
}

export const __agentTest = {
    FULL_BYTES,
    JSON_BYTES,
    nextDelay,
    submissionFrame,
    approveFrame,
    answerFrame,
    completionRequest,
    acceptCompletion,
    panelMessageFromEvent,
    panelMessageFromHub,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --grep "agent protocol"`

Expected: PASS. The large-file assertion `windowed.cursor.line === 200` depends on a cursor at line 1000 and a 200-line prefix. `4000` lines of 80 `x` characters exceed `262144` bytes.

- [ ] **Step 5: Commit**

```bash
git add src/agent/protocol.mjs test/agent.test.js
git commit -m "feat: map agent frames and completion windows"
```

---

### Task 3: Command-bus socket

**Files:**
- Create: `src/agent/bus.mjs`
- Modify: `test/agent.test.js`

**Interfaces:**
- Consumes: `submissionFrame`, `approveFrame`, `answerFrame`, `panelMessageFromHub`, `nextDelay` from `src/agent/protocol.mjs`
- Produces: `createBus({ WebSocketImpl, schedule, clearSchedule, onMessage, onStatus })` returning `{ connect, close, submit, approve, answer }`

`connect` takes `{ url, token }`. `submit` takes `{ command, prompt, cwd, approve }`. A second `connect` closes the previous socket without scheduling a retry for it. `submit` while `phase === 'starting'` returns `{ error: 'pending' }` and does not send. After a sent `start`, `phase` is `'starting'` until `run.started`. `run.ended` for that `runId` sets `phase` back to `'idle'`. Close code `1008` or an `unauthorized` error sets the bus idle until the next `connect`. Other closes schedule `nextDelay`.

- [ ] **Step 1: Write the failing test**

Append to `test/agent.test.js`:

```javascript
import { createBus } from '../src/agent/bus.mjs';

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent bus"`

Expected: FAIL because `../src/agent/bus.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/agent/bus.mjs`:

```javascript
import { answerFrame, approveFrame, nextDelay, panelMessageFromHub, submissionFrame } from './protocol.mjs';

export function createBus({ WebSocketImpl, schedule = setTimeout, clearSchedule = clearTimeout, onMessage, onStatus }) {
    let socket = null;
    let endpoint = null;
    let generation = 0;
    let unauthorized = false;
    let stopped = false;
    let delay = 0;
    let timer = null;
    let phase = 'idle';

    const status = (state, detail = '') => {
        onStatus?.({ type: 'status', state, detail });
    };

    const deliver = (frame) => {
        const message = panelMessageFromHub(frame);
        if (message) {
            onMessage?.(message);
        }
    };

    const open = () => {
        if (!endpoint || stopped || unauthorized) {
            return;
        }
        const gen = ++generation;
        status('connecting', endpoint.url);
        const ws = new WebSocketImpl(endpoint.url);
        socket = ws;
        ws.onopen = () => {
            if (gen !== generation) {
                return;
            }
            ws.send(JSON.stringify({ type: 'hello', role: 'client', token: endpoint.token }));
        };
        ws.onmessage = (event) => {
            if (gen !== generation) {
                return;
            }
            let frame;
            try {
                frame = JSON.parse(event.data);
            } catch {
                return;
            }
            if (frame.type === 'ready') {
                delay = 0;
                status('ready', endpoint.url);
            }
            if (frame.type === 'error' && frame.code === 'unauthorized') {
                unauthorized = true;
            }
            if (frame.type === 'run.started' && frame.run) {
                phase = { runId: frame.run.id, command: frame.run.command };
            }
            if (frame.type === 'run.ended' && phase && phase.runId === frame.runId) {
                phase = 'idle';
            }
            deliver(frame);
        };
        ws.onclose = (event) => {
            if (gen !== generation) {
                return;
            }
            socket = null;
            if (stopped || unauthorized || event?.code === 1008) {
                if (event?.code === 1008) {
                    unauthorized = true;
                    status('unauthorized', 'Неверный токен.');
                }
                return;
            }
            delay = nextDelay(delay);
            status('disconnected', 'нет связи');
            timer = schedule(open, delay);
        };
    };

    const send = (frame) => {
        if (!socket || socket.readyState !== 1) {
            return false;
        }
        socket.send(JSON.stringify(frame));
        return true;
    };

    return {
        connect(next) {
            stopped = false;
            unauthorized = false;
            delay = 0;
            if (timer) {
                clearSchedule(timer);
                timer = null;
            }
            generation += 1;
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
            endpoint = next;
            open();
        },
        close() {
            stopped = true;
            generation += 1;
            if (timer) {
                clearSchedule(timer);
                timer = null;
            }
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
        },
        submit(input) {
            const result = submissionFrame({ ...input, phase });
            if (result.error === 'pending') {
                status('connecting', 'запуск…');
                return result;
            }
            if (result.error) {
                return result;
            }
            if (!socket || socket.readyState !== 1) {
                return { error: 'disconnected' };
            }
            for (const frame of result.frames) {
                send(frame);
            }
            if (result.frames.some((frame) => frame.type === 'start')) {
                phase = 'starting';
            }
            return result;
        },
        approve(requestId, decision) {
            return send(approveFrame(requestId, decision));
        },
        answer(requestId, text) {
            return send(answerFrame(requestId, text));
        },
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --grep "agent bus"`

Expected: PASS. `connect` increments `generation` before `open`, and `open` increments it again, so both share the latest generation. The unauthorized test must not push a timer. The drop test's first scheduled function calls `open` and therefore replaces `FakeSocket.latest`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/bus.mjs test/agent.test.js
git commit -m "feat: add the ai serve command bus client"
```

---

### Task 4: Completion socket and inline provider

**Files:**
- Create: `src/agent/complete.mjs`
- Modify: `test/agent.test.js`

**Interfaces:**
- Consumes: `completionRequest` and `acceptCompletion` from `src/agent/protocol.mjs`. The same `FakeSocket` shape as Task 3 (`readyState`, `onopen`, `onmessage`, `send`).
- Produces:
  - `createCompleteClient({ WebSocketImpl, onStatus })` with `{ connect, close, request, isOpen }`
  - `registerAgentCompletion(vscode, client, getSettings, onError)` returning a disposable

`request(body, signal)` sends `body` and resolves with the parsed message whose `id` matches, or `null` on empty text, a stale id, a close, or cancellation. `registerAgentCompletion` registers providers for schemes `file` and `untitled`. It returns `{ items: [] }` when completion is disabled, the token is cancelled, or `completionRequest` returns null. Otherwise the item is `{ insertText }` with no range. `path` is set only for `file`. Errors call `onError(message)` and return an empty list.

- [ ] **Step 1: Write the failing test**

Append to `test/agent.test.js`. Reuse `FakeSocket` from the bus suite in this same file (it is already declared once).

```javascript
import { createCompleteClient } from '../src/agent/complete.mjs';

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent complete"`

Expected: FAIL because `../src/agent/complete.mjs` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/agent/complete.mjs`:

```javascript
import { acceptCompletion, completionRequest } from './protocol.mjs';

function wait(ms, token) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        const cancel = () => {
            clearTimeout(timer);
            resolve(true);
        };
        if (token?.isCancellationRequested) {
            cancel();
            return;
        }
        token?.onCancellationRequested?.(cancel);
    });
}

export function createCompleteClient({ WebSocketImpl, onStatus }) {
    let socket = null;
    let endpoint = null;
    let generation = 0;
    let opened = Promise.resolve();
    const waiters = new Map();

    const failAll = () => {
        for (const [id, waiter] of waiters) {
            waiter(null);
            waiters.delete(id);
        }
    };

    const open = () => {
        if (!endpoint?.completeWs) {
            return;
        }
        const gen = ++generation;
        const ws = new WebSocketImpl(endpoint.completeWs);
        socket = ws;
        opened = new Promise((resolve) => {
            ws.onopen = () => resolve();
        });
        ws.onmessage = (event) => {
            if (gen !== generation) {
                return;
            }
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            if (message?.type === 'error') {
                onStatus?.(String(message.message ?? 'Ошибка дополнения.'));
                const waiter = waiters.get(message.id);
                if (waiter) {
                    waiter(null);
                    waiters.delete(message.id);
                }
                return;
            }
            const waiter = waiters.get(message?.id);
            if (!waiter) {
                return;
            }
            waiter(acceptCompletion(message.id, message));
            waiters.delete(message.id);
        };
        ws.onclose = () => {
            if (gen !== generation) {
                return;
            }
            socket = null;
            failAll();
        };
    };

    return {
        connect(next) {
            generation += 1;
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
            endpoint = next;
            open();
        },
        close() {
            generation += 1;
            failAll();
            try {
                socket?.close(1000);
            } catch { /* already closed */ }
            socket = null;
        },
        request(body, signal) {
            const sendNow = () => new Promise((resolve) => {
                if (!socket || socket.readyState !== 1) {
                    resolve(null);
                    return;
                }
                const finish = (value) => resolve(value);
                waiters.set(body.id, finish);
                const cancel = () => {
                    if (waiters.get(body.id) !== finish) {
                        return;
                    }
                    waiters.delete(body.id);
                    finish(null);
                };
                if (signal?.isCancellationRequested) {
                    cancel();
                    return;
                }
                signal?.onCancellationRequested?.(cancel);
                socket.send(JSON.stringify(body));
            });
            if (socket && socket.readyState === 1) {
                return sendNow();
            }
            return opened.then(sendNow);
        },
        isOpen() {
            return Boolean(socket && socket.readyState === 1);
        },
    };
}

export function registerAgentCompletion(vscode, client, getSettings, onError) {
    let seq = 0;
    return vscode.languages.registerInlineCompletionItemProvider(
        [{ scheme: 'file' }, { scheme: 'untitled' }],
        {
            async provideInlineCompletionItems(document, position, _context, token) {
                const settings = getSettings();
                if (!settings.completionEnabled) {
                    return { items: [] };
                }
                const cancelled = await wait(settings.debounceMs, token);
                if (cancelled || token?.isCancellationRequested) {
                    return { items: [] };
                }
                const id = String(++seq);
                const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
                let body;
                try {
                    body = completionRequest({
                        id,
                        language: document.languageId,
                        path: filePath,
                        text: document.getText(),
                        cursor: { line: position.line, character: position.character },
                    });
                } catch (error) {
                    onError?.(error?.message || 'Ошибка дополнения.');
                    return { items: [] };
                }
                if (!body) {
                    return { items: [] };
                }
                try {
                    const text = await client.request(body, token);
                    if (!text) {
                        return { items: [] };
                    }
                    return { items: [{ insertText: text }] };
                } catch (error) {
                    onError?.(error?.message || 'Ошибка дополнения.');
                    return { items: [] };
                }
            },
        },
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --grep "agent complete"`

Expected: PASS. `request` resolves to the string from `acceptCompletion`, not the raw frame.

- [ ] **Step 5: Commit**

```bash
git add src/agent/complete.mjs test/agent.test.js
git commit -m "feat: request inline completions over the serve socket"
```

---

### Task 5: Sidebar webview

**Files:**
- Create: `src/agent/html.mjs`
- Create: `icons/agent.mjs`
- Create: `src/agent/panel.mjs`
- Modify: `test/agent.test.js`

**Interfaces:**
- Consumes: a session object `{ onWebview(message), attach(webview), detach(webview), setStopVisible(boolean) }` supplied later by `index.mjs`
- Produces:
  - `agentHtml({ cssHref, scriptHref, nonce }) -> string`
  - `AgentViewProvider` with static `viewType = 'vext.agentView'`

The HTML uses `icons/webview.css` through `cssHref` and `icons/agent.mjs` through `scriptHref`. CSP is `default-src 'none'`, with style and script limited to `cspSource` and the nonce. The document contains buttons Run, Ask, Chat, Image, Переподключить, and Остановить, a prompt textarea, and a log. `body` has class `agent-body` so the prompt can be selected despite `user-select: none` in `webview.css`.

- [ ] **Step 1: Write the failing test**

Append to `test/agent.test.js`:

```javascript
import { agentHtml } from '../src/agent/html.mjs';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent panel"`

Expected: FAIL because `../src/agent/html.mjs` does not exist.

- [ ] **Step 3: Write the HTML, the webview script, and the provider**

Create `src/agent/html.mjs`:

```javascript
export function agentHtml({ cssHref, scriptHref, nonce, cspSource }) {
    const csp = [
        "default-src 'none'",
        `img-src ${cspSource} data:`,
        `style-src ${cspSource} 'nonce-${nonce}'`,
        `font-src ${cspSource}`,
        `script-src ${cspSource} 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssHref}" />
  <style nonce="${nonce}">
    body.agent-body { block-size: 100dvh; overflow: hidden; }
    body.agent-body .agent-shell, body.agent-body textarea, body.agent-body .agent-log { user-select: text; }
    .agent-shell { display: flex; flex-direction: column; gap: 8px; block-size: 100dvh; padding: 8px; }
    .agent-log { flex: 1; overflow: auto; white-space: pre-wrap; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
    .agent-log .warn, .agent-log .fail { color: var(--button-active); }
    #prompt { inline-size: 100%; min-block-size: 4.5rem; resize: vertical; }
    .agent-actions, .agent-approval { display: flex; flex-wrap: wrap; gap: 6px; }
    .agent-actions button, .agent-approval button, #reconnect, #stop {
      border: 1px solid var(--border); background: var(--button-bg); color: var(--foreground); border-radius: 8px; padding: 4px 8px;
    }
  </style>
</head>
<body class="agent-body" data-theme="dark">
  <div class="agent-shell">
    <div class="toolbar">
      <span id="status" class="toolbar-label">агент не запущен</span>
      <button id="reconnect" type="button">Переподключить</button>
      <button id="stop" type="button" hidden>Остановить</button>
    </div>
    <div id="log" class="agent-log" aria-live="polite"></div>
    <div id="approval" class="agent-approval" hidden></div>
    <form id="composer">
      <textarea id="prompt" placeholder="Команда агенту"></textarea>
      <div class="agent-actions">
        <button type="submit" data-command="run">Run</button>
        <button type="submit" data-command="ask">Ask</button>
        <details>
          <summary>Ещё</summary>
          <button type="submit" data-command="chat">Chat</button>
          <button type="submit" data-command="image">Image</button>
        </details>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptHref}"></script>
</body>
</html>`;
}
```

Create `icons/agent.mjs`:

```javascript
const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const log = document.getElementById('log');
const approval = document.getElementById('approval');
const prompt = document.getElementById('prompt');
const stop = document.getElementById('stop');

const append = (className, text) => {
    const row = document.createElement('div');
    row.className = className || '';
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
};

document.getElementById('reconnect').addEventListener('click', () => {
    vscode.postMessage({ type: 'reconnect' });
});
stop.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
});
document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const command = event.submitter?.dataset?.command;
    if (!command) {
        return;
    }
    vscode.postMessage({ type: 'start', command, prompt: prompt.value });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
        return;
    }
    if (message.type === 'status') {
        status.textContent = message.detail || message.state;
        return;
    }
    if (message.type === 'stopVisible') {
        stop.hidden = !message.visible;
        return;
    }
    if (message.type === 'text') {
        const last = log.lastElementChild;
        if (last && last.dataset.kind === 'text') {
            last.textContent += message.text;
        } else {
            const row = document.createElement('div');
            row.dataset.kind = 'text';
            row.textContent = message.text;
            log.appendChild(row);
        }
        log.scrollTop = log.scrollHeight;
        return;
    }
    if (message.type === 'log') {
        append(message.level, message.text);
        return;
    }
    if (message.type === 'run' && message.status === 'ended') {
        append('info', `завершено (${message.exitCode})`);
        approval.hidden = true;
        approval.replaceChildren();
        return;
    }
    if (message.type === 'approval') {
        approval.hidden = false;
        approval.replaceChildren();
        const title = document.createElement('div');
        title.textContent = `${message.name || 'действие'} · ${message.category || ''} ${message.preview || ''}`.trim();
        approval.appendChild(title);
        for (const decision of ['yes', 'no', 'always', 'abort']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = decision;
            button.addEventListener('click', () => {
                vscode.postMessage({ type: 'approve', requestId: message.requestId, decision });
                approval.hidden = true;
            });
            approval.appendChild(button);
        }
        return;
    }
    if (message.type === 'question') {
        approval.hidden = false;
        approval.replaceChildren();
        const title = document.createElement('div');
        title.textContent = message.question;
        const input = document.createElement('input');
        input.type = 'text';
        const send = document.createElement('button');
        send.type = 'button';
        send.textContent = 'Ответить';
        send.addEventListener('click', () => {
            vscode.postMessage({ type: 'answer', requestId: message.requestId, text: input.value });
            approval.hidden = true;
        });
        approval.append(title, input, send);
    }
});

vscode.postMessage({ type: 'ready' });
```

Create `src/agent/panel.mjs`:

```javascript
import { agentHtml } from './html.mjs';

const nonce32 = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
};

export class AgentViewProvider {
    static viewType = 'vext.agentView';

    constructor(extensionUri, session) {
        this._extensionUri = extensionUri;
        this._session = session;
    }

    resolveWebviewView(webviewView) {
        const webview = webviewView.webview;
        const vscode = this._session.vscode;
        webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        const nonce = nonce32();
        const cssHref = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'icons', 'webview.css')));
        const scriptHref = String(webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'icons', 'agent.mjs')));
        webview.html = agentHtml({ cssHref, scriptHref, nonce, cspSource: webview.cspSource });
        this._session.attach(webview);
        const disposable = webview.onDidReceiveMessage((message) => {
            this._session.onWebview(message);
        });
        webviewView.onDidDispose(() => {
            disposable.dispose();
            this._session.detach(webview);
        });
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --grep "agent panel"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/html.mjs src/agent/panel.mjs icons/agent.mjs test/agent.test.js
git commit -m "feat: add the agent sidebar webview"
```

---

### Task 6: Settings, process launch, and activation

**Files:**
- Create: `src/agent/settings.mjs`
- Create: `src/agent/index.mjs`
- Modify: `src/extension.mjs`
- Modify: `package.json` (`contributes.configuration.properties`, `viewsContainers.activitybar`, `views`, `commands`)
- Modify: `.cursor/maps/index.md`
- Modify: `.cursor/maps/src.md`
- Modify: `test/agent.test.js`

**Interfaces:**
- Consumes: `agentHome`, `loadServeRecord`, `pidAlive`, `resolveEndpoint`, `createBus`, `createCompleteClient`, `registerAgentCompletion`, `AgentViewProvider`
- Produces:
  - `readAgentSettings(get) -> settings object`
  - `spawnArgs(settings) -> string[]`
  - `spawnEnv(baseEnv, settings) -> object`
  - `export async function agent(context)`

`readAgentSettings` reads the keys below. Invalid `approve` becomes `ask`. A non-integer port or a port outside `0..65535` becomes `0`. A negative or non-numeric debounce becomes `350`.

Spawn only from `agent()` when `allowLaunch` is true and `resolveEndpoint` would be null for the current file. Poll `serve.json` every `200` ms for up to `10000` ms until `pidAlive(record.pid)` is true. Then set `ownPid` to that file pid, not `child.pid`. On timeout, `child.kill()`, clear `ownPid`, and call `showErrorMessage` once. Stop kills `ownPid` with `process.kill(ownPid)` and then `child.kill()`, and only if this extension spawned it. Reconnect passes `allowLaunch: false`. A configuration change passes `allowLaunch: settings.launch`. A second launch shares the same in-flight spawn. The bus connects when the view sends `ready` and after start or reconnect. The completion socket connects from the wrapper passed to `registerAgentCompletion`, before `complete.request`, whenever `isOpen()` is false or the completion URL changed. The status bar item text is `U2RE Agent`; `onError` sets it to the error for `4000` ms and also posts `{ type: 'status', state: 'error', detail }` to the panel.

- [ ] **Step 1: Write the failing test**

Append to `test/agent.test.js`:

```javascript
import { readAgentSettings, spawnArgs, spawnEnv } from '../src/agent/settings.mjs';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --grep "agent settings"`

Expected: FAIL because `src/agent/settings.mjs` does not exist and `package.json` has no `vext.agent.start`.

- [ ] **Step 3: Write settings, wire the extension, and update the maps**

Create `src/agent/settings.mjs`:

```javascript
const APPROVE = new Set(['ask', 'read', 'write', 'all']);

export function readAgentSettings(get) {
    const portValue = get('vext.agent.port');
    const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : 0;
    const debounceValue = get('vext.agent.completion.debounceMs');
    const debounceMs = typeof debounceValue === 'number' && Number.isFinite(debounceValue) && debounceValue >= 0 ? debounceValue : 350;
    const approveValue = get('vext.agent.approve');
    return {
        port,
        token: typeof get('vext.agent.token') === 'string' ? get('vext.agent.token') : '',
        openaiBaseUrl: typeof get('vext.agent.openaiBaseUrl') === 'string' ? get('vext.agent.openaiBaseUrl') : '',
        openaiApiKey: typeof get('vext.agent.openaiApiKey') === 'string' ? get('vext.agent.openaiApiKey') : '',
        launch: get('vext.agent.launch') === true,
        command: typeof get('vext.agent.command') === 'string' && get('vext.agent.command').trim() ? get('vext.agent.command').trim() : 'ai',
        approve: APPROVE.has(approveValue) ? approveValue : 'ask',
        completionEnabled: get('vext.agent.completion.enabled') !== false,
        debounceMs,
    };
}

export function spawnArgs(settings) {
    const args = ['serve'];
    if (settings.port > 0) {
        args.push('--port', String(settings.port));
    }
    return args;
}

export function spawnEnv(baseEnv, settings) {
    const env = { ...baseEnv };
    if (settings.openaiBaseUrl) {
        env.OPENAI_BASE_URL = settings.openaiBaseUrl;
    }
    if (settings.openaiApiKey) {
        env.OPENAI_API_KEY = settings.openaiApiKey;
    }
    return env;
}
```

Create `src/agent/index.mjs`:

```javascript
import { spawn } from 'node:child_process';

import vscodeAPI from '../imports/api.ts';
import { createBus } from './bus.mjs';
import { createCompleteClient, registerAgentCompletion } from './complete.mjs';
import { agentHome, loadServeRecord, pidAlive, resolveEndpoint } from './endpoint.mjs';
import { AgentViewProvider } from './panel.mjs';
import { readAgentSettings, spawnArgs, spawnEnv } from './settings.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function agent(context) {
    const vscode = await vscodeAPI;
    const views = new Set();
    let ownPid = null;
    let child = null;
    let endpoint = null;
    let completeUrl = '';
    let launchTask = null;

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

    const spawnAndWait = async () => {
        const settings = settingsOf();
        const proc = spawn(settings.command, spawnArgs(settings), {
            shell: process.platform === 'win32',
            windowsHide: true,
            env: spawnEnv(process.env, settings),
        });
        child = proc;
        const deadline = Date.now() + 10000;
        let found = null;
        while (Date.now() < deadline) {
            const record = await loadServeRecord(agentHome());
            if (record && pidAlive(record.pid)) {
                found = record;
                break;
            }
            await sleep(200);
        }
        if (!found) {
            proc.kill();
            if (child === proc) {
                child = null;
            }
            ownPid = null;
            const message = 'serve.json не появился за 10 с';
            vscode.window.showErrorMessage(message);
            post({ type: 'status', state: 'error', detail: message });
            return;
        }
        ownPid = found.pid;
        post({ type: 'stopVisible', visible: true });
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
            post({ type: 'stopVisible', visible: ownPid != null });
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
                if (ownPid != null) {
                    try {
                        process.kill(ownPid);
                    } catch { /* already gone */ }
                }
                if (child) {
                    child.kill();
                    child = null;
                }
                ownPid = null;
                bus.close();
                complete.close();
                endpoint = null;
                completeUrl = '';
                post({ type: 'stopVisible', visible: false });
                post({ type: 'status', state: 'disconnected', detail: 'агент не запущен' });
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
```

In `src/extension.mjs`, add the import next to the other registrars and call it from `activate`:

```javascript
import { agent } from './agent/index.mjs';
```

```javascript
Promise.try(agent, context)?.catch?.(e=>console.error(e));
```

In `package.json`, add this object to `contributes.viewsContainers.activitybar` after the `gptView` object:

```json
{
    "id": "agentView",
    "title": "Universal AI",
    "icon": "assets/openai.svg"
}
```

Add this object to `contributes.views` after `gptPanel`:

```json
"agentView": [
    {
        "icon": "assets/openai.svg",
        "type": "webview",
        "id": "vext.agentView",
        "name": "Agent",
        "contextualTitle": "Universal AI"
    }
]
```

Add these objects at the end of `contributes.commands`:

```json
{
    "command": "vext.agent.start",
    "title": "Universal AI: Start agent",
    "icon": "$(play)"
},
{
    "command": "vext.agent.stop",
    "title": "Universal AI: Stop agent",
    "icon": "$(debug-stop)"
},
{
    "command": "vext.agent.reconnect",
    "title": "Universal AI: Reconnect agent",
    "icon": "$(refresh)"
}
```

Add these properties at the end of `contributes.configuration.properties`:

```json
"vext.agent.port": {
    "type": "number",
    "default": 0,
    "minimum": 0,
    "maximum": 65535,
    "description": "WebSocket port for ai serve. 0 uses the port from serve.json."
},
"vext.agent.token": {
    "type": "string",
    "default": "",
    "description": "Token for an already running ai serve. Empty uses serve.json. Ignored for a process this extension started."
},
"vext.agent.openaiBaseUrl": {
    "type": "string",
    "default": "",
    "description": "OPENAI_BASE_URL passed only to an ai serve process started by this extension."
},
"vext.agent.openaiApiKey": {
    "type": "string",
    "default": "",
    "description": "OPENAI_API_KEY passed only to an ai serve process started by this extension."
},
"vext.agent.launch": {
    "type": "boolean",
    "default": false,
    "description": "Start ai serve when no live serve.json is found."
},
"vext.agent.command": {
    "type": "string",
    "default": "ai",
    "description": "Command used to start ai serve."
},
"vext.agent.approve": {
    "type": "string",
    "enum": ["ask", "read", "write", "all"],
    "default": "ask",
    "description": "Approval level sent with each agent start frame."
},
"vext.agent.completion.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Show ghost-text completions from ai serve."
},
"vext.agent.completion.debounceMs": {
    "type": "number",
    "default": 350,
    "minimum": 0,
    "description": "Pause before a completion request."
}
```

In `.cursor/maps/index.md`, add a row:

```markdown
| Agent WebSocket / completion | `src/agent/index.mjs` |
```

In `.cursor/maps/src.md`, add `agent` to the `activate` list and this row:

```markdown
| `src/agent/index.mjs` | `agent(context)`; endpoint `src/agent/endpoint.mjs`; frames `src/agent/protocol.mjs`; bus `src/agent/bus.mjs`; completion `src/agent/complete.mjs`; panel `src/agent/panel.mjs` |
```

Add the commands to the command list in that map: `vext.agent.start`, `vext.agent.stop`, `vext.agent.reconnect`.

- [ ] **Step 4: Run the tests, lint, and build**

Run: `npm test -- --grep "agent "`

Expected: PASS for `agent endpoint`, `agent protocol`, `agent bus`, `agent complete`, `agent panel`, and `agent settings`.

Run: `npm run lint`

Expected: exit code 0. ESLint may rewrite `src` with `--fix`; keep those edits.

Run: `npm run build`

Expected: esbuild finishes and `tsc --noEmit` prints no errors. `src/web/webview.mjs` is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/agent/settings.mjs src/agent/index.mjs src/extension.mjs package.json .cursor/maps/index.md .cursor/maps/src.md test/agent.test.js
git commit -m "feat: register the Universal-AI agent client"
```
