---
summary: "Per-agent sandbox + tool restrictions, precedence, and examples"
title: "Multi-agent sandbox and tools"
sidebarTitle: "Multi-agent sandbox and tools"
read_when: "You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway."
status: active
---

Each agent in a multi-agent setup can override the global sandbox and tool policy. This page covers per-agent configuration, precedence rules, and examples.

<CardGroup cols={3}>
  <Card title="Sandboxing" href="/gateway/sandboxing">
    Backends and modes — full sandbox reference.
  </Card>
  <Card title="Sandbox vs tool policy vs elevated" href="/gateway/sandbox-vs-tool-policy-vs-elevated">
    Debug "why is this blocked?"
  </Card>
  <Card title="Elevated mode" href="/tools/elevated">
    Elevated exec for trusted senders.
  </Card>
</CardGroup>

<Warning>
Auth is scoped by agent: each agent has its own `agentDir` auth store at `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`. Never reuse `agentDir` across agents. Agents can read through to the default/main agent's auth profiles when they do not have a local profile, but OAuth refresh tokens are not cloned into secondary agent stores. If you copy credentials manually, copy only portable static `api_key` or `token` profiles.
</Warning>

---

## Configuration examples

<AccordionGroup>
  <Accordion title="Example 1: Personal + restricted family agent">
    ```json
    {
      "agents": {
        "list": [
          {
            "id": "main",
            "default": true,
            "name": "Personal Assistant",
            "workspace": "~/.openclaw/workspace",
            "sandbox": { "mode": "off" }
          },
          {
            "id": "family",
            "name": "Family Bot",
            "workspace": "~/.openclaw/workspace-family",
            "sandbox": {
              "mode": "all",
              "scope": "agent"
            },
            "tools": {
              "allow": ["read", "message"],
              "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"],
              "message": {
                "crossContext": {
                  "allowWithinProvider": false,
                  "allowAcrossProviders": false
                }
              }
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

    - `main` agent: runs on host, full tool access.
    - `family` agent: runs in Docker (one container per agent), only `read` and current-conversation message sends.

  </Accordion>
  <Accordion title="Example 2: Work agent with shared sandbox">
    ```json
    {
      "agents": {
        "list": [
          {
            "id": "personal",
            "workspace": "~/.openclaw/workspace-personal",
            "sandbox": { "mode": "off" }
          },
          {
            "id": "work",
            "workspace": "~/.openclaw/workspace-work",
            "sandbox": {
              "mode": "all",
              "scope": "shared",
              "workspaceRoot": "/tmp/work-sandboxes"
            },
            "tools": {
              "allow": ["read", "write", "apply_patch", "exec"],
              "deny": ["browser", "gateway", "discord"]
            }
          }
        ]
      }
    }
    ```
  </Accordion>
  <Accordion title="Example 2b: Global coding profile + messaging-only agent">
    ```json
    {
      "tools": { "profile": "coding" },
      "agents": {
        "list": [
          {
            "id": "support",
            "tools": { "profile": "messaging", "allow": ["slack"] }
          }
        ]
      }
    }
    ```

    **Result:**

    - default agents get coding tools.
    - `support` agent is messaging-only (+ Slack tool).

  </Accordion>
  <Accordion title="Example 3: Different sandbox modes per agent">
    ```json
    {
      "agents": {
        "defaults": {
          "sandbox": {
            "mode": "non-main",
            "scope": "session"
          }
        },
        "list": [
          {
            "id": "main",
            "workspace": "~/.openclaw/workspace",
            "sandbox": {
              "mode": "off"
            }
          },
          {
            "id": "public",
            "workspace": "~/.openclaw/workspace-public",
            "sandbox": {
              "mode": "all",
              "scope": "agent"
            },
            "tools": {
              "allow": ["read"],
              "deny": ["exec", "write", "edit", "apply_patch"]
            }
          }
        ]
      }
    }
    ```
  </Accordion>
</AccordionGroup>

---

## Configuration precedence

When both global (`agents.defaults.*`) and agent-specific (`agents.list[].*`) configs exist:

### Sandbox config

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

<Note>
`agents.list[].sandbox.{docker,browser,prune}.*` overrides `agents.defaults.sandbox.{docker,browser,prune}.*` for that agent (ignored when sandbox scope resolves to `"shared"`).
</Note>

### Tool restrictions

The filtering order is:

<Steps>
  <Step title="Tool profile">
    `tools.profile` or `agents.list[].tools.profile`.
  </Step>
  <Step title="Provider tool profile">
    `tools.byProvider[provider].profile` or `agents.list[].tools.byProvider[provider].profile`.
  </Step>
  <Step title="Global tool policy">
    `tools.allow` / `tools.deny`.
  </Step>
  <Step title="Provider tool policy">
    `tools.byProvider[provider].allow/deny`.
  </Step>
  <Step title="Agent-specific tool policy">
    `agents.list[].tools.allow/deny`.
  </Step>
  <Step title="Agent provider policy">
    `agents.list[].tools.byProvider[provider].allow/deny`.
  </Step>
  <Step title="Sandbox tool policy">
    `tools.sandbox.tools` or `agents.list[].tools.sandbox.tools`.
  </Step>
  <Step title="Subagent tool policy">
    `tools.subagents.tools`, if applicable.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Precedence rules">
    - Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
    - If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.
    - If `agents.list[].tools.profile` is set, it overrides `tools.profile` for that agent.
    - Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.4`).

  </Accordion>
  <Accordion title="Empty allowlist behavior">
    If any explicit allowlist in that chain leaves the run with no callable tools, OpenClaw stops before submitting the prompt to the model. This is intentional: an agent configured with a missing tool such as `agents.list[].tools.allow: ["query_db"]` should fail loudly until the plugin that registers `query_db` is enabled, not continue as a text-only agent.
  </Accordion>
</AccordionGroup>

Tool policies support `group:*` shorthands that expand to multiple tools. See [Tool groups](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands) for the full list.

Per-agent elevated overrides (`agents.list[].tools.elevated`) can further restrict elevated exec for specific agents. See [Elevated mode](/tools/elevated) for details.

---

## Migration from single agent

<Tabs>
  <Tab title="Before (single agent)">
    ```json
    {
      "agents": {
        "defaults": {
          "workspace": "~/.openclaw/workspace",
          "sandbox": {
            "mode": "non-main"
          }
        }
      },
      "tools": {
        "sandbox": {
          "tools": {
            "allow": ["read", "write", "apply_patch", "exec"],
            "deny": []
          }
        }
      }
    }
    ```
  </Tab>
  <Tab title="After (multi-agent)">
    ```json
    {
      "agents": {
        "list": [
          {
            "id": "main",
            "default": true,
            "workspace": "~/.openclaw/workspace",
            "sandbox": { "mode": "off" }
          }
        ]
      }
    }
    ```
  </Tab>
</Tabs>

<Note>
Legacy `agent.*` configs are migrated by `openclaw doctor`; prefer `agents.defaults` + `agents.list` going forward.
</Note>

---

## Tool restriction examples

<Tabs>
  <Tab title="Read-only agent">
    ```json
    {
      "tools": {
        "allow": ["read"],
        "deny": ["exec", "write", "edit", "apply_patch", "process"]
      }
    }
    ```
  </Tab>
  <Tab title="Shell execution with filesystem tools disabled">
    ```json
    {
      "tools": {
        "allow": ["read", "exec", "process"],
        "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
      }
    }
    ```

    <Warning>
    This policy disables OpenClaw filesystem tools, but `exec` is still a shell and can write files wherever the selected host or sandbox filesystem allows. For a read-only agent, deny `exec` and `process`, or combine shell access with sandbox filesystem controls such as `agents.defaults.sandbox.workspaceAccess: "ro"` or `"none"`.
    </Warning>

  </Tab>
  <Tab title="Communication-only">
    ```json
    {
      "tools": {
        "sessions": { "visibility": "tree" },
        "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
        "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
      }
    }
    ```

    `sessions_history` in this profile still returns a bounded, sanitized recall view rather than a raw transcript dump. Assistant recall strips thinking tags, `<relevant-memories>` scaffolding, plain-text tool-call XML payloads (including `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks), downgraded tool-call scaffolding, leaked ASCII/full-width model control tokens, and malformed MiniMax tool-call XML before redaction/truncation.

  </Tab>
</Tabs>

---

## Common pitfall: "non-main"

<Warning>
`agents.defaults.sandbox.mode: "non-main"` is based on `session.mainKey` (default `"main"`), not the agent id. Group/channel sessions always get their own keys, so they are treated as non-main and will be sandboxed. If you want an agent to never sandbox, set `agents.list[].sandbox.mode: "off"`.
</Warning>

---

## Testing

After configuring multi-agent sandbox and tools:

<Steps>
  <Step title="Check agent resolution">
    ```bash
    openclaw agents list --bindings
    ```
  </Step>
  <Step title="Verify sandbox containers">
    ```bash
    docker ps --filter "name=openclaw-sbx-"
    ```
  </Step>
  <Step title="Test tool restrictions">
    - Send a message requiring restricted tools.
    - Verify the agent cannot use denied tools.

  </Step>
  <Step title="Monitor logs">
    ```bash
    tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
    ```
  </Step>
</Steps>

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Agent not sandboxed despite `mode: 'all'`">
    - Check if there's a global `agents.defaults.sandbox.mode` that overrides it.
    - Agent-specific config takes precedence, so set `agents.list[].sandbox.mode: "all"`.

  </Accordion>
  <Accordion title="Tools still available despite deny list">
    - Check tool filtering order: global → agent → sandbox → subagent.
    - Each level can only further restrict, not grant back.
    - Verify with logs: `[tools] filtering tools for agent:${agentId}`.

  </Accordion>
  <Accordion title="Container not isolated per agent">
    - Set `scope: "agent"` in agent-specific sandbox config.
    - Default is `"session"` which creates one container per session.

  </Accordion>
</AccordionGroup>

---

## Related

- [Elevated mode](/tools/elevated)
- [Multi-agent routing](/concepts/multi-agent)
- [Sandbox configuration](/gateway/config-agents#agentsdefaultssandbox)
- [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) — debugging "why is this blocked?"
- [Sandboxing](/gateway/sandboxing) — full sandbox reference (modes, scopes, backends, images)
- [Session management](/concepts/session)
