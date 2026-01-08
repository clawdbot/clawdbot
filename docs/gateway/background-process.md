---
summary: "Background bash execution and process management"
read_when:
  - Adding or modifying background bash behavior
  - Debugging long-running bash tasks
---

# Background Bash + Process Tool

Clawdbot runs shell commands through the `bash` tool and keeps long‑running tasks in memory. The `process` tool manages those background sessions.

## bash tool

Key parameters:
- `command` (required)
- `yieldMs` (default 10000): auto‑background after this delay
- `background` (bool): background immediately
- `timeout` (seconds, default 1800): kill the process after this timeout
- `elevated` (bool): run on host if elevated mode is enabled/allowed
- Need a real TTY? Use the tmux skill.
- `workdir`, `env`

Behavior:
- Foreground runs return output directly.
- When backgrounded (explicit or timeout), the tool returns `status: "running"` + `sessionId` and a short tail.
- Output is kept in memory until the session is polled or cleared.
- If the `process` tool is disallowed, `bash` runs synchronously and ignores `yieldMs`/`background`.

Environment overrides:
- `PI_BASH_YIELD_MS`: default yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: in‑memory output cap (chars)
- `PI_BASH_JOB_TTL_MS`: TTL for finished sessions (ms, bounded to 1m–3h)

Config (preferred):
- `agent.bash.backgroundMs` (default 10000)
- `agent.bash.timeoutSec` (default 1800)
- `agent.bash.cleanupMs` (default 1800000)

## process tool

Actions:
- `list`: running + finished sessions
- `poll`: drain new output for a session (also reports exit status)
- `log`: read the aggregated output (supports `offset` + `limit`)
- `write`: send stdin (`data`, optional `eof`)
- `kill`: terminate a background session
- `clear`: remove a finished session from memory
- `remove`: kill if running, otherwise clear if finished

Notes:
- Only backgrounded sessions are listed/persisted in memory.
- Sessions are lost on process restart (no disk persistence).
- Session logs are only saved to chat history if you run `process poll/log` and the tool result is recorded.
- `process` is scoped per agent; it only sees sessions started by that agent.
- `process list` includes a derived `name` (command verb + target) for quick scans.
- `process log` uses line-based `offset`/`limit` (omit `offset` to grab the last N lines).

## Examples

Run a long task and poll later:
```json
{"tool": "bash", "command": "sleep 5 && echo done", "yieldMs": 1000}
```
```json
{"tool": "process", "action": "poll", "sessionId": "<id>"}
```

Start immediately in background:
```json
{"tool": "bash", "command": "npm run build", "background": true}
```

Send stdin:
```json
{"tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n"}
```
