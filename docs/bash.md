---
summary: "Bash tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the bash tool
  - Debugging stdin or TTY behavior
---

# Bash tool

Run shell commands in the workspace. Supports foreground + background execution via `process`.

## Parameters

- `command` (required)
- `yieldMs` (default 10000): auto-background after delay
- `background` (bool): background immediately
- `timeout` (seconds, default 1800): kill on expiry
- Need a real TTY? Use the tmux skill.

## Examples

Foreground:
```json
{"tool":"bash","command":"ls -la"}
```

Background + poll:
```json
{"tool":"bash","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```
