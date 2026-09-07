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

| Parameter        | Description                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | Required. Shell command to run.                                                                                                                                   |
| `workdir`        | Working directory; omit to use the default cwd.                                                                                                                   |
| `env`            | Extra environment variables for the command.                                                                                                                      |
| `yieldMs`        | Milliseconds to wait before backgrounding (default 10000).                                                                                                        |
| `background`     | Run in background immediately.                                                                                                                                    |
| `timeoutSeconds` | Timeout in seconds (default `tools.exec.timeoutSeconds`); kills the process on expiry. Set `timeoutSeconds: 0` to disable the exec process timeout for that call. |
| `pty`            | Run in a pseudo-terminal when available (TTY-required CLIs, coding agents).                                                                                       |
| `elevated`       | Run outside the sandbox if elevated mode is enabled/allowed (`gateway` by default, or `node` when the exec target is `node`).                                     |
| `host`           | Exec target: `auto`, `sandbox`, `gateway`, or `node`.                                                                                                             |
| `node`           | Node id/name, used with `host: "node"`.                                                                                                                           |

Behavior:

- Foreground runs return retained output directly and disclose when earlier output exceeded the aggregate cap.
- When backgrounded (explicit or via `yieldMs` timeout), the tool returns `status: "running"` + `sessionId` and a short output tail.
- Backgrounded and `yieldMs` runs inherit `tools.exec.timeoutSeconds` unless the call passes an explicit `timeoutSeconds`.
- Returning a background session ID does not stop the process timeout. For a persistent service on the gateway or in a sandbox, use `background: true` with `timeoutSeconds: 0`, then stop it with `process` action `kill` when finished. Host and worker lifecycle limits still apply.
- Output stays in memory up to the per-session aggregate cap until the session is polled or cleared.
- Finished sessions expire after their configured TTL, measured from completion. Each exec captures its agent's retention setting when admitted; using another agent's process tool does not change existing results' lifetimes. The registry also retains at most 50 finished sessions and 2,000,000 total retained output characters, evicting the oldest records first. The newest completed session retains its capped per-session aggregate even when that record alone exceeds the global limit.
- If the `process` tool is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.
- Spawned exec commands receive `OPENCLAW_SHELL=exec` for context-aware shell/profile rules.
- For long-running work that starts now: start it once and rely on automatic completion wake (when enabled) once the command emits output or fails.
- If automatic completion wake is unavailable, or you need quiet-success confirmation for a command that exits cleanly with no output, poll with `process`.
- Don't emulate reminders or delayed follow-ups with `sleep` loops or repeated polling — use cron for future work.

### Env overrides

| Variable                                 | Effect                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BASH_YIELD_MS`                 | Default yield before backgrounding (ms). Default 10000, clamped 10-120000.                                       |
| `OPENCLAW_BASH_MAX_OUTPUT_CHARS`         | In-memory aggregate cap in characters. Default 200000, clamped 1000-200000.                                      |
| `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` | Pending stdout/stderr cap per stream. Default 30000, clamped 1000-200000 and limited by the aggregate cap.       |
| `OPENCLAW_BASH_JOB_TTL_MS`               | TTL for finished sessions (ms), bounded to 1m-3h.                                                                |
| `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`    | Idle-output threshold before writable background sessions are marked as likely waiting for input. Default 15000. |

### Config (preferred over env overrides)

| Key                                   | Default | Effect                                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `tools.exec.backgroundMs`             | 10000   | Same as `OPENCLAW_BASH_YIELD_MS`.                                               |
| `tools.exec.timeoutSeconds`           | 1800    | Default per-call timeout.                                                       |
| `tools.exec.cleanupMs`                | 1800000 | Same as `OPENCLAW_BASH_JOB_TTL_MS`.                                             |
| `tools.exec.notifyOnExit`             | true    | Enqueue a system event + request heartbeat when a backgrounded exec exits.      |
| `tools.exec.notifyOnExitEmptySuccess` | false   | Also enqueue completion events for successful backgrounded runs with no output. |

## Worker environments

On a paired-node or node-backed cloud worker, background processes belong to the
session's environment. Finishing or cancelling a turn leaves already-backgrounded
commands running. A later turn in the same environment can use `process` to poll,
send input, or stop them; foreground commands still stop when their turn is cancelled.

The retained worker occupies one node worker slot. Reusing it needs no additional
slot. If a command finishes between turns, its retained output remains available
to the next turn, subject to the normal process output limits and TTL. Once a turn
finishes with no live background commands, the worker exits. Moving or retiring
the environment, replacing its ownership, or stopping the node also stops its
processes. Process handles do not survive a worker or node restart.

If the node's pairing is revoked or its provider no longer recognizes the lease,
the session placement fails. Physical cleanup can remain pending until OpenClaw
confirms that the exact worker has stopped; an unconfirmed stop does not release
its ownership record.

Worker completion does not currently wake the Gateway session automatically;
use `process poll` in a later turn to inspect the result. Closing a portal closes
its proxy, not the development server: stop the server with `process kill`.

## Child process bridging

When spawning long-running child processes outside the exec/process tools (CLI respawns, gateway helpers), attach the child-process bridge helper so termination signals forward and listeners detach on exit/close. This avoids orphaned processes on systemd and keeps shutdown consistent across platforms.

A supervised command's timeout also covers startup, including blocked private-input
delivery. The timeout result can return while cleanup continues. Scope retirement
and Gateway shutdown wait for the cleanup owner separately; when that owner reports
uncertainty, they report failure instead of treating the timeout as proof that the
command has stopped.

For owned POSIX process groups, cleanup also waits for the operating system to
confirm that the group has disappeared after graceful shutdown. A completed
command or closed output pipe alone does not establish that its descendants have
stopped. Forced termination without confirmed cleanup remains uncertain. Local
TUI shell shutdown uses the same cleanup owner for its own commands.

One-shot tool cleanup keeps configured sandbox runtimes on their
[session, agent, or shared lifetime](/gateway/sandboxing#modes-scope-and-backend). It joins the local
command transport and backend cleanup for that command. It does not stop a shared
sandbox or claim that every remote descendant has exited. Host commands, including
elevated commands from sandboxed sessions, still require owned process-tree cleanup.

When a host command requires process-tree cleanup, a `pty` request falls back to
the child-process path before starting a native PTY and reports a warning. Commands
that require a terminal may fail under that fallback. Cleanup failures remain
uncertain rather than being reported as a clean shutdown.

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
- Resetting or deleting a session clears only its completed background processes; other sessions, explicit shared scopes, and running processes remain unaffected.
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
- `process poll` and `process log` distinguish output discarded at the aggregate retention cap from output merely omitted by the pending buffer or retained tail. Discarded output cannot be recovered; paged logs can inspect only the retained portion.
- `poll`'s `timeout` waits up to that many milliseconds before returning; values above 30000 are clamped to 30000.
- Polling is for on-demand status, not wait-loop scheduling. If the work should happen later, use cron.

In [Code Mode](/tools/code-mode), `process` returns its structured details directly.
For `action: "log"`, `output` contains the requested log page, including paging,
retention, and input-recovery hints. Failed process actions include an `error`
message alongside `status: "failed"`, so the agent can choose the next action.

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
