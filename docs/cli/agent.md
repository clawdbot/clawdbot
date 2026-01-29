---
summary: "CLI reference for `clawdbot agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
---

# `clawdbot agent`

Run an agent turn via the Gateway (use `--local` for embedded).
Use `--agent <id>` to target a configured agent directly.

Related:
- Agent send tool: [Agent send](/tools/agent-send)

## Options

| Flag | Description |
|------|-------------|
| `--url <url>` | Gateway WebSocket URL (for Docker setups where gateway is on a different host/container) |
| `--local` | Run embedded agent locally instead of via gateway |
| `--deliver` | Send the agent's reply back to the channel |
| `--json` | Output result as JSON |
| `--timeout <seconds>` | Override agent command timeout |

See `clawdbot agent --help` for the full list of options.

## Examples

```bash
clawdbot agent --to +15555550123 --message "status update" --deliver
clawdbot agent --agent ops --message "Summarize logs"
clawdbot agent --session-id 1234 --message "Summarize inbox" --thinking medium
clawdbot agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"

# Docker: connect CLI container to gateway container
docker compose run --rm clawdbot-cli agent --agent main --message "test" --url ws://clawdbot-gateway:18789
```
