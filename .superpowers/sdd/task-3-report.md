# Task 3 Report: Command-bus socket

## Status

DONE

## What was implemented

Added `createBus` in `src/agent/bus.mjs`, a WebSocket command-bus client for the AI serve hub. It:

- Connects with `{ url, token }`, sends `hello`, handles `ready`, and forwards hub frames through `panelMessageFromHub` to `onMessage`.
- Tracks run `phase` (`idle` | `starting` | `{ runId, command }`) and delegates submission framing to `submissionFrame`.
- Exposes `submit`, `approve`, and `answer` using protocol helpers.
- Uses generation guards so stale socket callbacks are ignored after `connect` / `close` / retry.
- Stops retry on `unauthorized` or close code `1008`; otherwise schedules reconnect with `nextDelay`.
- Clears timers and closes the previous socket when `connect` is called again (no retry for the superseded connection).

Tests append the `agent bus` suite and a shared `FakeSocket` helper to `test/agent.test.js`.

## Files changed

| File | Change |
|------|--------|
| `src/agent/bus.mjs` | **Created** — `createBus` implementation |
| `test/agent.test.js` | **Modified** — import `createBus`, `FakeSocket`, `agent bus` suite (3 tests) |

## TDD evidence

### RED

**Command:** `npm test -- --grep "agent bus"`

**Result:** Exit code 1. Module missing:

```
Error: Cannot find module 'c:\Projects\VSCodeExtension\.worktrees\feat-agent-websocket\src\agent\bus.mjs' imported from c:\Projects\VSCodeExtension\.worktrees\feat-agent-websocket\test\agent.test.js
```

### GREEN (focused)

**Command:** `npm test -- --grep "agent bus"`

**Result:** Exit code 0.

```
  agent bus
    √ says hello and starts a run
    √ stops retrying after an unauthorized hello
    √ schedules a growing retry after a drop
  3 passing (86ms)
```

### Full suite (pre-commit)

**Command:** `npm test`

**Result:** Exit code 0 — **35 passing (135ms)**.

## Commit

- `6a4c73e` — feat: add the ai serve command bus client

## Self-review

- Implementation matches the task brief verbatim; no duplicate protocol logic.
- `connect` increments `generation` before closing the old socket; `open` increments again so handlers share the latest generation (as noted in the plan).
- Pending submit path emits status `connecting` / `запуск…` per spec.
- Unauthorized path sets `unauthorized`, emits `unauthorized` status with Russian detail on 1008, and does not schedule retry (verified by test).
- Drop retry uses `nextDelay(0) → 2000`, then `2000 → 4000` on second drop.
- `FakeSocket` is file-scoped once for reuse in later tasks.
- Lint: pre-existing warning in `endpoint.mjs` (`eqeqeq`); no new lint issues in `bus.mjs`.

## Concerns

None.

## Fix: phase on socket close / stray run.started

**Command:** `npm test -- --grep "agent bus"`

**Result:** Exit code 0.

```
  agent bus
    √ says hello and starts a run
    √ stops retrying after an unauthorized hello
    √ schedules a growing retry after a drop
    √ ignores run.started before a local start
    √ clears starting phase after a drop so submit can start again
  5 passing (81ms)
```

**Full suite (pre-commit):** `npm test` — exit 0, **37 passing (121ms)**.

**Commit:** `b05687d` — fix: keep the command bus phase on this socket
