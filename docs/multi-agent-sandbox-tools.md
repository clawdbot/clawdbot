---
summary: "Per-agent sandbox + tool restrictions, precedence, and examples"
title: Multi-Agent Sandbox & Tools
read_when: "You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway."
status: active
---

# Multi-Agent Sandbox & Tools Configuration

## Overview

Each agent in a multi-agent setup can now have its own:
- **Sandbox configuration** (`agents.list[].sandbox` overrides `agents.defaults.sandbox`)
- **Tool restrictions** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

This allows you to run multiple agents with different security profiles:
- Personal assistant with full access
- Family/work agents with restricted tools
- Public-facing agents in sandboxes

For how sandboxing behaves at runtime, see [Sandboxing](/gateway/sandboxing).
For debugging “why is this blocked?”, see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) and `clawdbot sandbox explain`.

---

## Configuration Examples

### Example 1: Personal + Restricted Family Agent

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/clawd",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/clawd-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["bash", "write", "edit", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Result:**
- `main` agent: Runs on host, full tool access
- `family` agent: Runs in Docker (one container per agent), only `read` tool

---

### Example 2: Work Agent with Shared Sandbox

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/clawd-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/clawd-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "bash"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Example 3: Different Sandbox Modes per Agent

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",  // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/clawd",
        "sandbox": {
          "mode": "off"  // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/clawd-public",
        "sandbox": {
          "mode": "all",  // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["bash", "write", "edit"]
        }
      }
    ]
  }
}
```

---

## Configuration Precedence

When both global (`agents.defaults.*`) and agent-specific (`agents.list[].*`) configs exist:

### Sandbox Config
Agent-specific settings override global:
```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Notes:**
- `agents.list[].sandbox.{docker,browser,prune}.*` overrides `agents.defaults.sandbox.{docker,browser,prune}.*` for that agent (ignored when sandbox scope resolves to `"shared"`).

### Tool Restrictions
The filtering order is:
1. **Global tool policy** (`tools.allow` / `tools.deny`)
2. **Agent-specific tool policy** (`agents.list[].tools`)
3. **Sandbox tool policy** (`tools.sandbox.tools` or `agents.list[].tools.sandbox.tools`)
4. **Subagent tool policy** (`tools.subagents.tools`, if applicable)

Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.

### Elevated Mode
`tools.elevated` is the global baseline (sender-based allowlist). `agents.list[].tools.elevated` can further restrict elevated for specific agents (both must allow).

Mitigation patterns:
- Deny `bash` for untrusted agents (`agents.list[].tools.deny: ["bash"]`)
- Avoid allowlisting senders that route to restricted agents
- Disable elevated globally (`tools.elevated.enabled: false`) if you only want sandboxed execution
- Disable elevated per agent (`agents.list[].tools.elevated.enabled: false`) for sensitive profiles

---

## Migration from Single Agent

**Before (single agent):**
```json
{
  "agents": {
    "defaults": {
      "workspace": "~/clawd",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "bash"],
        "deny": []
      }
    }
  }
}
```

**After (multi-agent with different profiles):**
```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/clawd",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Legacy `agent.*` configs are migrated by `clawdbot doctor`; prefer `agents.defaults` + `agents.list` going forward.

---

## Tool Restriction Examples

### Read-only Agent
```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["bash", "write", "edit", "process"]
  }
}
```

### Safe Execution Agent (no file modifications)
```json
{
  "tools": {
    "allow": ["read", "bash", "process"],
    "deny": ["write", "edit", "browser", "gateway"]
  }
}
```

### Communication-only Agent
```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["bash", "write", "edit", "read", "browser"]
  }
}
```

---

## Common Pitfall: "non-main"

`agents.defaults.sandbox.mode: "non-main"` is based on `session.mainKey` (default `"main"`),
not the agent id. Group/channel sessions always get their own keys, so they
are treated as non-main and will be sandboxed. If you want an agent to never
sandbox, set `agents.list[].sandbox.mode: "off"`.

---

## Testing

After configuring multi-agent sandbox and tools:

1. **Check agent resolution:**
   ```bash
   clawdbot agents list --bindings
   ```

2. **Verify sandbox containers:**
   ```bash
   docker ps --filter "label=clawdbot.sandbox=1"
   ```

3. **Test tool restrictions:**
   - Send a message requiring restricted tools
   - Verify the agent cannot use denied tools

4. **Monitor logs:**
   ```bash
   tail -f "${CLAWDBOT_STATE_DIR:-$HOME/.clawdbot}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Troubleshooting

### Agent not sandboxed despite `mode: "all"`
- Check if there's a global `agents.defaults.sandbox.mode` that overrides it
- Agent-specific config takes precedence, so set `agents.list[].sandbox.mode: "all"`

### Tools still available despite deny list
- Check tool filtering order: global → agent → sandbox → subagent
- Each level can only further restrict, not grant back
- Verify with logs: `[tools] filtering tools for agent:${agentId}`

### Container not isolated per agent
- Set `scope: "agent"` in agent-specific sandbox config
- Default is `"session"` which creates one container per session

---

## See Also

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
