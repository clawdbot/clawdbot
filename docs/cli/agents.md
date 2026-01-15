---
summary: "CLI reference for `clawdbot agents` (list/add/delete isolated agents)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
---

# `clawdbot agents`

Manage isolated agents (workspaces + auth + routing).

Related:
- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
clawdbot agents list
clawdbot agents add work --workspace ~/clawd-work
clawdbot agents delete work
```

