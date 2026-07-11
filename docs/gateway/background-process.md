---
summary: "Background exec execution and process management"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: "Background exec and process tool"
---

OpenClaw runs shell commands through the `exec` tool and keeps long-running tasks in memory. The `process` tool manages those background sessions.

## exec tool

Parameters:

| Parameter    | Description                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`    | Required. Shell command to run.                                                                                                                        |
| `workdir`    | Working directory; omit to use the default cwd.                                                                                                        |
| `env`        | Extra environment variables for the command.                                                                                                           |
| `yieldMs`    | Milliseconds to wait before backgrounding (default 10000).                                                                                             |
| `background` | Run in background immediately.                                                                                                                         |
| `timeout`    | Timeout in seconds (default `tools.exec.timeoutSec`); kills the process on expiry. Set `timeout: 0` to disable the exec process timeout for that call. |
| `pty`        | Run in a pseudo-terminal when available (TTY-required CLIs, coding agents).                                                                            |
| `elevated`   | Run outside the sandbox if elevated mode is enabled/allowed (`gateway` by default, or `node` when the exec target is `node`).                          |
| `host`       | Exec target: `auto`, `sandbox`, `gateway`, or `node`.                                                                                                  |
| `node`       | Node id/name, used with `host: "node"`.                                                                                                                |

Behavior:

- Foreground runs return output directly.
- When backgrounded (explicit or via `yieldMs` timeout), the tool returns `status: "running"` + `sessionId` and a short output tail.
- Backgrounded and `yieldMs` runs inherit `tools.exec.timeoutSec` unless the call passes an explicit `timeout`.
- Output stays in memory until the session is polled or cleared.
- If the `process` tool is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.
- Spawned exec commands receive `OPENCLAW_SHELL=exec` for context-aware shell/profile rules.
- For long-running work that starts now: start it once and rely on automatic completion wake (when enabled) once the command emits output or fails.
- If automatic completion wake is unavailable, or you need quiet-success confirmation for a command that exits cleanly with no output, poll with `process`.
- Don't emulate reminders or delayed follow-ups with `sleep` loops or repeated polling — use cron for future work.

### Env overrides

| Variable                                 | Effect                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BASH_YIELD_MS`                 | Default yield before backgrounding (ms). Default 10000, clamped 10-120000.                                       |
| `OPENCLAW_BASH_MAX_OUTPUT_CHARS`         | In-memory output cap (chars).                                                                                    |
| `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` | Pending stdout/stderr cap per stream (chars).                                                                    |
| `OPENCLAW_BASH_JOB_TTL_MS`               | TTL for finished sessions (ms), bounded to 1m-3h.                                                                |
| `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`    | Idle-output threshold before writable background sessions are marked as likely waiting for input. Default 15000. |

### Config (preferred over env overrides)

| Key                                   | Default | Effect                                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `tools.exec.backgroundMs`             | 10000   | Same as `OPENCLAW_BASH_YIELD_MS`.                                               |
| `tools.exec.timeoutSec`               | 1800    | Default per-call timeout.                                                       |
| `tools.exec.cleanupMs`                | 1800000 | Same as `OPENCLAW_BASH_JOB_TTL_MS`.                                             |
| `tools.exec.notifyOnExit`             | true    | Enqueue a system event + request heartbeat when a backgrounded exec exits.      |
| `tools.exec.notifyOnExitEmptySuccess` | false   | Also enqueue completion events for successful backgrounded runs with no output. |

## Child process bridging

When spawning long-running child processes outside the exec/process tools (CLI respawns, gateway helpers), attach the child-process bridge helper so termination signals forward and listeners detach on exit/error. This avoids orphaned processes on systemd and keeps shutdown consistent across platforms.

## process tool

Actions:

| Action      | Effect                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `list`      | Running + finished sessions.                                                  |
| `poll`      | Drain new output for a session (also reports exit status).                    |
| `log`       | Read aggregated output and input-recovery hints. Supports `offset` + `limit`. |
| `write`     | Send stdin (`data`, optional `eof`).                                          |
| `send-keys` | Send explicit key tokens or bytes to a PTY-backed session.                    |
| `submit`    | Send Enter/carriage return to a PTY-backed session.                           |
| `paste`     | Send literal text, optionally wrapped in bracketed paste mode.                |
| `kill`      | Terminate a background session.                                               |
| `clear`     | Remove a finished session from memory.                                        |
| `remove`    | Kill if running, otherwise clear if finished.                                 |

Notes:

- Only backgrounded sessions are listed/persisted — in memory only, not on disk. Sessions are lost on process restart.
- A live background session blocks cooperative host suspension and safe Gateway restart until the process owner confirms its actual exit.
- `process remove` can hide a running session immediately after requesting termination; suspension and restart remain blocked until exit confirmation.
- Session logs are only saved to chat history if you run `process poll`/`log` and the tool result is recorded.
- `process` is scoped per agent; it only sees sessions started by that agent.
- Use `poll`/`log` for status, logs, or completion confirmation when automatic completion wake is unavailable.
- Use `log` before recovering an interactive CLI, so the current transcript, stdin state, and input-wait hint are visible together.
- Use `write`/`send-keys`/`submit`/`paste`/`kill` when you need input or intervention.
- `process list` includes a derived `name` (command verb + target) for quick scans.
- `process list`, `poll`, and `log` report `waitingForInput` only when the session still has writable stdin and has been idle longer than the input-wait threshold (default 15000 ms, `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`).
- `process log` uses line-based `offset`/`limit`. When both are omitted, it returns the last 200 lines with a paging hint. When `offset` is set and `limit` isn't, it returns from `offset` to the end (not capped to 200).
- `poll`'s `timeout` waits up to that many milliseconds before returning; values above 30000 are clamped to 30000.
- Polling is for on-demand status, not wait-loop scheduling. If the work should happen later, use cron.

## Examples

Run a long task and poll later:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Inspect an interactive session before sending input:

```json
{ "tool": "process", "action": "log", "sessionId": "<id>" }
```

Start immediately in background:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```

Send PTY keys:

```json
{ "tool": "process", "action": "send-keys", "sessionId": "<id>", "keys": ["C-c"] }
```

Submit current line:

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste literal text:

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## Related

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
