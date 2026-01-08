---
summary: "Per-agent sandbox + tool restrictions, precedence, and examples"
title: Multi-Agent Sandbox & Tools
read_when: "You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway."
status: active
---

# Multi-Agent Sandbox & Tools Configuration

## Overview

Each agent in a multi-agent setup can now have its own:
- **Sandbox configuration** (`mode`, `scope`, `workspaceRoot`, `workspaceAccess`, `tools`)
- **Tool restrictions** (`allow`, `deny`)

This allows you to run multiple agents with different security profiles:
- Personal assistant with full access
- Family/work agents with restricted tools
- Public-facing agents in sandboxes

---

## Configuration Examples

### Example 1: Personal + Restricted Family Agent

```json
{
  "routing": {
    "defaultAgentId": "main",
    "agents": {
      "main": {
        "name": "Personal Assistant",
        "workspace": "~/clawd",
        "sandbox": {
          "mode": "off"
        }
        // No tool restrictions - all tools available
      },
      "family": {
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
}
```

**Result:**
- `main` agent: Runs on host, full tool access
- `family` agent: Runs in Docker (one container per agent), only `read` tool

---

### Example 2: Work Agent with Shared Sandbox

```json
{
  "routing": {
    "agents": {
      "personal": {
        "workspace": "~/clawd-personal",
        "sandbox": { "mode": "off" }
      },
      "work": {
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
    }
  }
}
```

---

### Example 3: Different Sandbox Modes per Agent

```json
{
  "agent": {
    "sandbox": {
      "mode": "non-main",  // Global default
      "scope": "session"
    }
  },
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/clawd",
        "sandbox": {
          "mode": "off"  // Override: main never sandboxed
        }
      },
      "public": {
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
    }
  }
}
```

---

## Configuration Precedence

When both global (`agent.*`) and agent-specific (`routing.agents[id].*`) configs exist:

### Sandbox Config
Agent-specific settings override global:
```
routing.agents[id].sandbox.mode > agent.sandbox.mode
routing.agents[id].sandbox.scope > agent.sandbox.scope
routing.agents[id].sandbox.workspaceRoot > agent.sandbox.workspaceRoot
routing.agents[id].sandbox.workspaceAccess > agent.sandbox.workspaceAccess
routing.agents[id].sandbox.docker.* > agent.sandbox.docker.*
routing.agents[id].sandbox.browser.* > agent.sandbox.browser.*
routing.agents[id].sandbox.prune.* > agent.sandbox.prune.*
```

**Notes:**
- `routing.agents[id].sandbox.{docker,browser,prune}.*` overrides `agent.sandbox.{docker,browser,prune}.*` for that agent (ignored when sandbox scope resolves to `"shared"`).

### Tool Restrictions
The filtering order is:
1. **Global tool policy** (`agent.tools`)
2. **Agent-specific tool policy** (`routing.agents[id].tools`)
3. **Sandbox tool policy** (`agent.sandbox.tools` or `routing.agents[id].sandbox.tools`)
4. **Subagent tool policy** (if applicable)

Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
If `routing.agents[id].sandbox.tools` is set, it replaces `agent.sandbox.tools` for that agent.

---

## Migration from Single Agent

**Before (single agent):**
```json
{
  "agent": {
    "workspace": "~/clawd",
    "sandbox": {
      "mode": "non-main",
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
  "routing": {
    "defaultAgentId": "main",
    "agents": {
      "main": {
        "workspace": "~/clawd",
        "sandbox": {
          "mode": "off"
        }
      }
    }
  }
}
```

The global `agent.workspace` and `agent.sandbox` are still supported for backward compatibility, but we recommend using `routing.agents` for clarity in multi-agent setups.

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
    "allow": ["sessions_list", "sessions_send", "sessions_history"],
    "deny": ["bash", "write", "edit", "read", "browser"]
  }
}
```

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
- Check if there's a global `agent.sandbox.mode` that overrides it
- Agent-specific config takes precedence, so set `routing.agents[id].sandbox.mode: "all"`

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
- [Sandbox Configuration](/gateway/configuration#agent-sandbox)
- [Session Management](/concepts/session)
