---
summary: "CLI reference for `clawdbot wake` (enqueue a system event and optionally trigger an immediate heartbeat)"
read_when:
  - You want to “poke” a running Gateway to process a system event
  - You use `wake` with cron jobs or remote nodes
---

# `clawdbot wake`

Enqueue a system event on the Gateway and optionally trigger an immediate heartbeat.

This is a lightweight “poke” for automation flows where you don’t want to run a full command, but you do want the Gateway to react quickly.

Related:
- Cron jobs: [Cron](/cli/cron)
- Gateway heartbeat: [Heartbeat](/gateway/heartbeat)

## Common commands

```bash
clawdbot wake --text "sync"
clawdbot wake --text "sync" --mode now
```

## Flags

- `--text <text>`: system event text.
- `--mode <mode>`: `now` or `next-heartbeat` (default).
- `--json`: machine-readable output.

## Notes

- Requires a running Gateway reachable by your current config (local or remote).
- If you’re using sandboxing, `wake` still targets the Gateway; sandboxing does not block the command itself.

