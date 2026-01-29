---
summary: "CLI reference for `moltbot sessions` (list stored sessions + usage) + `moltbot sessions health` (diagnose tool pairing issues)"
read_when:
  - You want to list stored sessions and see recent activity
  - You encounter "tool id not found" errors
---

# `moltbot sessions`

List stored conversation sessions.

```bash
moltbot sessions
moltbot sessions --active 120
moltbot sessions --json
```

# `moltbot sessions health`

Diagnose session health for tool call/result pairing issues. Use this when you encounter errors like:

> `LLM request rejected: invalid params, tool result's tool id(call_function_xxx) not found`

This command checks for:
- **Orphaned tool results** - tool results without matching tool calls
- **Unmatched tool calls** - tool calls without results
- **Duplicate tool results** - multiple results for the same tool call

```bash
# Check all sessions for issues
moltbot sessions health

# Show detailed diagnostics for all sessions
moltbot sessions health --verbose

# Check a specific session by ID
moltbot sessions health --session-id d7ce8851-6c25-4244-b872-58690b546288

# Use a custom session store
moltbot sessions health --store /path/to/sessions.json
```

## Example output

**Healthy session:**
```
✅ [agent:main:main] HEALTHY (22 messages)
```

**Unhealthy session:**
```
❌ [agent:main:main] UNHEALTHY
  - Found 1 orphaned tool result(s) without matching tool call
  Orphaned IDs: call_function_ynavyw1i6p3e_1
```

## Troubleshooting

If a session is unhealthy:

1. Clear the session:
   ```bash
   rm -f ~/.clawdbot/agents/*/sessions/*.jsonl
   ```

2. Restart the gateway:
   ```bash
   pkill -HUP moltbot-gateway
   ```

3. Verify health:
   ```bash
   moltbot sessions health --verbose
   ```